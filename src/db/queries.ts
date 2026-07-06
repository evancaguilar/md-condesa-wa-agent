// Typed query layer over D1. This is a shared contract (workstreams B/C/D call
// these); keep signatures stable.

import type {
  ApprovalStatus,
  Confidence,
  Contact,
  Followup,
  FollowupKind,
  Language,
  PendingApproval,
  StoredMessage,
} from "../types.js";

const now = (): number => Math.floor(Date.now() / 1000);

// ---- contacts ----

export interface UpsertContactInput {
  phone: string;
  name?: string | null;
  lang?: Language;
}

/** Creates the contact if absent; otherwise fills name/lang only when provided. */
export async function upsertContact(
  db: D1Database,
  input: UpsertContactInput,
): Promise<void> {
  const t = now();
  await db
    .prepare(
      `INSERT INTO contacts(phone, name, lang, status, created_at, updated_at)
       VALUES(?1, ?2, COALESCE(?3, 'es'), 'lead', ?4, ?4)
       ON CONFLICT(phone) DO UPDATE SET
         name = COALESCE(?2, contacts.name),
         lang = COALESCE(?3, contacts.lang),
         updated_at = ?4`,
    )
    .bind(input.phone, input.name ?? null, input.lang ?? null, t)
    .run();
}

export async function getContact(
  db: D1Database,
  phone: string,
): Promise<Contact | null> {
  return await db
    .prepare(`SELECT * FROM contacts WHERE phone = ?1`)
    .bind(phone)
    .first<Contact>();
}

/** Records an inbound arrival time (drives the 24h window). */
export async function touchLastInbound(
  db: D1Database,
  phone: string,
  ts: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts SET last_inbound_at = ?2, updated_at = ?3 WHERE phone = ?1`,
    )
    .bind(phone, ts, now())
    .run();
}

export async function setContactStatus(
  db: D1Database,
  phone: string,
  status: Contact["status"],
): Promise<void> {
  await db
    .prepare(`UPDATE contacts SET status = ?2, updated_at = ?3 WHERE phone = ?1`)
    .bind(phone, status, now())
    .run();
}

export async function setQualification(
  db: D1Database,
  phone: string,
  qualificationJson: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts SET qualification = ?2, updated_at = ?3 WHERE phone = ?1`,
    )
    .bind(phone, qualificationJson, now())
    .run();
}

/** Sets human_override_until = now + hours*3600. */
export async function setHumanOverride(
  db: D1Database,
  phone: string,
  hours: number,
): Promise<number> {
  const until = now() + Math.round(hours * 3600);
  await db
    .prepare(
      `UPDATE contacts SET human_override_until = ?2, updated_at = ?3 WHERE phone = ?1`,
    )
    .bind(phone, until, now())
    .run();
  return until;
}

// ---- messages ----

export interface InsertMessageInput {
  wamid: string;
  phone: string;
  direction: StoredMessage["direction"];
  body: string;
  ts: number;
  meta?: string | null;
}

/**
 * The dedupe primitive. INSERT OR IGNORE on the wamid PK; returns true only if
 * a new row was actually inserted (false ⇒ webhook retry / duplicate).
 */
export async function insertMessageIfNew(
  db: D1Database,
  input: InsertMessageInput,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO messages(wamid, phone, direction, body, ts, meta)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      input.wamid,
      input.phone,
      input.direction,
      input.body,
      input.ts,
      input.meta ?? null,
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Recent messages for a phone, newest-first from the DB then reversed to oldest→newest. */
export async function recentMessages(
  db: D1Database,
  phone: string,
  limit: number,
  sinceEpoch?: number,
): Promise<StoredMessage[]> {
  const stmt =
    sinceEpoch === undefined
      ? db
          .prepare(
            `SELECT * FROM messages WHERE phone = ?1 ORDER BY ts DESC LIMIT ?2`,
          )
          .bind(phone, limit)
      : db
          .prepare(
            `SELECT * FROM messages WHERE phone = ?1 AND ts >= ?3 ORDER BY ts DESC LIMIT ?2`,
          )
          .bind(phone, limit, sinceEpoch);
  const { results } = await stmt.all<StoredMessage>();
  return results.reverse();
}

/** wamid of the newest inbound message for a phone (debounce re-check). */
export async function newestInboundWamid(
  db: D1Database,
  phone: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT wamid FROM messages WHERE phone = ?1 AND direction = 'in' ORDER BY ts DESC LIMIT 1`,
    )
    .bind(phone)
    .first<{ wamid: string }>();
  return row?.wamid ?? null;
}

// ---- pending approvals ----

export interface CreateApprovalInput {
  phone: string;
  draft: string;
  context?: string | null;
  confidence: Confidence;
  slackTs?: string | null;
}

export async function createApproval(
  db: D1Database,
  input: CreateApprovalInput,
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO pending_approvals(phone, draft, context, confidence, slack_ts, status, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, 'pending', ?6)`,
    )
    .bind(
      input.phone,
      input.draft,
      input.context ?? null,
      input.confidence,
      input.slackTs ?? null,
      now(),
    )
    .run();
  return res.meta.last_row_id as number;
}

