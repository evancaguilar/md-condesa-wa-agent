// POST /g — the site's attribution.js reports a Google Ads click under a short
// code, so the WhatsApp prefill only has to carry "[K7M2QX]" instead of a
// ~100-character gclid (src/services/google-click.ts has the shapes).
//
// Public by design (the visitor's browser calls it). Defences: the body must
// validate exactly, a code is written once (INSERT OR IGNORE, never
// overwritten), and at most GREF_DAILY_CAP new codes are accepted per CDMX day.
// Always 204 — a caller learns nothing. Keys expire with gcGoogleRefs (cron).

import type { Env } from "../types.js";
import { kvGet, kvIncrementIfBelow, kvSetIfAbsent } from "../db/queries.js";
import { cdmxDateStr } from "../cron/time.js";
import {
  GOOGLE_CLICK_TTL_SEC,
  googleRefKey,
  parseGoogleClickBeacon,
} from "../services/google-click.js";

/** New codes accepted per CDMX day (Google brings ~5 leads/day; pages re-send). */
export const GREF_DAILY_CAP = 1000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const done = (): Response => new Response(null, { status: 204, headers: CORS });

export async function handleGoogleClickBeacon(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return done();
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });
  const nowSec = Math.floor(Date.now() / 1000);
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return done();
  }
  const b = parseGoogleClickBeacon(raw, nowSec);
  if (!b) return done();
  const key = googleRefKey(b.code);
  try {
    // A page re-sends until it gets this 204: a known code costs one read.
    if ((await kvGet(env.DB, key)) !== null) return done();
    if (!(await kvIncrementIfBelow(env.DB, `gref_day:${cdmxDateStr(nowSec)}`, GREF_DAILY_CAP))) return done();
    await kvSetIfAbsent(env.DB, key, JSON.stringify(b.click));
  } catch (err) {
    console.warn("[gref] store failed", err);
  }
  return done();
}

/**
 * Deletes codes older than Google's 90-day click life and past day counters.
 * PRIMARY KEY range scans over kv (no LIKE), run once per CDMX day.
 */
export async function gcGoogleRefs(db: D1Database, nowSec: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM kv WHERE key >= 'gref:' AND key < 'gref;'
         AND CAST(json_extract(value, '$.ts') AS INTEGER) < ?1`,
    )
    .bind(nowSec - GOOGLE_CLICK_TTL_SEC)
    .run();
  await db
    .prepare(`DELETE FROM kv WHERE key >= 'gref_day:' AND key < ?1`)
    .bind(`gref_day:${cdmxDateStr(nowSec - 7 * 86400)}`)
    .run();
}
