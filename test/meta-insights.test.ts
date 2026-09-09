import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONVERSATION_ACTION,
  adAccountPath,
  fetchInsights,
  insightsUrl,
  metaToken,
  parseInsightsRows,
  probeMetaAds,
} from "../src/services/meta-insights.js";
import type { Env } from "../src/types.js";

const ENV = {
  META_AD_ACCOUNT_ID: "act_123",
  ADS_ACCESS_TOKEN: "ads-secret",
  WA_ACCESS_TOKEN: "wa-secret",
} as unknown as Env;

function fakeRes(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

const ROW = {
  ad_id: "120249684011860518",
  ad_name: "Buscamos Personas Débiles!",
  adset_id: "111",
  adset_name: "cold 2mi",
  campaign_id: "222",
  campaign_name: "Reto Gladiador",
  spend: "123.45",
  impressions: "1000",
  clicks: "40",
  reach: "800",
  account_currency: "MXN",
  date_start: "2026-09-08",
  date_stop: "2026-09-08",
  actions: [
    { action_type: "link_click", value: "40" },
    { action_type: CONVERSATION_ACTION, value: "7" },
  ],
};

test("adAccountPath normalizes with/without the act_ prefix", () => {
  assert.equal(adAccountPath("123"), "act_123");
  assert.equal(adAccountPath("act_123"), "act_123");
});

test("insightsUrl: ad level, daily increment, JSON time_range, no token", () => {
  const u = insightsUrl("123", "2026-09-01", "2026-09-07");
  assert.match(u, /^https:\/\/graph\.facebook\.com\/v23\.0\/act_123\/insights\?/);
  assert.match(u, /level=ad/);
  assert.match(u, /time_increment=1/);
  assert.match(u, /limit=500/);
  assert.ok(u.includes(encodeURIComponent(JSON.stringify({ since: "2026-09-01", until: "2026-09-07" }))));
  assert.ok(u.includes("campaign_id") && u.includes("actions") && u.includes("account_currency"));
  assert.ok(!u.includes("access_token"));
});

test("parseInsightsRows: numerics, conversations, defaults, drops rows without id/date", () => {
  const rows = parseInsightsRows({
    data: [
      ROW,
      { ...ROW, ad_id: "2", actions: undefined, account_currency: undefined, spend: "0" },
      { ...ROW, ad_id: "" },
      { ...ROW, date_start: undefined },
      null,
    ],
  });
  assert.equal(rows.length, 2);
  const r = rows[0]!;
  assert.equal(r.spend, 123.45);
  assert.equal(r.impressions, 1000);
  assert.equal(r.clicks, 40);
  assert.equal(r.reach, 800);
  assert.equal(r.conversations, 7);
  assert.equal(r.campaignId, "222");
  assert.equal(r.currency, "MXN");
  assert.equal(r.date, "2026-09-08");
  assert.equal(rows[1]!.conversations, 0);
  assert.equal(rows[1]!.currency, "MXN");
  assert.deepEqual(parseInsightsRows({}), []);
  assert.deepEqual(parseInsightsRows(null), []);
});

test("metaToken prefers ADS_ACCESS_TOKEN, falls back to WA, else null", () => {
  assert.deepEqual(metaToken(ENV), { token: "ads-secret", source: "ADS_ACCESS_TOKEN" });
  assert.deepEqual(metaToken({ WA_ACCESS_TOKEN: "wa" } as unknown as Env), {
    token: "wa",
    source: "WA_ACCESS_TOKEN",
  });
  assert.deepEqual(metaToken({} as unknown as Env), { token: null, source: null });
});

test("fetchInsights follows paging.next with the Bearer header on every hop", async () => {
  const calls: { url: string; auth: string | undefined }[] = [];
  const next = "https://graph.facebook.com/v23.0/act_123/insights?after=abc";
  const doFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (calls.length === 1) return fakeRes(true, { data: [ROW], paging: { next } });
    return fakeRes(true, { data: [{ ...ROW, ad_id: "9" }], paging: {} });
  };
  const rows = await fetchInsights(ENV, "2026-09-08", "2026-09-08", doFetch);
  assert.equal(rows.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url, next);
  assert.ok(calls.every((c) => c.auth === "Bearer ads-secret"));
});

test("fetchInsights surfaces Graph's message, never the token or URL", async () => {
  const doFetch = async (): Promise<Response> =>
    fakeRes(false, { error: { message: "(#200) Requires ads_read", code: 200 } }, 403);
  let message = "";
  try {
    await fetchInsights(ENV, "2026-09-08", "2026-09-08", doFetch);
  } catch (err) {
    message = (err as Error).message;
  }
  assert.ok(message.includes("Requires ads_read"), message);
  assert.ok(!message.includes("ads-secret") && !message.includes("http"), message);
  await assert.rejects(() => fetchInsights({} as unknown as Env, "a", "b", doFetch), /no Meta token/);
});

test("probeMetaAds: account + one-day pull, timezone/currency warnings, no throw on failure", async () => {
  const good = async (url: string): Promise<Response> =>
    url.includes("/insights")
      ? fakeRes(true, { data: [ROW, { ...ROW, ad_id: "2", spend: "10" }], paging: {} })
      : fakeRes(true, { name: "MD Condesa", currency: "USD", timezone_name: "America/Bogota", account_status: 1 });
  const p = await probeMetaAds(ENV, "2026-09-08", good);
  assert.equal(p.ok, true);
  assert.equal(p.tokenSource, "ADS_ACCESS_TOKEN");
  assert.equal(p.account.name, "MD Condesa");
  assert.equal(p.day?.rows, 2);
  assert.equal(p.day?.spend, 133.45);
  assert.equal(p.day?.conversations, 14);
  assert.equal(p.warnings.length, 2);

  const bad = async (): Promise<Response> => fakeRes(false, { error: { message: "Invalid OAuth token" } }, 401);
  const q = await probeMetaAds(ENV, "2026-09-08", bad);
  assert.equal(q.ok, false);
  assert.match(q.error ?? "", /Invalid OAuth token/);
  assert.equal(q.day, null);

  const none = await probeMetaAds({} as unknown as Env, "2026-09-08", good);
  assert.equal(none.ok, false);
  assert.match(none.error ?? "", /no Meta token/);
});