export async function setApprovalSlackTs(
  db: D1Database,
  id: number,
  slackTs: string,
): Promise<void> {
  await db
    .prepare(`UPDATE pending_approvals SET slack_ts = ?2 WHERE id = ?1`)
    .bind(id, slackTs)
    .run();
}

export async function resolveApproval(
  db: D1Database,
  id: number,
  status: ApprovalStatus,
  finalText?: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_approvals
       SET status = ?2, resolved_at = ?3, final_text = ?4
       WHERE id = ?1`,
    )
    .bind(id, status, now(), finalText ?? null)
    .run();
}

/** Cancels all still-pending approvals for a phone (e.g. human takeover). */
export async function cancelPendingApprovals(
  db: D1Database,
  phone: string,
  status: ApprovalStatus,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_approvals
       SET status = ?2, resolved_at = ?3
       WHERE phone = ?1 AND status = 'pending'`,
    )
    .bind(phone, status, now())
    .run();
}

export async function getPendingApprovals(
  db: D1Database,
  phone?: string,
): Promise<PendingApproval[]> {
  const stmt =
    phone === undefined
      ? db.prepare(`SELECT * FROM pending_approvals WHERE status = 'pending'`)
      : db
          .prepare(
            `SELECT * FROM pending_approvals WHERE status = 'pending' AND phone = ?1`,
          )
          .bind(phone);
  const { results } = await stmt.all<PendingApproval>();
  return results;
}

export async function markHoldingSent(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(`UPDATE pending_approvals SET holding_sent = 1 WHERE id = ?1`)
    .bind(id)
    .run();
}

// ---- followups ----

export interface ScheduleFollowupInput {
  phone: string;
  kind: FollowupKind;
  dueAt: number;
  airtableRecordId?: string | null;
  note?: string | null;
}

/**
 * Idempotent via UNIQUE(phone, kind, airtable_record_id). NULL record ids are
 * distinct under SQLite UNIQUE, so we coalesce to '' to make dedupe work for
 * bot/custom followups that have no Airtable id.
 */
export async function scheduleFollowup(
  db: D1Database,
  input: ScheduleFollowupInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO followups(phone, kind, due_at, status, airtable_record_id, note, created_at)
       VALUES(?1, ?2, ?3, 'scheduled', ?4, ?5, ?6)`,
    )
    .bind(
      input.phone,
      input.kind,
      input.dueAt,
      input.airtableRecordId ?? "",
      input.note ?? null,
      now(),
    )
    .run();
}

/** Scheduled followups due at or before `at` (default now). */
export async function dueFollowups(
  db: D1Database,
  at: number = now(),
): Promise<Followup[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM followups WHERE status = 'scheduled' AND due_at <= ?1 ORDER BY due_at ASC`,
    )
    .bind(at)
    .all<Followup>();
  return results;
}

export async function markFollowup(
  db: D1Database,
  id: number,
  status: Followup["status"],
): Promise<void> {
  await db
    .prepare(`UPDATE followups SET status = ?2 WHERE id = ?1`)
    .bind(id, status)
    .run();
}

/** Cancels every scheduled followup for a phone (opt-out). */
export async function cancelFollowups(
  db: D1Database,
  phone: string,
  status: Followup["status"] = "cancelled",
): Promise<void> {
  await db
    .prepare(
      `UPDATE followups SET status = ?2 WHERE phone = ?1 AND status = 'scheduled'`,
    )
    .bind(phone, status)
    .run();
}

// ---- outbound wamids (echo detection) ----

export async function recordOutboundWamid(
  db: D1Database,
  wamid: string,
): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO outbound_wamids(wamid, ts) VALUES(?1, ?2)`)
    .bind(wamid, now())
    .run();
}

export async function isOwnWamid(
  db: D1Database,
  wamid: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT wamid FROM outbound_wamids WHERE wamid = ?1`)
    .bind(wamid)
    .first<{ wamid: string }>();
  return row !== null;
}

// ---- edits ----

export async function insertEdit(
  db: D1Database,
  phone: string,
  draft: string,
  final: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO edits(phone, draft, final, ts) VALUES(?1, ?2, ?3, ?4)`,
    )
    .bind(phone, draft, final, now())
    .run();
}

// ---- usage log ----

export async function accrueUsage(
  db: D1Database,
  day: string,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  costUsd: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_log(day, input_tokens, cached_tokens, output_tokens, cost_usd)
       VALUES(?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(day) DO UPDATE SET
         input_tokens = input_tokens + ?2,
         cached_tokens = cached_tokens + ?3,
         output_tokens = output_tokens + ?4,
         cost_usd = cost_usd + ?5`,
    )
    .bind(day, inputTokens, cachedTokens, outputTokens, costUsd)
    .run();
}

// ---- kv ----

export async function kvGet(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM kv WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function kvSet(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO kv(key, value) VALUES(?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = ?2`,
    )
    .bind(key, value)
    .run();
}

/** bot_enabled defaults to true when the kv row is absent. */
export async function isBotEnabled(db: D1Database): Promise<boolean> {
  const v = await kvGet(db, "bot_enabled");
  return v !== "false";
}
