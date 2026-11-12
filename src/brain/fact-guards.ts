// Deterministic checks on OUTGOING copy for the fact errors the 2026-11-11
// grading found again and again (WRONG_FACT, 27 conversations). Pure.
//
//  - capacityClaim: "hay lugar", "tienes lugar", "ya no tenemos cupo". The
//    persona forbids any capacity talk — there is no cupo system the bot can
//    read — yet it kept appearing (A11, A45, A174, A187, A54).
//  - comboClaimIssues: "a las 7 pm pruebas Jiu-Jitsu y Muay Thai seguidas"
//    when the two run in PARALLEL at 7 pm (A236), or a 10 am combo on a day
//    with a single 10 am class (A0, A54). Checked against the generated grid.

import { SLOTS, type Slot } from "./slots.gen.js";
import { CLIENT } from "../client.gen.js";
import { parseAllTimes } from "../services/booking-claims.js";
import { slotGroup } from "../services/age-band.js";
import { findDateRefs, normDate, weekdayOfYmd, WEEKDAY_NAMES_ES } from "./stated-date.js";

/**
 * Capacity / availability-count claims. Booking language that is NOT a
 * capacity claim stays out: "ya tiene su lugar" (a confirmation), "te aparto
 * lugar" (a reservation), "¿quieres que te aparte lugar?".
 */
