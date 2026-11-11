// What the CONVERSATION says, read at nudge time (2026-11-11 quality review).
//
// The drip used to pick its copy and its slot from the campaign default and a
// qualification that the brain rarely fills (discipline is stamped from the ad
// text and never updated). Graded review of 475 conversations: "nudges that
// ignore the conversation" was the single most frequent defect (84 / 315) —
// the lead said "Box" and got MMA, said "Adultos" and got "tu peque", said
// "solo fines de semana" / "por las tardes" / "la próxima semana" / "salgo
// hasta las 9 pm" and got a weekday / 7 am / today / 8 pm.
//
// This module reads the lead's own recent messages (the nudge already loads
// the last 7 days, idx_messages_phone_ts) and returns the facts that must
// shape an unsolicited message: discipline, adult/teen, time-of-day window,
// preferred / declined weekdays, dates that don't work, a defer-until date, a
// soft deferral ("más adelante", "les aviso", "estoy de viaje"), and whether
// our own last message already proposed a concrete time. Pure: no D1, clock
// passed in, CDMX wall time. Deliberately conservative — a fact that is not
// clearly stated stays null and the nudge behaves as before.

import { normalizeText } from "../pipeline/campaigns.js";
import { detectDeferral } from "../pipeline/decline.js";
import { adultSelfSignal, programSignalFromText } from "../services/program-signal.js";
import { cdmxParts, cdmxToEpoch, DAY } from "./time.js";
import { weekdayIndex } from "../brain/tools.js";

export interface ConvoMessage {
  direction: string;
  body: string | null;
  ts: number;
}

/** Allowed class start times, minutes after CDMX midnight, [from, to). */
export type MinuteRange = readonly [number, number];

export interface ConvoFacts {
  /** Service key ("muay" | "jiu" | "mma" | "box") the lead named LAST, or null. */
  discipline: string | null;
  /** The lead said the class is for an adult / themselves (after any child signal). */
  adultSelf: boolean;
  /** The lead talked about a teenager. */
  teen: boolean;
  /** Allowed start-time ranges from the lead's latest time-of-day statement. */
  timeRanges: MinuteRange[] | null;
  /** Weekdays (0=Mon … 6=Sun) from the lead's latest day preference, or null. */
  preferredWeekdays: number[] | null;
  /** Weekdays the lead said don't work. */
  declinedWeekdays: number[];
  /** CDMX dates ("YYYY-MM-DD") the lead said don't work ("hoy no puedo"). */
  excludeDates: string[];
  /** The lead deferred to a later period: nothing before this epoch. */
  deferUntil: number | null;
  /** A soft deferral in the lead's LAST burst ("más adelante", "les aviso"). */
  softDeferral: { ts: number; text: string } | null;
  /** Our latest outbound (< 24h old, after the lead's last message) named a clock time. */
  botOfferedSlot: boolean;
}

export const EMPTY_FACTS: ConvoFacts = Object.freeze({
  discipline: null,
  adultSelf: false,
  teen: false,
  timeRanges: null,
  preferredWeekdays: null,
  declinedWeekdays: [],
  excludeDates: [],
  deferUntil: null,
  softDeferral: null,
  botOfferedSlot: false,
}) as ConvoFacts;

// ---- discipline -------------------------------------------------------------

const DISC: readonly [string, RegExp][] = [
  ["muay", /\bmuay\b|\bthai\b/],
  ["jiu", /\bjiu\b|\bbjj\b|jitsu|\bjiujitsu\b/],
  ["mma", /\bmma\b|\bartes marciales mixtas\b/],
  ["box", /\bbox(?:eo|ing)?\b/],
];
const DISC_WORDS = "(?:muay thai|muay|thai|jiu jitsu|jiujitsu|jiu|jitsu|bjj|mma|box|boxeo|boxing)";
/** "más que en MMA", "en vez de box", "no quiero mma", "ni box" — not the choice. */
const DISC_NEGATED = new RegExp(
  `\\b(?:mas que(?: en)?|en vez de|en lugar de|no (?:quiero|me interesa|me late)|ni)(?: el| la| de)? ${DISC_WORDS}\\b`,
  "g",
);

