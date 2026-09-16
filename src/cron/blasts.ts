// Blast drain: every 5-min tick, send up to `perTick` queued `blast` rows
// (src/services/blast.ts) inside 09:00–21:00 CDMX and under the run's per-day
// cap. Rows are claimed (status 'sent') BEFORE the Graph call, so a tick that
// dies mid-batch can never resend; a failed claim-then-send lands the row in
// 'failed' (per-recipient error) or back in 'scheduled' (transient), and a
// template/account error pauses the whole run and tells Slack once.
//
// Subrequest budget (free plan: 50 per invocation): one batch query, one kv
// read for the day counter (+ one write), one kv read per run touched, and
// ~5 per send (claim, Graph POST, wamid + message rows, [fail/retry update]).

import type { Env } from "../types.js";
import type { CronSlackDeps } from "./deps.js";
import { kvGet, kvSet } from "../db/queries.js";
import { sendTemplate, sendText, WindowClosedError } from "../services/send.js";
import {
  BLAST_PER_TICK,
  BLAST_PER_TICK_MAX,
  blastWindowOpen,
  classifySendError,
  decodeBlastNote,
  getRunMeta,
  loadRunCounts,
  markRowFailed,
  saveRunMeta,
  setRunRowsStatus,
  templateComponents,
  type BlastPayload,
  type BlastRunMeta,
} from "../services/blast.js";
import { cdmxDateStr } from "./time.js";

/** Transient (rate-limit / 5xx) retries before a row is given up as failed. */
export const MAX_RETRY_ATTEMPTS = 3;
export const KV_PER_TICK = "blast_per_tick";
export const KV_SENT_DAY_PREFIX = "blast_sent:";

interface DueBlastRow {
  id: number;
  phone: string;
  note: string | null;
  rid: string | null;
  c_status: string | null;
  c_name: string | null;
}

export interface BlastBatchResult {
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
  pausedRun: string | null;
  finishedRuns: string[];
  /** Why nothing ran (window closed, nothing due, cap reached). */
  idle: string | null;
}

export interface BlastDrainDeps {
  slack: CronSlackDeps;
  /** Injectable for tests. */
  sendTemplate?: typeof sendTemplate;
  sendText?: typeof sendText;
}

/** Sends per tick: kv `blast_per_tick` (1..MAX) or the default. */
async function perTickLimit(env: Env): Promise<number> {
  const raw = await kvGet(env.DB, KV_PER_TICK);
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 1) return BLAST_PER_TICK;
  return Math.min(BLAST_PER_TICK_MAX, Math.floor(n));
}

