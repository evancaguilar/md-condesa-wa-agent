// Audit export (2026-10-11): everything that happened in a time window, as
// JSON, so a weekly review (or the regression harness) can read the real
// transcripts without a D1 console. Owner-only route; read-only queries.
//
// Why: the 2026-10-09 audit had to be rebuilt twice — Slack cards are
// rewritten when resolved and dashboard approvals never reach Slack, so the
// lead-side text only exists here. Bounded (≤ 7 days, ≤ 20k rows per table)
// so a careless call cannot blow the D1 rows-read budget.

export const EXPORT_MAX_SPAN_SECONDS = 7 * 86400;
export const EXPORT_ROW_CAP = 20000;

export interface ExportWindow {
  since: number; // epoch seconds, inclusive
  until: number; // epoch seconds, exclusive
}

/** Clamp a requested window: `until` defaults to now, span to ≤ 7 days. */
export function clampExportWindow(
  sinceRaw: string | null,
  untilRaw: string | null,
  now: number,
): ExportWindow | null {
  const since = Number(sinceRaw);
  if (!Number.isFinite(since) || since <= 0) return null;
  const untilN = Number(untilRaw);
  const until = Number.isFinite(untilN) && untilN > since ? Math.floor(untilN) : now;
  const start = Math.max(Math.floor(since), until - EXPORT_MAX_SPAN_SECONDS);
  return { since: start, until };
}

export interface ExportBundle {
  window: ExportWindow;
  truncated: boolean;
  messages: Array<{
    phone: string;
    direction: string;
    body: string | null;
    ts: number;
    meta: string | null;
  }>;
  approvals: Array<{
    id: number;
    phone: string;
    draft: string | null;
    final_text: string | null;
    confidence: string | null;
    status: string;
    created_at: number;
    resolved_at: number | null;
  }>;
  followups: Array<{
    id: number;
    phone: string;
    kind: string;
    due_at: number;
    status: string;
    airtable_record_id: string | null;
    note: string | null;
    created_at: number;
  }>;
  contacts: Array<{
    phone: string;
    name: string | null;
    status: string;
    qualification: string | null;
    campaign_id: number | null;
    airtable_lead_id: string | null;
  }>;
}

export async function exportWindow(db: D1Database, w: ExportWindow): Promise<ExportBundle> {
  const cap = EXPORT_ROW_CAP + 1;
  const messages = (
    await db
      .prepare(
        `SELECT phone, direction, body, ts, meta FROM messages
         WHERE ts >= ?1 AND ts < ?2 ORDER BY phone, ts LIMIT ?3`,
      )
      .bind(w.since, w.until, cap)
      .all<ExportBundle["messages"][number]>()
  ).results;
  const approvals = (
    await db
      .prepare(
        `SELECT id, phone, draft, final_text, confidence, status, created_at, resolved_at
         FROM pending_approvals WHERE created_at >= ?1 AND created_at < ?2
         ORDER BY id LIMIT ?3`,
      )
      .bind(w.since, w.until, cap)
      .all<ExportBundle["approvals"][number]>()
  ).results;
  const followups = (
    await db
      .prepare(
        `SELECT id, phone, kind, due_at, status, airtable_record_id, note, created_at
         FROM followups WHERE due_at >= ?1 AND due_at < ?2 ORDER BY due_at LIMIT ?3`,
      )
      .bind(w.since, w.until, cap)
      .all<ExportBundle["followups"][number]>()
  ).results;
  const phones = [...new Set(messages.map((m) => m.phone))];
  const contacts: ExportBundle["contacts"] = [];
  // D1 binds are limited per statement; chunk the IN list.
  for (let i = 0; i < phones.length; i += 50) {
    const chunk = phones.slice(i, i + 50);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(",");
    const rows = (
      await db
        .prepare(
          `SELECT phone, name, status, qualification, campaign_id, airtable_lead_id
           FROM contacts WHERE phone IN (${marks})`,
        )
        .bind(...chunk)
        .all<ExportBundle["contacts"][number]>()
    ).results;
    contacts.push(...rows);
  }
  const truncated =
    messages.length > EXPORT_ROW_CAP ||
    approvals.length > EXPORT_ROW_CAP ||
    followups.length > EXPORT_ROW_CAP;
  return {
    window: w,
    truncated,
    messages: messages.slice(0, EXPORT_ROW_CAP),
    approvals: approvals.slice(0, EXPORT_ROW_CAP),
    followups: followups.slice(0, EXPORT_ROW_CAP),
    contacts,
  };
}
