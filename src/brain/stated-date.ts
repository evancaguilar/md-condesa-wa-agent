// Deterministic reading of the DATES a lead (or our own confirmation) names.
// Pure: no D1, no fetch, no Env, no clock — `todayYmd` is injected.
//
// Why (grading 2026-11-04→11-11, BOOKING_MISMATCH in 9 conversations): a lead
// wrote "sábado 14", "martes 17", "el próximo lunes 16" and the bot booked and
// confirmed the NEAREST such weekday (Sat 7, "hoy", Mon 9). The <context> only
// listed the next two class days, so the model mapped "sábado" to the Saturday
// it could see and dropped the day of the month. Reminders then fired on the
// wrong day and a false no-show followed. One reply even confirmed "sábado 17
// de noviembre" — a Tuesday.
//
// Three consumers:
//  - prompt.ts puts the lead's stated date (and a 14-day calendar) in <context>;
//  - handleBookTrial refuses a trial_date that contradicts it;
//  - bookResult / the send guard flag a confirmation whose dates do not match
//    the booked record (those never auto-send).

export type DateRefKind =
  | "today"
  | "tomorrow"
  | "day_after"
  | "weekday" // bare "el sábado" — nearest occurrence
  | "dom" // a day of the month ("sábado 14", "el 16", "14/11")
  | "day_month" // "14 de noviembre"
  | "next_week" // "el sábado de la próxima semana"
  | "after_next" // "el otro sábado"
  | "week"; // "la próxima semana" with no day

export interface DateRef {
  kind: DateRefKind;
  /** Resolved CDMX date. For `week`: the Monday of that week. */
  ymd: string;
  /** The matched words (normalized: lowercase, no accents). */
  text: string;
  /** Weekday the text named, 0=Mon … 6=Sun. */
  statedWeekday?: number;
  /** The named weekday is NOT the weekday of the named day of the month. */
  weekdayMismatch?: boolean;
}

