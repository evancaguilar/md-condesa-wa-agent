// Outage redrive (2026-10-06). During the D1 overload every brain turn died
// after the webhook had already acked Meta, so the leads who wrote from the
// evening of 10-05 got the canned welcome (or nothing) and then silence. Evan:
// "prepare responses for every chat that needs a response and leave it in
// Aprobar for me to send each after reviewing."
//
// One-shot, kv-guarded, a few leads per cron tick (each is a full brain call).
// "Needs a response" = the phone's NEWEST message is from the lead, arrived at
// or after REDRIVE_SINCE, the contact is a lead (not student / opted out), no
// human has taken the thread (human_override), and nothing is already waiting
// in Aprobar for them. The brain turn itself runs through
// pipeline/inbound.runBrainTurn with forceReview (always Aprobar, no auto-send,
// no best-bet, no holding line) and a <respuesta_tardia> prompt note.
//
// Progress is a ts cursor (rows are processed oldest → newest), so a turn that
// produces nothing (no-reply sentinel, brain error) can never make the same
// lead come back next tick.

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { cdmxParts, cdmxToEpoch } from "./time.js";

export const REDRIVE_KEY = "redrive:2026-10-06";
/** First unanswered messages seen: the D1 rows-read spike began ~22:30 CDMX on 10-05. */
export const REDRIVE_SINCE_EPOCH = cdmxToEpoch(2026, 10, 5, 22, 0, 0);
/** Brain turns per 5-min tick (each ≈ 5–15 s and one Anthropic call). */
export const REDRIVE_PER_TICK = 6;

export interface UnansweredRow {
  phone: string;
  wamid: string;
  body: string;
  ts: number;
}

export interface RedriveState {
  cursorTs: number;
  processed: number;
  failed: number;
  done: boolean;
  startedAt: number;
}

export interface RedriveDeps {
  turn(row: UnansweredRow, nowSec: number): Promise<void>;
  postNote(text: string): Promise<void>;
}

/** Reactions ("[reaccionó ❤️]") are not messages the bot owes a reply to. */
function isReaction(body: string): boolean {
  return /^\s*\[reaccion/i.test(body);
}

/**
 * Leads whose newest message is their own, arrived in (afterTs, ∞) and at or
 * after `sinceEpoch`, oldest first. Index-pinned like the inbox query.
 */
export async function findUnanswered(
  db: D1Database,
  sinceEpoch: number,
  afterTs: number,
  nowSec: number,
  limit: number,
): Promise<UnansweredRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.phone AS phone, m.wamid AS wamid, COALESCE(m.body, '') AS body, m.ts AS ts
       FROM contacts c
       JOIN messages m INDEXED BY idx_messages_phone_ts
         ON m.phone = c.phone
        AND m.rowid = (SELECT m2.rowid FROM messages m2 INDEXED BY idx_messages_phone_ts
                       WHERE m2.phone = c.phone
                       ORDER BY m2.ts DESC, m2.rowid DESC LIMIT 1)
       WHERE c.last_inbound_at >= ?1
         AND c.status = 'lead'
         AND (c.human_override_until IS NULL OR c.human_override_until < ?3)
         AND m.direction = 'in'
         AND m.ts >= ?1 AND m.ts > ?2
         AND NOT EXISTS (SELECT 1 FROM pending_approvals pa INDEXED BY idx_pending_approvals_phone
                         WHERE pa.phone = c.phone AND pa.status = 'pending')
       ORDER BY m.ts ASC, m.rowid ASC
       LIMIT ?4`,
    )
    .bind(sinceEpoch, afterTs, nowSec, limit + 20)
    .all<UnansweredRow>();
  return results.filter((r) => !isReaction(r.body)).slice(0, limit);
}

/** The <respuesta_tardia> facts for one redriven lead. */
export function staleReplyFor(
  row: { ts: number },
  nowSec: number,
): { waitedHours: number; lastInboundCdmx: string } {
  const p = cdmxParts(row.ts);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return {
    waitedHours: (nowSec - row.ts) / 3600,
    lastInboundCdmx: `${p.day}/${p.month}/${p.year} ${hh}:${mm} (hora CDMX)`,
  };
}

async function readState(db: D1Database): Promise<RedriveState | null> {
  const raw = await kvGet(db, REDRIVE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RedriveState;
  } catch {
    return null;
  }
}

/**
 * One tick of the redrive. Returns the state after the tick. Never throws for
 * a single lead's failure (counted, logged, cursor advances).
 */
export async function runRedrive(
  env: Env,
  deps: RedriveDeps,
  nowSec: number,
  opts: { sinceEpoch?: number; perTick?: number } = {},
): Promise<RedriveState> {
  const since = opts.sinceEpoch ?? REDRIVE_SINCE_EPOCH;
  const perTick = opts.perTick ?? REDRIVE_PER_TICK;
  const state: RedriveState = (await readState(env.DB)) ?? {
    cursorTs: 0,
    processed: 0,
    failed: 0,
    done: false,
    startedAt: nowSec,
  };
  if (state.done) return state;

  const rows = await findUnanswered(env.DB, since, state.cursorTs, nowSec, perTick);
  for (const row of rows) {
    try {
      await deps.turn(row, nowSec);
      state.processed++;
    } catch (err) {
      state.failed++;
      console.error(`[redrive] turn failed for ${row.phone}: ${String(err)}`);
    }
    state.cursorTs = Math.max(state.cursorTs, row.ts);
    // Persist after EVERY lead: a tick killed mid-way must not redo a brain call.
    await kvSet(env.DB, REDRIVE_KEY, JSON.stringify(state));
  }

  if (rows.length < perTick) {
    state.done = true;
    await kvSet(env.DB, REDRIVE_KEY, JSON.stringify(state));
    await deps.postNote(
      `🔁 Reproceso de la caída de D1 terminado: ${state.processed} chat(s) sin respuesta pasaron por el cerebro y esperan en *Aprobar* (solo revisión: sin envío automático ni best-bet)` +
        (state.failed ? ` · ${state.failed} fallaron (ver logs)` : "") +
        ".",
    );
  }
  return state;
}
