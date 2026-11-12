// I/O half of «💬 Esperando respuesta» (rules: services/unanswered.ts).
//
// D1 rows-read budget (free plan, 5M/day, three past outages): a computation
// is at most FIVE set-based statements, each riding an existing index — never
// a scan of messages or contacts, and no per-row query fan-out:
//   1. contacts touched in the look-back (idx_contacts_updated: every inbound
//      bumps updated_at via touchLastInbound) whose last_inbound_at is in the
//      look-back, joined to their messages SINCE that inbound
//      (idx_messages_phone_ts) — usually the inbound plus our reply;
//   2. for chats not answered in (1): the last UNANSWERED_TAIL_LIMIT messages
//      (idx_messages_phone_ts, json_each of the phones);
//   3. newest approval + "any pending" per waiting phone (idx_pending_approvals_phone);
//   4. «Ya lo atendí» / «Sin responder» done markers (kv primary key);
//   5. bot_enabled (one kv row).
// The panel shares ONE kv-cached result for UNANSWERED_CACHE_TTL_SEC across
// every open browser; the cron reuses it when fresh and otherwise computes a
// 24 h list (smaller scan) for the Slack reminder.

import type { Env } from "../types.js";
import { isBotEnabled, kvGet, kvSet } from "../db/queries.js";
import { CLIENT } from "../client.gen.js";
import {
  isInOwedList,
  dueForReminder,
  holdingTexts,
  inReminderWindow,
  judgeTail,
  parseCache,
  reminderText,
  selectUnanswered,
  unansweredDoneKey,
  unansweredPingKey,
  UNANSWERED_CACHE_KEY,
  UNANSWERED_CACHE_TTL_SEC,
  UNANSWERED_CANDIDATE_LIMIT,
  UNANSWERED_CRON_CACHE_TTL_SEC,
  UNANSWERED_MAX_AGE_SEC,
  UNANSWERED_SLACK_LOOKBACK_SEC,
  UNANSWERED_TAIL_LIMIT,
  type CandidateFacts,
  type TailMsg,
  type UnansweredCache,
  type UnansweredItem,
} from "./unanswered.js";

interface ContactRow {
  phone: string;
  name: string | null;
  status: string | null;
  override_until: number | null;
  last_inbound_at: number;
  wamid: string | null;
  direction: string | null;
  body: string | null;
  ts: number | null;
  meta: string | null;
}

function holdingSet(): Set<string> {
  const copy = (CLIENT as unknown as { copy?: Record<string, string | undefined> }).copy ?? {};
  // The student acknowledgement is a "someone will answer you" placeholder too.
  return holdingTexts([copy.studentAckEs, copy.studentAckEn]);
}

/** Pure grouping helper: rows (already newest first per phone) → phone → tail. */
function groupTails(rows: ReadonlyArray<{ phone: string } & Partial<TailMsg>>): Map<string, TailMsg[]> {
  const out = new Map<string, TailMsg[]>();
  for (const r of rows) {
    let list = out.get(r.phone);
    if (!list) {
      list = [];
      out.set(r.phone, list);
    }
    if (r.wamid && r.direction && typeof r.ts === "number") {
      list.push({ wamid: r.wamid, direction: r.direction, body: r.body ?? null, ts: r.ts, meta: r.meta ?? null });
    }
  }
  return out;
}

