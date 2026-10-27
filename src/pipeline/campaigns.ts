// Campaign matching for inbound leads. When a lead's first message repeats the
// trigger phrase from an ad (e.g. "Vi su anuncio de defensa personal"), we tag
// the contact with that campaign so the brain can respond with campaign-specific
// knowledge. Pure module (no I/O) — unit-tested.

import type { Campaign } from "../types.js";
import { childAgeMonthsFromText } from "../services/age-band.js";
import { adultSelfSignal } from "../services/program-signal.js";

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
 * Retired prefill phrasings → their current form, applied to the start of BOTH
 * sides (after the greeting strip). The site's Google WhatsApp prefill went from
 * "vi su anuncio en Google" to "vi su página en Google" (md-condesa-site#7,
 * 2026-10-12): pages cached before the switch still send the old one, and the
 * site merge and the D1 trigger update can't land at the same instant. With
 * the alias, either phrase matches either stored trigger.
 */
const PHRASE_ALIASES: readonly (readonly [string, string])[] = [
  ["vi su anuncio en google", "vi su pagina en google"],
];

/** Greeting-stripped, alias-canonicalized form used for trigger comparison. */
export function triggerKey(norm: string): string {
  const s = stripLeadingGreeting(norm);
  for (const [from, to] of PHRASE_ALIASES) {
    if (s === from || s.startsWith(`${from} `)) return to + s.slice(from.length);
  }
  return s;
}

/**
 * First active campaign whose normalized trigger matches the normalized inbound
 * body: either the whole body equals the trigger, or the body starts with the
 * trigger (so "curso de defensa ... me interesa" still matches trigger "curso de
 * defensa"). Leading greetings ("hola", "buenas", …) are ignored on both sides,
 * and retired phrasings (PHRASE_ALIASES) count as their current form.
 * Returns the campaign id, or null when nothing matches.
 *
 * `bodyNorm` is expected already normalized via `normalizeText`.
 */
export function matchCampaign(
  bodyNorm: string,
  campaigns: Campaign[],
): number | null {
  const body = triggerKey(bodyNorm);
  for (const c of campaigns) {
    const trigger = c.trigger_norm ? triggerKey(c.trigger_norm) : "";
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
  /** Concrete next-slot label ("mañana sábado 2:00 pm") for a `{{slot}}`
   *  placeholder in the welcome. A welcome WITH the placeholder but no slot
   *  returns null — the brain answers instead of a half-filled sentence. */
  slotLabel?: string | null,
): string | null {
  if (!campaign || hasPriorOutbound) return null;
  const text = (campaign.first_reply ?? "").trim();
  if (text === "") return null;
  return fillSlotPlaceholder(text, slotLabel ?? null);
}

/** The welcome-copy placeholder the sender fills from nextTrialSlot. */
export const SLOT_PLACEHOLDER = "{{slot}}";

/** Replaces every `{{slot}}`; null when one is present and no slot is known. */
export function fillSlotPlaceholder(text: string, slotLabel: string | null): string | null {
  if (!text.includes(SLOT_PLACEHOLDER)) return text;
  if (!slotLabel || !slotLabel.trim()) return null;
  return text.split(SLOT_PLACEHOLDER).join(slotLabel.trim());
}

/**
 * Which grid a campaign's `{{slot}}` is computed from, by its name. Program by
 * AGE rules bookings; this only picks the welcome's example slot for a
 * campaign that is itself age-scoped (Baby Fight Club, Kids).
 */
export function slotQueryForCampaign(
  name: string,
): { discipline: string | null; audience: "adult" | "kid" } {
  const n = normalizeText(name);
  if (/\b(baby|bebe|bebes)\b/.test(n)) return { discipline: "baby", audience: "kid" };
  if (/\b(kids|ninos|ninas|infantil|peques?)\b/.test(n)) return { discipline: null, audience: "kid" };
  return { discipline: null, audience: "adult" };
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
  /** The message itself says "quiero inscribirme / pagar": the canned trial
   *  welcome would answer the wrong question (2026-09-21, lead from the site
   *  asking for plan Silver got "¿la clase es para ti o para un peque?"). */
  buyIntent?: boolean;
  /** hasRealQuestion(): the lead wrote their own words, not just the prefill.
   *  A RETURNING lead with real text goes straight to the brain. */
  realQuestion?: boolean;
  /** shouldSkipCannedWelcome(): the message already carries an age, a
   *  day/hour or a discipline the welcome does not cover ⇒ brain alone.
   *  (2026-10 welcome_resend: "Jueves está bien 7:00am" got the Reto welcome
   *  a second time and the booking was lost.) */
  skipCanned?: boolean;
}): "first" | "resend" | "none" {
  if (opts.buyIntent) return "none";
  if (opts.skipCanned) return "none";
  if (!opts.hasPriorOutbound) return "first";
  if (opts.hasReferral && !opts.hasActiveBooking && !opts.realQuestion) return "resend";
  return "none";
}

/** A weekday or a clock time in the lead's own words ("jueves", "7:00am", "a las 6"). */
const DAY_OR_HOUR_RE =
  /\b(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}\s*(?:\d{2}\s*)?(?:am|pm|hrs?)\b|\ba las \d{1,2}\b/;

/** Discipline vocabulary (normalized text) → canonical key. */
const DISCIPLINE_WORDS: [RegExp, string][] = [
  [/\bmuay ?thai\b/, "muay"],
  [/\b(jiu ?jitsu|jiujitsu|bjj)\b/, "bjj"],
  [/\b(box|boxeo|boxing)\b/, "box"],
  [/\b(mma|artes marciales mixtas)\b/, "mma"],
  [/\bkick ?boxing\b/, "kick"],
  [/\bdefensa personal\b/, "defensa"],
  [/\b(karate|taekwondo|judo|lucha)\b/, "other"],
];

