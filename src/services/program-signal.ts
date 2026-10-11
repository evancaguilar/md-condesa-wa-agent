// Program signal from what the LEAD wrote (2026-09-30).
//
// contacts.qualification used to be written only at booking time, so a parent
// who told us "2 años" or "es para mi hija" but never booked stayed
// unclassified and classifyProgram (nudges + blast audiences) filed them as
// ADULTS — a BFC parent got the adults blast on 2026-09-29 and booked an adult
// 6 pm class by mistake. This module reads a single inbound message and says
// whether it clearly points at a baby (12–36 months → Baby Fight Club) or a
// child (3–12 → Kids). Pure; the pipeline and the backfill route persist it.
//
// Deliberately conservative: a bare age only counts when the message is ABOUT
// someone else ("tiene 2 años", "cumplió 5", a message that is just "2 años",
// or an age next to a child word). "Tengo 25 años" and "entreno hace 2 años"
// never fire.

import type { Qualification, QualUpdate } from "../types.js";
import { bandFromAgeMonths, bandFromQualification, childAgeMonthsFromText } from "./age-band.js";

export type ProgramSignal = "baby" | "kids";

// Trailing (?!\p{L}) not \b: JS \b is ASCII-only, so "bebé" at the end of a
// message never matched a trailing \b.
const BABY_WORD_RE = /\b(mi|mis|nuestr[ao]s?|la|el|su|tu)\s+(beb[eé]s?|bebit[ao]s?|nen[ea]s?)(?![\p{L}\d])|\bbaby\s*fight\b|\bbfc\b/iu;
const CHILD_WORD_RE =
  /\b(mi|mis|nuestr[ao]s?|su|sus|tu|tus|para\s+(?:mi|el|la))\s+(hij[oa]s?|peques?|pequeñ[oa]s?|niñ[oa]s?|nin[oa]s?|niet[oa]s?|sobrin[oa]s?|chamac[oa]s?|chiquit[oa]s?|nen[ea]s?)(?![\p{L}\d])/iu;
/** Months only about a third person or as the whole message — "llevo 6 meses
 *  entrenando" is an adult talking about themselves. */
const MONTHS_RE =
  /\b(?:tiene|tienen|cumpli[oó]|cumple|va\s+a\s+cumplir)\s+(\d{1,2})\s*mes(?:es)?\b|^\s*(\d{1,2})\s*mes(?:es)?\s*[.!]?\s*$/i;
/** Age that is clearly about a third person. */
const THIRD_PERSON_AGE_RE =
  /\b(?:tiene|tienen|cumpli[oó]|cumple|va\s+a\s+cumplir)\s+(\d{1,2})\s*(?:años|añitos|anos|a[ñn]o)?\b/i;
/** A message that is only an age ("2 años", "tiene 5", "5 añitos 🙂"). */
const BARE_AGE_RE = /^\s*(?:tiene\s+)?(\d{1,2})\s*(?:años|añitos|anos|a[ñn]o)?\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}.!🙂]*\s*$/u;
const ANY_AGE_RE = /\b(\d{1,2})\s*(?:años|añitos|anos)\b/i;

function fromYears(n: number): ProgramSignal | null {
  if (n >= 1 && n <= 2) return "baby";
  if (n >= 3 && n <= 12) return "kids";
  return null;
}

/** Pure. The program one inbound message points at, or null when unclear. */
export function programSignalFromText(text: string | null | undefined): ProgramSignal | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  const months = MONTHS_RE.exec(t);
  if (months) {
    const n = Number(months[1] ?? months[2]);
    if (n >= 1 && n <= 36) return "baby";
  }
  if (BABY_WORD_RE.test(t)) return "baby";

  const third = THIRD_PERSON_AGE_RE.exec(t);
  if (third) {
    const s = fromYears(Number(third[1]));
    if (s) return s;
  }
  const bare = BARE_AGE_RE.exec(t);
  if (bare && /años|añitos|anos|año|tiene/i.test(t)) {
    const s = fromYears(Number(bare[1]));
    if (s) return s;
  }
  if (CHILD_WORD_RE.test(t)) {
    const any = ANY_AGE_RE.exec(t);
    if (any) return fromYears(Number(any[1])) ?? "kids";
    return "kids";
  }
  return null;
}

/**
 * Pure. The qualification JSON to store for a signal, or null when nothing
 * should change. Never overrides a qualification that already names an
 * audience (a booking wrote it, it is authoritative); only fills the gap, and
 * upgrades a signal-only "kids" to "baby" when a later message says months.
 */
export function mergeProgramSignal(
  current: Qualification,
  signal: ProgramSignal | null,
): Qualification | null {
  if (!signal) return null;
  const disc = (current.discipline ?? "").toLowerCase();
  if (current.audience === "adult") return null;
  if (disc.includes("baby")) return null;
  if (current.audience === "kid") {
    if (signal === "baby" && !current.discipline) return { ...current, discipline: "baby" };
    return null;
  }
  return signal === "baby"
    ? { ...current, audience: "kid", discipline: "baby" }
    : { ...current, audience: "kid" };
}

// ---- age + discipline signal (2026-10-11, WP1) ----
//
// The routing now trusts AGE (age-band.ts), so every inbound also tries to read
// the child's age and stores it as child_age_months + program. A new stated
// age overrides an older one ("tiene 3" → "perdón, ya cumplió 4"); a message
// with no age never erases one. The discipline the lead came for (the ad they
// tapped) fills qualification.discipline when it is still empty, so the
// <context> can put that discipline's class first.