export async function runBlastBatch(
  env: Env,
  deps: BlastDrainDeps,
  nowEpoch: number,
): Promise<BlastBatchResult> {
  const result: BlastBatchResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    retried: 0,
    pausedRun: null,
    finishedRuns: [],
    idle: null,
  };
  if (!blastWindowOpen(nowEpoch)) {
    result.idle = "window";
    return result;
  }
  const limit = await perTickLimit(env);
  const { results: rows } = await env.DB.prepare(
    `SELECT f.id, f.phone, f.note, f.airtable_record_id AS rid,
            c.status AS c_status, c.name AS c_name
       FROM followups f LEFT JOIN contacts c ON c.phone = f.phone
      WHERE f.kind = 'blast' AND f.status = 'scheduled' AND f.due_at <= ?1
      ORDER BY f.due_at ASC, f.id ASC LIMIT ?2`,
  )
    .bind(nowEpoch, limit)
    .all<DueBlastRow>();
  if (rows.length === 0) {
    result.idle = "nothing_due";
    return result;
  }

  const dayKey = KV_SENT_DAY_PREFIX + cdmxDateStr(nowEpoch);
  let sentToday = Number((await kvGet(env.DB, dayKey)) ?? "0") || 0;
  const startCount = sentToday;
  const metas = new Map<string, BlastRunMeta | null>();
  const touched = new Set<string>();
  const doSendTemplate = deps.sendTemplate ?? sendTemplate;
  const doSendText = deps.sendText ?? sendText;

  for (const row of rows) {
    const runId = (row.rid ?? "").startsWith("blast:") ? (row.rid ?? "").slice(6) : "";
    if (!metas.has(runId)) metas.set(runId, runId ? await getRunMeta(env, runId) : null);
    const meta = metas.get(runId) ?? null;
    if (meta && meta.status !== "active") continue; // rows should already be paused/cancelled
    if (meta && meta.startAt > nowEpoch) continue; // scheduled for later (due_at was clamped)
    touched.add(runId);

    const payload = decodeBlastNote(row.note);
    if (!payload) {
      await env.DB.prepare(`UPDATE followups SET status = 'failed' WHERE id = ?1`).bind(row.id).run();
      result.failed++;
      continue;
    }
    if (row.c_status === "opted_out") {
      await env.DB.prepare(`UPDATE followups SET status = 'skipped_optout' WHERE id = ?1`)
        .bind(row.id)
        .run();
      result.skipped++;
      continue;
    }
    const cap = meta?.dailyCap ?? Number.POSITIVE_INFINITY;
    if (sentToday >= cap) {
      result.idle = "daily_cap";
      break;
    }

    // Claim first: at-most-once even if the invocation dies after the POST.
    const claim = await env.DB.prepare(
      `UPDATE followups SET status = 'sent' WHERE id = ?1 AND status = 'scheduled'`,
    )
      .bind(row.id)
      .run();
    if ((claim.meta.changes ?? 0) === 0) continue;

    const name = payload.nm ?? row.c_name;
    try {
      if (payload.txt) {
        // Freeform: only while the lead's window is open; a closed window is a
        // quiet per-recipient skip, never a template fallback.
        try {
          await doSendText(env, row.phone, payload.txt);
        } catch (err) {
          if (err instanceof WindowClosedError) {
            await markRowFailed(env, row.id, payload, "ventana de 24h cerrada");
            result.failed++;
            continue;
          }
          throw err;
        }
      } else {
        // force: opt-out was checked in the batch query (one JOIN, not one
        // getContact per row) — this keeps the send at ~4 subrequests.
        await doSendTemplate(
          env,
          row.phone,
          payload.t,
          payload.l,
          templateComponents(payload, name),
          { force: true },
        );
      }
      result.sent++;
      sentToday++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const { cls } = classifySendError(msg);
      if (cls === "skip") {
        await markRowFailed(env, row.id, payload, msg);
        result.failed++;
        continue;
      }
      if (cls === "retry") {
        const attempts = (payload.a ?? 0) + 1;
        if (attempts >= MAX_RETRY_ATTEMPTS) {
          await markRowFailed(env, row.id, payload, msg);
          result.failed++;
        } else {
          await env.DB.prepare(`UPDATE followups SET status = 'scheduled', note = ?2 WHERE id = ?1`)
            .bind(row.id, JSON.stringify({ ...payload, a: attempts }))
            .run();
          result.retried++;
        }
        break; // rate-limited: stop this tick, the next one retries
      }
      // pause: the run cannot proceed (template missing/unapproved, account,
      // auth, media). Put this row back, freeze the rest, tell Slack once.
      await env.DB.prepare(`UPDATE followups SET status = 'paused', note = ?2 WHERE id = ?1`)
        .bind(row.id, JSON.stringify({ ...payload, err: msg.slice(0, 300) }))
        .run();
      if (runId) {
        await setRunRowsStatus(env, runId, ["scheduled"], "paused");
        if (meta) {
          meta.status = "paused";
          meta.pausedReason = msg.slice(0, 300);
          meta.updatedAt = nowEpoch;
          await saveRunMeta(env, meta);
        }
      }
      result.pausedRun = runId || null;
      await deps.slack.postNote(
        `⏸️ Envío masivo *${meta?.name ?? runId}* pausado automáticamente: ${msg}\n` +
          `Corrige (plantilla aprobada / nombre e idioma exactos / link del encabezado) y reanuda desde /admin → Envíos.`,
      );
      break;
    }
  }

  if (sentToday !== startCount) await kvSet(env.DB, dayKey, String(sentToday));

  // A run whose last sendable row just went out is done — say so once.
  if (result.sent > 0 || result.failed > 0 || result.skipped > 0) {
    const counts = await loadRunCounts(env);
    for (const runId of touched) {
      const meta = metas.get(runId) ?? null;
      if (!meta || meta.status !== "active") continue;
      const c = counts.get(runId);
      if (!c || c.scheduled + c.paused > 0) continue;
      meta.status = "done";
      meta.updatedAt = nowEpoch;
      await saveRunMeta(env, meta);
      result.finishedRuns.push(runId);
      await deps.slack.postNote(
        `✅ Envío masivo *${meta.name}* terminado: ${c.sent} enviados · ${c.failed} fallidos · ${c.skipped} baja · ${c.cancelled} cancelados (de ${meta.total}).`,
      );
    }
  }
  return result;
}

/** For the dashboard: today's sent count under the cap. */
export async function sentTodayCount(env: Env, nowEpoch: number): Promise<number> {
  return Number((await kvGet(env.DB, KV_SENT_DAY_PREFIX + cdmxDateStr(nowEpoch))) ?? "0") || 0;
}

export type { BlastPayload };
