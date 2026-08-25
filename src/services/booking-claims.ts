// Pure regex + helpers for detecting a WhatsApp reply that CLAIMS a completed
// booking, and for pulling the booking's fields back out of that copy. Shared by
// src/brain/claude.ts (guardUnbackedBookingClaim — blocks auto-send when
// book_trial didn't actually run this turn), src/cron/booking-recon.ts (nightly
// reconciliation backstop) and src/services/booking-guard.ts (post-send audit of
// HUMAN-originated confirmations → Slack capture card).
//
// Everything here is pure: no D1, no fetch, no Env. CLIENT is read only for the
// client's service keys/match patterns (a compile-time constant).

import { CLIENT } from "../client.gen.js";

/**
 * Past-participle / confirmatory booking claims ("ya quedó agendado", "tu
 * clase está reservada", "you're booked", "te esperamos mañana a las 7 pm",
 * "nos vemos el sábado 11 am"). Deliberately does NOT match offers or
 * questions ("¿quieres agendar?", "puedo agendarte", "¿nos vemos mañana?") —
 * offering to book, or asking about a future meetup, is fine.
 *
 * Patterns:
 *  - bare past participles: agendad(o/a)(s), reservad(o/a)(s), booked,
 *    "you're all set", confirmad(o/a)(s) (not immediately followed by "?").
 *    The bare "agendad…" form excludes an immediately preceding "no (has/ha)
 *    " so nudge copy ("todavía no has agendado") doesn't trip it — the
 *    reconciliation layer (booking-recon-core.ts) also excludes these bodies
 *    explicitly as a second line of defense.
 *  - "quedó/quedo agendado/apartado/reservado…" and "ya quedaste apartado".
 *  - "te esperamos"/"te espero" or "nos vemos" followed, within the same
 *    sentence, by a weekday/hoy/mañana/clock-time — i.e. a specific promised
 *    meetup, not a vague pleasantry ("te esperamos pronto" does NOT match).
 *    "nos vemos …" additionally does not match when the sentence is a
 *    question ("¿nos vemos mañana?" does NOT match).
 */
export const CLAIMS_BOOKED =
  /(?<!\bno\s(?:has\s|ha\s)?)\bagendad[oa]s?\b|\breservad[oa]s?\b|\bbooked\b|\byou'?re all set\b|\bte esper(?:amos|o)\b(?=[^.?!]*(?:hoy|mañana|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo|\d{1,2}\s*(?::\d{2})?\s*[ap]m))|\bqued(?:ó|o)\s+(?:agendad|apartad|reservad)\w*|\bya\s+quedaste\b|\bconfirmad[oa]s?\b(?!\?)|\bnos vemos\b(?=[^.!?]*(?:hoy|mañana|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo|\d{1,2}\s*(?::\d{2})?\s*[ap]m)(?:[^.!?]*[.!]|[^.!?]*$))/i;

/** True when `text` reads as a confirmed (not offered) booking claim. */
export function claimsBooking(text: string): boolean {
  return CLAIMS_BOOKED.test(text);
}

// ---- shared booking-capture vocabulary -----------------------------------

/**
 * Where a non-brain outbound came from (drives the Slack card copy).
 * "auto_timeout" is the bot's own best-bet send after an hour with no human
 * review (owner directive 2026-08-25) — not human-originated, but it goes down
 * the same audit path because nothing verified the text before it left.
 */
export type HumanSendSource =
  | "approved"
  | "edited"
  | "staff"
  | "staff_later"
  | "auto_timeout";

/** validateSlot's answer, flattened for storage on a capture record. */
export interface BookingVerdict {
  ok: boolean;
  reason?: string;
  alternatives?: string[];
}

/**
 * One "a human confirmed a class but Airtable has no record" capture, persisted
 * in kv under `booking_capture:<epoch>:<phone>` and rendered as the Slack card.
 */
