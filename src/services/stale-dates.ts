// Stale relative dates (2026-11-11 review): a draft written at 19:00 that says
// "mañana sábado a las 10 am" means Saturday — sent at 08:00 the next day it
// would invite the lead to SUNDAY. Same for "hoy a las 6 pm" approved at 18:40.
// Before any draft leaves late (a human tapping Aprobar long after, the timeout
// send, the 08:00 release of an overnight draft) this re-reads the text against
// the send time. Pure: no clock, no I/O; fake clocks in test/stale-dates.test.ts.
//
// Deliberately conservative: a false positive only costs a regenerated reply
// (or a human edit); a false negative sends a wrong day. Times we cannot pin to
// a day ("a las 7" with no am/pm) are ignored.

import { CDMX_OFFSET_SECONDS, DAY } from "../cron/time.js";

export type StaleDateIssue =
  | { kind: "day_changed"; word: string }
  | { kind: "time_passed"; time: string };

/** Lowercase, accents folded, so "mañana" / "manana" match alike. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// "hoy", "esta tarde/noche", "en la noche", "ahorita", "today", "tonight"…
const TODAY_RE =
  /\bhoy\b|\besta (?:tarde|noche|manana)\b|\ben la noche\b|\bahorita\b|\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b/;
// "mañana" = tomorrow, but NOT "en/por/de la mañana", "esta mañana"; the plural
// ("las mañanas") is always "mornings".
const TOMORROW_RE = /(?<!\b(?:la|esta|una|cada)\s)\bmanana\b|\btomorrow\b/;
const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const WEEKDAYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// "6 pm", "6:30 pm", "10 am", "7 p.m." — explicit meridiem only.
const TIME_RE = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/g;

/** CDMX calendar day index (days since epoch) and minute-of-day. */
function local(epoch: number): { day: number; minute: number; weekday: number } {
  const t = epoch + CDMX_OFFSET_SECONDS;
  const day = Math.floor(t / DAY);
  // 1970-01-01 was a Thursday (4).
  return { day, minute: Math.floor((t - day * DAY) / 60), weekday: (day + 4) % 7 };
}

/** Explicit-meridiem clock times in the text, as minutes of the day. */
export function clockMinutes(text: string): { minute: number; label: string }[] {
  const out: { minute: number; label: string }[] = [];
  for (const m of fold(text).matchAll(TIME_RE)) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12) continue;
    const pm = m[3]!.startsWith("p");
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    out.push({ minute: h * 60 + min, label: m[0].trim() });
  }
  return out;
}

/** Minutes before a class that are too late to still offer it. */
export const TOO_LATE_BEFORE_CLASS_MIN = 30;

/**
 * Does `text`, written at `writtenAt`, still mean the same thing at `sendAt`?
 * - day_changed: the CDMX day rolled over and the text says hoy / mañana /
 *   esta tarde / en la noche (or today/tomorrow/tonight): those now point at
 *   a different day than the draft meant.
 * - time_passed: same day, the text says "hoy" (or names today's weekday) and
 *   a clock time that was still ahead when written is now past, or less than
 *   TOO_LATE_BEFORE_CLASS_MIN away.
 * Null = safe to send as written.
 */
export function staleDateIssue(text: string, writtenAt: number, sendAt: number): StaleDateIssue | null {
  if (sendAt <= writtenAt) return null;
  const t = fold(text);
  const w = local(writtenAt);
  const s = local(sendAt);
  const today = t.match(TODAY_RE);
  const tomorrow = t.match(TOMORROW_RE);
  if (s.day !== w.day) {
    const word = today?.[0] ?? tomorrow?.[0];
    if (word) return { kind: "day_changed", word: word.replace(/manana/g, "mañana") };
  }
  // A clock time "for today": the text says hoy/esta tarde, or names the send
  // day's weekday. (A same-day "mañana" offer can't have passed yet.)
  const namesSendDay =
    new RegExp(`\\b(?:${WEEKDAYS[s.weekday]}|${WEEKDAYS_EN[s.weekday]})\\b`).test(t);
  if (!today && !namesSendDay) return null;
  for (const c of clockMinutes(text)) {
    // Was still ahead (or not today at all) when written, too close/past now.
    const wasAhead = s.day !== w.day || c.minute > w.minute;
    if (wasAhead && c.minute <= s.minute + TOO_LATE_BEFORE_CLASS_MIN) {
      return { kind: "time_passed", time: c.label };
    }
  }
  return null;
}

/** One-line Spanish label for a card / Slack note. */
export function staleDateLabel(issue: StaleDateIssue): string {
  return issue.kind === "day_changed"
    ? `el borrador dice «${issue.word}» pero se escribió otro día`
    : `el borrador ofrece las ${issue.time} y esa hora ya pasó (o falta muy poco)`;
}
