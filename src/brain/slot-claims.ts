// Every "(día) (hora)" a reply names, checked against the real grid for the
// lead's AGE BAND (2026-10-11). Pure — unit-tested with fixed clocks.
//
// Why: guardUnverifiedSlotClaim's pairing tier only reads copy with ONE day and
// ONE hour, so multi-offer replies went unchecked — and the audit's worst
// slot errors were exactly there: "el lunes a la 1:15 pm" re-offered four
// times to a Mini Muay Thai parent (Mini runs lun/mié 3:15 pm, sáb 1:15 pm),
// "No hay Kids el sábado" (there are two), Sunday-morning classes. Here each
// hour is paired with the nearest day named before it in the same sentence
// (or right after it), and a pair is only judged when that day is explicit —
// a weekday name, or "hoy"/"mañana" resolved from the <context> clock. Copy
// with no day stays untouched (low false positives over full coverage).

import { SLOTS, type Slot } from "./slots.gen.js";
import { CLIENT } from "../client.gen.js";
import { bandLabel, slotMatchesBand, type ProgramBand } from "../services/age-band.js";

const WEEKDAY_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;

/** Lowercase + strip accents WITHOUT changing string length (positions stay valid). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[áàä]/g, "a")
    .replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u")
    .replace(/ñ/g, "n");
}

const DAY_TOKEN_RE =
  /\b(hoy|pasado\s+manana|manana|lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/g;
const DAY_INDEX: Record<string, number> = {
  lunes: 0, martes: 1, miercoles: 2, jueves: 3, viernes: 4, sabado: 5, sabados: 5, domingo: 6, domingos: 6,
};

interface DayTok {
  at: number;
  end: number;
  weekday: number;
}

interface TimeTok {
  at: number;
  end: number;
  /** Candidate "HH:mm" readings (a bare "a las 4" may be 04:00 or 16:00). */
  times: string[];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function meridiem(h: number, m: string | undefined): number {
  if (!m) return h;
  if (/p/.test(m)) return h === 12 ? 12 : h + 12;
  return h === 12 ? 0 : h;
}

function dayTokens(t: string, todayWd: number): DayTok[] {
  const out: DayTok[] = [];
  for (const m of t.matchAll(DAY_TOKEN_RE)) {
    const w = m[1]!;
    const at = m.index ?? 0;
    let wd: number | undefined;
    if (w === "hoy") wd = todayWd;
    else if (/^pasado/.test(w)) wd = (todayWd + 2) % 7;
    else if (w === "manana") {
      // "en/de/por la mañana" is a time of day, not tomorrow.
      if (/\b(?:la|las)\s+$/.test(t.slice(Math.max(0, at - 6), at))) continue;
      wd = (todayWd + 1) % 7;
    } else wd = DAY_INDEX[w];
    if (wd !== undefined) out.push({ at, end: at + m[0].length, weekday: wd });
  }
  return out;
}

const MER = "(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)";

