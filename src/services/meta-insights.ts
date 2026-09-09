// Meta Marketing API reads for the marketing-metrics feeder: daily per-ad
// insights (spend, delivery, messaging conversations) and a token/account
// probe. Raw fetch, zero deps. Auth is a Bearer header (never a query param) so
// no URL ever carries the token; errors surface only Graph's `error.message`.
//
// Token: ADS_ACCESS_TOKEN when set, else the WhatsApp token (works when the
// system user also holds ad-account access) — the same fallback ad-meta.ts uses.

import type { Env } from "../types.js";
import { GRAPH } from "./ad-meta.js";

/** Insights action_type for click-to-WhatsApp "messaging conversations started". */
export const CONVERSATION_ACTION =
  "onsite_conversion.messaging_conversation_started_7d";

const FIELDS = [
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
  "spend",
  "impressions",
  "clicks",
  "reach",
  "actions",
  "account_currency",
];
/** Hard cap on paging.next hops per pull (a 7-day ad-level window is < 5 pages). */
const MAX_PAGES = 20;

export interface InsightRow {
  /** YYYY-MM-DD in the ad account's timezone (date_start). */
  date: string;
  adId: string;
  adName: string;
  adSetId: string;
  adSetName: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  /** Messaging conversations started (CONVERSATION_ACTION), 0 when absent. */
  conversations: number;
  /** Account currency code, e.g. "MXN". */
  currency: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** "act_123" | "123" → "act_123". */
export function adAccountPath(raw: string): string {
  const t = raw.trim();
  return t.startsWith("act_") ? t : `act_${t}`;
}

/** Pure: the ad-level, daily-increment insights URL for [since, until]. */
export function insightsUrl(account: string, since: string, until: string): string {
  const qs = new URLSearchParams();
  qs.set("level", "ad");
  qs.set("time_increment", "1");
  qs.set("time_range", JSON.stringify({ since, until }));
  qs.set("fields", FIELDS.join(","));
  qs.set("limit", "500");
  return `${GRAPH}/${adAccountPath(account)}/insights?${qs.toString()}`;
}

export function metaToken(env: Env): {
  token: string | null;
  source: "ADS_ACCESS_TOKEN" | "WA_ACCESS_TOKEN" | null;
} {
  if (env.ADS_ACCESS_TOKEN) return { token: env.ADS_ACCESS_TOKEN, source: "ADS_ACCESS_TOKEN" };
  if (env.WA_ACCESS_TOKEN) return { token: env.WA_ACCESS_TOKEN, source: "WA_ACCESS_TOKEN" };
  return { token: null, source: null };
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

/**
 * Pure. One insights page → rows. Tolerant: Graph returns every numeric as a
 * string, `actions` is absent when an ad had no conversions, and unknown keys
 * are ignored. Rows without an ad_id or date are dropped.
 */
export function parseInsightsRows(json: unknown): InsightRow[] {
  const data = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: InsightRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const adId = str(r.ad_id);
    const date = str(r.date_start);
    if (!adId || !date) continue;
    let conversations = 0;
    if (Array.isArray(r.actions)) {
      for (const a of r.actions as unknown[]) {
        const act = a as { action_type?: unknown; value?: unknown } | null;
        if (act && act.action_type === CONVERSATION_ACTION) conversations += num(act.value);
      }
    }
    out.push({
      date,
      adId,
      adName: str(r.ad_name),
      adSetId: str(r.adset_id),
      adSetName: str(r.adset_name),
      campaignId: str(r.campaign_id),
      campaignName: str(r.campaign_name),
      spend: num(r.spend),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      reach: num(r.reach),
      conversations,
      currency: str(r.account_currency) || "MXN",
    });
  }
  return out;
}

/** Graph error → a message safe to log (no URL, no token). */
async function graphError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  const m = body.error?.message ?? `HTTP ${res.status}`;
  const code = body.error?.code !== undefined ? ` (code ${body.error.code})` : "";
  return `${m}${code}`;
}