/** Pure. The ONE discipline a lead message names (negated mentions removed), or null. */
export function disciplineInText(text: string | null | undefined): string | null {
  const n = normalizeText(text ?? "").replace(DISC_NEGATED, " ");
  if (!n) return null;
  const hits = DISC.filter(([, re]) => re.test(n)).map(([k]) => k);
  return hits.length === 1 ? hits[0]! : null;
}

// ---- adult / teen -----------------------------------------------------------

/** A message that is just "adultos" / "para mí" / "yo" (an answer to "¿para quién es?"). */
const ADULT_ANSWER_RE =
  /^(?:(?:es|son|seria|sería) )?(?:para )?(?:mi|yo|adult[oa]s?|un adulto|una adulta|mi mism[oa]|soy adult[oa]|soy mayor de edad|mayor de edad|clases? de adultos|el de adultos|la de adultos)(?: gracias)?$/;

/** Pure. The lead says the class is for an adult (themselves). */
export function adultInText(text: string | null | undefined): boolean {
  if (adultSelfSignal(text)) return true;
  return ADULT_ANSWER_RE.test(normalizeText(text ?? ""));
}

const TEEN_RE = /\badolescentes?\b|\bteens?\b|\bpuberto\b|\bsecundaria\b|\bprepa\b/;

// ---- time of day ------------------------------------------------------------

const H = 60;
const MORNING: MinuteRange = [0, 12 * H];
const AFTERNOON: MinuteRange = [12 * H, 20 * H];
const EVENING: MinuteRange = [18 * H, 24 * H];
const NOT_MORNING: MinuteRange = [12 * H, 24 * H];

/** "6" → 18:00 unless am; "9 pm" → 21:00. `pmBias` hours (1–`pmBelow`) are read as pm. */
function clockMinutes(h: number, m: number, suffix: string | undefined, pmBelow: number): number {
  let hh = h;
  if (suffix === "pm" && hh < 12) hh += 12;
  else if (suffix === "am" && hh === 12) hh = 0;
  else if (!suffix && hh >= 1 && hh < pmBelow) hh += 12;
  return hh * H + m;
}

const CLOCK = "(\\d{1,2})(?: (\\d{2}))? ?(am|pm|a m|p m|hrs|de la noche|de la tarde|de la manana)?";
function suffixOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw === "am" || raw === "a m" || raw === "de la manana") return "am";
  if (raw === "hrs") return undefined;
  return "pm";
}

const LEAVE_RE = new RegExp(
  `\\b(?:salgo|salimos|sale|termino|terminamos|me desocupo|me libero|llego a casa|estoy libre)(?: de (?:trabajar|la oficina|la escuela|clases|chambear)| del trabajo)? (?:a|hasta) las ${CLOCK}`,
);
const AFTER_RE = new RegExp(`\\b(?:despues|a partir) de las ${CLOCK}`);
const BEFORE_RE = new RegExp(`\\bantes de las ${CLOCK}`);

/**
 * Pure. Allowed start-time ranges a lead message states, or null when it
 * states none. Negations first ("en la mañana no puedo", "estudio en las
 * mañanas" → after noon), then explicit clock limits ("salgo hasta las 9 pm"
 * → from 9:30 pm), then the plain parts of the day.
 */
export function timeRangesInText(text: string | null | undefined): MinuteRange[] | null {
  const n = normalizeText(text ?? "");
  if (!n) return null;
  const leave = LEAVE_RE.exec(n);
  if (leave) {
    const from = clockMinutes(Number(leave[1]), Number(leave[2] ?? 0), suffixOf(leave[3]), 11) + 30;
    return [[Math.min(from, 24 * H), 24 * H]];
  }
  const after = AFTER_RE.exec(n);
  if (after) return [[clockMinutes(Number(after[1]), Number(after[2] ?? 0), suffixOf(after[3]), 9), 24 * H]];
  const before = BEFORE_RE.exec(n);
  if (before) return [[0, clockMinutes(Number(before[1]), Number(before[2] ?? 0), suffixOf(before[3]), 7)]];

  const morningNo =
    /\b(?:las? )?mananas? no\b|\btemprano no\b|\bno (?:puedo |me queda |me late |me acomoda )?(?:en |por )?(?:las? )?mananas?\b|\bno (?:puedo )?temprano\b|\b(?:estudio|trabajo|chambeo|ocupad[oa]s?|estoy ocupad[oa]) (?:en |por )?las? mananas?\b/;
  if (morningNo.test(n)) return [NOT_MORNING];
  const afternoonNo = /\b(?:estudio|trabajo|chambeo) (?:en |por )?las? tardes?\b|\b(?:las? )?tardes? no\b/;
  if (afternoonNo.test(n)) return [MORNING, [20 * H, 24 * H]];

  const out: MinuteRange[] = [];
  if (/\b(?:en|por|de) las? mananas?\b|\bmananas\b|\btemprano\b|\bmatutin[oa]s?\b/.test(n)) out.push(MORNING);
  if (/\b(?:en|por|de) las? tardes?\b|\btardes\b/.test(n)) out.push(AFTERNOON);
  if (/\b(?:en|por|de) las? noches?\b|\bnoches\b|\btarde noche\b|\bdespues del? (?:trabajo|chamba|oficina|jale)\b/.test(n)) {
    out.push(EVENING);
  }
  return out.length ? out : null;
}

