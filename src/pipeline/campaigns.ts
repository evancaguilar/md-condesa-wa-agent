// Campaign matching for inbound leads. When a lead's first message repeats the
// trigger phrase from an ad (e.g. "Vi su anuncio de defensa personal"), we tag
// the contact with that campaign so the brain can respond with campaign-specific
// knowledge. Pure module (no I/O) — unit-tested.

import type { Campaign } from "../types.js";

/**
 * Normalize free text for trigger matching:
 *   - NFD decompose + strip combining diacritics ("Ánuncio" → "anuncio")
 *   - lowercase
 *   - strip punctuation (anything not a letter, number, or space)
 *   - collapse runs of whitespace to a single space, trim
 *
 * The same normalization is applied to stored `trigger_norm` (in the KB editor /
 * campaign create path) so equality/prefix comparisons line up.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First active campaign whose normalized trigger matches the normalized inbound
 * body: either the whole body equals the trigger, or the body starts with the
 * trigger (so "curso de defensa ... me interesa" still matches trigger "curso de
 * defensa"). Returns the campaign id, or null when nothing matches.
 *
 * `bodyNorm` is expected already normalized via `normalizeText`.
 */
export function matchCampaign(
  bodyNorm: string,
  campaigns: Campaign[],
): number | null {
  for (const c of campaigns) {
    const trigger = c.trigger_norm;
    if (!trigger) continue;
    if (bodyNorm === trigger || bodyNorm.startsWith(trigger)) {
      return c.id;
    }
  }
  return null;
}

/**
 * First campaign whose `ad_id` contains the referral `source_id` (the Meta ad
 * id). `ad_id` may hold SEVERAL ids separated by commas/whitespace — one
 * campaign concept usually runs as multiple live ads (creatives) in Meta.
 * This takes precedence over trigger-phrase matching: a click-to-WhatsApp lead is
 * attributed by the ad it came from, not by whatever prefilled text it sent.
 * Returns the campaign id, or null when `sourceId` is empty or nothing matches.
 */
export function matchCampaignByAdId(
  sourceId: string | null | undefined,
  campaigns: Campaign[],
): number | null {
  if (!sourceId) return null;
  for (const c of campaigns) {
    if (!c.ad_id) continue;
    if (c.ad_id.split(/[\s,]+/).includes(sourceId)) return c.id;
  }
  return null;
}

/**
 * Split a comma-separated ad-keyword list into normalized keyword phrases.
 * Commas ONLY (unlike ad_id's comma/whitespace split) so multi-word phrases
 * like "reto gladiador" survive. Absent/undefined raw (pre-migration
 * SELECT * rows lack the column) → [].
 */
export function parseAdKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => normalizeText(k))
    .filter((k) => k !== "");
}

/**
 * Normalized ad creative text for keyword matching: headline + body run
 * through `normalizeText`. No referral / no text → "".
 */
export function adTextForMatch(
  referral: { headline?: string | null; body?: string | null } | null | undefined,
): string {
  if (!referral) return "";
  const joined = `${referral.headline ?? ""} ${referral.body ?? ""}`;
  return normalizeText(joined);
}

/**
 * First campaign with ANY keyword phrase contained in the normalized ad text.
 * Space-padded whole-phrase containment so keyword "reto" matches "unete al
 * reto gladiador" but NOT "retorno seguro". Campaign order = caller's list
 * order (getActiveCampaigns is id DESC ⇒ newest campaign wins ties, same
 * rule as trigger matching).
 */
export function matchCampaignByAdText(
  adTextNorm: string,
  campaigns: Campaign[],
): number | null {
  if (!adTextNorm) return null;
  const padded = ` ${adTextNorm} `;
  for (const c of campaigns) {
    const keywords = parseAdKeywords(c.ad_keywords ?? null);
    if (keywords.some((k) => padded.includes(` ${k} `))) return c.id;
  }
  return null;
}

