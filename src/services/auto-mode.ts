// Night mode ("modo nocturno"): a time-boxed full-auto window. While armed,
// getTrainingWheels() returns false so high-confidence brain replies send
// instantly — speed-to-lead overnight beats waiting hours for a human approval.
// The window is stored as a single kv epoch (`auto_mode_until`) and simply
// LAPSES: no cron, no un-arm step, nothing that can get stuck — at 07:00 CDMX
// the comparison flips and the standing training-wheels config rules again.
//
// Safety rails that do NOT change while armed: low-confidence replies still
// queue as drafts, crisis/opt-out/kill-switch/human-override gates run first in
// the pipeline, and quiet hours still block unsolicited sends (replies to an
// inbound are in-window free-form and were always allowed).

import { kvGet, kvSet, kvDelete } from "../db/queries.js";
import { cdmxParts, cdmxToEpoch } from "../cron/time.js";

export const AUTO_MODE_KV = "auto_mode_until";
/** Auto mode always ends at 07:00 CDMX — Evan's "back to manual" hour. */
export const AUTO_MODE_END_HOUR = 7;
const DAY = 24 * 3600;

/**
 * Next 07:00 CDMX strictly after `now`. Arming at 22:00 → tomorrow 07:00;
 * arming at 06:30 → today 07:00. (CDMX has no DST since 2022 — fixed offset,
 * so day arithmetic in epoch space is safe.)
 */
export function nextAutoModeEnd(now: number): number {
  const p = cdmxParts(now);
  const todaySeven = cdmxToEpoch(p.year, p.month, p.day, AUTO_MODE_END_HOUR, 0, 0);
  return todaySeven > now ? todaySeven : todaySeven + DAY;
}

/** Pure check: does a stored kv value describe a still-active auto window? */
export function autoModeActive(raw: string | null, now: number): boolean {
  if (!raw) return false;
  const until = Number(raw);
  return Number.isFinite(until) && now < until;
}

/** Active-window end epoch, or null when auto mode is off/lapsed. */
export async function getAutoModeUntil(
  db: D1Database,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  const raw = await kvGet(db, AUTO_MODE_KV);
  return autoModeActive(raw, now) ? Number(raw) : null;
}

/** Arms auto mode until the next 07:00 CDMX; returns the end epoch. */
export async function armAutoMode(
  db: D1Database,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const until = nextAutoModeEnd(now);
  await kvSet(db, AUTO_MODE_KV, String(until));
  return until;
}

/** Disarms immediately (manual "volver a manual" before 07:00). */
export async function disarmAutoMode(db: D1Database): Promise<void> {
  await kvDelete(db, AUTO_MODE_KV);
}

/** "HH:MM" CDMX label for a window end, for Slack/panel copy. */
export function autoModeEndLabel(until: number): string {
  const p = cdmxParts(until);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