/** Pure. Does a CDMX clock time "HH:mm" fall in any range? */
export function inTimeRanges(time: string, ranges: readonly MinuteRange[]): boolean {
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!m) return true;
  const t = Number(m[1]) * H + Number(m[2]);
  return ranges.some(([a, b]) => t >= a && t < b);
}

// ---- weekdays / dates -------------------------------------------------------

const DAY_NAMES: readonly [RegExp, number][] = [
  [/\blunes\b/, 0],
  [/\bmartes\b/, 1],
  [/\bmiercoles\b/, 2],
  [/\bjueves\b/, 3],
  [/\bviernes\b/, 4],
  [/\bsabados?\b/, 5],
  [/\bdomingos?\b/, 6],
];

export interface DayStatement {
  preferred: number[] | null;
  declined: number[];
}

/**
 * Pure. Weekday preference in a lead message. "solo fines de semana" / "entre
 * semana no" → Sat+Sun preferred; "entre semana" → Mon–Fri; a day name is a
 * preference unless negated ("el lunes no puedo", "no puedo el martes").
 */
export function daysInText(text: string | null | undefined): DayStatement {
  const n = normalizeText(text ?? "");
  const out: DayStatement = { preferred: null, declined: [] };
  if (!n) return out;
  const pref = new Set<number>();
  if (/\bentre semana no\b|\bno (?:puedo |me queda )?entre semana\b|\bfin(?:es)? de semana\b|\bweekends?\b/.test(n)) {
    pref.add(5).add(6);
    if (/\bentre semana no\b|\bno (?:puedo |me queda )?entre semana\b/.test(n)) out.declined.push(0, 1, 2, 3, 4);
  } else if (/\bentre semana\b/.test(n)) {
    [0, 1, 2, 3, 4].forEach((d) => pref.add(d));
  }
  for (const [re, d] of DAY_NAMES) {
    const m = re.exec(n);
    if (!m) continue;
    const before = n.slice(Math.max(0, m.index - 24), m.index);
    const after = n.slice(m.index + m[0].length, m.index + m[0].length + 14);
    const negated = /\bno (?:puedo |me queda |me late |podria |podemos )?(?:el |los |en )?$/.test(before) || /^ (?:no|tampoco|imposible)\b/.test(after);
    if (negated) out.declined.push(d);
    else pref.add(d);
  }
  if (pref.size) out.preferred = [...pref].sort((a, b) => a - b);
  return out;
}

/** The message without its question clauses ("¿cierran en diciembre?" defers nothing). */
export function statementText(body: string): string {
  return body
    .split(/[.!;\n…]+/)
    .filter((c) => !/[?¿]/.test(c))
    .join(". ");
}

