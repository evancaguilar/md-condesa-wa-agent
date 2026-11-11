// The holding line the approval-timeout cron sends while a draft waits for a
// human (services/slack.ts, decideTimeout → "hold"). Pure.
//
// 2026-11 grading: it went out in SPANISH to English speakers (A2, A3, A4) and
// up to three times in one chat (A140: 15:40, 16:55, next day 14:35 — the old
// per-phone cap was 45 min). Now: the contact's language, and at most once per
// CDMX calendar day per phone (never closer than 45 min across midnight).

import { HOLDING_LINE } from "./slack-timeouts.js";
import { CDMX_OFFSET_SECONDS, DAY } from "../cron/time.js";

export const HOLDING_LINE_EN = "Thanks for your message! 🙌 We'll reply here in a moment.";

/** The holding line in the contact's language (es default). */
export function holdingLineFor(lang: string | null | undefined): string {
  return lang === "en" ? HOLDING_LINE_EN : HOLDING_LINE;
}

/** Seconds elapsed since the last CDMX midnight. */
export function secondsSinceCdmxMidnight(nowSec: number): number {
  const local = nowSec + CDMX_OFFSET_SECONDS;
  return ((local % DAY) + DAY) % DAY;
}

/** Minimum per-phone spacing between two holding lines. */
export const HOLDING_MIN_GAP_SECONDS = 45 * 60;

/**
 * Pure. The `minAgeSeconds` for kvClaimIfAbsentOrOlder(`holding_line:<phone>`):
 * the stored send must predate today's CDMX midnight (once per day), and be at
 * least 45 min old.
 */
export function holdingClaimMinAge(nowSec: number): number {
  return Math.max(HOLDING_MIN_GAP_SECONDS, secondsSinceCdmxMidnight(nowSec) + 1);
}