const CAPACITY_RE =
  /\b(?:(?:todav[ií]a|a[uú]n|tambi[eé]n|s[ií])\s+)?(?:hay|tienes|tienen|tenemos|queda|quedan|contamos\s+con)\s+(?:un\s+|unos\s+|algunos\s+|pocos\s+|varios\s+|muchos\s+)?(?:lugar(?:es|cito)?|cupos?|disponibilidad)\b(?!\s+(?:de|para)\s+(?:estacion|paga|dejar|guardar|la\s+bici|bicis))|\b(?:ya\s+)?no\s+(?:hay|tenemos|tienen|queda[n]?)\s+(?:m[aá]s\s+)?(?:lugar(?:es)?|cupos?|disponibilidad)\b(?!\s+(?:de|para)\s+(?:estacion|paga|dejar|guardar))|\bsin\s+cupos?\b|\b(?:est[aá]|va)\s+(?:muy\s+)?llen[oa]\b|\b(?:se\s+)?llen[oó]\b|\b[uú]ltimos?\s+(?:lugar(?:es)?|cupos?)\b|\blugares\s+disponibles\b|\bcupos?\s+(?:disponibles?|limitados?)\b|\bspots?\s+(?:left|available)\b|\b(?:there\s+is|there'?s|we\s+have)\s+(?:still\s+)?(?:room|space|availability)\b|\bfully\s+booked\b/i;

/** The capacity phrase in `text`, or null. Pure. */
export function capacityClaim(text: string): string | null {
  const m = CAPACITY_RE.exec(text);
  return m ? m[0].trim() : null;
}

/**
 * Group-size / scarcity selling claims that are not in the KB (AI follow-up
 * preview 2026-11-12: "grupos chicos"). Capacity wording ("cupo limitado",
 * "últimos lugares") is already capacityClaim's job; this adds the group-size
 * phrasings and the English "limited spots/space". Conservative list. Pure.
 */
const UNBACKED_CLAIM_RE =
  /\bgrupos?\s+(?:muy\s+)?(?:chic[oa]s?|peque[ñn][oa]s?|reducid[oa]s?)\b|\bclases?\s+(?:muy\s+)?(?:reducid[oa]s?|con\s+pocos\s+alumnos)\b|\bsmall(?:er)?\s+(?:groups?|class(?:es)?|class\s+sizes?)\b|\blimited\s+(?:spots?|space|spaces|availability|capacity)\b/i;

/** The group-size / capacity-style selling phrase in `text`, or null. Pure. */
export function unbackedClaim(text: string): string | null {
  const m = UNBACKED_CLAIM_RE.exec(text);
  return m ? m[0].trim() : null;
}

// ---- two-class combos ---------------------------------------------------

/** Cues that claim a two-class sequence on their own. */
const COMBO_CUE =
  /\bseguid[ao]s\b|\bdos\s+clases\b|\b2\s+clases\b|\bback[-\s]to[-\s]back\b|\btwo\s+classes\b/i;
/** Cues that only mean a combo when two disciplines are named alongside
 *  ("…y luego te mando el link" is not a combo). */
const WEAK_COMBO_CUE = /\by\s+luego\b|\by\s+despu[eé]s\b|\bde\s+pil[oó]n\b|\bambas\b/i;

/** Max gap (minutes) between the two classes of a trial-day combo. */
const COMBO_GAP_MIN = 60;

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Discipline keys in reading order (first mention position). */
function disciplinesInOrder(sentence: string): string[] {
  const t = normDate(sentence);
  const hits: { key: string; at: number }[] = [];
  for (const svc of CLIENT.services) {
    if (!svc.match || svc.key === "baby") continue;
    const m = new RegExp(svc.match).exec(t);
    if (m) hits.push({ key: svc.key, at: m.index });
  }
  // "MMA Striking" counts as Muay Thai on the grid's 9 am row, but it is its
  // own key there — keep it as mma.
  return hits.sort((a, b) => a.at - b.at).map((h) => h.key);
}

function adultTrialRows(wd: number, schedule: readonly Slot[]): Slot[] {
  return schedule.filter((s) => s.weekday === wd && s.trial !== false && slotGroup(s) === "adult" && !s.pp);
}

/**
 * Is there an adult two-class sequence on weekday `wd` that STARTS at `start`
 * with `first` (any discipline when null) and continues within an hour with
 * `second` (any OTHER discipline when null)? Pure.
 */
export function comboStartsAt(
  wd: number,
  start: string,
  first: string | null,
  second: string | null,
  schedule: readonly Slot[] = SLOTS,
): boolean {
  const rows = adultTrialRows(wd, schedule);
  const t0 = minutes(start);
  const a = rows.filter((s) => s.time === start && !s.name && (first === null || s.discipline === first));
  return a.some((x) =>
    rows.some((y) => {
      const gap = minutes(y.time) - t0;
      if (gap <= 0 || gap > COMBO_GAP_MIN || y.name) return false;
      return second === null ? y.discipline !== x.discipline : y.discipline === second;
    }),
  );
}

/** "7:00" → "7 am". */
function clock(hhmm: string): string {
  const h = Math.floor(minutes(hhmm) / 60);
  const m = minutes(hhmm) % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/**
 * Pure. Adult two-class combo claims that the grid does not support. A
 * sentence with a combo cue ("seguidas", "dos clases", "de pilón", "y luego")
 * and one resolvable day is checked hour by hour:
 *  - one or 3+ hours: each hour must START a combo, in the order the sentence
 *    names the disciplines ("JJ y MT seguidas a las 7 pm" = JJ 7 → MT 8);
 *  - exactly two hours: they must be the two halves of one combo.
 * Sentences whose day cannot be read are left alone (no false alarms).
 * Only for adults — kids/teens two-class days come from the context's `then`.
 */
export function comboClaimIssues(
  text: string,
  todayYmd: string,
  schedule: readonly Slot[] = SLOTS,
): string[] {
  const issues: string[] = [];
  const wholeDays = [...new Set(findDateRefs(text, todayYmd).filter((r) => r.kind !== "week").map((r) => r.ymd))];
  const sentences = text.split(/(?<=[.!?\n])/);
  let prev = "";
  for (const raw of sentences) {
    const cur = raw.trim();
    const before = prev;
    prev = cur;
    if (!cur) continue;
    const strongCue = COMBO_CUE.test(cur);
    if (!strongCue && !(WEAK_COMBO_CUE.test(cur) && disciplinesInOrder(cur).length >= 2)) continue;
    // "¿Te late hoy a las 7 pm? Pruebas Jiu-Jitsu y Muay Thai seguidas": the
    // hour sits in the sentence before the combo cue.
    const s = parseAllTimes(cur).length === 0 ? `${before} ${cur}` : cur;
    const days = [...new Set(findDateRefs(s, todayYmd).filter((r) => r.kind !== "week").map((r) => r.ymd))];
    const ymd = days.length === 1 ? days[0]! : days.length === 0 && wholeDays.length === 1 ? wholeDays[0]! : null;
    if (!ymd) continue;
    const wd = weekdayOfYmd(ymd);
    const times = parseAllTimes(s);
    if (times.length === 0) continue;
    const discs = disciplinesInOrder(s);
    const first = discs[0] ?? null;
    const second = discs.length >= 2 ? discs[1]! : null;
    const day = WEEKDAY_NAMES_ES[wd];
    if (times.length === 2) {
      const [x, y] = [...times].sort((p, q) => minutes(p) - minutes(q)) as [string, string];
      const gap = minutes(y) - minutes(x);
      if (gap > 0 && gap <= COMBO_GAP_MIN) {
        // The two halves of one combo ("llegas a las 9 … y a las 10 Muay Thai").
        const ok =
          first && second
            ? comboStartsAt(wd, x, first, second, schedule) || comboStartsAt(wd, x, second, first, schedule)
            : comboStartsAt(wd, x, null, null, schedule);
        if (!ok) issues.push(`el ${day} no hay combo de 2 clases ${clock(x)} + ${clock(y)}.`);
        continue;
      }
      // Two separate arrival offers: each one is checked below.
    }
    for (const t of times) {
      const ok = first && second ? comboStartsAt(wd, t, first, second, schedule) : comboStartsAt(wd, t, first, null, schedule);
      if (!ok) {
        const what = first && second ? `${labelOf(first)} y luego ${labelOf(second)}` : "dos clases seguidas";
        issues.push(`el ${day} a las ${clock(t)} no se puede tomar ${what} (a esa hora hay una sola clase o corren al mismo tiempo).`);
      }
    }
  }
  return [...new Set(issues)];
}

function labelOf(key: string): string {
  return CLIENT.services.find((s) => s.key === key)?.label ?? key;
}

/**
 * Pure. The combos the grid supports on one day, for the <context>:
 * "7 am Jiu-Jitsu→Muay Thai, 6 pm Jiu-Jitsu→Muay Thai" (arrival hour, then the
 * class right after). One entry per arrival hour; `fromTime` skips past hours.
 */
export function dayCombos(
  wd: number,
  fromTime = "00:00",
  schedule: readonly Slot[] = SLOTS,
): string[] {
  const rows = adultTrialRows(wd, schedule).filter((s) => !s.name && minutes(s.time) >= minutes(fromTime));
  const times = [...new Set(rows.map((s) => s.time))].sort((a, b) => minutes(a) - minutes(b));
  const out: string[] = [];
  for (const t of times) {
    const firsts = rows.filter((s) => s.time === t);
    let best: { a: Slot; b: Slot } | null = null;
    for (const a of firsts) {
      for (const b of rows) {
        const gap = minutes(b.time) - minutes(t);
        if (gap <= 0 || gap > COMBO_GAP_MIN || b.discipline === a.discipline) continue;
        // Prefer Jiu-Jitsu → Muay Thai (the KB's recommended order), then the shortest gap.
        const score = (a.discipline === "jiu" && b.discipline === "muay" ? 0 : 1) * 1000 + gap;
        const bestScore = best
          ? (best.a.discipline === "jiu" && best.b.discipline === "muay" ? 0 : 1) * 1000 + (minutes(best.b.time) - minutes(t))
          : Infinity;
        if (score < bestScore) best = { a, b };
      }
    }
    if (best) out.push(`${clock(t)} ${labelOf(best.a.discipline)}→${labelOf(best.b.discipline)}`);
  }
  return out;
}
