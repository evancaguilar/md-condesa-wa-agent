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
 * Leading greeting tokens ignored on BOTH sides of the trigger comparison.
 * Meta rewrites ad prefills over time — the same designed ice-breaker has
 * shipped as "¡Hola! Sí, quiero inscribirme…" and later as plain "Sí, quiero
 * inscribirme…" (seen live 2026-08-07: the hola-less variant matched nothing).
 * Stripping greetings from the stored trigger too means neither variant of the
 * stored phrase nor of the inbound body breaks the prefix match.
 */
const GREETING_TOKENS = new Set(["hola", "buenas", "oigan", "oye", "hello", "hi"]);

/** Drops leading greeting tokens from an already-normalized string. */
export function stripLeadingGreeting(norm: string): string {
  const words = norm.split(" ");
  let i = 0;
  while (i < words.length && GREETING_TOKENS.has(words[i]!)) i++;
  return i === 0 ? norm : words.slice(i).join(" ");
}

/**
 * First active campaign whose normalized trigger matches the normalized inbound
 * body: either the whole body equals the trigger, or the body starts with the
 * trigger (so "curso de defensa ... me interesa" still matches trigger "curso de
 * defensa"). Leading greetings ("hola", "buenas", …) are ignored on both sides.
 * Returns the campaign id, or null when nothing matches.
 *
 * `bodyNorm` is expected already normalized via `normalizeText`.
 */
export function matchCampaign(
  bodyNorm: string,
  campaigns: Campaign[],
): number | null {
  const body = stripLeadingGreeting(bodyNorm);
  for (const c of campaigns) {
    const trigger = c.trigger_norm ? stripLeadingGreeting(c.trigger_norm) : "";
    if (!trigger) continue;
    if (body === trigger || body.startsWith(trigger)) {
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

/** Extra characters over the trigger phrase that count as the lead's own words. */
const REAL_QUESTION_SLACK = 15;

/**
 * Does a campaign-matched FIRST message carry a real question of the lead's
 * own, beyond the ad's prefilled ice-breaker? The canned welcome answers the
 * ad, not the lead: the 2026-08 conversation audit found 4/20 conversations in
 * chunk 00 whose opening question ("¿Es apto para niños?", "¿costo?") was
 * swallowed by the first-reply gate and never answered.
 *
 * Deliberately loose — a false positive only costs one extra (approved) brain
 * reply, while a false negative loses the lead's question entirely:
 *  - any "?" / "¿" anywhere in the raw text, or
 *  - normalized text meaningfully longer than the normalized trigger phrase.
 */
export function hasRealQuestion(
  text: string,
  triggerPhrase: string | null | undefined,
): boolean {
  if (/[?¿]/.test(text)) return true;
  const body = normalizeText(text);
  const trigger = normalizeText(triggerPhrase ?? "");
  return body.length > trigger.length + REAL_QUESTION_SLACK;
}