export interface BookingCapture {
  phone: string;
  name?: string;
  childName?: string;
  discipline?: string;
  audience?: "adult" | "kid";
  trialDate?: string; // YYYY-MM-DD (CDMX)
  trialTime?: string; // HH:mm 24h (CDMX)
  /** The outbound text that made the claim, capped at 500 chars. */
  sentText: string;
  source: HumanSendSource;
  by?: string;
  verdict: BookingVerdict;
  /**
   * Set when the lead ALREADY has a fresh registered booking, for a different
   * slot than the one this text promises ("…esto parece OTRA clase"). Rendered
   * on the card so whoever taps «Registrar» knows they're adding a second class.
   */
  conflictNote?: string;
  status: "open" | "registered" | "skipped";
  /** ts of the Slack card, so apply/skip can swap it. */
  slackTs?: string | null;
  /** Airtable record id once registered. */
  recordId?: string;
  createdAt?: number;
}

// ---- deterministic field extraction (parseBookingHints) -------------------

export interface BookingHints {
  trialDate?: string;
  trialTime?: string;
  discipline?: string;
  audience?: "adult" | "kid";
  childName?: string;
  /** full = date + time + discipline all found; none = none of the three. */
  confidence: "full" | "partial" | "none";
}

/** Lowercase + strip diacritics ("mañana" → "manana", "miércoles" → "miercoles"). */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Shift a YYYY-MM-DD calendar date by `n` days (UTC-noon anchored, DST-proof). */
function addDays(ymd: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Weekday name → index, 0=Mon … 6=Sun (same convention as brain/tools.ts). */
const WEEKDAYS: [RegExp, number][] = [
  [/\blunes\b/, 0],
  [/\bmartes\b/, 1],
  [/\bmiercoles\b/, 2],
  [/\bjueves\b/, 3],
  [/\bviernes\b/, 4],
  [/\bsabados?\b/, 5],
  [/\bdomingos?\b/, 6],
];

const BABY_RE = /baby\s*fight\s*club|\bbfc\b/;
const MINI_RE = /\bmini\s*(?:muay(?:\s*thai)?|mt)\b/;
const KID_WORDS =
  /\bbebes?\b|\bpeques?\b|\bpequen\w*|\bnin[oa]s?\b|\bhij[oa]s?\b|\bkids?\b|\binfantil\b/;
/** Conservative: only a Capitalized word right after a child noun counts. */
const CHILD_NAME_RE =
  /(?:hij[oa]|peque|niñ[oa]|nin[oa]|bebé|bebe)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,19})\b/;

/** Resolve the promised DATE (YYYY-MM-DD, CDMX) mentioned in `t` (normalized). */
function parseDate(t: string, todayYmd: string, weekdayIdx: number): string | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso) return iso[1];

  // "pasado mañana" must be tested before the bare "mañana".
  if (/\bpasado\s+manana\b/.test(t)) return addDays(todayYmd, 2);
  // "de/por/en la mañana" is a time of day, not tomorrow — drop those first.
  const withoutMorning = t.replace(/\b(?:de|por|en)\s+la\s+manana\b/g, " ");
  if (/\bmanana\b/.test(withoutMorning)) return addDays(todayYmd, 1);

  const saysToday = /\bhoy\b/.test(t);
  for (const [re, idx] of WEEKDAYS) {
    if (!re.test(t)) continue;
    let delta = (idx - weekdayIdx + 7) % 7;
    // A weekday that IS today means next week unless the copy also says "hoy".
    if (delta === 0 && !saysToday) delta = 7;
    return addDays(todayYmd, delta);
  }
  if (saysToday) return todayYmd;
  return undefined;
}