export type CampaignMatchKind = "ad_id" | "ad_text" | "trigger";

export interface CampaignMatch {
  id: number;
  kind: CampaignMatchKind;
}

/**
 * Full attribution precedence for one inbound message:
 *   1. trigger phrase prefix on the message body — a designed prefill is the
 *      strongest intent signal: one ad can offer SEVERAL prefill questions
 *      (Meta ice breakers) that route to DIFFERENT campaigns, so the exact
 *      phrase must outrank the ad id they share. Random typed text never
 *      matches a designed phrase, so this tier is safe first.
 *   2. exact ad-id (referral.source_id ∈ campaigns.ad_id).
 *   3. ad keywords vs the ad's creative text AND its Ads-Manager name/Meta
 *      campaign name (caller folds those into adTextNorm) — covers brand-new
 *      ads nobody registered and prefills Meta rewrote/localized.
 */
export function matchCampaignTiered(opts: {
  sourceId: string | null | undefined;
  adTextNorm: string;
  bodyNorm: string;
  campaigns: Campaign[];
}): CampaignMatch | null {
  const byTrigger = matchCampaign(opts.bodyNorm, opts.campaigns);
  if (byTrigger !== null) return { id: byTrigger, kind: "trigger" };
  const byId = matchCampaignByAdId(opts.sourceId, opts.campaigns);
  if (byId !== null) return { id: byId, kind: "ad_id" };
  const byText = matchCampaignByAdText(opts.adTextNorm, opts.campaigns);
  if (byText !== null) return { id: byText, kind: "ad_text" };
  return null;
}

/** Sane Meta ad-id token — also guards the auto-learn SQL LIKE below against
 *  wildcards/separators smuggled in hostile referral data. */
const AD_ID_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The ad id worth auto-appending to the matched campaign's ad_id list, or
 * null. Only keyword/trigger-tier matches learn (an ad_id-tier match is
 * already registered), and only a sane token qualifies.
 */
export function adIdToLearn(
  match: CampaignMatch | null,
  sourceId: string | null | undefined,
): string | null {
  if (!match || match.kind === "ad_id") return null;
  if (!sourceId || !AD_ID_TOKEN.test(sourceId)) return null;
  return sourceId;
}

/**
 * The instant canned welcome for a brand-new ad lead, or null when none applies:
 * no campaign, the lead already has an outbound message (mid-conversation trigger
 * typing, or human already replied), or the campaign's first_reply is unset/blank.
 * `?? ""` covers the pre-migration shape where the property is absent entirely.
 */
export function firstReplyFor(
  campaign: Campaign | null | undefined,
  hasPriorOutbound: boolean,
): string | null {
  if (!campaign || hasPriorOutbound) return null;
  const text = (campaign.first_reply ?? "").trim();
  return text === "" ? null : text;
}

/** kv key for the at-most-once claim on a phone's first-reply send. */
export function firstReplyKey(phone: string): string {
  return `first_reply_sent:${phone}`;
}

/** Minimum age of the last canned welcome before an ad re-click re-sends it. */
export const FIRST_REPLY_RESEND_COOLDOWN_SECONDS = 24 * 3600;

/**
 * Whether a campaign-matched inbound should get the canned welcome:
 *  - "first": brand-new lead (no outbound ever) — any match kind qualifies.
 *  - "resend": returning lead who CLICKED AN AD AGAIN (referral present — typing
 *    something trigger-like mid-chat never re-welcomes) and has no trial booked.
 *    The caller still enforces the resend cooldown via the kv timestamp claim.
 *  - "none": everything else → normal brain path.
 */
export function firstReplyDecision(opts: {
  hasPriorOutbound: boolean;
  hasReferral: boolean;
  hasActiveBooking: boolean;
}): "first" | "resend" | "none" {
  if (!opts.hasPriorOutbound) return "first";
  if (opts.hasReferral && !opts.hasActiveBooking) return "resend";
  return "none";
}