/** Computes the list from D1 (≤ 5 statements). `maxAgeSec` = look-back. */
export async function computeUnanswered(
  db: D1Database,
  now: number,
  maxAgeSec: number = UNANSWERED_MAX_AGE_SEC,
): Promise<UnansweredItem[]> {
  const since = now - maxAgeSec;
  const holding = holdingSet();

  // (1) candidates + their messages since the last inbound.
  const { results: rows } = await db
    .prepare(
      `SELECT c.phone AS phone, c.name AS name, c.status AS status,
              c.human_override_until AS override_until, c.last_inbound_at AS last_inbound_at,
              m.wamid AS wamid, m.direction AS direction, m.body AS body, m.ts AS ts, m.meta AS meta
       FROM (SELECT phone, name, status, human_override_until, last_inbound_at
             FROM contacts INDEXED BY idx_contacts_updated
             WHERE updated_at >= ?1 AND last_inbound_at >= ?1
               AND COALESCE(status, 'lead') <> 'opted_out'
             ORDER BY last_inbound_at DESC
             LIMIT ?2) c
       LEFT JOIN messages m INDEXED BY idx_messages_phone_ts
         ON m.phone = c.phone AND m.ts >= c.last_inbound_at
       ORDER BY c.last_inbound_at DESC, c.phone, m.ts DESC, m.rowid DESC`,
    )
    .bind(since, UNANSWERED_CANDIDATE_LIMIT)
    .all<ContactRow>();

  const contacts = new Map<string, ContactRow>();
  for (const r of rows ?? []) if (!contacts.has(r.phone)) contacts.set(r.phone, r);
  const firstTails = groupTails((rows ?? []) as Array<{ phone: string } & Partial<TailMsg>>);

  const unsure: string[] = [];
  for (const [phone, tail] of firstTails) {
    if (judgeTail(tail, holding).kind !== "answered") unsure.push(phone);
  }
  if (!unsure.length) return [];

  // (2) longer tail for the chats (1) could not settle.
  const { results: tailRows } = await db
    .prepare(
      `SELECT m.phone AS phone, m.wamid AS wamid, m.direction AS direction, m.body AS body,
              m.ts AS ts, m.meta AS meta
       FROM json_each(?1) j
       JOIN messages m ON m.rowid IN (
         SELECT m2.rowid FROM messages m2 INDEXED BY idx_messages_phone_ts
         WHERE m2.phone = j.value
         ORDER BY m2.ts DESC, m2.rowid DESC
         LIMIT ?2)
       ORDER BY m.phone, m.ts DESC, m.rowid DESC`,
    )
    .bind(JSON.stringify(unsure), UNANSWERED_TAIL_LIMIT)
    .all<{ phone: string } & TailMsg>();
  const tails = groupTails(tailRows ?? []);

  const waiting = unsure
    .map((phone) => ({ phone, verdict: judgeTail(tails.get(phone) ?? [], holding) }))
    .filter((w) => w.verdict.kind === "waiting");
  if (!waiting.length) return [];
  const phones = waiting.map((w) => w.phone);

  // (3) newest approval + pending flag per waiting phone.
  const { results: apprRows } = await db
    .prepare(
      `SELECT j.value AS phone, pa.id AS id, pa.status AS status, pa.created_at AS created_at,
              EXISTS(SELECT 1 FROM pending_approvals p3 INDEXED BY idx_pending_approvals_phone
                     WHERE p3.phone = j.value AND p3.status = 'pending') AS has_pending
       FROM json_each(?1) j
       LEFT JOIN pending_approvals pa ON pa.id = (
         SELECT MAX(p2.id) FROM pending_approvals p2 INDEXED BY idx_pending_approvals_phone
         WHERE p2.phone = j.value)`,
    )
    .bind(JSON.stringify(phones))
    .all<{ phone: string; id: number | null; status: string | null; created_at: number | null; has_pending: number }>();
  const appr = new Map((apprRows ?? []).map((a) => [a.phone, a]));

  // (4) «Ya lo atendí» markers for these inbounds.
  const keys: string[] = [];
  for (const w of waiting) {
    if (w.verdict.kind === "waiting") keys.push(unansweredDoneKey(w.phone, w.verdict.last.wamid));
  }
  const { results: kvRows } = await db
    .prepare(`SELECT key FROM kv WHERE key IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(keys))
    .all<{ key: string }>();
  const set = new Set((kvRows ?? []).map((k) => k.key));

  // (5)
  const botEnabled = await isBotEnabled(db);

  const facts: CandidateFacts[] = [];
  for (const w of waiting) {
    if (w.verdict.kind !== "waiting") continue;
    const c = contacts.get(w.phone)!;
    const a = appr.get(w.phone);
    const latest =
      a && a.id !== null && a.status !== null
        ? { id: a.id, status: a.status, createdAt: a.created_at ?? 0 }
        : null;
    // Dedupe vs «⏱ Sin responder» (owed-approvals.ts): the newest approval
    // for THIS silence expired ⇒ the chat is listed there (or someone already
    // tapped its «Ya lo atendí») — never twice.
    const inOwed = isInOwedList(latest, w.verdict.since, now);
    facts.push({
      phone: w.phone,
      name: c.name,
      status: c.status,
      overrideUntil: c.override_until,
      verdict: w.verdict,
      latestApproval: latest,
      hasPending: !!a?.has_pending,
      handled: set.has(unansweredDoneKey(w.phone, w.verdict.last.wamid)) || inOwed,
    });
  }
  return selectUnanswered(facts, { now, botEnabled, maxAgeSec });
}

/** The panel's list: shared kv cache (≤ UNANSWERED_CACHE_TTL_SEC old) or a fresh computation. */
export async function getUnansweredForPanel(db: D1Database, now: number): Promise<UnansweredCache> {
  const cached = parseCache(await kvGet(db, UNANSWERED_CACHE_KEY), now, UNANSWERED_CACHE_TTL_SEC, UNANSWERED_MAX_AGE_SEC);
  if (cached) return cached;
  const items = await computeUnanswered(db, now, UNANSWERED_MAX_AGE_SEC);
  const fresh: UnansweredCache = { at: now, maxAgeSec: UNANSWERED_MAX_AGE_SEC, items };
  await kvSet(db, UNANSWERED_CACHE_KEY, JSON.stringify(fresh));
  return fresh;
}

/** Count for the nav badge from the cache only (one kv row; null = unknown/stale). */
export async function cachedUnansweredCount(db: D1Database, now: number): Promise<number | null> {
  const c = parseCache(await kvGet(db, UNANSWERED_CACHE_KEY), now, 15 * 60, UNANSWERED_MAX_AGE_SEC);
  return c ? c.items.length : null;
}

/** «Ya lo atendí»: marker + drop the row from the shared cache right away. */
export async function markUnansweredDone(
  db: D1Database,
  phone: string,
  wamid: string,
  by: string,
  now: number,
): Promise<void> {
  await kvSet(db, unansweredDoneKey(phone, wamid), `${by}:${now}`);
  const raw = await kvGet(db, UNANSWERED_CACHE_KEY);
  if (!raw) return;
  try {
    const c = JSON.parse(raw) as UnansweredCache;
    if (!Array.isArray(c.items)) return;
    c.items = c.items.filter((it) => !(it.phone === phone && it.wamid === wamid));
    await kvSet(db, UNANSWERED_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* garbled cache: the next read recomputes */
  }
}

export interface ReminderDeps {
  postTask(text: string): Promise<void>;
  panelUrl: string;
  chatUrl(phone: string): string | null;
}

/**
 * Cron: ONE aggregated #wa-leads message per tick listing chats that newly
 * crossed 60 min of waiting, inside 08:00–21:30 CDMX; each inbound at most
 * once (kv unansweredPingKey, written AFTER the post so a failed post retries).
 * Returns how many chats it listed.
 */
export async function runUnansweredReminder(env: Env, deps: ReminderDeps, now: number): Promise<number> {
  if (!inReminderWindow(now)) return 0;
  const db = env.DB;
  const cached = parseCache(await kvGet(db, UNANSWERED_CACHE_KEY), now, UNANSWERED_CRON_CACHE_TTL_SEC, UNANSWERED_SLACK_LOOKBACK_SEC);
  const items = cached ? cached.items : await computeUnanswered(db, now, UNANSWERED_SLACK_LOOKBACK_SEC);
  const due = dueForReminder(items, now);
  if (!due.length) return 0;
  const pingKeys = due.map((it) => unansweredPingKey(it.phone, it.wamid));
  const { results } = await db
    .prepare(`SELECT key FROM kv WHERE key IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(pingKeys))
    .all<{ key: string }>();
  const seen = new Set((results ?? []).map((r) => r.key));
  const fresh = due.filter((it) => !seen.has(unansweredPingKey(it.phone, it.wamid)));
  if (!fresh.length) return 0;
  await deps.postTask(reminderText(fresh, now, { panel: deps.panelUrl, chat: deps.chatUrl }));
  await db
    .prepare(`INSERT OR REPLACE INTO kv(key, value) SELECT value, ?2 FROM json_each(?1)`)
    .bind(JSON.stringify(fresh.map((it) => unansweredPingKey(it.phone, it.wamid))), String(now))
    .run();
  return fresh.length;
}
