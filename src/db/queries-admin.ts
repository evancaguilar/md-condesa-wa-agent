// Admin-dashboard query layer over D1. Stateless `(db, ...)` style mirroring
// queries.ts. Shared contract: W2 (KB editor / campaign matching) and W3 (API
// routes) call these — keep signatures stable.

import type {
  AirtableRule,
  ApprovalStatus,
  Campaign,
  Env,
  KbRevision,
  KbSection,
  PendingApproval,
} from "../types.js";
import {
  buildApprovalHistorySql,
  type ApprovalHistoryQuery,
} from "./approvals-history.js";
import { cdmxMonthStr, cdmxParts, cdmxToEpoch, DAY } from "../cron/time.js";
import { isBotEnabled, kvGet } from "./queries.js";
import { AUTO_MODE_KV, autoModeActive } from "../services/auto-mode.js";
import { HOLDING_LINE } from "../services/slack-timeouts.js";

const now = (): number => Math.floor(Date.now() / 1000);

// ---- kb_sections (overlay) ----

/** All overlay sections, ordered for assembly: (sort ASC, id ASC). */
export async function listKbSections(db: D1Database): Promise<KbSection[]> {
  const { results } = await db
    .prepare(`SELECT * FROM kb_sections ORDER BY sort ASC, id ASC`)
    .all<KbSection>();
  return results;
}

export async function getKbSection(
  db: D1Database,
  id: number,
): Promise<KbSection | null> {
  return await db
    .prepare(`SELECT * FROM kb_sections WHERE id = ?1`)
    .bind(id)
    .first<KbSection>();
}

export interface CreateKbSectionInput {
  title: string;
  content: string;
  sort?: number;
  enabled?: number;
}

/** Inserts a section and returns the freshly-created row. */
export async function createKbSection(
  db: D1Database,
  input: CreateKbSectionInput,
): Promise<KbSection> {
  const t = now();
  const res = await db
    .prepare(
      `INSERT INTO kb_sections(title, content, sort, enabled, created_at, updated_at)
       VALUES(?1, ?2, COALESCE(?3, 100), COALESCE(?4, 1), ?5, ?5)`,
    )
    .bind(
      input.title,
      input.content,
      input.sort ?? null,
      input.enabled ?? null,
      t,
    )
    .run();
  const id = res.meta.last_row_id as number;
  const row = await getKbSection(db, id);
  // Just inserted — non-null by construction.
  return row as KbSection;
}

export interface UpdateKbSectionInput {
  title?: string;
  content?: string;
  sort?: number;
  enabled?: number;
}

/** Partial update (only provided fields change); returns the updated row. */
export async function updateKbSection(
  db: D1Database,
  id: number,
  input: UpdateKbSectionInput,
): Promise<KbSection | null> {
  await db
    .prepare(
      `UPDATE kb_sections SET
         title = COALESCE(?2, title),
         content = COALESCE(?3, content),
         sort = COALESCE(?4, sort),
         enabled = COALESCE(?5, enabled),
         updated_at = ?6
       WHERE id = ?1`,
    )
    .bind(
      id,
      input.title ?? null,
      input.content ?? null,
      input.sort ?? null,
      input.enabled ?? null,
      now(),
    )
    .run();
  return getKbSection(db, id);
}

export async function deleteKbSection(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM kb_sections WHERE id = ?1`).bind(id).run();
}

// ---- kb_revisions (audit log) ----

export interface InsertKbRevisionInput {
  sectionId?: number | null;
  action: KbRevision["action"];
  title: string;
  content?: string | null;
  prevContent?: string | null;
  reason?: string | null;
  source?: KbRevision["source"];
}

export async function insertKbRevision(
  db: D1Database,
  input: InsertKbRevisionInput,
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO kb_revisions(section_id, action, title, content, prev_content, reason, source, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 'manual'), ?8)`,
    )
    .bind(
      input.sectionId ?? null,
      input.action,
      input.title,
      input.content ?? null,
      input.prevContent ?? null,
      input.reason ?? null,
      input.source ?? null,
      now(),
    )
    .run();
  return res.meta.last_row_id as number;
}

export async function listKbRevisions(
  db: D1Database,
  limit: number,
): Promise<KbRevision[]> {
  const { results } = await db
    .prepare(`SELECT * FROM kb_revisions ORDER BY id DESC LIMIT ?1`)
    .bind(limit)
    .all<KbRevision>();
  return results;
}

export async function getKbRevision(
  db: D1Database,
  id: number,
): Promise<KbRevision | null> {
  return await db
    .prepare(`SELECT * FROM kb_revisions WHERE id = ?1`)
    .bind(id)
    .first<KbRevision>();
}

// ---- campaigns ----

