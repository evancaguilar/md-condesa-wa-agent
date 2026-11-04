// D1 layer of the nudge catch-up (pure logic: ./nudge-catchup.ts). One indexed
// scan over contacts, then batched per-phone probes in chunks (D1 caps bound
// parameters at 100 per statement), so a 2,000-lead dry run costs ~110
// statements. No Airtable / Graph calls: zero subrequests. Apply mode only
// INSERTS followups rows (token seq:catchup:<runId>) — the cron sends them.
//
// Query plan (each pinned to an index; see test/nudge-catchup.test.ts):
//   contacts scan        → idx_contacts_created (created_at range, DESC)
//   campaigns names      → full read of the tiny campaigns table
//   pending approvals    → idx_pending_approvals_status
//   followups probe      → sqlite_autoindex_followups_1 (phone, kind, …)
//   booking markers (kv) → sqlite_autoindex_kv_1 (key)
//   messages probe       → idx_messages_phone_ts (phone, ts ≥ now−7d)

import { PAST_BOOKING_KINDS, ALL_EXTENDED_KINDS, extendedChainKinds } from "../cron/nudges.js";
import { bookingRecordedKey } from "./booking-core.js";
import { kvSet, scheduleOrReviveFollowupStmt } from "../db/queries.js";
import {
  BUY_INTENT_WINDOW_SECONDS,
  catchupKvKey,
  catchupToken,
  classifyCatchupLead,
  emptySkipCounts,
  planCatchup,
  rowSkipReason,
  summarizeCatchup,
  type CatchupContactRow,
  type CatchupLead,
  type CatchupOptions,
  type CatchupSummary,
  type ProbeFollowup,
  type ProbeMessage,
  type SkipReason,
} from "./nudge-catchup.js";

/** Phones per probe statement (+ ≤20 kinds stays under D1's 100 bound params). */
export const PROBE_CHUNK = 60;

export const CATCHUP_SQL = {
  contacts: `SELECT phone, name, lang, status, qualification, human_override_until,
                    last_inbound_at, campaign_id, created_at
               FROM contacts WHERE created_at >= ?1
              ORDER BY created_at DESC LIMIT ?2`,
  campaigns: `SELECT id, name FROM campaigns`,
  pending: `SELECT DISTINCT phone FROM pending_approvals WHERE status = 'pending'`,
  followups: (nPhones: number, nKinds: number): string =>
    `SELECT phone, kind, status, due_at FROM followups
      WHERE phone IN (${ph(1, nPhones)}) AND kind IN (${ph(nPhones + 1, nKinds)})`,
  kv: (n: number): string => `SELECT key, value FROM kv WHERE key IN (${ph(1, n)})`,
  messages: (n: number): string =>
    `SELECT phone, direction, CASE WHEN direction = 'in' THEN body END AS body, ts
       FROM messages WHERE phone IN (${ph(1, n)}) AND ts >= ?${n + 1}`,
};

function ph(from: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `?${from + i}`).join(", ");
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

export interface CatchupResult extends CatchupSummary {
  ok: true;
  dryRun: boolean;
  runId: number;
  token: string;
  startAt: string;
  window: { since: string; until: string };
  scanned: number;
  truncated: boolean;
  scheduled: number;
  skipped: Record<SkipReason, number>;
  statements: number;
}

/**
 * Select, plan and (unless dryRun) insert the catch-up rows. `postNote` gets
 * ONE ops_log line in apply mode. Never sends anything.
 */
