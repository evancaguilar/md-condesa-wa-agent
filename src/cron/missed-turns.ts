// Missed-turn rescue (2026-10-23). Every inbound brain turn runs inside the
// webhook's ctx.waitUntil, which Cloudflare cuts ~30 s after the 200 to Meta.
// The 8 s debounce + a slow Anthropic call (or a booking retry) can cross that
// line and the turn dies with no reply, no Aprobar card and no log we can see
// (…1122 on 2026-10-22 09:54–10:02: names for a family booking, then the
// "¿cómo nos encontraste?" answer — both silent; draft latencies over 6 days
// stop dead at 30 s).
//
// Each cron tick (no 30 s cap) finds leads whose NEWEST message is their own,
// 4 min – 3 h old, with no approval row of any status created since it and no
// human override, and runs that turn again — once per message (kv claim
// BEFORE the brain call, so a tick killed mid-turn never repeats it). Under an
// hour late it routes exactly like the live turn would have; later than that
// it goes to Aprobar only, with the <respuesta_tardia> note (same as the
// outage redrive, src/cron/redrive.ts).

import type { Env } from "../types.js";
import { isBotEnabled, kvClaimIfAbsentOrOlder } from "../db/queries.js";
import { isReminderConfirmText } from "../pipeline/reminder-reply.js";
import type { OriginState } from "../services/origin-question-core.js";
import { staleReplyFor, type UnansweredRow } from "./redrive.js";
import { cdmxParts } from "./time.js";

/** A live turn is done (or dead) well before this: debounce 8 s + 30 s cap. */
export const RESCUE_MIN_AGE_SEC = 4 * 60;
/** Older silences are the auditor's / staff's call, and keep the scan small (D1 rows-read). */
export const RESCUE_MAX_AGE_SEC = 3 * 3600;
/** Past this the late reply goes to Aprobar only (no auto-send, no best-bet). */
export const RESCUE_REVIEW_AFTER_SEC = 60 * 60;
export const RESCUE_PER_TICK = 3;
const CLAIM_PREFIX = "rescue:";

export interface RescueTurnOptions {
  forceReview?: boolean;
  stale?: { waitedHours: number; lastInboundCdmx: string };
  originAnswer?: { canal: string | null };
}

/**
 * Leads whose newest message is an unanswered inbound in [now−max, now−min],
 * oldest first. Driven by idx_messages_direction_ts (a few hundred inbound rows
 * per 3 h), each candidate checked by index (D1 rows-read rule).
 */
export async function findMissedTurns(db: D1Database, nowSec: number, limit: number): Promise<UnansweredRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.phone AS phone, m.wamid AS wamid, COALESCE(m.body, '') AS body, m.ts AS ts
       FROM messages m INDEXED BY idx_messages_direction_ts
       JOIN contacts c ON c.phone = m.phone
       WHERE m.direction = 'in'
         AND m.ts >= ?1 AND m.ts <= ?2
         AND c.status = 'lead'
         AND (c.human_override_until IS NULL OR c.human_override_until < ?3)
         AND m.rowid = (SELECT m2.rowid FROM messages m2 INDEXED BY idx_messages_phone_ts
                        WHERE m2.phone = m.phone
                        ORDER BY m2.ts DESC, m2.rowid DESC LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM pending_approvals pa INDEXED BY idx_pending_approvals_phone
                         WHERE pa.phone = m.phone AND (pa.status = 'pending' OR pa.created_at >= m.ts))
         AND NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = '${CLAIM_PREFIX}' || m.wamid)
       ORDER BY m.ts ASC
       LIMIT ?4`,
    )
    .bind(nowSec - RESCUE_MAX_AGE_SEC, nowSec - RESCUE_MIN_AGE_SEC, nowSec, limit + 20)
    .all<UnansweredRow>();
  return results.filter((r) => isRescuable(r.body)).slice(0, limit);
}

/** Reactions and "ahí estaré" get silence on purpose — never rescued. */
export function isRescuable(body: string): boolean {
  if (/^\s*\[reaccion/i.test(body)) return false;
  return !isReminderConfirmText(body);
}

/** How the rescued turn routes; pure. */
export function rescueTurnOptions(
  row: { ts: number },
  nowSec: number,
  origin: OriginState | null,
): RescueTurnOptions {
  const opts: RescueTurnOptions = {};
  if (nowSec - row.ts >= RESCUE_REVIEW_AFTER_SEC) {
    opts.forceReview = true;
    opts.stale = staleReplyFor(row, nowSec);
  }
  // The message being rescued (or its burst) answered "¿cómo nos encontraste?":
  // the live hint window (ORIGIN_HINT_SEC) has passed by now, so anchor on the
  // message instead.
  if (origin?.answeredAt !== undefined && origin.answeredAt >= row.ts - 120 && origin.answeredAt <= row.ts + 60) {
    opts.originAnswer = { canal: origin.canal ?? null };
  }
  return opts;
}

export interface MissedTurnDeps {
  turn(row: UnansweredRow, nowSec: number): Promise<void>;
  /** ops_log line (rescue worked). */
  postNote(text: string): Promise<void>;
  /** #wa-leads task (rescue failed too — a human must answer). */
  postTask(text: string): Promise<void>;
}

/** One tick. Never throws for a single lead (logged, claim kept). */
export async function runMissedTurnRescue(
  env: Env,
  deps: MissedTurnDeps,
  nowSec: number,
  perTick: number = RESCUE_PER_TICK,
): Promise<number> {
  if (!(await isBotEnabled(env.DB))) return 0;
  const rows = await findMissedTurns(env.DB, nowSec, perTick);
  let done = 0;
  for (const row of rows) {
    // Claim first: a tick killed mid-turn must not run the same message again.
    if (!(await kvClaimIfAbsentOrOlder(env.DB, CLAIM_PREFIX + row.wamid, nowSec, 30 * 86400))) continue;
    let failed = false;
    try {
      await deps.turn(row, nowSec);
      done++;
    } catch (err) {
      failed = true;
      console.error(`[missed-turns] turn failed for ${row.phone}: ${String(err)}`);
    }
    const p = cdmxParts(row.ts);
    const at = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    const mins = Math.round((nowSec - row.ts) / 60);
    const note = failed
      ? deps.postTask(`🛟❌ ${row.phone}: su mensaje de las ${at} se quedó sin respuesta y el reintento también falló — contéstale a mano.`)
      : deps.postNote(`🛟 ${row.phone}: su mensaje de las ${at} se quedó sin respuesta (el turno se cortó); se reprocesó ${mins} min después.`);
    await note.catch(() => {});
  }
  return done;
}