export interface CreateCampaignInput {
  name: string;
  triggerPhrase: string;
  triggerNorm: string;
  info: string;
  status?: Campaign["status"];
  endsAt?: number | null;
  adId?: string | null;
  firstReply?: string | null;
  adKeywords?: string | null;
}

/**
 * Best-effort write of campaigns.first_reply. Pre-migration (column absent)
 * this is a silent no-op — soft-fail like listAirtableRules.
 */
async function setCampaignFirstReplySoft(
  db: D1Database,
  id: number,
  firstReply: string | null,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE campaigns SET first_reply = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(id, firstReply, now())
      .run();
  } catch (err) {
    if (/no such column/i.test(String(err))) return;
    throw err;
  }
}

export async function createCampaign(
  db: D1Database,
  input: CreateCampaignInput,
): Promise<Campaign> {
  const t = now();
  const res = await db
    .prepare(
      `INSERT INTO campaigns(name, trigger_phrase, trigger_norm, info, status, ends_at, ad_id, created_at, updated_at)
       VALUES(?1, ?2, ?3, ?4, COALESCE(?5, 'active'), ?6, ?7, ?8, ?8)`,
    )
    .bind(
      input.name,
      input.triggerPhrase,
      input.triggerNorm,
      input.info,
      input.status ?? null,
      input.endsAt ?? null,
      input.adId ?? null,
      t,
    )
    .run();
  const id = res.meta.last_row_id as number;
  const trimmedFirstReply = input.firstReply?.trim();
  if (trimmedFirstReply) await setCampaignFirstReplySoft(db, id, trimmedFirstReply);
  const trimmedKeywords = input.adKeywords?.trim();
  if (trimmedKeywords) await setCampaignAdKeywordsSoft(db, id, trimmedKeywords);
  return (await getCampaign(db, id)) as Campaign;
}

/**
 * Best-effort write of campaigns.ad_keywords. Pre-migration (column absent)
 * this is a silent no-op — same soft-fail contract as first_reply above.
 */
async function setCampaignAdKeywordsSoft(
  db: D1Database,
  id: number,
  adKeywords: string | null,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE campaigns SET ad_keywords = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(id, adKeywords, now())
      .run();
  } catch (err) {
    if (/no such column/i.test(String(err))) return;
    throw err;
  }
}

/**
 * Atomically append a learned Meta ad id to campaigns.ad_id (comma-separated).
 * ONE guarded UPDATE → race-safe under D1's serialized writes: of two
 * concurrent inbounds from the same new ad, one appends and the loser's WHERE
 * no-ops (meta.changes = 0). The replace() chain normalizes the mixed
 * comma/whitespace separators matchCampaignByAdId accepts into commas so the
 * duplicate guard is token-exact (a shorter id being a prefix of a longer one
 * can't false-positive). sourceId is pre-validated by adIdToLearn (alnum/_/-
 * only) so the LIKE needs no ESCAPE. Returns true when the id was appended.
 */
export async function appendCampaignAdId(
  db: D1Database,
  id: number,
  sourceId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE campaigns
         SET ad_id = CASE WHEN ad_id IS NULL OR trim(ad_id) = ''
                          THEN ?2 ELSE rtrim(ad_id) || ', ' || ?2 END,
             updated_at = ?3
       WHERE id = ?1
         AND (',' || replace(replace(replace(coalesce(ad_id, ''), char(9), ','),
                                     char(10), ','), ' ', ',') || ',')
             NOT LIKE '%,' || ?2 || ',%'`,
    )
    .bind(id, sourceId, now())
    .run();
  return ((res.meta.changes as number | undefined) ?? 0) > 0;
}

export interface UpdateCampaignInput {
  name?: string;
  triggerPhrase?: string;
  triggerNorm?: string;
  info?: string;
  status?: Campaign["status"];
  endsAt?: number | null;
  adId?: string | null;
  firstReply?: string | null;
  adKeywords?: string | null;
}

/**
 * Partial update. endsAt / adId are special: `undefined` leaves them unchanged,
 * but an explicit `null` clears them — so we pass a sentinel flag per field
 * rather than COALESCE. firstReply is handled separately via the soft-fail
 * helper (see CreateCampaignInput comment) rather than in this UPDATE, since
 * touching first_reply pre-migration would fail at prepare-time.
 */
export async function updateCampaign(
  db: D1Database,
  id: number,
  input: UpdateCampaignInput,
): Promise<Campaign | null> {
  const setEndsAt = "endsAt" in input;
  const setAdId = "adId" in input;
  await db
    .prepare(
      `UPDATE campaigns SET
         name = COALESCE(?2, name),
         trigger_phrase = COALESCE(?3, trigger_phrase),
         trigger_norm = COALESCE(?4, trigger_norm),
         info = COALESCE(?5, info),
         status = COALESCE(?6, status),
         ends_at = CASE WHEN ?7 = 1 THEN ?8 ELSE ends_at END,
         ad_id = CASE WHEN ?10 = 1 THEN ?11 ELSE ad_id END,
         updated_at = ?9
       WHERE id = ?1`,
    )
    .bind(
      id,
      input.name ?? null,
      input.triggerPhrase ?? null,
      input.triggerNorm ?? null,
      input.info ?? null,
      input.status ?? null,
      setEndsAt ? 1 : 0,
      input.endsAt ?? null,
      now(),
      setAdId ? 1 : 0,
      input.adId ?? null,
    )
    .run();
  if ("firstReply" in input) {
    await setCampaignFirstReplySoft(db, id, input.firstReply ?? null);
  }
  if ("adKeywords" in input) {
    await setCampaignAdKeywordsSoft(db, id, input.adKeywords ?? null);
  }
  return getCampaign(db, id);
}

export async function getCampaign(
  db: D1Database,
  id: number,
): Promise<Campaign | null> {
  return await db
    .prepare(`SELECT * FROM campaigns WHERE id = ?1`)
    .bind(id)
    .first<Campaign>();
}

export async function listCampaigns(db: D1Database): Promise<Campaign[]> {
  const { results } = await db
    .prepare(`SELECT * FROM campaigns ORDER BY id DESC`)
    .all<Campaign>();
  return results;
}

/** Active campaigns still in flight: status='active' AND (ends_at NULL OR > now). */
export async function getActiveCampaigns(db: D1Database): Promise<Campaign[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM campaigns
       WHERE status = 'active' AND (ends_at IS NULL OR ends_at > ?1)
       ORDER BY id DESC`,
    )
    .bind(now())
    .all<Campaign>();
  return results;
}