/**
 * Pull ad-level daily insights for [since, until] (YYYY-MM-DD, account tz),
 * following paging.next with the auth header re-sent each hop. Throws with a
 * token-free message on any non-ok page.
 */
export async function fetchInsights(
  env: Env,
  since: string,
  until: string,
  doFetch: FetchLike = defaultFetch,
): Promise<InsightRow[]> {
  const { token } = metaToken(env);
  if (!token) throw new Error("no Meta token (ADS_ACCESS_TOKEN / WA_ACCESS_TOKEN unset)");
  if (!env.META_AD_ACCOUNT_ID) throw new Error("META_AD_ACCOUNT_ID unset");
  const headers = { Authorization: `Bearer ${token}` };
  let url: string | null = insightsUrl(env.META_AD_ACCOUNT_ID, since, until);
  const rows: InsightRow[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await doFetch(url, { method: "GET", headers });
    if (!res.ok) throw new Error(`Meta insights ${since}..${until}: ${await graphError(res)}`);
    const json = (await res.json()) as { paging?: { next?: string } };
    rows.push(...parseInsightsRows(json));
    url = json.paging?.next ?? null;
  }
  return rows;
}

export interface ProbeResult {
  ok: boolean;
  tokenSource: "ADS_ACCESS_TOKEN" | "WA_ACCESS_TOKEN" | null;
  account: {
    id: string | null;
    name: string | null;
    currency: string | null;
    timezone: string | null;
    status: number | null;
  };
  /** One-day insights pull (the given date) as a permission smoke test. */
  day: { date: string; rows: number; spend: number; conversations: number } | null;
  warnings: string[];
  error: string | null;
}

/**
 * Go/no-go for the spend import: reads the ad account (name/currency/timezone)
 * and pulls one day of insights. Never throws; never includes the token.
 */
export async function probeMetaAds(
  env: Env,
  date: string,
  doFetch: FetchLike = defaultFetch,
): Promise<ProbeResult> {
  const { token, source } = metaToken(env);
  const out: ProbeResult = {
    ok: false,
    tokenSource: source,
    account: { id: env.META_AD_ACCOUNT_ID ?? null, name: null, currency: null, timezone: null, status: null },
    day: null,
    warnings: [],
    error: null,
  };
  if (!token) {
    out.error = "no Meta token: set ADS_ACCESS_TOKEN (ads_read on the ad account)";
    return out;
  }
  if (!env.META_AD_ACCOUNT_ID) {
    out.error = "META_AD_ACCOUNT_ID var unset";
    return out;
  }
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const res = await doFetch(
      `${GRAPH}/${adAccountPath(env.META_AD_ACCOUNT_ID)}?fields=name,currency,timezone_name,account_status`,
      { method: "GET", headers },
    );
    if (!res.ok) {
      out.error = `ad account read failed: ${await graphError(res)}`;
      return out;
    }
    const acc = (await res.json()) as {
      name?: string;
      currency?: string;
      timezone_name?: string;
      account_status?: number;
    };
    out.account.name = acc.name ?? null;
    out.account.currency = acc.currency ?? null;
    out.account.timezone = acc.timezone_name ?? null;
    out.account.status = typeof acc.account_status === "number" ? acc.account_status : null;
    if (acc.timezone_name && acc.timezone_name !== "America/Mexico_City") {
      out.warnings.push(
        `ad account timezone is ${acc.timezone_name}; spend days are bucketed in that zone while leads use America/Mexico_City`,
      );
    }
    if (acc.currency && acc.currency !== "MXN") {
      out.warnings.push(`ad account currency is ${acc.currency}, revenue is MXN — ROAS mixes currencies`);
    }
    const rows = await fetchInsights(env, date, date, doFetch);
    out.day = {
      date,
      rows: rows.length,
      spend: Math.round(rows.reduce((s, r) => s + r.spend, 0) * 100) / 100,
      conversations: rows.reduce((s, r) => s + r.conversations, 0),
    };
    out.ok = true;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}
