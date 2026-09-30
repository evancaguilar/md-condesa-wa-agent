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

import type { Qualification } from "../types.js";

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