// ---- airtable_rules (lead-sync automations) ----

export interface CreateAirtableRuleInput {
  name: string;
  triggerJson: string;
  actionsJson: string;
  enabled?: number;
}

export async function createAirtableRule(
  db: D1Database,
  input: CreateAirtableRuleInput,
): Promise<AirtableRule> {
  const t = now();
  const res = await db
    .prepare(
      `INSERT INTO airtable_rules(name, trigger_json, actions_json, enabled, created_at, updated_at)
       VALUES(?1, ?2, ?3, COALESCE(?4, 1), ?5, ?5)`,
    )
    .bind(input.name, input.triggerJson, input.actionsJson, input.enabled ?? null, t)
    .run();
  const id = res.meta.last_row_id as number;
  return (await getAirtableRule(db, id)) as AirtableRule;
}

export async function getAirtableRule(
  db: D1Database,
  id: number,
): Promise<AirtableRule | null> {
  return await db
    .prepare(`SELECT * FROM airtable_rules WHERE id = ?1`)
    .bind(id)
    .first<AirtableRule>();
}

/** All rules (newest first), or only enabled ones when enabledOnly is set. */
export async function listAirtableRules(
  db: D1Database,
  opts: { enabledOnly?: boolean } = {},
): Promise<AirtableRule[]> {
  const sql = opts.enabledOnly
    ? `SELECT * FROM airtable_rules WHERE enabled = 1 ORDER BY id DESC`
    : `SELECT * FROM airtable_rules ORDER BY id DESC`;
  try {
    const { results } = await db.prepare(sql).all<AirtableRule>();
    return results;
  } catch (err) {
    // Pre-migration deploys have no airtable_rules table yet. Rules simply
    // don't exist then — never take down callers (Editor chat, lead sync).
    if (/no such table/i.test(String(err))) return [];
    throw err;
  }
}

export interface UpdateAirtableRuleInput {
  name?: string;
  triggerJson?: string;
  actionsJson?: string;
  enabled?: number;
}

/** Partial update (COALESCE); only provided fields change. Returns updated row. */
export async function updateAirtableRule(
  db: D1Database,
  id: number,
  input: UpdateAirtableRuleInput,
): Promise<AirtableRule | null> {
  await db
    .prepare(
      `UPDATE airtable_rules SET
         name = COALESCE(?2, name),
         trigger_json = COALESCE(?3, trigger_json),
         actions_json = COALESCE(?4, actions_json),
         enabled = COALESCE(?5, enabled),
         updated_at = ?6
       WHERE id = ?1`,
    )
    .bind(
      id,
      input.name ?? null,
      input.triggerJson ?? null,
      input.actionsJson ?? null,
      input.enabled ?? null,
      now(),
    )
    .run();
  return getAirtableRule(db, id);
}