function timeTokens(t: string): TimeTok[] {
  const out: TimeTok[] = [];
  const taken = (a: number, b: number) => out.some((x) => a < x.end && b > x.at);
  // "7 u 8 am" — one meridiem covering a run of hours.
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})((?:\\s*(?:,|u|o|y)\\s*\\d{1,2})+)\\s*${MER}(?![a-z])`, "g"))) {
    const at = m.index ?? 0;
    for (const h of m[0].matchAll(/\d{1,2}/g)) {
      const raw = Number(h[0]);
      const hAt = at + (h.index ?? 0);
      if (raw >= 1 && raw <= 12) out.push({ at: hAt, end: hAt + h[0].length, times: [`${pad2(meridiem(raw, m[3]))}:00`] });
    }
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*${MER}?`, "g"))) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (taken(at, end)) continue;
    const raw = Number(m[1]);
    const min = Number(m[2]);
    if (raw > 23 || min > 59) continue;
    if (m[3] || raw > 12) {
      const h = m[3] && raw <= 12 ? meridiem(raw, m[3]) : raw;
      out.push({ at, end, times: [`${pad2(h % 24)}:${pad2(min)}`] });
    } else {
      out.push({ at, end, times: [`${pad2(raw)}:${pad2(min)}`, `${pad2(raw + 12)}:${pad2(min)}`] });
    }
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s*${MER}(?![a-z])`, "g"))) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (taken(at, end)) continue;
    const raw = Number(m[1]);
    if (raw >= 1 && raw <= 12) out.push({ at, end, times: [`${pad2(meridiem(raw, m[2]))}:00`] });
  }
  for (const m of t.matchAll(/\ba\s+las?\s+(\d{1,2})(?![\d:])(?!\s*(?:a\.?\s?m|p\.?\s?m|hrs?|horas?\b|min))/g)) {
    const numAt = (m.index ?? 0) + m[0].length - m[1]!.length;
    const end = numAt + m[1]!.length;
    if (taken(numAt, end)) continue;
    const raw = Number(m[1]);
    if (raw >= 1 && raw <= 11) out.push({ at: numAt, end, times: [`${pad2(raw)}:00`, `${pad2(raw + 12)}:00`] });
    else if (raw === 12 || (raw >= 13 && raw <= 23)) out.push({ at: numAt, end, times: [`${pad2(raw)}:00`] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Sentence boundaries: newline, ?/!/¿/¡, or a period followed by a space. */
function sentenceBounds(t: string, at: number): [number, number] {
  const isBreak = (i: number) => {
    const c = t[i];
    if (c === "\n" || c === "?" || c === "!" || c === "¿" || c === "¡") return true;
    return c === "." && /\s/.test(t[i + 1] ?? "") && !/[ap]\.?\s?m$/.test(t.slice(Math.max(0, i - 5), i));
  };
  let a = at;
  while (a > 0 && !isBreak(a - 1)) a--;
  let b = at;
  while (b < t.length && !isBreak(b)) b++;
  return [a, b];
}

function disciplinesIn(seg: string): string[] {
  const out: string[] = [];
  if (/baby\s*fight|\bbfc\b/.test(seg)) out.push("baby");
  for (const svc of CLIENT.services) {
    if (svc.match && new RegExp(svc.match).test(seg) && !out.includes(svc.key)) out.push(svc.key);
  }
  return out;
}

function groupHint(seg: string): ProgramBand | null {
  if (/\bmini\b/.test(seg)) return "mini";
  if (/baby\s*fight|\bbfc\b/.test(seg)) return "baby";
  if (/\bteens?\b/.test(seg)) return "teens";
  if (/\bkids?\b|\bninos?\b|infantil/.test(seg)) return "kids";
  if (/\badultos?\b/.test(seg)) return "adults";
  return null;
}

export interface SlotClaimIssue {
  /** 0=Mon … 6=Sun — absent for a week-wide claim ("cerramos a las 8 pm"). */
  weekday?: number;
  /** "HH:mm" as read (first candidate) — absent for a "no hay … el sábado" claim. */
  time?: string;
  band: ProgramBand | null;
  /** Approver-facing Spanish line incl. the real options. */
  note: string;
}

export interface SlotClaimOpts {
  /** The lead's band when we have real evidence (qualification / campaign); null = any group. */
  band: ProgramBand | null;
  /** The lead's discipline key (adults only constrain on it). */
  discipline: string | null;
  schedule?: readonly Slot[];
}

function rowsFor(
  schedule: readonly Slot[],
  weekday: number,
  band: ProgramBand | null,
): Slot[] {
  return schedule.filter(
    (s) => s.weekday === weekday && s.trial !== false && (band === null || slotMatchesBand(s, band)),
  );
}

function time12(hhmm: string): string {
  const [hs, ms] = hhmm.split(":");
  const h = Number(hs);
  return `${h % 12 === 0 ? 12 : h % 12}:${ms} ${h < 12 ? "am" : "pm"}`;
}

/** "4:00 pm Muay Thai, 5:00 pm Jiu-Jitsu" for a band's day. */
export function dayOptionsText(rows: readonly Slot[]): string {
  const seen: string[] = [];
  for (const s of rows.slice().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))) {
    const what = s.name ?? CLIENT.services.find((x) => x.key === s.discipline)?.label ?? s.discipline;
    const label = `${time12(s.time)} ${what}`;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(", ");
}

// ---- range / summary claims (2026-10-21) -----------------------------------
//
// The pairing tier below only judges ONE named day + ONE hour. The nightly
// auditor kept catching schedule SUMMARIES that name no single slot yet are
// false: "lunes a viernes mañana y tarde" (Friday has nothing after 10 am),
// "todos los días de lunes a domingo, en la mañana y en la tarde-noche",
// "el horario cierra a las 8 pm" (Box runs until 10 pm Tue/Thu), "las clases
// de adultos empiezan a las 6 pm" (from 7 am), "Teens el sábado". Every rule
// below reads the generated grid (slots.gen.ts) — nothing is hardcoded — and
// leans to precision: anything ambiguous (no am/pm on a span, an exception
// word like "solo"/"salvo", two ranges in one sentence) is left alone.

const DAY_WORD = "(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)";
const RANGE_RE = new RegExp(`\\b(?:de\\s+)?${DAY_WORD}\\s+(?:a|al)\\s+${DAY_WORD}\\b`, "g");
const ALL_WEEK_RE = /\b(?:todos\s+los\s+dias|toda\s+la\s+semana)\b/g;
/** Words that make a summary sentence carry its own exception — never judged. */
const EXCEPTION_RE = /\b(?:solo|solamente|salvo|excepto|menos|pero|aunque|sin\s+contar)\b/;
/** The sentence itself says the slot takes no trial — a correct warning, not an offer. */
const NO_TRIAL_RE = /sparring|sin\s+(?:clase\s+de\s+)?prueba|no\s+(?:acepta|aplica|admite|tiene)\s+(?:clase\s+de\s+)?prueba|no\s+se\s+puede\s+agendar/;

interface DayGroup {
  at: number;
  end: number;
  days: number[];
  /** A "lunes a viernes" / "todos los días" claim (vs one named day). */
  range: boolean;
}

function dayGroups(t: string, todayWd: number): DayGroup[] {
  const out: DayGroup[] = [];
  for (const m of t.matchAll(RANGE_RE)) {
    const a = DAY_INDEX[m[1]!];
    const b = DAY_INDEX[m[2]!];
    if (a === undefined || b === undefined || a === b) continue;
    const days: number[] = [];
    for (let d = a; ; d = (d + 1) % 7) {
      days.push(d);
      if (d === b) break;
    }
    const at = m.index ?? 0;
    out.push({ at, end: at + m[0].length, days, range: true });
  }
  for (const m of t.matchAll(ALL_WEEK_RE)) {
    const at = m.index ?? 0;
    out.push({ at, end: at + m[0].length, days: [0, 1, 2, 3, 4, 5, 6], range: true });
  }
  for (const d of dayTokens(t, todayWd)) {
    if (out.some((g) => g.range && d.at >= g.at && d.end <= g.end)) continue;
    out.push({ at: d.at, end: d.end, days: [d.weekday], range: false });
  }
  return out.sort((x, y) => x.at - y.at);
}

/** The day group a phrase at [at, end) talks about: nearest before it in the sentence, else right after. */
function groupFor(groups: DayGroup[], sa: number, sb: number, at: number, end: number): DayGroup | undefined {
  const before = groups.filter((g) => g.end <= at && g.at >= sa).pop();
  return before ?? groups.find((g) => g.at >= end && g.at <= Math.min(sb, end + 25));
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function hm12(min: number): string {
  return time12(`${pad2(Math.floor(min / 60) % 24)}:${pad2(min % 60)}`);
}

function clockMin(h: number, m: string | undefined, mer: string | undefined): number | null {
  if (mer) {
    if (h < 1 || h > 12) return null;
    h = meridiem(h, mer);
  }
  const mm = m === undefined ? 0 : Number(m);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** Every reading of a clock time in a claim ("a las 8" → 8:00 and 20:00), in minutes. */
function readings(h: number, m: string | undefined, mer: string | undefined): number[] {
  if (mer) {
    const v = clockMin(h, m, mer);
    return v === null ? [] : [v];
  }
  const v = clockMin(h, m, undefined);
  if (v === null) return [];
  return h >= 1 && h <= 11 ? [v, v + 12 * 60] : [v];
}

interface Span {
  at: number;
  end: number;
  /** null for an end-only "hasta las 10 pm". */
  from: number | null;
  to: number;
}

const HH = "(\\d{1,2})(?::(\\d{2}))?";

/**
 * "de 7 am a 9 pm", "desde las 7 am hasta las 9 pm", "(6-7 pm)", "hasta las
 * 10 pm". These name the edges of a schedule, not class start times, so the
 * pairing tier skips their hours (the KB's own canonical summary "desde las
 * 7 am hasta las 9 pm de lunes a jueves" used to be flagged as "lunes 9 pm
 * no existe"). A span with no am/pm at all is too ambiguous and is ignored.
 */
function spanTokens(t: string): Span[] {
  const out: Span[] = [];
  const overlaps = (a: number, b: number) => out.some((s) => a < s.end && b > s.at);
  const push = (at: number, len: number, h1: string, m1: string | undefined, r1: string | undefined, h2: string, m2: string | undefined, r2: string | undefined) => {
    if (!r1 && !r2) return;
    const a = Number(h1);
    const b = Number(h2);
    let from: number | null;
    let to: number | null;
    if (r1 && r2) {
      from = clockMin(a, m1, r1);
      to = clockMin(b, m2, r2);
    } else if (r2) {
      to = clockMin(b, m2, r2);
      const same = clockMin(a, m1, r2);
      from = same !== null && to !== null && same <= to ? same : clockMin(a, m1, "am");
    } else {
      from = clockMin(a, m1, r1);
      const same = clockMin(b, m2, r1);
      to = same !== null && from !== null && same >= from ? same : clockMin(b, m2, "pm");
    }
    if (from === null || to === null || to <= from) return;
    out.push({ at, end: at + len, from, to });
  };
  const SPAN_RE = new RegExp(`\\b(?:de|desde)\\s+(?:las?\\s+)?${HH}\\s*${MER}?\\s*(?:a|hasta|-|–)\\s*(?:las?\\s+)?${HH}\\s*${MER}?(?![a-z])`, "g");
  for (const m of t.matchAll(SPAN_RE)) push(m.index ?? 0, m[0].length, m[1]!, m[2], m[3], m[4]!, m[5], m[6]);
  const DASH_RE = new RegExp(`\\b${HH}\\s*${MER}?\\s*[-–]\\s*${HH}\\s*${MER}(?![a-z])`, "g");
  for (const m of t.matchAll(DASH_RE)) {
    if (!overlaps(m.index ?? 0, (m.index ?? 0) + m[0].length)) push(m.index ?? 0, m[0].length, m[1]!, m[2], m[3], m[4]!, m[5], m[6]);
  }
  const UNTIL_RE = new RegExp(`\\bhasta\\s+(?:las?\\s+)?${HH}\\s*${MER}(?![a-z])`, "g");
  for (const m of t.matchAll(UNTIL_RE)) {
    const at = m.index ?? 0;
    if (overlaps(at, at + m[0].length)) continue;
    const to = clockMin(Number(m[1]), m[2], m[3]);
    if (to !== null) out.push({ at, end: at + m[0].length, from: null, to });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Classes that EXIST that day for the band (sparring included); no band → every non-parent class. */
function existRows(schedule: readonly Slot[], wd: number, band: ProgramBand | null, disc: string | null): Slot[] {
  return schedule.filter(
    (s) =>
      s.weekday === wd &&
      (band ? slotMatchesBand(s, band) : !s.pp) &&
      (!disc || s.discipline === disc),
  );
}

const PARTS: { label: string; re: RegExp; from: number; to: number }[] = [
  { label: "la mañana", re: /\b(?:(?:en|por|de)\s+la\s+manana|mananas|manana\s+y\s+(?:tarde|noche))\b/, from: 6 * 60, to: 12 * 60 },
  { label: "la tarde", re: /(?<!buenas\s|llegar\s|llegues\s|llega\s|mas\s|muy\s)\btardes?\b/, from: 13 * 60, to: 20 * 60 - 1 },
  { label: "la noche", re: /(?<!buenas\s)\bnoches?\b/, from: 19 * 60, to: 24 * 60 - 1 },
];

const OPEN_CLAIM_RE = new RegExp(
  `\\b(?:(?:las\\s+)?clases(?:\\s+de\\s+[a-z-]+)?\\s+(?:empiezan|comienzan|inician|arrancan)|(?:empiezan|comienzan|inician|arrancan)\\s+las\\s+clases|abrimos|abre(?:n)?\\s+(?:el\\s+gimnasio|la\\s+academia)|(?:adultos|ninos|kids|teens)\\s+(?:empiezan|comienzan|inician|entran))\\b[^.\\n!?]{0,25}?\\ba\\s+las?\\s+${HH}\\s*${MER}?(?![a-z])`,
  "g",
);
const CLOSE_CLAIM_RE = new RegExp(
  `\\b(?:cierra(?:mos|n)?|cerramos|(?:las\\s+)?clases\\s+(?:terminan|acaban)|(?:terminan|acaban)\\s+las\\s+clases|ultima\\s+clase(?:\\s+del\\s+dia)?(?:\\s+es)?)\\b[^.\\n!?]{0,25}?\\ba\\s+las?\\s+${HH}\\s*${MER}?(?![a-z])`,
  "g",
);
const EDGE_CLAIMS: { re: RegExp; kind: "open" | "close" }[] = [
  { re: OPEN_CLAIM_RE, kind: "open" },
  { re: CLOSE_CLAIM_RE, kind: "close" },
];

/** Text ranges of opening/closing claims: their hour is an edge, not a class start. */
function edgeClaimRanges(t: string): { at: number; end: number }[] {
  const out: { at: number; end: number }[] = [];
  for (const { re } of EDGE_CLAIMS) {
    for (const m of t.matchAll(re)) out.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * Pure. Summary claims that name no single (day, hour): day ranges with parts
 * of the day / hours / spans, week-wide opening and closing times, and "hay
 * Teens el sábado"-style existence claims. Issues are keyed into `seen` so a
 * pair the slot tier already reported is not repeated.
 */
function findRangeClaimIssues(
  t: string,
  todayWd: number,
  opts: SlotClaimOpts,
  schedule: readonly Slot[],
  spans: Span[],
  times: TimeTok[],
  seen: Set<string>,
): SlotClaimIssue[] {
  const issues: SlotClaimIssue[] = [];
  const groups = dayGroups(t, todayWd);
  const sentenceOf = (at: number) => sentenceBounds(t, at);
  const discOf = (seg: string) => {
    const d = disciplinesIn(seg);
    return d.length === 1 ? d[0]! : null;
  };
  const push = (key: string, issue: SlotClaimIssue) => {
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  const realDay = (wd: number, band: ProgramBand | null, disc: string | null) =>
    dayOptionsText(existRows(schedule, wd, band, disc)) || "ninguna clase";

  // 1. Spans ("de 7 am a 9 pm", "(6-7 pm)", "hasta las 10 pm") against the days they describe.
  for (const sp of spans) {
    const [sa, sb] = sentenceOf(sp.at);
    const g = groupFor(groups, sa, sb, sp.at, sp.end);
    if (!g) continue;
    const seg = t.slice(sa, sb);
    const band = groupHint(seg) ?? opts.band;
    const disc = discOf(seg);
    for (const wd of g.days) {
      const starts = existRows(schedule, wd, band, disc).map((s) => minutesOf(s.time));
      const startOk = sp.from === null || starts.some((m) => m >= sp.from! && m <= sp.from! + 120);
      const endOk = starts.some((m) => m <= sp.to && m >= sp.to - 120);
      if (startOk && endOk) continue;
      const what = sp.from === null ? `hasta las ${hm12(sp.to)}` : `de ${hm12(sp.from)} a ${hm12(sp.to)}`;
      push(`span ${wd} ${sp.from}-${sp.to}`, {
        weekday: wd,
        band,
        note: `dice que el ${WEEKDAY_ES[wd]} hay clases ${what}${band ? ` (${bandLabel(band)})` : ""}, pero ese día solo hay: ${realDay(wd, band, disc)}.`,
      });
    }
  }

  // 2. A day RANGE + parts of the day ("lunes a viernes mañana y tarde").
  for (const g of groups) {
    if (!g.range) continue;
    const [sa, sb] = sentenceOf(g.at);
    // One claim per sentence ("todos los días de lunes a domingo" is ONE);
    // two different ranges ("L–J … y de vie a dom …") are left alone.
    const kinds = new Set(groups.filter((x) => x.range && x.at >= sa && x.at < sb).map((x) => x.days.join()));
    if (kinds.size !== 1) continue;
    if (groups.some((x) => x.range && x.at >= sa && x.at < g.at && x.days.join() === g.days.join())) continue; // judged once
    const seg = t.slice(sa, sb);
    if (EXCEPTION_RE.test(seg)) continue;
    const band = groupHint(seg) ?? opts.band;
    const disc = discOf(seg);
    for (const part of PARTS) {
      if (!part.re.test(seg)) continue;
      for (const wd of g.days) {
        const ok = existRows(schedule, wd, band, disc).some((s) => {
          const m = minutesOf(s.time);
          return m >= part.from && m <= part.to;
        });
        if (ok) continue;
        push(`part ${wd} ${part.label}`, {
          weekday: wd,
          band,
          note: `dice que hay clases el ${WEEKDAY_ES[wd]} en ${part.label}, pero ese día solo hay: ${realDay(wd, band, disc)}.`,
        });
      }
    }
  }

  // 3. A day RANGE + an hour ("MMA de lunes a jueves a las 8 pm"): every day
  //    of the range must have a TRIAL slot at that hour.
  for (const tok of times) {
    if (spans.some((s) => tok.at < s.end && tok.end > s.at)) continue;
    const [sa, sb] = sentenceOf(tok.at);
    const g = groupFor(groups, sa, sb, tok.at, tok.end);
    if (!g || !g.range) continue;
    const seg = t.slice(sa, sb);
    if (EXCEPTION_RE.test(seg) || NO_TRIAL_RE.test(seg)) continue;
    const band = groupHint(seg) ?? opts.band;
    const disc = discOf(seg);
    for (const wd of g.days) {
      const rows = existRows(schedule, wd, band, disc);
      if (rows.some((s) => s.trial !== false && tok.times.includes(s.time))) continue;
      const sparring = rows.some((s) => s.trial === false && tok.times.includes(s.time));
      const label = `${WEEKDAY_ES[wd]} ${time12(tok.times[tok.times.length - 1]!)}${disc ? ` (${disc})` : ""}`;
      push(`${wd} ${tok.times[0]}`, {
        weekday: wd,
        time: tok.times[0]!,
        band,
        note: sparring
          ? `${label} es sparring: NO acepta clase de prueba. Opciones reales el ${WEEKDAY_ES[wd]}: ${dayOptionsText(rows.filter((s) => s.trial !== false))}.`
          : `${label} no existe${band ? ` para ${bandLabel(band)}` : ""} (el mensaje lo incluye en un rango de días). Opciones reales el ${WEEKDAY_ES[wd]}: ${realDay(wd, band, disc)}.`,
      });
    }
  }

  // 4. Opening / closing claims ("las clases de adultos empiezan a las 6 pm",
  //    "el horario cierra a las 8 pm"). True when SOME day the claim covers
  //    really starts (first class) / ends (last class + 1 h, or its start for
  //    "última clase") at that time.
  for (const { re, kind } of EDGE_CLAIMS) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      const [sa, sb] = sentenceOf(at);
      const seg = t.slice(sa, sb);
      if (EXCEPTION_RE.test(seg)) continue;
      const claimed = readings(Number(m[1]), m[2], m[3]);
      if (claimed.length === 0) continue;
      const band = groupHint(seg) ?? opts.band;
      const disc = discOf(seg);
      const g = groupFor(groups, sa, sb, at, at + m[0].length);
      const days = g ? g.days : [0, 1, 2, 3, 4, 5, 6];
      const edges: number[] = [];
      for (const wd of days) {
        const starts = existRows(schedule, wd, band, disc).map((s) => minutesOf(s.time)).sort((a, b) => a - b);
        if (starts.length === 0) continue;
        const last = starts[starts.length - 1]!;
        if (kind === "open") edges.push(starts[0]!);
        // "cerramos / terminan las clases" = when the last class ENDS (≈ 1 h
        // after it starts); "la última clase es a las…" may mean its start.
        else edges.push(last + 60, ...(/ultima/.test(m[0]) ? [last] : []));
      }
      if (edges.length === 0) continue;
      if (claimed.some((c) => edges.some((e) => Math.abs(e - c) <= 30))) continue;
      const scope = g ? ` el ${g.days.map((d) => WEEKDAY_ES[d]).join("/")}` : "";
      const real = kind === "open"
        ? `la primera clase${band ? ` de ${bandLabel(band)}` : ""}${scope} es a las ${hm12(Math.min(...edges))}`
        : `la última clase${band ? ` de ${bandLabel(band)}` : ""}${scope} termina a las ${hm12(Math.max(...edges))}`;
      push(`${kind} ${m[0]}`, {
        band,
        note: `dice que las clases ${kind === "open" ? "empiezan" : "terminan"} a las ${hm12(claimed[claimed.length - 1]!)}${scope}, pero no es así: ${real}.`,
      });
    }
  }

  // 5. "Tenemos Teens el sábado" / "el domingo hay Kids" — an existence claim
  //    for an explicitly named group on a day it has no class at all.
  const POS: { re: RegExp; day: number; grp: number }[] = [
    { re: new RegExp(`\\b(?:hay|tenemos|damos)\\b([^.\\n!?]{0,40}?)\\b(?:el|los)\\s+${DAY_WORD}\\b`, "g"), day: 2, grp: 1 },
    { re: new RegExp(`\\b(?:el|los)\\s+${DAY_WORD}\\s+(?:si\\s+|tambien\\s+)?(?:hay|tenemos|damos)\\b([^.\\n!?]{0,30})`, "g"), day: 1, grp: 2 },
  ];
  for (const { re, day, grp } of POS) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      if (/\bno\s+$/.test(t.slice(Math.max(0, at - 4), at)) || /\bno\s+(?:hay|tenemos|damos)\b/.test(m[0])) continue;
      const wd = DAY_INDEX[m[day]!];
      if (wd === undefined) continue;
      const [sa] = sentenceOf(at);
      if (EXCEPTION_RE.test(t.slice(sa, sentenceOf(at)[1]))) continue;
      // The group named in the claim itself, or just before it ("Para Teens también hay clase el sábado").
      const lead = t.slice(Math.max(sa, at - 30), at);
      const band = groupHint(m[grp] ?? "") ?? groupHint(lead.slice(Math.max(lead.lastIndexOf(","), lead.lastIndexOf(";")) + 1));
      if (!band) continue;
      if (existRows(schedule, wd, band, null).length > 0) continue;
      push(`exists ${wd} ${band}`, {
        weekday: wd,
        band,
        note: `dice que hay ${bandLabel(band)} el ${WEEKDAY_ES[wd]}, pero ese día NO hay ninguna clase de ese grupo.`,
      });
    }
  }
  return issues;
}

/**
 * Pure. Every explicit (day, hour) the reply names that does NOT exist for
 * the lead's band (+ discipline for adults), plus "no hay X el <día>" claims
 * the grid contradicts, plus the range / summary claims of
 * findRangeClaimIssues. `todayWd` is the <context> weekday (0=Mon).
 */
export function findSlotClaimIssues(
  message: string,
  todayWd: number,
  opts: SlotClaimOpts,
): SlotClaimIssue[] {
  const schedule = opts.schedule ?? SLOTS;
  const t = fold(message);
  const days = dayTokens(t, todayWd);
  const spans = spanTokens(t);
  // Span edges ("hasta las 9 pm") and opening/closing hours ("cerramos a las
  // 10 pm") are not class start times.
  const edges = [...spans, ...edgeClaimRanges(t)];
  const times = timeTokens(t).filter((tok) => !edges.some((s) => tok.at < s.end && tok.end > s.at));
  const issues: SlotClaimIssue[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < times.length; i++) {
    const tok = times[i]!;
    const [sa, sb] = sentenceBounds(t, tok.at);
    // Nearest day named BEFORE the hour in the same sentence; else one right after it.
    const before = days.filter((d) => d.end <= tok.at && d.at >= sa).pop();
    const after = days.find((d) => d.at >= tok.end && d.at <= Math.min(sb, tok.end + 25));
    const day = before ?? after;
    if (!day) continue;

    const nextAt = times[i + 1]?.at ?? sb;
    const prevEnd = Math.max(times[i - 1]?.end ?? sa, sa);
    // A discipline AFTER the hour belongs to it only up to the next clause
    // ("9 am (Jiu-Jitsu) y seguido…", but not "Box a las 9 pm, o Muay Thai…").
    const tail = t.slice(tok.end, Math.min(nextAt, sb)).split(/[,;]|\s(?:o|y|u)\s/)[0] ?? "";
    const headRaw = t.slice(prevEnd, tok.at);
    const head = headRaw.slice(Math.max(headRaw.lastIndexOf(","), headRaw.lastIndexOf(";")) + 1);
    const discs = disciplinesIn(tail);
    const disc = discs.length === 1 ? discs[0]! : (() => {
      const h = disciplinesIn(head);
      return h.length === 1 ? h[0]! : null;
    })();
    const band = groupHint(tail) ?? groupHint(head) ?? opts.band;

    let rows = rowsFor(schedule, day.weekday, band);
    const fits = (r: Slot[]) => r.some((s) => tok.times.includes(s.time));
    let candidates = rows.filter((s) => (disc ? s.discipline === disc : true));
    if (!disc && band === "adults" && opts.discipline) {
      const mine = candidates.filter((s) => s.discipline === opts.discipline && !s.name);
      if (mine.length > 0) candidates = mine;
    }
    const seg = t.slice(sa, sb);
    if (fits(candidates)) {
      // "12 pm (Jiu-Jitsu)" on a Saturday: the only row at that hour is a
      // renamed class (Blindaje 8, booked under `jiu`) — offering it under the
      // discipline's name is wrong unless the copy names the class.
      const hit = candidates.filter((s) => tok.times.includes(s.time));
      const named = hit.every((s) => s.name) ? hit.find((s) => s.name) : undefined;
      if (disc && named && !seg.includes(fold(named.name!))) {
        const key = `${day.weekday} ${tok.times[0]}`;
        if (!seen.has(key)) {
          seen.add(key);
          issues.push({
            weekday: day.weekday,
            time: tok.times[0]!,
            band,
            note: `${WEEKDAY_ES[day.weekday]} ${time12(named.time)} no es ${CLIENT.services.find((x) => x.key === disc)?.label ?? disc}: es «${named.name}».`,
          });
        }
      }
      continue;
    }
    // The slot exists but takes no trial (sparring). A sentence that SAYS so
    // ("el sábado 11 am es sparring, sin prueba") is the correct warning.
    const sparring = schedule.some(
      (s) =>
        s.weekday === day.weekday &&
        s.trial === false &&
        tok.times.includes(s.time) &&
        (!disc || s.discipline === disc) &&
        (band === null || slotMatchesBand(s, band)),
    );
    if (sparring && NO_TRIAL_RE.test(seg)) continue;

    const key = `${day.weekday} ${tok.times[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (sparring) {
      const trialRows = rowsFor(schedule, day.weekday, band).filter((s) => (disc ? s.discipline === disc : true));
      issues.push({
        weekday: day.weekday,
        time: tok.times[0]!,
        band,
        note: `${WEEKDAY_ES[day.weekday]} ${time12(tok.times[tok.times.length - 1]!)}${disc ? ` (${disc})` : ""} es sparring: NO acepta clase de prueba. Opciones reales el ${WEEKDAY_ES[day.weekday]}: ${dayOptionsText(trialRows.length ? trialRows : rowsFor(schedule, day.weekday, band)) || "ninguna"}.`,
      });
      continue;
    }
    if (band === null) rows = rowsFor(schedule, day.weekday, null);
    const groupWords = band ? bandLabel(band) : "ningún grupo";
    const discRows = disc ? rows.filter((s) => s.discipline === disc) : [];
    const realOpts = dayOptionsText(discRows.length ? discRows : rows);
    issues.push({
      weekday: day.weekday,
      time: tok.times[0]!,
      band,
      note: `${WEEKDAY_ES[day.weekday]} ${time12(tok.times[tok.times.length - 1]!)}${disc ? ` (${disc})` : ""} no existe para ${groupWords}. Opciones reales ${band ? `de ${bandLabel(band)} ` : ""}el ${WEEKDAY_ES[day.weekday]}: ${realOpts || "ninguna — no hay clase de su grupo ese día"}.`,
    });
  }

  // "No hay Kids el sábado" — a negative claim the grid contradicts.
  const NEG = /\bno\s+(?:hay|tenemos|damos|abrimos)\b([^.\n!?]{0,40}?)\b(?:el|los)?\s*(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/g;
  for (const m of t.matchAll(NEG)) {
    const wd = DAY_INDEX[m[2]!];
    if (wd === undefined) continue;
    const band = groupHint(m[1] ?? "") ?? opts.band;
    if (band === null) continue;
    const rows = rowsFor(schedule, wd, band);
    if (rows.length === 0) continue;
    issues.push({
      weekday: wd,
      band,
      note: `dice que no hay ${bandLabel(band)} el ${WEEKDAY_ES[wd]}, pero SÍ hay: ${dayOptionsText(rows)}.`,
    });
  }
  issues.push(...findRangeClaimIssues(t, todayWd, opts, schedule, spans, times, seen));
  return issues;
}
