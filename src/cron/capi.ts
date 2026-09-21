// Drain for the Meta Conversions API queue (docs/meta-capi.md).
//
// The funnel hooks only write kv rows (`capi_q:<eventId>`); this job POSTs a
// few of them per tick. Budget: at most CAPI_MAX_PER_TICK (5) Graph subrequests
// per tick, and ZERO queries at all on an idle tick (the `capi_pending` gate).
//
// One POST PER EVENT on purpose: Meta rejects the entire request when any event
// in it is invalid, so a batch would let one bad row drop good conversions.
//
// Failure policy: a failed row stays queued with a bumped attempt count
// (retried next tick) and records `capi_last_error`; after CAPI_MAX_ATTEMPTS it
// is dropped so a poisoned payload can never wedge the queue. At most ONE Slack
// note per CDMX day. Nothing here throws into the dispatcher — and it is
// wrapped in safe() there anyway.

import type { Env } from "../types.js";
import { kvDelete, kvGet, kvSet } from "../db/queries.js";
import { cdmxDateStr } from "./time.js";
import {
  CAPI_MAX_ATTEMPTS,
  CAPI_MAX_PER_TICK,
  KV_CAPI_COUNT_PREFIX,
  KV_CAPI_LAST_ERROR,
  KV_CAPI_LAST_OK,
  KV_CAPI_NOTE_PREFIX,
  KV_CAPI_PENDING,
  KV_CAPI_QUEUE_PREFIX,
  capiConfig,
  eventFromQueued,
  capiEventFresh,
  parseQueuedEvent,
  sendMessagingEvents,
  type MessagingEvent,
  type QueuedCapiEvent,
} from "../services/meta-capi.js";

export interface CapiDrainResult {
  sent: number;
  /** Rows dropped because they aged out of Meta's window or were malformed. */
  dropped: number;
  failed: number;
  skipped: "disabled" | "empty" | null;
  error: string | null;
}

interface QueueRow {
  key: string;
  row: QueuedCapiEvent;
}

/**
 * One drain pass. `send` is injectable for tests; it is the only thing here
 * that touches the network.
 */
export async function runCapiDrain(
  env: Env,
  nowSec: number,
  deps: { postNote: (text: string) => Promise<void> },
  send: typeof sendMessagingEvents = sendMessagingEvents,
): Promise<CapiDrainResult> {
  const empty: CapiDrainResult = { sent: 0, dropped: 0, failed: 0, skipped: null, error: null };
  const cfg = capiConfig(env);
  if (!cfg.enabled || !cfg.wabaId) return { ...empty, skipped: "disabled" };

  // Idle gate: ONE primary-key read when there is nothing queued, instead of a
  // `LIKE 'capi_q:%'` scan of kv on every 5-minute tick (docs/STATUS.md — three
  // D1 rows-read outages came from exactly that pattern).
  if ((await kvGet(env.DB, KV_CAPI_PENDING)) !== "1") return { ...empty, skipped: "empty" };
  // Cleared BEFORE the work, not after: an enqueue that lands while this pass is
  // sending re-sets the flag, so a wakeup can never be lost. Anything still
  // waiting when the pass ends re-arms it below.
  await kvSet(env.DB, KV_CAPI_PENDING, "0");

  const { results } = await env.DB.prepare(
    `SELECT key, value FROM kv WHERE key LIKE '${KV_CAPI_QUEUE_PREFIX}%' ORDER BY key LIMIT ?1`,
  )
    .bind(CAPI_MAX_PER_TICK)
    .all<{ key: string; value: string }>();
  if (results.length === 0) return { ...empty, skipped: "empty" };

  const live: QueueRow[] = [];
  let dropped = 0;
  for (const r of results) {
    const row = parseQueuedEvent(r.value);
    // Malformed row, or one that sat in the queue past Meta's age window:
    // drop it rather than retry forever. The claim row stays, so nothing
    // re-queues it either.
    if (!row || !capiEventFresh(row.eventTime, nowSec)) {
      await kvDelete(env.DB, r.key);
      dropped++;
      continue;
    }
    live.push({ key: r.key, row });
  }
  if (live.length === 0) {
    // A full page of stale rows means there may be more behind them.
    if (results.length >= CAPI_MAX_PER_TICK) await kvSet(env.DB, KV_CAPI_PENDING, "1");
    return { ...empty, dropped };
  }

  let sent = 0;
  let failed = 0;
  let error: string | null = null;
  for (const q of live) {
    const event: MessagingEvent = eventFromQueued(q.row, cfg.wabaId);
    const res = await send(env, [event]);
    if (res.ok) {
      await kvDelete(env.DB, q.key);
      sent++;
      continue;
    }
    error = res.error ?? res.skipped ?? "unknown error";
    const attempts = (q.row.attempts ?? 0) + 1;
    if (attempts >= CAPI_MAX_ATTEMPTS) {
      await kvDelete(env.DB, q.key);
      dropped++;
    } else {
      await kvSet(env.DB, q.key, JSON.stringify({ ...q.row, attempts }));
      failed++;
    }
  }

  const stamp = new Date(nowSec * 1000).toISOString();
  if (sent > 0) {
    await kvSet(env.DB, KV_CAPI_LAST_OK, `${stamp} ${sent}`);
    await bumpDailyCount(env, cdmxDateStr(nowSec), sent);
  }
  if (error !== null) {
    // res.error is already token-free (sendMessagingEvents redacts).
    await kvSet(env.DB, KV_CAPI_LAST_ERROR, `${stamp} ${error}`);
    await noteOncePerDay(
      env,
      deps,
      nowSec,
      `⚠️ Conversions API (Meta): no pude enviar ${failed + dropped} evento(s) de conversión — ${error}. Revisa /admin/api/capi/probe (docs/meta-capi.md).`,
    );
  }
  // Re-arm when this pass left work behind: rows to retry, or a full page that
  // probably has more rows behind it.
  if (failed > 0 || results.length >= CAPI_MAX_PER_TICK) {
    await kvSet(env.DB, KV_CAPI_PENDING, "1");
  }
  return { sent, dropped, failed, skipped: null, error };
}

async function bumpDailyCount(env: Env, day: string, n: number): Promise<void> {
  const key = `${KV_CAPI_COUNT_PREFIX}${day}`;
  const current = Number((await kvGet(env.DB, key)) ?? 0) || 0;
  await kvSet(env.DB, key, String(current + n));
}

async function noteOncePerDay(
  env: Env,
  deps: { postNote: (text: string) => Promise<void> },
  nowSec: number,
  text: string,
): Promise<void> {
  const key = `${KV_CAPI_NOTE_PREFIX}${cdmxDateStr(nowSec)}`;
  if (await kvGet(env.DB, key)) return;
  await kvSet(env.DB, key, "1");
  try {
    await deps.postNote(text);
  } catch (err) {
    console.warn(`[capi] slack note failed: ${String(err)}`);
  }
}