export async function deleteAirtableRule(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM airtable_rules WHERE id = ?1`).bind(id).run();
}

/**
 * Set (or clear, when error is null) a rule's last_error — the amber schema-drift
 * chip. Passing null clears it (rule healthy again). updated_at is left untouched
 * so an error mark doesn't reorder or churn the rule.
 */
export async function setRuleLastError(
  db: D1Database,
  id: number,
  error: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE airtable_rules SET last_error = ?2 WHERE id = ?1`)
    .bind(id, error)
    .run();
}

// ---- contact <-> campaign + human override ----

/** Tags a contact with the campaign it arrived through. */
export async function setContactCampaign(
  db: D1Database,
  phone: string,
  campaignId: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts SET campaign_id = ?2, updated_at = ?3 WHERE phone = ?1`,
    )
    .bind(phone, campaignId, now())
    .run();
}

/**
 * Stores the click-to-WhatsApp ad referral JSON on a contact. Called once, on
 * first capture (the pipeline guards on ad_ref being null) so we keep the
 * ORIGINAL attribution even if the lead later re-clicks a different ad.
 */
export async function setContactAdRef(
  db: D1Database,
  phone: string,
  json: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts SET ad_ref = ?2, updated_at = ?3 WHERE phone = ?1`,
    )
    .bind(phone, json, now())
    .run();
}

/** Clears a human takeover so the bot resumes handling the conversation. */
export async function clearHumanOverride(
  db: D1Database,
  phone: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts SET human_override_until = NULL, updated_at = ?2 WHERE phone = ?1`,
    )
    .bind(phone, now())
    .run();
}

/**
 * Best-effort write of contacts.assigned_to. Pre-migration (column absent)
 * this is a silent no-op — soft-fail like setCampaignFirstReplySoft.
 */
export async function setAssignedToSoft(
  db: D1Database,
  phone: string,
  username: string | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE contacts SET assigned_to = ?2, updated_at = ?3 WHERE phone = ?1`,
      )
      .bind(phone, username, now())
      .run();
  } catch (err) {
    if (/no such column/i.test(String(err))) return;
    throw err;
  }
}

/** Shared read marker: `ts` = seconds read, 0 = explicitly marked unread. */
export async function setReadAtSoft(
  db: D1Database,
  phone: string,
  ts: number,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE contacts SET read_at = ?2, updated_at = ?3 WHERE phone = ?1`)
      .bind(phone, ts, now())
      .run();
  } catch (err) {
    if (/no such column/i.test(String(err))) return;
    throw err;
  }
}

// ---- admin_users (staff accounts; fail-soft pre-migration) ----

export interface AdminUserDbRow {
  username: string;
  display_name: string;
  pass_salt: string;
  pass_hash: string;
  role: string;
  disabled: number;
  created_at: number;
  updated_at: number;
}

/** Loads one staff user. Pre-migration (table absent) ⇒ null, like listAirtableRules. */
export async function getAdminUserSoft(
  db: D1Database,
  username: string,
): Promise<AdminUserDbRow | null> {
  try {
    const row = await db
      .prepare(`SELECT * FROM admin_users WHERE username = ?1`)
      .bind(username)
      .first<AdminUserDbRow>();
    return row ?? null;
  } catch (err) {
    if (/no such table/i.test(String(err))) return null;
    throw err;
  }
}

/** All staff users, oldest first. Pre-migration ⇒ []. */
export async function listAdminUsersSoft(db: D1Database): Promise<AdminUserDbRow[]> {
  try {
    const { results } = await db
      .prepare(`SELECT * FROM admin_users ORDER BY created_at ASC`)
      .all<AdminUserDbRow>();
    return results;
  } catch (err) {
    if (/no such table/i.test(String(err))) return [];
    throw err;
  }
}

/**
 * Creates a staff user. Pre-migration the missing table surfaces as a typed
 * `users_table_missing` error so the route can 409 with a clear message
 * instead of a 500.
 */
export async function createAdminUser(
  db: D1Database,
  input: {
    username: string;
    displayName: string;
    passSalt: string;
    passHash: string;
    role: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO admin_users(username, display_name, pass_salt, pass_hash, role, disabled, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)`,
      )
      .bind(
        input.username,
        input.displayName,
        input.passSalt,
        input.passHash,
        input.role,
        now(),
      )
      .run();
  } catch (err) {
    if (/no such table/i.test(String(err))) {
      throw new Error("users_table_missing");
    }
    throw err;
  }
}