function ymd(epoch: number): string {
  const p = cdmxParts(epoch);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Pure. Dates a lead message rules out, relative to the message's own CDMX day. */
export function excludedDatesInText(text: string | null | undefined, msgTs: number): string[] {
  const n = normalizeText(text ?? "");
  if (!n) return [];
  const out: string[] = [];
  if (/\bhoy (?:no|tengo|trabajo|estoy|imposible|me es imposible|ando|salgo tarde)\b|\bno (?:puedo|podre|podemos|alcanzo|llego) hoy\b|\bhoy ya no\b/.test(n)) {
    out.push(ymd(msgTs));
  }
  // "mañana no puedo" — but "en la mañana no puedo" is a time-of-day statement.
  if (/(?:^|[^a-z])(?<!la |las |por la |en la )manana (?:no|tengo|trabajo|imposible)\b|\bno (?:puedo|podre|podemos) manana\b/.test(n)) {
    out.push(ymd(msgTs + DAY));
  }
  return out;
}

// ---- deferral dates ---------------------------------------------------------

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function startOfCdmxDay(epoch: number): number {
  const p = cdmxParts(epoch);
  return cdmxToEpoch(p.year, p.month, p.day, 0, 0, 0);
}

/**
 * Pure. The epoch (CDMX midnight) before which nothing should be proposed,
 * when the lead message defers to a later period: "la próxima semana" → next
 * Monday; "el otro mes" → the 1st; "regreso el 20" / "a partir del 20" → the
 * 20th; "en un mes" / "en dos semanas"; "en enero" / "el año que entra".
 * null when the message states none.
 */
export function deferUntilInText(text: string | null | undefined, msgTs: number): number | null {
  const n = normalizeText(text ?? "");
  if (!n) return null;
  const p = cdmxParts(msgTs);
  const today = startOfCdmxDay(msgTs);
  const wd = weekdayIndex(ymd(msgTs)) ?? 0;
  if (/\b(?:la |esta )?(?:proxima|siguiente|otra) semana\b|\bsemana que entra\b|\bnext week\b/.test(n)) {
    return today + (7 - wd) * DAY;
  }
  if (/\b(?:el |al )?(?:proximo|siguiente|otro) mes\b|\bmes que entra\b|\bnext month\b/.test(n)) {
    return cdmxToEpoch(p.year, p.month + 1, 1, 0, 0, 0);
  }
  if (/\b(?:el |al )?(?:proximo|siguiente) ano\b|\bano que entra\b|\bnext year\b/.test(n)) {
    return cdmxToEpoch(p.year + 1, 1, 1, 0, 0, 0);
  }
  const rel = /\ben (?:un|una|1) (mes|semana|quincena)\b|\ben (dos|2|tres|3) semanas\b|\ben un par de semanas\b/.exec(n);
  if (rel) {
    if (rel[1] === "mes") return today + 30 * DAY;
    if (rel[1] === "semana") return today + 7 * DAY;
    if (rel[1] === "quincena") return today + 15 * DAY;
    const k = rel[2] === "tres" || rel[2] === "3" ? 3 : 2;
    return today + k * 7 * DAY;
  }
  const dom =
    /\b(?:regreso|regresamos|regresando|vuelvo|volvemos|llego|llegamos|estoy de vuelta|estamos de vuelta)(?: (?:de|del) (?:viaje|vacaciones))?(?: hasta)? (?:el|el dia|hasta el) (\d{1,2})\b|\ba partir del (?:dia )?(\d{1,2})\b|\bdespues del (?:dia )?(\d{1,2})\b/.exec(n);
  if (dom) {
    const d = Number(dom[1] ?? dom[2] ?? dom[3]);
    if (d >= 1 && d <= 31) {
      let at = cdmxToEpoch(p.year, p.month, d, 0, 0, 0);
      if (d < p.day) at = cdmxToEpoch(p.year, p.month + 1, d, 0, 0, 0);
      return at > today ? at : null;
    }
  }
  const mon = new RegExp(`\\b(?:en|hasta|para|a partir de|despues de|desde) (${MONTHS.join("|")})\\b`).exec(n);
  if (mon) {
    const idx = MONTHS.indexOf(mon[1]!) + 1;
    if (idx !== p.month) {
      const year = idx < p.month ? p.year + 1 : p.year;
      return cdmxToEpoch(year, idx, 1, 0, 0, 0);
    }
  }
  return null;
}

// ---- our own last offer -------------------------------------------------------

/** "7 am", "6:00 pm", "a las 4", "13:00" — a concrete clock time in our text. */
const CLOCK_IN_TEXT_RE = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.\s?m\.|p\.\s?m\.)|\ba las? \d{1,2}(?::\d{2})?\b|\b\d{1,2}:\d{2}\b/i;

