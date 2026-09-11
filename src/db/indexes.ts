// Additive D1 indexes, applied from the worker (kv-guarded, idempotent).
//
// Why from the worker: local wrangler is on the wrong Cloudflare account
// (CLAUDE.md §3), and on 2026-08-25 Evan asked for the created_at index to be
// applied this way. Same pattern here, one guard key for the whole batch.
//
// Why these (2026-09-10 D1 free-tier incident, 5M rows read/day exhausted):
//   - pending_approvals(phone): the chat-detail poll (every 5s) and the inbox
//     list count approvals per phone — without it every call is a full scan.
//   - pending_approvals(status): cron's getPendingApprovals every 5 min, the
//     overview's pending count every 30s, the inbox change fingerprint.
//   - followups(status, due_at): cron's dueFollowups every 5 min.
//   - messages(direction, ts): overview convosToday/Week (direction + ts
//     range), booking recon's outbound window.
//   - contacts(updated_at): MAX(updated_at) in the inbox change fingerprint.
// Mirrored at the end of src/db/schema.sql.

import { kvGet, kvSet } from "./queries.js";

export const INDEX_MIGRATION_KEY = "migr_idx_2026_09_11";

export const INDEX_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_pending_approvals_phone ON pending_approvals(phone)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status)`,
  `CREATE INDEX IF NOT EXISTS idx_followups_status_due ON followups(status, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_direction_ts ON messages(direction, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at)`,
];

// Per-isolate memo so a warm worker pays the kv read once, not per request.
let ensuredInIsolate = false;

/** Test hook: forget the per-isolate memo. */
export function resetIndexMemoForTests(): void {
  ensuredInIsolate = false;
}

/**
 * Creates the indexes above unless the kv guard says they already exist.
 * Returns true when it actually ran the CREATEs. Throws on a D1 error so the
 * guard stays unset and the next caller retries.
 */
export async function ensureIndexes(db: D1Database): Promise<boolean> {
  if (ensuredInIsolate) return false;
  if (await kvGet(db, INDEX_MIGRATION_KEY)) {
    ensuredInIsolate = true;
    return false;
  }
  for (const sql of INDEX_SQL) await db.prepare(sql).run();
  await kvSet(db, INDEX_MIGRATION_KEY, "1");
  ensuredInIsolate = true;
  return true;
}