/** Partial update of a staff user (display name, password salt+hash, disabled). */
export async function updateAdminUser(
  db: D1Database,
  username: string,
  patch: {
    displayName?: string;
    passSalt?: string;
    passHash?: string;
    disabled?: boolean;
  },
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE admin_users SET
         display_name = COALESCE(?2, display_name),
         pass_salt    = COALESCE(?3, pass_salt),
         pass_hash    = COALESCE(?4, pass_hash),
         disabled     = COALESCE(?5, disabled),
         updated_at   = ?6
       WHERE username = ?1`,
    )
    .bind(
      username,
      patch.displayName ?? null,
      patch.passSalt ?? null,
      patch.passHash ?? null,
      patch.disabled === undefined ? null : patch.disabled ? 1 : 0,
      now(),
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- followups: cancel by kind ----

/**
 * Cancels scheduled followups for a phone whose kind is in `kinds`. Used to drop
 * the lead-nudge drip (kind IN nudge_1h/6h/8h) when the lead replies, books, or
 * converts, without touching an active trial sequence. No-op on empty `kinds`.
 * `status` is the terminal status to write (default 'cancelled').
 */
export async function cancelFollowupsByKinds(
  db: D1Database,
  phone: string,
  kinds: readonly string[],
  status: string = "cancelled",
): Promise<void> {
  if (kinds.length === 0) return;
  const placeholders = kinds.map((_, i) => `?${i + 3}`).join(", ");
  await db
    .prepare(
      `UPDATE followups SET status = ?2
       WHERE phone = ?1 AND status = 'scheduled' AND kind IN (${placeholders})`,
    )
    .bind(phone, status, ...kinds)
    .run();
}

/**
 * True if the phone has any scheduled followup whose kind is in `kinds` — used
 * to detect an active/future trial booking (trial_confirm|day_before|same_day)
 * so the nudge drip is suppressed for leads who already have a class booked.
 */
export async function hasScheduledFollowupOfKind(
  db: D1Database,
  phone: string,
  kinds: readonly string[],
): Promise<boolean> {
  if (kinds.length === 0) return false;
  const placeholders = kinds.map((_, i) => `?${i + 2}`).join(", ");
  const row = await db
    .prepare(
      `SELECT 1 AS n FROM followups
       WHERE phone = ?1 AND status = 'scheduled' AND kind IN (${placeholders})
       LIMIT 1`,
    )
    .bind(phone, ...kinds)
    .first<{ n: number }>();
  return row !== null;
}

/**
 * The scheduled followups of `kinds` for a phone, with their due_at — the
 * slot-aware version of hasScheduledFollowupOfKind. booking-guard maps each
 * row's due_at back to the trial date it was derived from, so an OLD booking
 * can't back a claim about a DIFFERENT class.
 */
export async function scheduledFollowupsOfKind(
  db: D1Database,
  phone: string,
  kinds: readonly string[],
): Promise<Array<{ kind: string; due_at: number }>> {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT kind, due_at FROM followups
       WHERE phone = ?1 AND status = 'scheduled' AND kind IN (${placeholders})`,
    )
    .bind(phone, ...kinds)
    .all<{ kind: string; due_at: number }>();
  return results;
}

// ---- approvals: atomic claim ----

/**
 * Atomic conditional resolve: flips a still-pending approval to `status` in one
 * UPDATE guarded by `status='pending'`. Returns true only if THIS call won the
 * race (meta.changes === 1); false if it was already resolved (lost race). The
 * single source of truth for approve/edit/discard/takeover concurrency.
 */