/** Apply an am/pm marker to a 1–12 hour. */
function applyMeridiem(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const pm = /p/.test(meridiem);
  if (pm) return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

/**
 * Resolve the promised TIME (HH:mm 24h) mentioned in `t` (normalized). Three
 * tiers, most specific first:
 *  1. "19:00" / "3:15 pm"  — HH:mm, meridiem optional (bare HH:mm is 24h).
 *  2. "7 pm" / "11am"      — bare hour WITH a meridiem.
 *  3. "a las 7"            — bare hour, no meridiem. Disambiguated against this
 *     gym's grid: 1–6 ⇒ pm, 7 ⇒ 19:00 (evening dominates confirmations), 8–12
 *     ⇒ am. A wrong guess is visible on the Slack card before anyone registers.
 */
function parseTime(t: string): string | undefined {
  const hm = /\b(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/.exec(t);
  if (hm) {
    const raw = Number(hm[1]);
    const min = Number(hm[2]);
    if (raw <= 23 && min <= 59) {
      // A meridiem only applies to a 1–12 hour ("19:00 pm" stays 19:00).
      const h = hm[3] && raw <= 12 ? applyMeridiem(raw, hm[3]) : raw;
      return `${pad2(h % 24)}:${pad2(min)}`;
    }
  }
  const withMeridiem = /\b(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/.exec(t);
  if (withMeridiem) {
    const raw = Number(withMeridiem[1]);
    if (raw >= 1 && raw <= 12) {
      return `${pad2(applyMeridiem(raw, withMeridiem[2]))}:00`;
    }
  }
  // (?!\d) keeps "a las 1130" out; the ":"/"." guards keep this tier from
  // half-reading a time tier 1 should own. A trailing "." (end of sentence) is
  // deliberately allowed — "nos vemos el lunes a las 7." is the common shape.
  const bare = /\ba\s+la(?:s)?\s+(\d{1,2})(?!\d)(?!\s*:\s*\d)(?!\.\d)/.exec(t);
  if (bare) {
    const raw = Number(bare[1]);
    if (raw >= 1 && raw <= 12) {
      const h = raw <= 7 ? raw + 12 : raw;
      return `${pad2(h)}:00`;
    }
    if (raw >= 13 && raw <= 23) return `${pad2(raw)}:00`;
  }
  return undefined;
}

/** Resolve the discipline key (jiu/muay/…) named in `t` (normalized). */
function parseDiscipline(t: string): string | undefined {
  if (BABY_RE.test(t)) return "baby";
  if (MINI_RE.test(t)) return "muay"; // Mini Muay Thai lives on the muay grid
  for (const svc of CLIENT.services) {
    if (svc.match && new RegExp(svc.match).test(t)) return svc.key;
  }
  return undefined;
}

/**
 * Pull the booking fields out of a human-written confirmation. Pure and clock-
 * injected: `nowCdmxIso` is "YYYY-MM-DDTHH:mm" in CDMX and `weekdayIdx` is that
 * day's index (0=Mon … 6=Sun) — same shape the brain's <context> block carries.
 *
 * Anything it can't read with confidence is simply left undefined; the caller
 * (booking-guard) falls back to one cheap model call only when the result is
 * not `full`.
 */
export function parseBookingHints(
  text: string,
  nowCdmxIso: string,
  weekdayIdx: number,
): BookingHints {
  const t = norm(text);
  const todayYmd = /^(\d{4}-\d{2}-\d{2})/.exec(nowCdmxIso)?.[1] ?? "";

  const trialDate = todayYmd ? parseDate(t, todayYmd, weekdayIdx) : undefined;
  const trialTime = parseTime(t);
  const discipline = parseDiscipline(t);

  // Mini Muay Thai is inherently a kids program; otherwise any child word flips
  // the audience. Baby Fight Club runs under both audiences, so it stays unset.
  const audience: "adult" | "kid" | undefined =
    MINI_RE.test(t) || KID_WORDS.test(t) ? "kid" : undefined;
  const childName = CHILD_NAME_RE.exec(text)?.[1];

  const found = [trialDate, trialTime, discipline].filter(Boolean).length;
  const confidence: BookingHints["confidence"] =
    found === 3 ? "full" : found === 0 ? "none" : "partial";

  const hints: BookingHints = { confidence };
  if (trialDate) hints.trialDate = trialDate;
  if (trialTime) hints.trialTime = trialTime;
  if (discipline) hints.discipline = discipline;
  if (audience) hints.audience = audience;
  if (childName) hints.childName = childName;
  return hints;
}