/** Lowercase + strip diacritics. */
export function normDate(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/** Shift a YYYY-MM-DD calendar date by `n` days (UTC-noon anchored). */
export function addDaysYmd(ymd: string, n: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 0=Mon … 6=Sun for a YYYY-MM-DD date. */
export function weekdayOfYmd(ymd: string): number {
  const p = parseYmd(ymd);
  if (!p) return -1;
  return (new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay() + 6) % 7;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  if (!pa || !pb) return NaN;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

/** A real calendar date? (rejects 31 de noviembre). */
function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export const WEEKDAY_NAMES_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
export const WEEKDAY_SHORT_ES = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"] as const;
const MONTH_SHORT_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;
const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;

const WD_RE = "(lunes|martes|miercoles|jueves|viernes|sabado|domingo)";
const MONTH_RE = "(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)";
/** What may follow a number that makes it a clock time / quantity, not a date. */
const NOT_A_DATE_TAIL =
  "(?!\\s*(?::|\\.\\d|a\\.?\\s?m\\b|p\\.?\\s?m\\b|am\\b|pm\\b|hrs?\\b|h\\b|horas?\\b|de\\s+la\\s+(?:manana|tarde|noche)|y\\s+media|anos?\\b|meses\\b|mes\\b|semanas?\\b|%|personas?\\b|clases?\\b|veces\\b|min))";

function wdIndex(name: string): number {
  const i = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"].indexOf(name);
  return i;
}

function monthIndex(name: string): number {
  if (name === "setiembre") return 9;
  return MONTHS_ES.indexOf(name as (typeof MONTHS_ES)[number]) + 1;
}

/** Nearest date on/after today with that weekday (today counts only when `allowToday`). */
function nearestWeekday(todayYmd: string, wd: number, allowToday: boolean): string {
  let delta = (wd - weekdayOfYmd(todayYmd) + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return addDaysYmd(todayYmd, delta);
}

/** Future-first candidates (this month, next month, the one after) for a day of the month. */
function domCandidates(todayYmd: string, dom: number): string[] {
  const t = parseYmd(todayYmd);
  if (!t) return [];
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const m0 = t.m - 1 + k;
    const y = t.y + Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    const ymd = validYmd(y, m, dom);
    if (ymd && ymd >= todayYmd) out.push(ymd);
  }
  return out;
}

/** Replace a matched span with spaces so later patterns don't re-read it. */
function blank(s: string, start: number, len: number): string {
  return s.slice(0, start) + " ".repeat(len) + s.slice(start + len);
}

/**
 * Every date the text names, resolved against `todayYmd` (CDMX). Pure.
 * Conservative on purpose: a weekday followed by a small number that does not
 * fit the calendar ("sábado 10") is read as an hour, not a date.
 */
export function findDateRefs(text: string, todayYmd: string): DateRef[] {
  if (!parseYmd(todayYmd)) return [];
  let t = ` ${normDate(text)} `;
  const out: DateRef[] = [];

  // 1. "sábado 14 de noviembre" / "14 de noviembre" / "el día 14 de nov".
  for (const m of [...t.matchAll(new RegExp(`(?:\\b${WD_RE},?\\s+)?(?:el\\s+)?(?:dia\\s+)?\\b(\\d{1,2})\\s+de\\s+${MONTH_RE}\\b`, "g"))]) {
    const dom = Number(m[2]);
    const mon = monthIndex(m[3]!);
    const ty = Number(todayYmd.slice(0, 4));
    let ymd = validYmd(ty, mon, dom);
    if (ymd && ymd < addDaysYmd(todayYmd, -2)) ymd = validYmd(ty + 1, mon, dom);
    if (!ymd) continue;
    const ref: DateRef = { kind: "day_month", ymd, text: m[0].trim() };
    if (m[1]) {
      const sw = wdIndex(m[1]);
      ref.statedWeekday = sw;
      if (sw !== weekdayOfYmd(ymd)) ref.weekdayMismatch = true;
    }
    out.push(ref);
    t = blank(t, m.index!, m[0].length);
  }

  // 2. "14/11" (day/month).
  for (const m of [...t.matchAll(/(?:\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+)?\b(\d{1,2})\/(\d{1,2})(?:\/(?:\d{4}|\d{2}))?\b(?!\s*(?:anos?|meses|hrs?|horas?)\b)/g)]) {
    const dom = Number(m[2]);
    const mon = Number(m[3]);
    const ty = Number(todayYmd.slice(0, 4));
    let ymd = validYmd(ty, mon, dom);
    if (ymd && ymd < addDaysYmd(todayYmd, -2)) ymd = validYmd(ty + 1, mon, dom);
    if (!ymd) continue;
    const ref: DateRef = { kind: "dom", ymd, text: m[0].trim() };
    if (m[1]) {
      const sw = wdIndex(m[1]);
      ref.statedWeekday = sw;
      if (sw !== weekdayOfYmd(ymd)) ref.weekdayMismatch = true;
    }
    out.push(ref);
    t = blank(t, m.index!, m[0].length);
  }

  // 3. "el sábado de la próxima semana" / "la próxima semana el sábado" /
  //    "el sábado de la semana que entra".
  const thisMonday = addDaysYmd(todayYmd, -weekdayOfYmd(todayYmd));
  const nextMonday = addDaysYmd(thisMonday, 7);
  const NEXT_WEEK = "(?:(?:la\\s+)?(?:proxima|siguiente|otra)\\s+semana|(?:la\\s+)?semana\\s+que\\s+(?:entra|viene))";
  for (const re of [
    new RegExp(`\\b${WD_RE}\\s+(?:de\\s+)?${NEXT_WEEK}`, "g"),
    new RegExp(`${NEXT_WEEK}\\s*,?\\s*(?:el\\s+)?${WD_RE}\\b(?!\\s+\\d)`, "g"),
  ]) {
    for (const m of [...t.matchAll(re)]) {
      const sw = wdIndex(m[1]!);
      out.push({ kind: "next_week", ymd: addDaysYmd(nextMonday, sw), text: m[0].trim(), statedWeekday: sw });
      t = blank(t, m.index!, m[0].length);
    }
  }

  // 4. "el otro sábado" = the one after the coming one.
  for (const m of [...t.matchAll(new RegExp(`\\bel\\s+otro\\s+${WD_RE}\\b(?!\\s+\\d)`, "g"))]) {
    const sw = wdIndex(m[1]!);
    out.push({ kind: "after_next", ymd: addDaysYmd(nearestWeekday(todayYmd, sw, false), 7), text: m[0].trim(), statedWeekday: sw });
    t = blank(t, m.index!, m[0].length);
  }

  // 5. Weekday + day of month: "sábado 14", "el próximo lunes 16".
  for (const m of [...t.matchAll(new RegExp(`\\b${WD_RE},?\\s+(?:el\\s+|dia\\s+)?(\\d{1,2})\\b${NOT_A_DATE_TAIL}`, "g"))]) {
    const sw = wdIndex(m[1]!);
    const dom = Number(m[2]);
    const cands = domCandidates(todayYmd, dom);
    if (cands.length === 0) continue;
    const horizon = dom <= 12 ? 21 : 45;
    const match = cands.find((c) => weekdayOfYmd(c) === sw && daysBetween(todayYmd, c) <= horizon);
    if (match) {
      out.push({ kind: "dom", ymd: match, text: m[0].trim(), statedWeekday: sw });
      t = blank(t, m.index!, m[0].length);
    } else if (dom >= 13) {
      // Calendar says otherwise: "sábado 17" when the 17th is a Tuesday.
      out.push({ kind: "dom", ymd: cands[0]!, text: m[0].trim(), statedWeekday: sw, weekdayMismatch: true });
      t = blank(t, m.index!, m[0].length);
    }
    // else: "sábado 10" is most likely 10 am — leave the weekday for step 8.
  }

  // 6. Bare day of the month: "el 16", "el día 16", "para el 21".
  for (const m of [...t.matchAll(new RegExp(`\\b(?:el\\s+(?:dia\\s+)?|dia\\s+)(\\d{1,2})\\b${NOT_A_DATE_TAIL}`, "g"))]) {
    const dom = Number(m[1]);
    const c = domCandidates(todayYmd, dom)[0];
    if (!c || daysBetween(todayYmd, c) > 45) continue;
    out.push({ kind: "dom", ymd: c, text: m[0].trim() });
    t = blank(t, m.index!, m[0].length);
  }

  // 7. "la próxima semana" with no day: the whole next week.
  for (const m of [...t.matchAll(new RegExp(NEXT_WEEK, "g"))]) {
    out.push({ kind: "week", ymd: nextMonday, text: m[0].trim() });
    t = blank(t, m.index!, m[0].length);
  }

  // 8. Relative words and bare weekdays.
  const saysToday = /\bhoy\b(?!\s+en\s+dia)/.test(t);
  for (const m of [...t.matchAll(/\bpasado\s+manana\b/g)]) {
    out.push({ kind: "day_after", ymd: addDaysYmd(todayYmd, 2), text: m[0] });
    t = blank(t, m.index!, m[0].length);
  }
  const noMorning = t.replace(/\b(?:de|por|en|la|las|esta|cada)\s+(?:la\s+)?manana(s)?\b/g, (s) => " ".repeat(s.length));
  for (const m of [...noMorning.matchAll(/\bmanana\b/g)]) {
    out.push({ kind: "tomorrow", ymd: addDaysYmd(todayYmd, 1), text: m[0] });
  }
  for (const m of [...t.matchAll(/\bhoy\b(?!\s+en\s+dia)/g)]) {
    out.push({ kind: "today", ymd: todayYmd, text: m[0] });
  }
  // Plural / habitual ("los sábados", "entre semana") is a preference, not a date.
  for (const m of [...t.matchAll(new RegExp(`(\\blos\\s+)?\\b${WD_RE}(s?)\\b`, "g"))]) {
    if (m[1] || m[3]) continue;
    const sw = wdIndex(m[2]!);
    out.push({ kind: "weekday", ymd: nearestWeekday(todayYmd, sw, saysToday), text: m[0].trim(), statedWeekday: sw });
  }
  return out;
}

/** Kinds that pin a specific day the nearest-weekday reading would get wrong. */
const STRONG: ReadonlySet<DateRefKind> = new Set(["dom", "day_month", "next_week", "after_next"]);

export type StatedDate =
  | { kind: "date"; ymd: string; text: string }
  | { kind: "week"; start: string; end: string; text: string }
  | { kind: "mismatch"; text: string; ymd: string; statedWeekday: number };

/**
 * The ONE specific date a message pins down, or null. Only "strong" references
 * count (a day of the month, "la próxima semana", "el otro sábado"): "hoy",
 * "mañana" and a bare weekday are resolved fine by the model. Two different
 * dates in the same text = ambiguous = null. Pure.
 */
export function statedDate(text: string, todayYmd: string): StatedDate | null {
  const refs = findDateRefs(text, todayYmd);
  const bad = refs.find((r) => r.weekdayMismatch);
  if (bad) return { kind: "mismatch", text: bad.text, ymd: bad.ymd, statedWeekday: bad.statedWeekday ?? -1 };
  // "el próximo sábado, 14/11": the bare weekday describes the same day as
  // the strong reference — it is not a second date.
  const strongWds = new Set(refs.filter((r) => STRONG.has(r.kind)).map((r) => weekdayOfYmd(r.ymd)));
  const dated = refs.filter(
    (r) => r.kind !== "week" && !(r.kind === "weekday" && strongWds.has(r.statedWeekday ?? -1)),
  );
  const ymds = new Set(dated.map((r) => r.ymd));
  const week = refs.find((r) => r.kind === "week");
  if (ymds.size > 1) return null;
  const strong = dated.find((r) => STRONG.has(r.kind));
  if (strong) {
    if (week && daysBetween(week.ymd, strong.ymd) >= 7) return null;
    return { kind: "date", ymd: strong.ymd, text: strong.text };
  }
  if (week && ymds.size === 0) {
    return { kind: "week", start: week.ymd, end: addDaysYmd(week.ymd, 6), text: week.text };
  }
  return null;
}

/** Messages shape the pipeline stores (subset). */
export interface DatedMessage {
  direction: string;
  body: string;
}

/**
 * The date the lead asked for in THIS turn: their trailing run of messages
 * (everything after our last outbound). When that run names no date at all
 * ("sí", "va, perfecto") and our message right before it pinned one ("Te
 * aparto el martes 17 a las 6 pm"), the lead accepted THAT date. Pure.
 */
export function leadRequestedDate(
  history: readonly DatedMessage[],
  todayYmd: string,
): (StatedDate & { source: "lead" | "accepted_offer" }) | null {
  let i = history.length - 1;
  const run: string[] = [];
  while (i >= 0 && history[i]!.direction === "in") {
    run.unshift(history[i]!.body);
    i--;
  }
  if (run.length === 0) return null;
  const leadText = run.join("\n");
  const own = statedDate(leadText, todayYmd);
  if (own) return { ...own, source: "lead" };
  if (findDateRefs(leadText, todayYmd).length > 0) return null; // "mañana" etc.: the model's call
  const prev = i >= 0 ? history[i]! : null;
  if (!prev || !prev.direction.startsWith("out")) return null;
  const offered = statedDate(prev.body, todayYmd);
  if (offered && offered.kind === "date") return { ...offered, source: "accepted_offer" };
  return null;
}

/** "sábado 14 de noviembre" — the unambiguous way to say a date. */
export function longDateEs(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return `${WEEKDAY_NAMES_ES[weekdayOfYmd(ymd)]} ${p.d} de ${MONTHS_ES[p.m - 1]}`;
}

/**
 * Pure. "calendario: hoy mié 11 nov · jue 12 · vie 13 · … · mar 24": the next
 * `days` dates with their weekday, so the model never does weekday arithmetic.
 */
export function calendarLine(todayYmd: string, days = 14): string {
  const parts: string[] = [];
  for (let k = 0; k < days; k++) {
    const ymd = addDaysYmd(todayYmd, k);
    const p = parseYmd(ymd)!;
    const wd = WEEKDAY_SHORT_ES[weekdayOfYmd(ymd)];
    const mon = k === 0 || p.d === 1 ? ` ${MONTH_SHORT_ES[p.m - 1]}` : "";
    parts.push(`${k === 0 ? "hoy " : ""}${wd} ${p.d}${mon}`);
  }
  return `calendario (próximos ${days} días): ${parts.join(" · ")}`;
}

/**
 * Pure. The <context> line for the date the lead pinned, or null. Tells the
 * model which date that is (and that it is NOT the nearest such weekday), or —
 * when the lead's weekday and day of the month disagree — to ask first.
 */
export function statedDateLine(
  history: readonly DatedMessage[],
  todayYmd: string,
  /** The band's trial options on that date; null = closed / special holiday. */
  optionsFor?: (ymd: string) => string[] | null,
): string | null {
  const s = leadRequestedDate(history, todayYmd);
  if (!s) return null;
  if (s.kind === "mismatch") {
    const p = parseYmd(s.ymd)!;
    const sw = s.statedWeekday;
    const alt = sw >= 0 ? nearestWeekdaysAround(s.ymd, sw).filter((a) => a >= todayYmd) : [];
    return `OJO fecha: el lead escribió «${s.text}», pero el ${p.d} de ${MONTHS_ES[p.m - 1]} es ${WEEKDAY_NAMES_ES[weekdayOfYmd(s.ymd)]}${
      alt.length ? ` (${WEEKDAY_NAMES_ES[sw]} cercano: ${alt.map((a) => parseYmd(a)!.d).join(" o ")})` : ""
    }. NO agendes ni confirmes: pregúntale en una línea cuál fecha quiere.`;
  }
  if (s.kind === "week") {
    return `fecha que pidió el lead: «${s.text}» = semana del ${longDateEs(s.start)} al ${longDateEs(s.end)}. Ofrece y agenda SOLO días de esa semana (no de esta).`;
  }
  const opts = optionsFor ? optionsFor(s.ymd) : [];
  const who = s.source === "lead" ? "el lead pidió" : "el lead aceptó lo que le ofrecimos";
  const tail =
    opts === null
      ? " Ese día está cerrado o con horario especial (ver arriba): no lo agendes; ofrece el día con clase más cercano a esa fecha."
      : opts.length
        ? ` Opciones de su grupo ese día: ${opts.join(", ")}.`
        : optionsFor
          ? " Ese día NO hay clase de su grupo: díselo en positivo y ofrece el día con clase más cercano a esa fecha."
          : "";
  return `fecha que ${who}: «${s.text}» = ${longDateEs(s.ymd)} (${s.ymd}). Ésa es la fecha: agenda trial_date ${s.ymd} y en la confirmación escribe «${WEEKDAY_NAMES_ES[weekdayOfYmd(s.ymd)]} ${parseYmd(s.ymd)!.d}» — nunca «hoy»/«mañana» ni el ${WEEKDAY_NAMES_ES[weekdayOfYmd(s.ymd)]} más próximo si no es esa fecha.${tail}`;
}

function nearestWeekdayTo(ymd: string, wd: number): string {
  return addDaysYmd(ymd, (wd - weekdayOfYmd(ymd) + 7) % 7);
}

/** The `wd` weekdays right before and right after `ymd`. */
function nearestWeekdaysAround(ymd: string, wd: number): string[] {
  const after = nearestWeekdayTo(ymd, wd);
  const before = addDaysYmd(after, -7);
  return [before, after];
}

// ---- confirmation checks ----------------------------------------------------

/**
 * Pure. Problems with the dates a booking CONFIRMATION states, compared with
 * the booked record(s). Each entry is a short Spanish note for the approver.
 *  - a weekday + day of the month that disagree with the calendar;
 *  - "hoy" / "mañana" / a day of the month / "la próxima semana el X" that is
 *    not a booked date;
 *  - a bare weekday that is not the weekday of any booking, or whose nearest
 *    occurrence is not the booked date (booked Sat 14, written on Thu 5
 *    "el sábado" — the lead reads Sat 7);
 *  - (requireDay) a class 2+ days out with no day stated at all.
 */
export function confirmationDateIssues(
  text: string,
  bookedYmds: readonly string[],
  todayYmd: string,
  opts: { requireDay?: boolean } = {},
): string[] {
  const booked = [...new Set(bookedYmds.filter((d) => parseYmd(d)))];
  if (booked.length === 0) return [];
  const all = findDateRefs(text, todayYmd);
  const strongWds = new Set(all.filter((r) => STRONG.has(r.kind) && !r.weekdayMismatch).map((r) => weekdayOfYmd(r.ymd)));
  const refs = all.filter((r) => !(r.kind === "weekday" && strongWds.has(r.statedWeekday ?? -1)));
  const issues: string[] = [];
  const bookedTxt = booked.map(longDateEs).join(" / ");
  for (const r of refs) {
    if (r.kind === "week") continue;
    if (r.weekdayMismatch) {
      const p = parseYmd(r.ymd)!;
      issues.push(`dice «${r.text}», pero el ${p.d} es ${WEEKDAY_NAMES_ES[weekdayOfYmd(r.ymd)]}; la reserva es para el ${bookedTxt}.`);
      continue;
    }
    if (booked.includes(r.ymd)) continue;
    if (r.kind === "weekday" && booked.some((b) => weekdayOfYmd(b) === r.statedWeekday && daysBetween(r.ymd, b) % 7 === 0)) {
      // Same weekday, a later week: "el sábado" read as the nearest one.
      issues.push(`dice «${r.text}» sin el número de día — el lead lo leerá como el ${longDateEs(r.ymd)}, pero la reserva es para el ${bookedTxt}.`);
      continue;
    }
    issues.push(`dice «${r.text}» (= ${longDateEs(r.ymd)}), pero la reserva es para el ${bookedTxt}.`);
  }
  if (opts.requireDay && issues.length === 0) {
    const far = booked.filter((b) => daysBetween(todayYmd, b) >= 2);
    const named = refs.filter((r) => r.kind !== "week");
    if (far.length > 0 && named.length === 0) {
      issues.push(`no dice qué día es la clase (reserva: ${bookedTxt}).`);
    }
  }
  return [...new Set(issues)];
}

const WD_ORIG = [
  "lunes", "martes", "mi[ée]rcoles", "jueves", "viernes", "s[áa]bado", "domingo",
];

/**
 * Pure. For a class 2+ days out, write the day of the month after its weekday
 * ("el sábado a las 2 pm" → "el sábado 14 a las 2 pm") — the first mention
 * only, and only when that weekday is not already followed by a number. Text
 * that never names the weekday is returned unchanged.
 */
export function withDayOfMonth(text: string, bookedYmd: string, todayYmd: string): string {
  const p = parseYmd(bookedYmd);
  if (!p) return text;
  const ahead = daysBetween(todayYmd, bookedYmd);
  if (!(ahead >= 2 && ahead <= 60)) return text;
  const wd = weekdayOfYmd(bookedYmd);
  const re = new RegExp(`(^|[^\\p{L}])(${WD_ORIG[wd]})(?![\\p{L}])(?!\\s*,?\\s*(?:\\d|de\\s+la\\s+(?:pr[óo]xima|siguiente|otra)\\s+semana))`, "iu");
  const m = re.exec(text);
  if (!m) return text;
  const at = m.index + m[1]!.length + m[2]!.length;
  return `${text.slice(0, at)} ${p.d}${text.slice(at)}`;
}