export async function claimApproval(
  db: D1Database,
  id: number,
  status: ApprovalStatus,
  finalText?: string | null,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE pending_approvals
       SET status = ?2, resolved_at = ?3, final_text = ?4
       WHERE id = ?1 AND status = 'pending'`,
    )
    .bind(id, status, now(), finalText ?? null)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- approvals: history ----

/** The columns the history endpoint reads (raw snake_case row, like D1 gives). */
export type ApprovalHistoryRow = Pick<
  PendingApproval,
  | "id"
  | "phone"
  | "draft"
  | "final_text"
  | "confidence"
  | "status"
  | "holding_sent"
  | "created_at"
  | "resolved_at"
>;

/**
 * Resolved + pending approvals in a created_at window, newest first. Filters
 * and paging are built by the pure db/approvals-history.ts module (everything
 * parameterized); this only runs the statement.
 */
export async function listApprovalHistory(
  db: D1Database,
  q: ApprovalHistoryQuery,
): Promise<ApprovalHistoryRow[]> {
  const { sql, binds } = buildApprovalHistorySql(q);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ApprovalHistoryRow>();
  return results;
}

/**
 * Contact names for a batch of phones in ONE query (the history list would
 * otherwise fire a getContact per row). Phones absent from `contacts` simply
 * don't appear in the map; an empty input never touches the DB.
 */
export async function namesForPhones(
  db: D1Database,
  phones: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  // D1 rejects statements with too many bound parameters — a full 200-row
  // history page over an active window carries 100+ distinct phones and threw
  // a raw 1101 (seen live 2026-08-25). Chunk the IN() well under the limit.
  const CHUNK = 50;
  for (let i = 0; i < phones.length; i += CHUNK) {
    const batch = phones.slice(i, i + CHUNK);
    const placeholders = batch.map((_, j) => `?${j + 1}`).join(", ");
    const { results } = await db
      .prepare(`SELECT phone, name FROM contacts WHERE phone IN (${placeholders})`)
      .bind(...batch)
      .all<{ phone: string; name: string | null }>();
    for (const r of results) out.set(r.phone, r.name);
  }
  return out;
}

// ---- dashboard read models ----

export interface ConversationRow {
  phone: string;
  name: string | null;
  status: string;
  lastBody: string | null;
  lastTs: number | null;
  lastDirection: string | null;
  humanOverrideUntil: number | null;
  pendingCount: number;
  /** Approvals (any status) where the brain claimed high confidence — the
   *  would-have-auto-sent replies the "IA segura" audit filter surfaces. */
  hiConfCount: number;
  /** Approvals Evan sent AS-IS (status 'approved', not edited) — with
   *  inboundCount ≥ 2 these are the "AI replied without intervention" convos
   *  the retro audit filter surfaces. */
  approvedAsIsCount: number;
  /** Total inbound messages: ≥2 means the lead kept talking past the initial
   *  ad message (a real AI dialogue, not just the canned welcome). */
  inboundCount: number;
  campaignName: string | null;
  /** Absent pre-migration (contacts.assigned_to column) — consumers `?? null`. */
  assignedTo?: string | null;
  /** Absent pre-migration (contacts.read_at column) — consumers `?? null`. */
  readAt?: number | null;
  /** Only on search (`q`): newest message body matching the query, if any. */
  matchBody?: string | null;
}

/** Escapes LIKE wildcards so user input matches literally (ESCAPE '\'). */
function likePattern(q: string): string {
  return "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
}

/**
 * SQL predicate: true for messages that count as a conversation's "last
 * message" in the inbox list. Holding lines ("te respondemos pronto") are
 * excluded — they are noise, not an answer — so a lead who only got the
 * holding line still surfaces as waiting under the "No leídos" filter.
 * Matched two ways: the meta tag new sends carry (LIKE on the raw JSON — no
 * json_extract, so one malformed meta row can't brick the whole list) and the
 * exact body text for rows stored before tagging existed. An inbound message
 * that coincidentally repeats the sentence still counts (direction check).
 */
function notHoldingSql(col: string): string {
  const body = HOLDING_LINE.replace(/'/g, "''");
  return `(${col}.direction = 'in'
     OR ((${col}.meta IS NULL OR ${col}.meta NOT LIKE '%"holding":1%')
         AND COALESCE(${col}.body, '') <> '${body}'))`;
}

/**
 * Conversation list for the Chats view: each contact with its last message,
 * count of still-pending approvals, and campaign name (if tagged). Ordered by
 * most-recent activity (last message ts, then contact updated_at).
 */
export async function listConversations(
  db: D1Database,
  limit: number,
  offset: number,
  q?: string | null,
): Promise<ConversationRow[]> {
  // Search: ?3 matches name/message text literally (wildcards escaped); ?4 is
  // the digits-only variant so a formatted phone like "(564) 755-8301" still
  // finds contact 5215647558301. Falls back to ?3 when q has <4 digits.
  const query = (q ?? "").trim();
  const pattern = query ? likePattern(query) : null;
  const digits = query.replace(/\D/g, "");
  const digitsPattern = digits.length >= 4 ? "%" + digits + "%" : pattern;
  // Optional columns are added per tier so each pre-migration fallback (an
  // absent column fails at prepare time) keeps the list working: 2 =
  // assigned_to + read_at, 1 = assigned_to only, 0 = base (today's minimum).
  const sqlFor = (tier: number): string =>
    `SELECT
       c.phone                         AS phone,
       c.name                          AS name,
       c.status                        AS status,
       c.human_override_until          AS humanOverrideUntil,
       ${tier >= 1 ? "c.assigned_to                   AS assignedTo," : ""}
       ${tier >= 2 ? "c.read_at                       AS readAt," : ""}
       lm.body                         AS lastBody,
       lm.ts                           AS lastTs,
       lm.direction                    AS lastDirection,
       COALESCE(pa.pendingCount, 0)    AS pendingCount,
       COALESCE(hc.hiConfCount, 0)     AS hiConfCount,
       COALESCE(aa.approvedAsIsCount, 0) AS approvedAsIsCount,
       COALESCE(ic.inboundCount, 0)    AS inboundCount,
       camp.name                       AS campaignName${
         pattern
           ? `,
       (SELECT ms.body FROM messages ms
        WHERE ms.phone = c.phone AND ms.body LIKE ?3 ESCAPE '\\'
        ORDER BY ms.ts DESC LIMIT 1)   AS matchBody`
           : ""
       }
     FROM contacts c
     LEFT JOIN (
       SELECT m.phone, m.body, m.ts, m.direction
       FROM messages m
       JOIN (
         SELECT mi.phone, MAX(mi.ts) AS maxTs FROM messages mi
         WHERE ${notHoldingSql("mi")}
         GROUP BY mi.phone
       ) last ON last.phone = m.phone AND last.maxTs = m.ts
       WHERE ${notHoldingSql("m")}
     ) lm ON lm.phone = c.phone
     LEFT JOIN (
       SELECT phone, COUNT(*) AS pendingCount
       FROM pending_approvals WHERE status = 'pending' GROUP BY phone
     ) pa ON pa.phone = c.phone
     LEFT JOIN (
       SELECT phone, COUNT(*) AS hiConfCount
       FROM pending_approvals WHERE confidence = 'high' GROUP BY phone
     ) hc ON hc.phone = c.phone
     LEFT JOIN (
       SELECT phone, COUNT(*) AS approvedAsIsCount
       FROM pending_approvals WHERE status = 'approved' GROUP BY phone
     ) aa ON aa.phone = c.phone
     LEFT JOIN (
       SELECT phone, COUNT(*) AS inboundCount
       FROM messages WHERE direction = 'in' GROUP BY phone
     ) ic ON ic.phone = c.phone
     LEFT JOIN campaigns camp ON camp.id = c.campaign_id
     ${
       pattern
         ? `WHERE (c.name LIKE ?3 ESCAPE '\\'
            OR c.phone LIKE ?4
            OR EXISTS (SELECT 1 FROM messages ms
                       WHERE ms.phone = c.phone AND ms.body LIKE ?3 ESCAPE '\\'))`
         : ""
     }
     ORDER BY COALESCE(lm.ts, c.updated_at) DESC
     LIMIT ?1 OFFSET ?2`;
  const run = async (tier: number): Promise<ConversationRow[]> => {
    try {
      const stmt = db.prepare(sqlFor(tier));
      const bound = pattern
        ? stmt.bind(limit, offset, pattern, digitsPattern)
        : stmt.bind(limit, offset);
      const { results } = await bound.all<ConversationRow>();
      return results;
    } catch (err) {
      if (tier === 0 || !/no such column/i.test(String(err))) throw err;
      return run(tier - 1);
    }
  };
  return run(2);
}

export interface EditRow {
  id: number;
  phone: string;
  draft: string;
  final: string;
  ts: number;
}

/** Recent human edits (draft → final), newest first. */
export async function listEdits(db: D1Database, limit: number): Promise<EditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, phone, draft, final, ts FROM edits ORDER BY id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<EditRow>();
  return results;
}

/**
 * Edits with id > afterId for the edit tuner. Takes the MOST RECENT `limit`
 * past the watermark, returned in chronological order so the model reads the
 * conversation-style pairs oldest → newest.
 */
export async function editsAfter(
  db: D1Database,
  afterId: number,
  limit: number,
): Promise<EditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, phone, draft, final, ts FROM edits
       WHERE id > ?1 ORDER BY id DESC LIMIT ?2`,
    )
    .bind(afterId, limit)
    .all<EditRow>();
  return results.reverse();
}

