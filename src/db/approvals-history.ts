// Pure query-param parsing + SQL building for the approvals history endpoint
// (GET /admin/api/approvals/history). No D1 handle and no Worker globals here
// so it unit-tests under `node --test`: the builder only returns a statement
// plus its positional binds, and every caller-supplied value (status, phone,
// limit, offset, timestamps) travels as a BIND — never interpolated into SQL.

import type { ApprovalStatus } from "../types.js";

/** Default history window when `since` is omitted: the last 15 days. */
const DEFAULT_WINDOW_DAYS = 15;
const DAY = 86400;

/** Same shape as the dashboard's other lists (clampLimit): default 100, cap 200. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

// Exhaustive by construction: adding a member to ApprovalStatus without adding
// it here is a compile error, so the filter can never silently reject a status.
const STATUSES: Record<ApprovalStatus, true> = {
  pending: true,
  approved: true,
  edited: true,
  taken_over: true,
  expired: true,
  discarded: true,
  superseded: true,
  // Best-bet timeout send (owner directive 2026-08-25). Listed here so the
  // history endpoint can FILTER on it — the compile error you get by omitting a
  // new status is the whole point of this map.
  auto_sent: true,
};

function isApprovalStatus(s: string): s is ApprovalStatus {
  return Object.prototype.hasOwnProperty.call(STATUSES, s);
}

export interface ApprovalHistoryQuery {
  since: number; // epoch seconds, inclusive lower bound on created_at
  until?: number; // epoch seconds, exclusive upper bound; omitted = no cap
  status?: ApprovalStatus; // omitted = every status
  phone?: string; // exact match (contacts are stored as the raw wa_id)
  limit: number;
  offset: number;
}

/**
 * Builds the parameterized history SELECT. Placeholders are numbered in bind
 * order (?1 is always `since`), so optional filters shift the later refs — that
 * bookkeeping is why this lives in one tested place instead of the route.
 */
export function buildApprovalHistorySql(q: ApprovalHistoryQuery): {
  sql: string;
  binds: unknown[];
} {
  const binds: unknown[] = [q.since];
  const where: string[] = ["created_at >= ?1"];
  if (q.until !== undefined) {
    binds.push(q.until);
    where.push(`created_at < ?${binds.length}`);
  }
  if (q.status !== undefined) {
    binds.push(q.status);
    where.push(`status = ?${binds.length}`);
  }
  if (q.phone !== undefined) {
    binds.push(q.phone);
    where.push(`phone = ?${binds.length}`);
  }
  binds.push(q.limit);
  const limitRef = `?${binds.length}`;
  binds.push(q.offset);
  const offsetRef = `?${binds.length}`;
  const sql = `SELECT id, phone, draft, final_text, confidence, status, holding_sent,
            created_at, resolved_at
     FROM pending_approvals
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limitRef} OFFSET ${offsetRef}`;
  return { sql, binds };
}

export type ParsedApprovalHistoryParams =
  | { ok: true; query: ApprovalHistoryQuery }
  | { ok: false; error: "bad_status" | "bad_since" };

/**
 * Parses the endpoint's query string. `since` defaults to now − 15 days; an
 * unparseable one is an error rather than a silent full-table scan. `status`
 * absent or "all" means no status clause; anything outside the ApprovalStatus
 * union is rejected. A malformed `until` / `limit` / `offset` falls back to its
 * default (they only narrow the page, never the safety of the query).
 */
export function parseApprovalHistoryParams(
  p: URLSearchParams,
  now: number,
): ParsedApprovalHistoryParams {
  const sinceRaw = p.get("since");
  let since = now - DEFAULT_WINDOW_DAYS * DAY;
  if (sinceRaw !== null && sinceRaw !== "") {
    const n = Number(sinceRaw);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "bad_since" };
    since = Math.floor(n);
  }

  const statusRaw = (p.get("status") ?? "").trim();
  let status: ApprovalStatus | undefined;
  if (statusRaw !== "" && statusRaw !== "all") {
    if (!isApprovalStatus(statusRaw)) return { ok: false, error: "bad_status" };
    status = statusRaw;
  }

  const untilRaw = Number(p.get("until"));
  const until =
    Number.isFinite(untilRaw) && untilRaw > 0 ? Math.floor(untilRaw) : undefined;

  const phone = (p.get("phone") ?? "").trim().slice(0, 40) || undefined;

  const limitRaw = Number(p.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const offsetRaw = Number(p.get("offset"));
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  return { ok: true, query: { since, until, status, phone, limit, offset } };
}
