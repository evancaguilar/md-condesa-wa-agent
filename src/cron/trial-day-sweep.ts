// Early warning for booked trials on a day that does not run (incident
// 2026-11-16). When the owner adds a closed / tbd / special date to
// CLIENT.closedDates, trials already booked on it are found here — at most
// once an hour, and only while a closure falls within the next 14 days — so
// staff hear about it when the holiday is configured, not at reminder time.
// The send-time guard in cron/followups.ts (noClassGuard) is the backstop.
//
// D1 rows-read budget (free plan, three outages from scans): ZERO reads when
// no closure is within 14 days (pure check on the config); otherwise one kv
// claim + one SELECT served by idx_followups_kind_status_due
// (kind, status, due_at): kind IN (…) + status = 'scheduled' + due_at range.

import type { Env } from "../types.js";
import type { ClosedDate } from "../client-config.js";
import { CLIENT } from "../client.gen.js";
import { kvClaimIfAbsentOrOlder } from "../db/queries.js";
import { decodeChainNote } from "./post-trial.js";
import { hasClosureWithin, trialDayCheck } from "../services/trial-day-check.js";
import { applyNoClassCancellation } from "../services/trial-cancel.js";

export const TRIAL_DAY_SWEEP_KEY = "trial_day_sweep_at";
export const TRIAL_DAY_SWEEP_EVERY = 3600;
export const TRIAL_DAY_SWEEP_DAYS = 14;

/** Armed rows whose note carries the trial epoch (trial_confirm has none and
 *  fires within minutes — its own send-time guard covers it). */
export const SWEEP_KINDS = ["day_before", "same_day", "no_show_hoy"] as const;

export const TRIAL_DAY_SWEEP_SQL =
  `SELECT id, phone, kind, note FROM followups
   WHERE kind IN ('day_before', 'same_day', 'no_show_hoy') AND status = 'scheduled' AND due_at <= ?1`;

export interface TrialDaySweepResult {
  rows: number;
  /** phone:trial pairs whose class does not run. */
  flagged: number;
  cancelled: number;
  notes: number;
}

/** Pure. The distinct (phone, trial) pairs of the swept rows. */
export function sweepPairs(rows: readonly { phone: string; note: string | null }[]): { phone: string; trial: number }[] {
  const seen = new Set<string>();
  const out: { phone: string; trial: number }[] = [];
  for (const r of rows) {
    const t = decodeChainNote(r.note).trial;
    if (t === null) continue;
    const k = `${r.phone}:${t}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ phone: r.phone, trial: t });
  }
  return out;
}

/** null when gated off (no closure soon, or ran less than an hour ago). */
export async function runTrialDaySweep(
  env: Env,
  deps: { postTaskNote: (text: string) => Promise<void> },
  now: number,
  closedDates: readonly ClosedDate[] = CLIENT.closedDates ?? [],
): Promise<TrialDaySweepResult | null> {
  if (!hasClosureWithin(closedDates, now, TRIAL_DAY_SWEEP_DAYS)) return null;
  if (!(await kvClaimIfAbsentOrOlder(env.DB, TRIAL_DAY_SWEEP_KEY, now, TRIAL_DAY_SWEEP_EVERY))) return null;
  // +1 day: a no_show_hoy for a late class on the last closure is quiet-shifted to the next 08:00.
  const horizon = now + (TRIAL_DAY_SWEEP_DAYS + 1) * 86400;
  const { results } = await env.DB.prepare(TRIAL_DAY_SWEEP_SQL)
    .bind(horizon)
    .all<{ id: number; phone: string; kind: string; note: string | null }>();
  const rows = results ?? [];
  const res: TrialDaySweepResult = { rows: rows.length, flagged: 0, cancelled: 0, notes: 0 };
  for (const { phone, trial } of sweepPairs(rows)) {
    const verdict = trialDayCheck(trial, closedDates);
    if (verdict.runs) continue;
    res.flagged++;
    try {
      const r = await applyNoClassCancellation(env, phone, trial, verdict, deps, now);
      res.cancelled += r.cancelled;
      if (r.noted) res.notes++;
    } catch (err) {
      console.warn(`[trial-day-sweep] ${phone} trial ${trial} failed: ${String(err)}`);
    }
  }
  if (res.flagged) console.log(`[trial-day-sweep] ${JSON.stringify(res)}`);
  return res;
}
