// D1 side of the "declined" stop (pure rules: src/pipeline/decline.ts).
// Marker = kv `declined:<phone>` (kv PRIMARY KEY lookups only); the cancel is
// one UPDATE on followups by phone (sqlite_autoindex_followups_1 = UNIQUE(phone,
// kind, airtable_record_id), phone-prefixed). No schema change.

import {
  DECLINED_KEY_PREFIX,
  DECLINE_CANCEL_KINDS,
  declineNote,
  declinedKey,
  encodeDeclineMarker,
  parseDeclineMarker,
  type DeclineMarker,
  type DeclineSource,
} from "../pipeline/decline.js";
import { kvDelete, kvGet, kvSet } from "../db/queries.js";

/** The phone's marker, or null. Fails SOFT to null (never blocks on a kv hiccup). */
export async function getDeclineMarker(db: D1Database, phone: string): Promise<DeclineMarker | null> {
  try {
    return parseDeclineMarker(await kvGet(db, declinedKey(phone)));
  } catch (err) {
    console.warn(`[decline] marker read failed for ${phone}: ${String(err)}`);
    return null;
  }
}

/** SQL of the batched marker probe (exported for the index-plan test): kv PRIMARY KEY IN-list. */
export function declineMarkersSql(n: number): string {
  return `SELECT key, value FROM kv WHERE key IN (${Array.from({ length: n }, (_, i) => `?${i + 1}`).join(", ")})`;
}

/** Max phones per IN-list (D1 caps bound parameters at 100). */
export const DECLINE_PROBE_CHUNK = 90;

/**
 * Markers for a page of phones (Chats list): one kv PK IN-list per ≤90
 * phones — never one query per row, never a LIKE / range scan. Phones without
 * a marker are absent. Fails SOFT to an empty map (the list must render).
 */
export async function getDeclineMarkers(db: D1Database, phones: readonly string[]): Promise<Map<string, DeclineMarker>> {
  const out = new Map<string, DeclineMarker>();
  const uniq = [...new Set(phones.filter(Boolean))];
  try {
    for (let i = 0; i < uniq.length; i += DECLINE_PROBE_CHUNK) {
      const keys = uniq.slice(i, i + DECLINE_PROBE_CHUNK).map(declinedKey);
      const { results } = await db.prepare(declineMarkersSql(keys.length)).bind(...keys).all<{ key: string; value: string }>();
      for (const r of results ?? []) {
        const m = parseDeclineMarker(r.value);
        if (m) out.set(r.key.slice(DECLINED_KEY_PREFIX.length), m);
      }
    }
  } catch (err) {
    console.warn(`[decline] batched marker read failed: ${String(err)}`);
  }
  return out;
}

/** True while the stop is set for this phone. */
export async function isDeclined(db: D1Database, phone: string): Promise<boolean> {
  return (await getDeclineMarker(db, phone)) !== null;
}

/** SQL of the cancel (exported for the index-plan test). */
export function declineCancelSql(nKinds: number): string {
  const ph = Array.from({ length: nKinds }, (_, i) => `?${i + 2}`).join(", ");
  return `UPDATE followups SET status = 'cancelled'
           WHERE phone = ?1 AND status IN ('scheduled', 'paused') AND kind IN (${ph})`;
}

/** Cancel every pending chasing row of the phone; returns how many. */
export async function cancelDeclinedFollowups(db: D1Database, phone: string): Promise<number> {
  const r = await db
    .prepare(declineCancelSql(DECLINE_CANCEL_KINDS.length))
    .bind(phone, ...DECLINE_CANCEL_KINDS)
    .run();
  return Number(r.meta?.changes ?? 0);
}

/**
 * Set (or refresh) the stop: write the marker, cancel the pending chasing rows,
 * and post ONE ops_log note when the stop is new or something was cancelled.
 * A refresh on an already-declined lead with nothing to cancel stays quiet.
 * Never throws (the reply to the lead must still go out).
 */
export async function applyDecline(
  db: D1Database,
  phone: string,
  source: DeclineSource,
  opts: { text?: string; now?: number; postNote?: (text: string, meta: Record<string, unknown>) => Promise<void> } = {},
): Promise<{ cancelled: number; fresh: boolean }> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  let fresh = false;
  let cancelled = 0;
  try {
    fresh = (await getDeclineMarker(db, phone)) === null;
    await kvSet(db, declinedKey(phone), encodeDeclineMarker({ ts: now, source, ...(opts.text ? { text: opts.text } : {}) }));
    cancelled = await cancelDeclinedFollowups(db, phone);
  } catch (err) {
    console.error(`[decline] apply failed for ${phone}`, err);
  }
  if ((fresh || cancelled > 0) && opts.postNote) {
    try {
      await opts.postNote(declineNote(phone, source, cancelled), { phone, source, cancelled });
    } catch (err) {
      console.warn(`[decline] note failed for ${phone}: ${String(err)}`);
    }
  }
  return { cancelled, fresh };
}

/** Lift the stop (booking / expressed interest / staff reset). True when one was set. Never throws. */
export async function clearDecline(db: D1Database, phone: string): Promise<boolean> {
  try {
    if ((await kvGet(db, declinedKey(phone))) === null) return false;
    await kvDelete(db, declinedKey(phone));
    return true;
  } catch (err) {
    console.error(`[decline] clear failed for ${phone}`, err);
    return false;
  }
}

/**
 * Every declined phone, for audience building (blasts). A PK range scan over
 * the `declined:` prefix only — never a LIKE (which cannot use the kv PK and
 * reads the whole table).
 */
export const DECLINED_RANGE_SQL = `SELECT key FROM kv WHERE key >= ?1 AND key < ?2`;

export async function declinedPhones(db: D1Database): Promise<Set<string>> {
  const hi = DECLINED_KEY_PREFIX.slice(0, -1) + String.fromCharCode(DECLINED_KEY_PREFIX.charCodeAt(DECLINED_KEY_PREFIX.length - 1) + 1);
  const { results } = await db.prepare(DECLINED_RANGE_SQL).bind(DECLINED_KEY_PREFIX, hi).all<{ key: string }>();
  return new Set(results.map((r) => r.key.slice(DECLINED_KEY_PREFIX.length)));
}