/** Count + high-water id of edits past the watermark (cheap tuner gate check). */
export async function countEditsAfter(
  db: D1Database,
  afterId: number,
): Promise<{ count: number; maxId: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId
       FROM edits WHERE id > ?1`,
    )
    .bind(afterId)
    .first<{ count: number; maxId: number }>();
  return { count: row?.count ?? 0, maxId: row?.maxId ?? 0 };
}

export interface StatsOverview {
  pendingCount: number;
  convosToday: number;
  convosWeek: number;
  month: {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

/**
 * Overview stats for the Inicio dashboard:
 * - month: MTD usage_log sums keyed by CDMX month (`day` rows are YYYY-MM-DD).
 * - convosToday / convosWeek: distinct phones with an inbound message since the
 *   CDMX start-of-today / 7-days-ago boundary.
 * - pendingCount: still-pending approvals.
 */
export async function statsOverview(db: D1Database): Promise<StatsOverview> {
  const nowSec = now();
  const month = cdmxMonthStr(nowSec); // "YYYY-MM"

  const usage = await db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0)  AS inputTokens,
         COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
         COALESCE(SUM(output_tokens), 0) AS outputTokens,
         COALESCE(SUM(cost_usd), 0)      AS costUsd
       FROM usage_log WHERE substr(day, 1, 7) = ?1`,
    )
    .bind(month)
    .first<{
      inputTokens: number;
      cachedTokens: number;
      outputTokens: number;
      costUsd: number;
    }>();

  // CDMX day boundaries → epoch seconds.
  const p = cdmxParts(nowSec);
  const startOfToday = cdmxToEpoch(p.year, p.month, p.day, 0, 0, 0);
  const startOfWeek = startOfToday - 6 * DAY; // today + previous 6 days

  const today = await db
    .prepare(
      `SELECT COUNT(DISTINCT phone) AS n FROM messages
       WHERE direction = 'in' AND ts >= ?1`,
    )
    .bind(startOfToday)
    .first<{ n: number }>();

  const week = await db
    .prepare(
      `SELECT COUNT(DISTINCT phone) AS n FROM messages
       WHERE direction = 'in' AND ts >= ?1`,
    )
    .bind(startOfWeek)
    .first<{ n: number }>();

  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM pending_approvals WHERE status = 'pending'`,
    )
    .first<{ n: number }>();

  return {
    pendingCount: pending?.n ?? 0,
    convosToday: today?.n ?? 0,
    convosWeek: week?.n ?? 0,
    month: {
      inputTokens: usage?.inputTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costUsd: usage?.costUsd ?? 0,
    },
  };
}

// ---- conversation reset (testing tool) ----

/**
 * Wipes a conversation so the phone behaves like a brand-new lead again:
 * deletes its messages, followups, pending approvals, and the first-reply /
 * nudge-cap kv claims, then resets the contact's lead state. Admin testing
 * tool — keeps `airtable_lead_id` so the CRM row stays linked (upsert-by-phone
 * would re-find it anyway).
 */
export async function resetConversation(
  db: D1Database,
  phone: string,
): Promise<void> {
  await db.prepare(`DELETE FROM messages WHERE phone = ?1`).bind(phone).run();
  await db.prepare(`DELETE FROM followups WHERE phone = ?1`).bind(phone).run();
  await db
    .prepare(`DELETE FROM pending_approvals WHERE phone = ?1`)
    .bind(phone)
    .run();
  await db
    .prepare(`DELETE FROM kv WHERE key IN (?1, ?2, ?3)`)
    .bind(
      `first_reply_sent:${phone}`,
      `nudge_count:${phone}`,
      `seq_done:${phone}`,
    )
    .run();
  await db
    .prepare(
      `UPDATE contacts SET status = 'lead', campaign_id = NULL, ad_ref = NULL,
       qualification = NULL, human_override_until = NULL, last_inbound_at = NULL,
       updated_at = ?2 WHERE phone = ?1`,
    )
    .bind(phone, now())
    .run();
}

// ---- scheduled staff sends ("send later") ----

export interface StaffLaterRow {
  id: number;
  dueAt: number;
  status: string;
  note: string | null;
}

/**
 * staff_later rows for one phone's chat detail: everything still scheduled,
 * plus rows cancelled since `cancelledSince` so staff can recover the text
 * after the lead wrote first (older cancellations drop off the panel).
 */
export async function listStaffLater(
  db: D1Database,
  phone: string,
  cancelledSince: number,
  limit = 10,
): Promise<StaffLaterRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, due_at AS dueAt, status, note FROM followups
       WHERE phone = ?1 AND kind = 'staff_later'
         AND (status = 'scheduled' OR (status = 'cancelled' AND due_at >= ?2))
       ORDER BY due_at ASC LIMIT ?3`,
    )
    .bind(phone, cancelledSince, limit)
    .all<StaffLaterRow>();
  return results;
}

