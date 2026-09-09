// Meta ad-spend import (marketing metrics). Daily: re-pull the last 3 days +
// today (Meta restates spend/conversions for ~72h; the Airtable upsert is
// idempotent) into Ad Spend Diario. Backfill: one 7-day chunk per cron tick
// from METRICS_SINCE until yesterday, then a kv done-flag. Pure date helpers
// are exported for tests; all state is kv (no D1 migration).

import type { Env } from "../types.js";
import type { CronSlackDeps } from "./deps.js";
import { kvGet, kvSet } from "../db/queries.js";
import { cdmxDateStr, DAY } from "./time.js";
import { fetchInsights, type InsightRow } from "../services/meta-insights.js";
import {
  MetricsSchemaError,
  fillNamelessAds,
  upsertAdSpendRows,
  upsertAdsMeta,
  type UpsertStats,
} from "../services/metrics-airtable.js";

export const KV_SPEND_MARK = "ad_spend_mark";
export const KV_SPEND_LAST_OK = "ad_spend_last_ok";
export const KV_SPEND_LAST_ERROR = "ad_spend_last_error";
export const KV_SPEND_CURRENCY = "ad_spend_currency";
export const KV_BACKFILL_CURSOR = "ad_spend_backfill_cursor";
export const KV_BACKFILL_DONE = "ad_spend_backfill_done";

/** Daily window: [today-lookback, today] in CDMX. */
export function dailyPullWindow(
  nowEpoch: number,
  lookbackDays = 3,
): { since: string; until: string } {
  return { since: cdmxDateStr(nowEpoch - lookbackDays * DAY), until: cdmxDateStr(nowEpoch) };
}

/** 05:30–06:59 CDMX: Meta has finalized yesterday by then; wide so a missed tick catches up. */
export function shouldRunDailyPull(p: { hour: number; minute: number }): boolean {
  return (p.hour === 5 && p.minute >= 30) || p.hour === 6;
}

/** "YYYY-MM-DD" ± n days (pure calendar arithmetic, no timezone). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + n * DAY * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Pure. Next backfill chunk given the kv cursor: [start, min(start+days-1,
 * yesterday)]. `next` is the following cursor, or null when the chunk reaches
 * yesterday. Returns null when the cursor is already past yesterday (done).
 */
export function nextBackfillChunk(
  cursor: string | null,
  since: string,
  today: string,
  days = 7,
): { since: string; until: string; next: string | null } | null {
  const start = cursor && cursor > since ? cursor : since;
  const yesterday = addDays(today, -1);
  if (start > yesterday) return null;
  const candidate = addDays(start, days - 1);
  const until = candidate < yesterday ? candidate : yesterday;
  return { since: start, until, next: until < yesterday ? addDays(until, 1) : null };
}

export interface PullDeps {
  fetchInsights?: (env: Env, since: string, until: string) => Promise<InsightRow[]>;
  upsertAdsMeta?: (env: Env, rows: InsightRow[]) => Promise<UpsertStats>;
  upsertAdSpendRows?: (
    env: Env,
    rows: InsightRow[],
    account: string,
    updatedIso: string,
  ) => Promise<UpsertStats>;
}

export interface PullResult {
  since: string;
  until: string;
  rows: number;
  ads: number;
  created: number;
  updated: number;
  errors: string[];
  currency: string | null;
}

/** Pull [since, until] from Meta and upsert campaigns → ads → spend rows. */
export async function pullAdSpend(
  env: Env,
  since: string,
  until: string,
  deps: PullDeps = {},
): Promise<PullResult> {
  const rows = await (deps.fetchInsights ?? fetchInsights)(env, since, until);
  const account = env.META_AD_ACCOUNT_ID ?? "";
  const meta = await (deps.upsertAdsMeta ?? upsertAdsMeta)(env, rows);
  const spend = await (deps.upsertAdSpendRows ?? upsertAdSpendRows)(
    env,
    rows,
    account,
    new Date().toISOString(),
  );
  return {
    since,
    until,
    rows: rows.length,
    ads: new Set(rows.map((r) => r.adId)).size,
    created: spend.created,
    updated: spend.updated,
    errors: [...meta.errors, ...spend.errors],
    currency: rows[0]?.currency ?? null,
  };
}

function iso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

/** The 05:30 job: last 3 days + today, then name any lead-only ads. */
export async function runDailyAdSpend(
  env: Env,
  nowEpoch: number,
  deps: { slack: Pick<CronSlackDeps, "postNote"> },
  pull: typeof pullAdSpend = pullAdSpend,
): Promise<PullResult> {
  const w = dailyPullWindow(nowEpoch);
  try {
    const r = await pull(env, w.since, w.until);
    await kvSet(env.DB, KV_SPEND_LAST_OK, iso(nowEpoch));
    if (r.currency) await kvSet(env.DB, KV_SPEND_CURRENCY, r.currency);
    try {
      await fillNamelessAds(env);
    } catch (err) {
      console.warn(`[ad-spend] fillNamelessAds: ${String(err)}`);
    }
    if (r.errors.length) {
      await deps.slack.postNote(
        `⚠️ Ad spend import ${w.since}..${w.until}: ${r.errors.length} batch error(s). First: ${r.errors[0]}`,
      );
    }
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await kvSet(env.DB, KV_SPEND_LAST_ERROR, `${iso(nowEpoch)} ${msg}`).catch(() => {});
    if (err instanceof MetricsSchemaError) {
      await deps.slack.postNote(
        `⚠️ Ad spend import stopped: Airtable field missing (${msg}). Fix the base or the airtableMetrics map.`,
      );
    }
    throw err;
  }
}

/**
 * One backfill chunk per call (the dispatcher calls it every tick): advances
 * kv cursor from METRICS_SINCE to yesterday, then flips the done flag.
 */
export async function runAdSpendBackfillStep(
  env: Env,
  nowEpoch: number,
  deps: { slack: Pick<CronSlackDeps, "postNote"> },
  pull: typeof pullAdSpend = pullAdSpend,
): Promise<"skipped" | "advanced" | "done"> {
  if (!env.METRICS_SINCE) return "skipped";
  if (await kvGet(env.DB, KV_BACKFILL_DONE)) return "skipped";
  const cursor = await kvGet(env.DB, KV_BACKFILL_CURSOR);
  const chunk = nextBackfillChunk(cursor, env.METRICS_SINCE, cdmxDateStr(nowEpoch));
  if (!chunk) {
    await kvSet(env.DB, KV_BACKFILL_DONE, iso(nowEpoch));
    return "done";
  }
  const r = await pull(env, chunk.since, chunk.until);
  console.log(
    `[ad-spend] backfill ${chunk.since}..${chunk.until}: ${r.rows} rows, +${r.created}/~${r.updated}`,
  );
  if (chunk.next) {
    await kvSet(env.DB, KV_BACKFILL_CURSOR, chunk.next);
    return "advanced";
  }
  await kvSet(env.DB, KV_BACKFILL_DONE, iso(nowEpoch));
  await deps.slack.postNote(
    `✅ Ad spend backfill complete: ${env.METRICS_SINCE} → ${chunk.until} is in Airtable (Ad Spend Diario).`,
  );
  return "done";
}
