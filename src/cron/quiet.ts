// Quiet hours for unsolicited sends (R1/R2 of sequences-v2). No follow-up may be
// SENT between 21:30 and 08:00 CDMX. These are pure functions over epoch seconds
// (no Intl, fixed CDMX offset via ./time.ts) so the scheduling math is fully
// unit-testable with fake clocks.
//
// Boundary convention: 21:30:00 is the LAST permissible instant (the nudge-3
// "pull to 21:30" rule targets it), so isQuietHour treats > 21:30 as quiet and
// exactly 21:30 as allowed. 08:00:00 is allowed; anything before it is quiet.

import { cdmxParts, cdmxToEpoch, DAY } from "./time.js";

/** 21:30 CDMX, in minutes-since-midnight. Sends AFTER this are quiet. */
export const QUIET_START_MIN = 21 * 60 + 30; // 1290
/** 08:00 CDMX, in minutes-since-midnight. Sends BEFORE this are quiet. */
export const QUIET_END_MIN = 8 * 60; // 480

const TWO_HOURS = 2 * 3600;

/** Minutes-since-CDMX-midnight for an epoch. */
function cdmxMinuteOfDay(epoch: number): number {
  const p = cdmxParts(epoch);
  return p.hour * 60 + p.minute;
}

/**
 * True when `epoch` falls in the CDMX quiet window (after 21:30, before 08:00).
 * 21:30:00 and 08:00:00 exactly are NOT quiet (both are valid send instants).
 */
export function isQuietHour(epoch: number): boolean {
  const min = cdmxMinuteOfDay(epoch);
  return min > QUIET_START_MIN || min < QUIET_END_MIN;
}

/** The 08:00 CDMX that is strictly AFTER `epoch`. */
export function next8am(epoch: number): number {
  const p = cdmxParts(epoch);
  const today8 = cdmxToEpoch(p.year, p.month, p.day, 8, 0, 0);
  return today8 > epoch ? today8 : today8 + DAY;
}

/**
 * If `epoch` is inside quiet hours, return the next 08:00 CDMX; otherwise return
 * `epoch` unchanged. Early-morning quiet (00:00–07:59) → 08:00 the SAME day;
 * evening quiet (after 21:30) → 08:00 the NEXT day.
 */
export function shiftOutOfQuiet(epoch: number): number {
  if (!isQuietHour(epoch)) return epoch;
  const p = cdmxParts(epoch);
  const min = p.hour * 60 + p.minute;
  const today8 = cdmxToEpoch(p.year, p.month, p.day, 8, 0, 0);
  // Early morning → 08:00 today. Evening (after 21:30) → 08:00 tomorrow.
  return min < QUIET_END_MIN ? today8 : today8 + DAY;
}

/** Result of placing nudge 3: a concrete time, or dropped (day-2 takes over). */
export type Nudge3Placement = { dueAt: number } | { dropped: true };

/**
 * Window-aware placement for nudge 3 (R2). It must land inside the 24h window
 * AND outside quiet hours, at least 2h after nudge 2's time:
 *  - natural (+8h) time is fine (in-window, not quiet, ≥2h after nudge 2) → keep;
 *  - else pull EARLIER to 21:30 (the 21:30 at/just-before natural) if that is
 *    ≥ nudge2 + 2h and still inside the window;
 *  - else defer to the next 08:00 if that's still inside the window;
 *  - else drop (the day-2 extended message covers it).
 * Pure: all times are epoch seconds; `now` guards against placing in the past.
 */
export function placeNudge3(
  natural: number,
  nudge2Time: number,
  windowEnd: number,
  now: number,
): Nudge3Placement {
  const earliest = nudge2Time + TWO_HOURS;

  // Keep the natural time when it is genuinely fine.
  if (
    !isQuietHour(natural) &&
    natural < windowEnd &&
    natural >= earliest &&
    natural > now
  ) {
    return { dueAt: natural };
  }

  // Pull earlier to 21:30 on the evening at/just-before `natural`.
  const pn = cdmxParts(natural);
  let pull = cdmxToEpoch(pn.year, pn.month, pn.day, 21, 30, 0);
  if (pull > natural) pull -= DAY;
  if (
    pull >= earliest &&
    pull < windowEnd &&
    pull > now &&
    pull <= natural
  ) {
    return { dueAt: pull };
  }

  // Defer to the next 08:00 after `natural`.
  const deferred = next8am(natural);
  if (deferred < windowEnd && deferred >= earliest && deferred > now) {
    return { dueAt: deferred };
  }

  return { dropped: true };
}