/**
 * Race-safe cancel against the cron: only a still-'scheduled' row flips, so a
 * tap that lands while the tick is sending returns false instead of pretending
 * the message was stopped.
 */
export async function cancelStaffLater(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE followups SET status = 'cancelled'
       WHERE id = ?1 AND kind = 'staff_later' AND status = 'scheduled'`,
    )
    .bind(id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- training wheels (kv override, env fallback) ----

/**
 * Effective training-wheels state. The kv key `training_wheels` ("1"/"0")
 * overrides env.TRAINING_WHEELS when present; otherwise fall back to the env
 * var. Used by the pipeline (replacing the direct env read) and the dashboard.
 */
export async function getTrainingWheels(env: Env): Promise<boolean> {
  // Time-boxed night mode wins while its window is open: full auto until the
  // stored epoch (next 07:00 CDMX) lapses, then the standing config resumes.
  const auto = await kvGet(env.DB, AUTO_MODE_KV);
  if (autoModeActive(auto, Math.floor(Date.now() / 1000))) return false;
  const override = await kvGet(env.DB, "training_wheels");
  if (override === "1") return true;
  if (override === "0") return false;
  return env.TRAINING_WHEELS === "1";
}

// Re-export read helpers the dashboard overview needs from the core layer, so
// W3 imports a single admin surface.
export { isBotEnabled };
