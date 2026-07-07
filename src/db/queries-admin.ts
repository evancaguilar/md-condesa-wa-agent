// Admin-dashboard query layer over D1. Stateless `(db, ...)` style mirroring
// queries.ts. Shared contract: W2 (KB editor / campaign matching) and W3 (API
// routes) call these — keep signatures stable.

import type {
  ApprovalStatus,
  Campaign,
  Env,
  KbRevision,
  KbSection,
} from "../types.js";
import { cdmxMonthStr, cdmxParts, cdmxToEpoch, DAY } from "../cron/time.js";
import { isBotEnabled, kvGet } from "./queries.js";

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
  return (await getCampaign(db, id)) as Campaign;
}

export interface UpdateCampaignInput {
  name?: string;
  triggerPhrase?: string;
  triggerNorm?: string;
  info?: string;
  status?: Campaign["status"];
  endsAt?: number | null;
  adId?: string | null;
}

/**
 * Partial update. endsAt / adId are special: `undefined` leaves them unchanged,
 * but an explicit `null` clears them — so we pass a sentinel flag per field
 * rather than COALESCE.
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

// ---- contact <-> campaign + human override ----

/** Tags a contact with the campaign it arrived through. */
export async function setContactCampaign(
  db: D1Database,
  phone: string,
  campaignId: number,
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
  campaignName: string | null;
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
): Promise<ConversationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT
         c.phone                         AS phone,
         c.name                          AS name,
         c.status                        AS status,
         c.human_override_until          AS humanOverrideUntil,
         lm.body                         AS lastBody,
         lm.ts                           AS lastTs,
         lm.direction                    AS lastDirection,
         COALESCE(pa.pendingCount, 0)    AS pendingCount,
         camp.name                       AS campaignName
       FROM contacts c
       LEFT JOIN (
         SELECT m.phone, m.body, m.ts, m.direction
         FROM messages m
         JOIN (
           SELECT phone, MAX(ts) AS maxTs FROM messages GROUP BY phone
         ) last ON last.phone = m.phone AND last.maxTs = m.ts
       ) lm ON lm.phone = c.phone
       LEFT JOIN (
         SELECT phone, COUNT(*) AS pendingCount
         FROM pending_approvals WHERE status = 'pending' GROUP BY phone
       ) pa ON pa.phone = c.phone
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       ORDER BY COALESCE(lm.ts, c.updated_at) DESC
       LIMIT ?1 OFFSET ?2`,
    )
    .bind(limit, offset)
    .all<ConversationRow>();
  return results;
}

export interface EditRow {
  phone: string;
  draft: string;
  final: string;
  ts: number;
}

/** Recent human edits (draft → final), newest first. */
export async function listEdits(db: D1Database, limit: number): Promise<EditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT phone, draft, final, ts FROM edits ORDER BY id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<EditRow>();
  return results;
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

// ---- training wheels (kv override, env fallback) ----

/**
 * Effective training-wheels state. The kv key `training_wheels` ("1"/"0")
 * overrides env.TRAINING_WHEELS when present; otherwise fall back to the env
 * var. Used by the pipeline (replacing the direct env read) and the dashboard.
 */
export async function getTrainingWheels(env: Env): Promise<boolean> {
  const override = await kvGet(env.DB, "training_wheels");
  if (override === "1") return true;
  if (override === "0") return false;
  return env.TRAINING_WHEELS === "1";
}

// Re-export read helpers the dashboard overview needs from the core layer, so
// W3 imports a single admin surface.
export { isBotEnabled };
