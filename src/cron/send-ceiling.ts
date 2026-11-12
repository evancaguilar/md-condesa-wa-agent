// Hard per-lead ceiling on UNSOLICITED automated messages (2026-11-11).
//
// Meta flagged the number for spam twice; the graded review found leads with
// up to 7 automated messages in 7 days (A258, A224) — day-1 free-form nudges,
// the extended templates, post-trial / no-show chains and re-engagement all
// counted against separate, kind-local caps (NUDGE_CAP = 3 day-1 nudges / 7 d,
// one extended step per CDMX day, the nudgePolicy step lists) and nothing
// bounded the SUM. This is that bound, enforced at send time on every chasing
// kind (src/cron/followups.ts processOne):
//
//   at most `perDay` unsolicited messages per CDMX day, and at most
//   `per7Days` in any rolling 7 days, counting only messages sent AFTER the
//   lead's last inbound (a reply from the lead resets it — then it is a
//   conversation, not a chase).
//
// Defaults 1 / 4 (client.mjs `nudgePolicy.ceiling`): the shipped engaged chain
// (nudge_1h + d2 + d4 + d7) is exactly 4, the silent one (1h + d2 + d7) 3, so
// the ceiling only bites when chains STACK. Over the day cap a day-1 nudge is
// dropped (the extended chain covers tomorrow) and any other kind waits for
// the next 08:00; over the 7-day cap the row is cancelled. Counted from the
// followups rows marked sent (their due_at ≈ send time): the phone-prefixed
// UNIQUE(phone, kind, airtable_record_id) autoindex, never a table scan.
//
// Pure decision + one small D1 helper.

import type { NudgeCeilingConfig } from "../client-config.js";
import { CLIENT } from "../client.gen.js";
import { DECLINE_CANCEL_KINDS } from "../pipeline/decline.js";
import { next8am } from "./quiet.js";
import { cdmxDateStr, DAY } from "./time.js";

export interface SendCeiling {
  perDay: number;
  per7Days: number;
  /**
   * Cap for the first 24 h after the lead's last message (owner, 2026-11-11:
   * "keep at least 2 automated messages within the first day, if not 3" —
   * that is the free-form window, where the day-1 follow-ups live). It
   * REPLACES perDay inside those 24 h; absent ⇒ perDay.
   */
  firstDay?: number;
}

export const DEFAULT_SEND_CEILING: SendCeiling = Object.freeze({ perDay: 1, per7Days: 4 });

/** Config → ceiling; absent / invalid values fall back to the defaults. Pure. */
export function resolveSendCeiling(cfg: NudgeCeilingConfig | null | undefined): SendCeiling {
  const day = Number(cfg?.perDay);
  const week = Number(cfg?.per7Days);
  const first = Number(cfg?.firstDay);
  return {
    perDay: Number.isInteger(day) && day >= 1 ? day : DEFAULT_SEND_CEILING.perDay,
    per7Days: Number.isInteger(week) && week >= 1 ? week : DEFAULT_SEND_CEILING.per7Days,
    ...(Number.isInteger(first) && first >= 1 ? { firstDay: first } : {}),
  };
}

/** The shipped client's ceiling (client.gen.ts nudgePolicy.ceiling). */
export const SEND_CEILING: SendCeiling = resolveSendCeiling(CLIENT.nudgePolicy?.ceiling);

/** Every kind that COUNTS: everything that chases (= the declined-stop list). */
export const CEILING_COUNTED_KINDS: readonly string[] = DECLINE_CANCEL_KINDS;

/**
 * Kinds the ceiling BLOCKS. Not `blast` (owner-approved runs, paced and capped
 * by src/cron/blasts.ts) and not `custom` (a follow-up the lead asked for —
 * "escríbeme el lunes"); both still count.
 */
export const CEILING_ENFORCED_KINDS: readonly string[] = DECLINE_CANCEL_KINDS.filter(
  (k) => k !== "blast" && k !== "custom",
);

const DAY1_KINDS = new Set(["nudge_1h", "nudge_6h", "nudge_8h"]);

export type CeilingVerdict =
  | { ok: true }
  | { ok: false; scope: "day"; action: "cancel" | "defer"; retryAt: number }
  | { ok: false; scope: "week"; action: "cancel" };

/**
 * Pure. May one more unsolicited `kind` go out at `now`? `sentAts` = epochs of
 * the lead's sent chasing rows (any order, any age); only those after the
 * lead's last inbound and inside the last 7 days count.
 */
export function ceilingVerdict(
  kind: string,
  sentAts: readonly number[],
  lastInboundAt: number | null,
  now: number,
  ceiling: SendCeiling = SEND_CEILING,
): CeilingVerdict {
  const since = Math.max(lastInboundAt ?? -Infinity, now - 7 * DAY);
  const counted = sentAts.filter((t) => t > since && t <= now);
  if (counted.length >= ceiling.per7Days) return { ok: false, scope: "week", action: "cancel" };
  // First 24 h after the lead's last message: everything counted is inside
  // that window already (counted = after the last inbound), so the first-day
  // cap bounds the whole day-1 chase, across midnight too.
  if (ceiling.firstDay !== undefined && lastInboundAt !== null && now - lastInboundAt < DAY) {
    if (counted.length >= ceiling.firstDay) {
      return { ok: false, scope: "day", action: DAY1_KINDS.has(kind) ? "cancel" : "defer", retryAt: next8am(now) };
    }
    return { ok: true };
  }
  const today = cdmxDateStr(now);
  if (counted.filter((t) => cdmxDateStr(t) === today).length >= ceiling.perDay) {
    return { ok: false, scope: "day", action: DAY1_KINDS.has(kind) ? "cancel" : "defer", retryAt: next8am(now) };
  }
  return { ok: true };
}

/** SQL of the per-phone probe (exported for tests): phone-prefixed autoindex. */
export function sentChasingSql(nKinds: number): string {
  const ph = Array.from({ length: nKinds }, (_, i) => `?${i + 3}`).join(", ");
  return `SELECT due_at FROM followups WHERE phone = ?1 AND status = 'sent' AND due_at >= ?2 AND kind IN (${ph})`;
}

/** Epochs of the phone's chasing rows sent since `since`. */
export async function sentChasingAts(db: D1Database, phone: string, since: number): Promise<number[]> {
  const { results } = await db
    .prepare(sentChasingSql(CEILING_COUNTED_KINDS.length))
    .bind(phone, since, ...CEILING_COUNTED_KINDS)
    .all<{ due_at: number }>();
  return (results ?? []).map((r) => Number(r.due_at)).filter(Number.isFinite);
}

/** ops_log text for the ceiling hits of one cron tick (null when none). Pure. */
export function ceilingNote(counts: ReadonlyMap<string, number>, ceiling: SendCeiling = SEND_CEILING): string | null {
  let total = 0;
  const parts: string[] = [];
  for (const [key, n] of [...counts.entries()].sort()) {
    total += n;
    parts.push(`${key} ${n}`);
  }
  if (total === 0) return null;
  return (
    `🧱 Tope de mensajes automáticos (${ceiling.firstDay !== undefined ? `${ceiling.firstDay} en las primeras 24 h, ` : ""}${ceiling.perDay}/día, ${ceiling.per7Days}/7 días sin respuesta del lead): ` +
    `${total} envío(s) detenidos en este tick — ${parts.join(", ")}.`
  );
}
