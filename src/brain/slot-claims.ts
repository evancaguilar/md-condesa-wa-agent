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
  weekday: number;
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

/**
 * Pure. Every explicit (day, hour) the reply names that does NOT exist for
 * the lead's band (+ discipline for adults), plus "no hay X el <día>" claims
 * the grid contradicts. `todayWd` is the <context> weekday (0=Mon).
 */
export function findSlotClaimIssues(
  message: string,
  todayWd: number,
  opts: SlotClaimOpts,
): SlotClaimIssue[] {
  const schedule = opts.schedule ?? SLOTS;
  const t = fold(message);
  const days = dayTokens(t, todayWd);
  const times = timeTokens(t);
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
    if (fits(candidates)) continue;

    const key = `${day.weekday} ${tok.times[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
  return issues;
}