/** Pure. Our message proposes a concrete time. */
export function namesClockTime(body: string | null | undefined): boolean {
  return CLOCK_IN_TEXT_RE.test(body ?? "");
}

// ---- assembly -----------------------------------------------------------------

/** How long a bot offer keeps the nudge from proposing a different one. */
export const BOT_OFFER_WINDOW_SECONDS = 24 * 3600;

/**
 * The lead's LAST burst: the inbound messages after our latest outbound that
 * precedes the newest inbound (the whole thread if we never wrote first).
 */
export function lastInboundBurst(msgs: readonly ConvoMessage[]): ConvoMessage[] {
  const sorted = [...msgs].sort((a, b) => a.ts - b.ts);
  let lastIn = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.direction === "in") {
      lastIn = i;
      break;
    }
  }
  if (lastIn < 0) return [];
  let start = 0;
  for (let i = lastIn; i >= 0; i--) {
    if (sorted[i]!.direction !== "in") {
      start = i + 1;
      break;
    }
  }
  return sorted.slice(start, lastIn + 1);
}

/**
 * Pure. The facts of a conversation (any order; inbound read chronologically,
 * the latest statement of each kind wins). `now` drops a defer date that has
 * already passed.
 */
export function conversationFacts(msgs: readonly ConvoMessage[], now: number): ConvoFacts {
  const sorted = [...msgs].sort((a, b) => a.ts - b.ts);
  const facts: ConvoFacts = { ...EMPTY_FACTS, declinedWeekdays: [], excludeDates: [] };
  let lastAdultTs = -1;
  let lastChildTs = -1;
  const declined = new Set<number>();
  const excluded = new Set<string>();
  for (const m of sorted) {
    if (m.direction !== "in") continue;
    const body = m.body ?? "";
    if (!body.trim()) continue;
    const d = disciplineInText(body);
    if (d) facts.discipline = d;
    if (adultInText(body)) lastAdultTs = m.ts;
    if (programSignalFromText(body)) lastChildTs = m.ts;
    if (TEEN_RE.test(normalizeText(body))) facts.teen = true;
    const t = timeRangesInText(body);
    if (t) facts.timeRanges = t;
    const days = daysInText(body);
    if (days.preferred) facts.preferredWeekdays = days.preferred;
    for (const x of days.declined) declined.add(x);
    const stated = statementText(body);
    for (const x of excludedDatesInText(stated, m.ts)) excluded.add(x);
    const until = deferUntilInText(stated, m.ts);
    if (until !== null) facts.deferUntil = until;
  }
  facts.adultSelf = lastAdultTs >= 0 && lastAdultTs >= lastChildTs;
  if (facts.preferredWeekdays) facts.preferredWeekdays = facts.preferredWeekdays.filter((d) => !declined.has(d));
  if (facts.preferredWeekdays?.length === 0) facts.preferredWeekdays = null;
  facts.declinedWeekdays = [...declined].sort((a, b) => a - b);
  const today = ymd(now);
  facts.excludeDates = [...excluded].filter((x) => x >= today).sort();
  if (facts.deferUntil !== null && facts.deferUntil <= now) facts.deferUntil = null;

  const burst = lastInboundBurst(sorted);
  for (const m of burst) {
    if (detectDeferral(m.body ?? "")) facts.softDeferral = { ts: m.ts, text: (m.body ?? "").slice(0, 160) };
  }

  // Our latest outbound, if it came after the lead's last message and still
  // names a time: the nudge must not contradict it with another slot.
  const lastInTs = burst.length ? burst[burst.length - 1]!.ts : -1;
  const lastOut = [...sorted].reverse().find((m) => m.direction !== "in");
  facts.botOfferedSlot =
    !!lastOut && lastOut.ts > lastInTs && now - lastOut.ts < BOT_OFFER_WINDOW_SECONDS && namesClockTime(lastOut.body) &&
    !/^\[template:/.test(lastOut.body ?? "") && !isOwnNudge(lastOut.body);
  return facts;
}

/** Our own drip copy (it names a time too, but it is not a negotiated offer). */
function isOwnNudge(body: string | null | undefined): boolean {
  return /todav[ií]a no has agendado|Te puedo apartar lugar en|Les puedo apartar lugar en|I can save (?:you a|their) spot/.test(body ?? "");
}