/** Did our last message ask for the child's age? Then a bare "5" is an age. */
const ASKS_AGE_RE = /\bedad(es)?\b|a[ñn]os\s+tiene|cu[aá]ntos\s+a[ñn]os|how\s+old/i;

export function botAskedAge(lastBotBody: string | null | undefined): boolean {
  return ASKS_AGE_RE.test(lastBotBody ?? "");
}

const DISCIPLINE_PATTERNS: readonly [string, RegExp][] = [
  ["muay", /muay/i],
  ["jiu", /\bjiu|\bbjj\b|jitsu/i],
  ["mma", /\bmma\b|artes\s+marciales\s+mixtas/i],
  ["box", /\bbox(eo)?\b|\bboxing\b/i],
];

/**
 * The ONE discipline an ad (headline + body + campaign ad_keywords) is about,
 * or null when it names none or several (a "4 disciplinas" creative says
 * nothing about what this lead wants). Pure.
 */
export function disciplineFromAdText(text: string | null | undefined): string | null {
  const t = text ?? "";
  if (!t.trim()) return null;
  if (/baby\s*fight|\bbfc\b/i.test(t)) return null;
  const hits = DISCIPLINE_PATTERNS.filter(([, re]) => re.test(t)).map(([k]) => k);
  return hits.length === 1 ? hits[0]! : null;
}

export interface SignalInput {
  /** The inbound text. */
  body: string;
  /** Our previous outbound message (bot or human), for expectingAge. */
  lastOutboundBody?: string | null;
  /** Ad headline + body + matched campaign ad_keywords, when known. */
  adText?: string | null;
}

/**
 * Pure. The qualification to store after one inbound, or null when nothing
 * changes. Layers: the legacy audience/discipline signal (mergeProgramSignal),
 * then the child's age (overrides any earlier age; never erased), then the
 * ad's discipline when none is stored yet.
 */
export function programSignalUpdate(current: Qualification, input: SignalInput): Qualification | null {
  let next: Qualification = mergeProgramSignal(current, programSignalFromText(input.body)) ?? { ...current };

  const months = childAgeMonthsFromText(input.body, { expectingAge: botAskedAge(input.lastOutboundBody) });
  if (months !== null && months !== current.child_age_months) {
    const band = bandFromAgeMonths(months);
    next = { ...next, child_age_months: months, program: band, audience: band === "adults" ? next.audience : "kid" };
    // A legacy "baby" discipline stamped by the campaign/BFC words must not
    // outlive an age that says otherwise.
    if (band !== "baby" && (next.discipline ?? "").toLowerCase().includes("baby")) delete next.discipline;
  }

  if (!next.discipline) {
    const band = bandFromQualification(next);
    const disc = disciplineFromAdText(input.adText);
    if (disc && band !== "baby" && band !== "mini") next = { ...next, discipline: disc };
  }

  return JSON.stringify(next) === JSON.stringify(current) ? null : next;
}

const DAY_RE: readonly [string, RegExp][] = [
  ["lun", /^lun/],
  ["mar", /^mar/],
  ["mie", /^mi[eé]/],
  ["jue", /^jue/],
  ["vie", /^vie/],
  ["sab", /^s[aá]b/],
  ["dom", /^dom/],
];

/** Model-supplied day list → canonical keys (lun|mar|mie|jue|vie|sab|dom), deduped. */
export function cleanDayKeys(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().toLowerCase();
    const hit = DAY_RE.find(([, re]) => re.test(s));
    if (hit && !out.includes(hit[0])) out.push(hit[0]);
  }
  return out;
}

/** What send_reply / book_trial may teach us about the lead this turn (types.ts). */
export type { QualUpdate } from "../types.js";

/**
 * Pure. Merge a model-reported update into the stored qualification, or null
 * when nothing changes. A stated age replaces the old one (and re-derives the
 * band); absence never erases. A day the lead now prefers leaves the declined
 * list and vice versa.
 */
export function mergeQualUpdate(current: Qualification, u: QualUpdate | undefined): Qualification | null {
  if (!u) return null;
  const next: Qualification = { ...current };
  if (u.child_name && u.child_name.trim()) next.child_name = u.child_name.trim();
  if (typeof u.child_age_months === "number" && Number.isFinite(u.child_age_months) && u.child_age_months >= 0) {
    next.child_age_months = Math.round(u.child_age_months);
    next.program = bandFromAgeMonths(next.child_age_months);
    if (next.program !== "adults") next.audience = "kid";
  }
  if (u.preferred_days?.length) {
    next.preferred_days = [...new Set([...(next.preferred_days ?? []), ...u.preferred_days])];
    next.declined_days = (next.declined_days ?? []).filter((d) => !u.preferred_days!.includes(d));
    if (next.declined_days.length === 0) delete next.declined_days;
  }
  if (u.declined_days?.length) {
    next.declined_days = [...new Set([...(next.declined_days ?? []), ...u.declined_days])];
    next.preferred_days = (next.preferred_days ?? []).filter((d) => !u.declined_days!.includes(d));
    if (next.preferred_days.length === 0) delete next.preferred_days;
  }
  return JSON.stringify(next) === JSON.stringify(current) ? null : next;
}