/** A welcome written for parents or teens (normalized text). */
const YOUTH_WELCOME_RE = /\b(ninos?|ninas?|kids?|infantil|peques?|teens?|adolescentes?|bebes?|baby)\b/;

function disciplinesIn(norm: string): Set<string> {
  const out = new Set<string>();
  for (const [re, key] of DISCIPLINE_WORDS) if (re.test(norm)) out.add(key);
  return out;
}

/**
 * Pure. True when the canned welcome would answer the AD instead of the lead,
 * so the brain answers alone (no canned text, `justSentWelcome` unset):
 *  - the message states a child's age ("una niña de 4 años" — joss_bfc_mini
 *    got the 12–36-month Baby Fight Club pitch),
 *  - it names a weekday or an hour ("Jueves 7:00am" — the lead is booking),
 *  - it names a discipline the campaign/welcome never mentions,
 *  - it says the classes are for an adult / themselves on a kids, teens or
 *    baby welcome ("Jiu-Jitsu para adulto" got the Jiu-Jitsu niños pitch).
 * Words of the campaign's own prefill never count (the ad put them there).
 * Bare prefills keep the instant welcome.
 */
export function shouldSkipCannedWelcome(
  text: string,
  campaign: Pick<Campaign, "name" | "trigger_phrase" | "first_reply">,
): boolean {
  const body = normalizeText(text);
  if (!body) return false;
  const trigger = stripLeadingGreeting(normalizeText(campaign.trigger_phrase ?? ""));
  const stripped = stripLeadingGreeting(body);
  // Only the part the lead added beyond the prefill.
  const own =
    trigger && stripped.startsWith(trigger) ? stripped.slice(trigger.length).trim() : stripped;
  if (!own) return false;
  if (childAgeMonthsFromText(own) !== null) return true;
  if (DAY_OR_HOUR_RE.test(own)) return true;
  if (
    adultSelfSignal(own) &&
    YOUTH_WELCOME_RE.test(normalizeText(`${campaign.name} ${campaign.first_reply ?? ""}`))
  ) {
    return true;
  }
  const asked = disciplinesIn(own);
  if (asked.size === 0) return false;
  const covered = disciplinesIn(
    normalizeText(`${campaign.name} ${campaign.trigger_phrase ?? ""} ${campaign.first_reply ?? ""}`),
  );
  for (const d of asked) if (!covered.has(d)) return true;
  return false;
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
 *
 * `knownPhrases` is the campaign's own vocabulary beyond the trigger — its
 * name, ad keywords, the referral headline. 2026-10-07: a Reto lead matched by
 * ad id against a trigger that never named the program ("¿Cómo funciona el
 * Reto Gladiador?" vs an "agenda tu día gratis" prefill) — "reto" and
 * "gladiador" looked like the lead's own words, so the welcome AND a brain
 * reply went out again. Words of the campaign itself are never the lead's.
 */
export function hasRealQuestion(
  text: string,
  triggerPhrase: string | null | undefined,
  knownPhrases: readonly (string | null | undefined)[] = [],
): boolean {
  const body = normalizeText(text);
  const trigger = normalizeText(triggerPhrase ?? "");
  const known = knownPhrases
    .map((p) => normalizeText(p ?? ""))
    .filter((p) => p !== "");
  // Boilerplate length = the longest phrase the ad itself could have put in
  // the lead's mouth (prefill, campaign name, headline), not just the trigger.
  const baseline = Math.max(trigger.length, ...known.map((p) => p.length));
  if (body.length > baseline + REAL_QUESTION_SLACK) return true;
  // Boilerplate-length message: a "?" only counts when it is the LEAD's, not
  // the ad's. 2026-09-22: the Reto prefill is itself "¿Cómo funciona el Reto
  // Gladiador?", so every Reto lead got the canned welcome AND a brain reply.
  const qMarks = (s: string): number => (s.match(/[?¿]/g) ?? []).length;
  if (qMarks(text) <= qMarks(triggerPhrase ?? "")) return false;
  // Still boilerplate: a generic "how does it work / what is it / info?"
  // about the campaign itself is exactly what the welcome answers. Meta
  // rewrites prefills over time, so the stored trigger may lack the "?" the
  // current ad carries (2026-09-22: "Como funciona el reto gladiador?" matched
  // by ad id against an older trigger and got two replies). Real question =
  // at least one word that is neither the campaign's own nor generic filler.
  const campaignWords = new Set(
    [trigger, ...known].flatMap((p) => p.split(" ")).filter(Boolean),
  );
  return body
    .split(" ")
    .some((w) => w && !campaignWords.has(w) && !GENERIC_ASK_WORDS.has(w));
}

/** Words that never make a first message a question of the lead's own. */
const GENERIC_ASK_WORDS = new Set([
  "hola", "buenas", "buenos", "buen", "dia", "dias", "tardes", "noches",
  "como", "funciona", "que", "es", "incluye", "trata", "info", "informacion",
  "me", "interesa", "quiero", "quisiera", "mas", "pueden", "puedes", "dar", "das",
  "pasan", "necesito", "saber", "de", "del", "sobre", "el", "la", "los", "las",
  "este", "esta", "esto", "su", "tu", "un", "una", "y", "o", "por", "favor", "gracias",
]);
