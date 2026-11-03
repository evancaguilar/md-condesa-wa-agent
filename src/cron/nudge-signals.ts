// Pure signals a nudge checks at send time (2026-09-18, nightly-auditor finds):
//  - the SAME nudge text went out twice in a minute to four leads;
//  - a parent who said the child is 3 got "Kids 4 pm" (the campaign default)
//    instead of Mini Muay Thai; a lead who wanted to enrol online got a class push.
// The schedule model only knows adult|kid, so when the lead's own words
// contradict the campaign's program we do NOT guess a slot — the nudge falls
// back to the booking link (the kids page asks the age and routes correctly).

import type { Program } from "./nudge-copy.js";

export interface StatedAge {
  value: number;
  unit: "years" | "months";
}

const AGE_RE = /(\d{1,2})\s*(años?|anos?|añitos?|meses|mes|years?\s*old|yo\b|months?)/gi;

/** Ages the lead mentioned, in order. "tiene 3 años", "de 10 meses", "5 years old". */
export function statedAges(bodies: readonly string[]): StatedAge[] {
  const out: StatedAge[] = [];
  for (const b of bodies) {
    for (const m of b.matchAll(AGE_RE)) {
      const value = Number(m[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const unit = /mes|month/i.test(m[2] ?? "") ? "months" : "years";
      out.push({ value, unit });
    }
  }
  return out;
}

/**
 * True when what the lead said about age does not fit the program the campaign
 * implies: Kids (6–12) vs a ≤5-year-old / baby / 13+; Baby Fight Club (12–36
 * months) vs a child of 3+ years.
 */
export function ageConflictsWithProgram(program: Program, bodies: readonly string[]): boolean {
  const ages = statedAges(bodies);
  if (ages.length === 0) return false;
  if (program === "kids") {
    return ages.some((a) => a.unit === "months" || a.value <= 5 || (a.value >= 13 && a.value <= 17));
  }
  if (program === "baby") {
    return ages.some((a) => a.unit === "years" && a.value >= 3 && a.value <= 17);
  }
  return false;
}

/** Paying, or already paid. Never about the (free) trial. */
const PAY_INTENT_RE =
  /(?:^|[^a-záéíóúñ])(?:ya\s+pagu[eé]|(?:quiero|quisiera)\s+pagar|c[oó]mo\s+pago|link\s+de\s+pago|d[oó]nde\s+(?:pago|deposito|transfiero)|comprobante|i\s+want\s+to\s+pay|already\s+paid)/i;

/** Enrolling. Luis Ortega (2026-10-30) asked to sign up without a trial and
 *  got pushed to one, then escalated; "me quiero inscribir", "quisiera
 *  inscribirme", "inscribirme directo" all count. */
const ENROL_INTENT_RE =
  /(?:^|[^a-záéíóúñ])(?:(?:quiero|quisiera|me\s+gustar[ií]a|deseo|puedo|podr[ií]a|para)\s+(?:inscribir(?:me|nos|lo|la|le)?|comprar|contratar)|inscribir(?:me|nos)\s+(?:ya|en\s+l[ií]nea|online|direct(?:o|amente)|de\s+una\s+vez)|me\s+inscribo|(?:quiero|quisiera)\s+(?:la\s+|una\s+|el\s+)?(?:membres[ií]a|mensualidad|plan\s+(?:silver|gold|diamond|bronze))|i\s+want\s+to\s+(?:sign\s*up|enrol+|join)|sign\s+me\s+up)/i;

/** "inscribirme a la clase de prueba" is booking a trial, not enrolling. */
const TRIAL_SCOPED_RE = /clase\s+(?:de\s+)?(?:prueba|muestra|gratis)|prueba\s+gratis|free\s+(?:trial|class)|trial\s+class/i;

/** …unless they say they want to skip it. */
const SKIP_TRIAL_RE =
  /sin\s+(?:tomar\s+|hacer\s+)?(?:la\s+|una\s+|el\s+)?(?:clase\s+)?(?:de\s+)?(?:prueba|muestra)|no\s+(?:necesito|quiero|ocupo)\s+(?:tomar\s+)?(?:la\s+|una\s+)?(?:clase\s+)?(?:de\s+)?(?:prueba|muestra)|without\s+(?:a\s+)?trial|skip\s+the\s+trial/i;

function saysBuyIntent(body: string): boolean {
  if (PAY_INTENT_RE.test(body)) return true;
  if (!ENROL_INTENT_RE.test(body)) return false;
  return !TRIAL_SCOPED_RE.test(body) || SKIP_TRIAL_RE.test(body);
}

/** The lead said they want to pay / enrol (or already paid): no class push —
 *  nudges stop, the canned welcome is skipped, and the brain is told to enrol
 *  them (src/brain/prompt.ts <quiere_inscribirse>). */
export function hasBuyIntent(bodies: readonly string[]): boolean {
  return bodies.some(saysBuyIntent);
}

/** Same text already sent to this lead recently → a duplicate row, not a new touch. */
export function isDuplicateSend(
  body: string,
  recentOutbound: readonly { body: string; ts: number }[],
  nowEpoch: number,
  windowSeconds = 24 * 3600,
): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const want = norm(body);
  return recentOutbound.some((m) => m.ts >= nowEpoch - windowSeconds && norm(m.body) === want);
}