export async function runNudgeCatchup(
  db: D1Database,
  opts: CatchupOptions,
  now: number,
  deps: { postNote?: (text: string) => Promise<void>; day7?: boolean } = {},
): Promise<CatchupResult> {
  let statements = 0;
  const all = async <T>(sql: string, binds: unknown[]): Promise<T[]> => {
    statements++;
    const { results } = await db.prepare(sql).bind(...binds).all<T>();
    return results;
  };

  const since = now - opts.sinceDays * 86400;
  const scan = await all<CatchupContactRow>(CATCHUP_SQL.contacts, [since, opts.limit]);
  const skipped = emptySkipCounts();

  // Row-only checks first: the probes only touch phones that survive them.
  const survivors: CatchupContactRow[] = [];
  for (const row of scan) {
    const r = rowSkipReason(row, now, opts.excludePhones);
    if (r) skipped[r]++;
    else survivors.push(row);
  }

  const pendingSet = new Set<string>();
  const fuBy = new Map<string, ProbeFollowup[]>();
  const markerBy = new Map<string, string>();
  const msgBy = new Map<string, ProbeMessage[]>();
  if (survivors.length > 0) {
    for (const r of await all<{ phone: string }>(CATCHUP_SQL.pending, [])) pendingSet.add(r.phone);
    const kinds = [...PAST_BOOKING_KINDS, ...ALL_EXTENDED_KINDS];
    for (const chunk of chunks(survivors.map((s) => s.phone), PROBE_CHUNK)) {
      for (const r of await all<ProbeFollowup & { phone: string }>(
        CATCHUP_SQL.followups(chunk.length, kinds.length),
        [...chunk, ...kinds],
      )) {
        push(fuBy, r.phone, { kind: r.kind, status: r.status, due_at: r.due_at });
      }
      const keys = chunk.map(bookingRecordedKey);
      for (const r of await all<{ key: string; value: string }>(CATCHUP_SQL.kv(keys.length), keys)) {
        markerBy.set(r.key, r.value);
      }
      for (const r of await all<ProbeMessage & { phone: string }>(
        CATCHUP_SQL.messages(chunk.length),
        [...chunk, now - BUY_INTENT_WINDOW_SECONDS],
      )) {
        push(msgBy, r.phone, { direction: r.direction, body: r.body, ts: r.ts });
      }
    }
  }

  const chain = extendedChainKinds(deps.day7 === true);
  const leads: CatchupLead[] = [];
  for (const row of survivors) {
    const v = classifyCatchupLead(
      row,
      {
        pendingApproval: pendingSet.has(row.phone),
        bookingMarker: markerBy.get(bookingRecordedKey(row.phone)) ?? null,
        followups: fuBy.get(row.phone) ?? [],
        messages: msgBy.get(row.phone) ?? [],
      },
      now,
      chain,
      opts.excludePhones,
    );
    if (v.skip) skipped[v.skip]++;
    else leads.push({ row, sentKinds: v.sentKinds, nextKinds: v.nextKinds });
  }

  const campaignNames = new Map<number, string>();
  if (leads.length > 0) {
    for (const c of await all<{ id: number; name: string }>(CATCHUP_SQL.campaigns, [])) {
      campaignNames.set(c.id, c.name);
    }
  }

  const plan = planCatchup(leads, opts.perDay, opts.startAt);
  const summary = summarizeCatchup(plan, now, campaignNames);
  const runId = opts.startAt;
  const token = catchupToken(runId);

  let scheduled = 0;
  if (!opts.dryRun && plan.length > 0) {
    const stmts = plan.flatMap((p) =>
      p.rows.map((r) =>
        scheduleOrReviveFollowupStmt(db, {
          phone: p.row.phone,
          kind: r.kind,
          dueAt: r.dueAt,
          airtableRecordId: token,
          note: null,
        }),
      ),
    );
    // db.batch = one round trip per 100 rows (and atomic per batch).
    const batch = (db as { batch?: (s: D1PreparedStatement[]) => Promise<unknown> }).batch;
    if (typeof batch === "function") {
      for (const b of chunks(stmts, 100)) {
        statements += b.length;
        await batch.call(db, b);
      }
    } else {
      for (const s of stmts) {
        statements++;
        await s.run();
      }
    }
    scheduled = plan.length;
  }

  const result: CatchupResult = {
    ok: true,
    dryRun: opts.dryRun,
    runId,
    token,
    startAt: new Date(opts.startAt * 1000).toISOString(),
    window: { since: new Date(since * 1000).toISOString(), until: new Date(now * 1000).toISOString() },
    scanned: scan.length,
    truncated: scan.length >= opts.limit,
    ...summary,
    scheduled,
    skipped,
    statements,
  };

  if (!opts.dryRun) {
    const { sample: _sample, ...rest } = result;
    await kvSet(db, catchupKvKey(runId), JSON.stringify({ ...rest, appliedAt: new Date(now * 1000).toISOString() }));
    statements++;
    result.statements = statements;
    await deps.postNote?.(
      `🔁 Catch-up de nudges ${token}: ${scheduled} leads, ${summary.rows} envíos programados ` +
        `(${summary.days} días desde ${result.startAt}, ~${summary.estTemplateSends} plantillas). ` +
        `Siguiente paso: ${Object.entries(summary.byNextStep).map(([k, n]) => `${k} ${n}`).join(", ") || "—"}. ` +
        `Omitidos: ${Object.entries(skipped).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "—"}.`,
    );
  }
  return result;
}
