import { test } from "node:test";
import assert from "node:assert/strict";
import { BLINDAJE_8, seedCampaigns } from "../src/cron/seed-campaigns.js";
import { normalizeText, matchCampaignTiered } from "../src/pipeline/campaigns.js";
import type { Campaign, Env } from "../src/types.js";

// Scriptable fake D1: kv map + campaigns table in memory.
function fakeDb(existing: Campaign[] = []) {
  const kv = new Map<string, string>();
  const campaigns: Campaign[] = [...existing];
  const calls: { sql: string; binds: unknown[] }[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) { binds = v; return stmt; },
      async first<T>(): Promise<T | null> {
        calls.push({ sql, binds });
        if (sql.includes("FROM kv")) {
          const v = kv.get(String(binds[0]));
          return (v === undefined ? null : ({ value: v } as unknown as T)) as T | null;
        }
        if (sql.includes("FROM campaigns WHERE id")) {
          return (campaigns.find((c) => c.id === binds[0]) ?? null) as T | null;
        }
        return null;
      },
      async run() {
        calls.push({ sql, binds });
        if (sql.includes("INTO kv")) kv.set(String(binds[0]), String(binds[1]));
        if (sql.includes("INSERT INTO campaigns")) {
          const id = campaigns.length + 1;
          campaigns.push({
            id, name: String(binds[0]), trigger_phrase: String(binds[1]), trigger_norm: String(binds[2]),
            info: String(binds[3]), status: "active", ends_at: null, ad_id: null, first_reply: null,
            ad_keywords: null, created_at: 0, updated_at: 0,
          } as Campaign);
          return { results: [], meta: { changes: 1, last_row_id: id } };
        }
        if (sql.includes("SET first_reply")) { const c = campaigns.find((c) => c.id === binds[0]); if (c) c.first_reply = String(binds[1]); }
        if (sql.includes("SET ad_keywords")) { const c = campaigns.find((c) => c.id === binds[0]); if (c) c.ad_keywords = String(binds[1]); }
        return { results: [], meta: { changes: 1 } };
      },
      async all<T>() {
        calls.push({ sql, binds });
        if (sql.includes("FROM campaigns")) return { results: [...campaigns] as T[], meta: {} };
        return { results: [] as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make } as D1Database, kv, campaigns, calls };
}

const env = (db: D1Database) => ({ DB: db } as unknown as Env);

test("seedCampaigns: creates Blindaje 8 once with first reply + keywords, then never again", async () => {
  const fx = fakeDb();
  const notes: string[] = [];
  const created = await seedCampaigns(env(fx.db), { postNote: async (t) => { notes.push(t); } });
  assert.deepEqual(created, ["Blindaje 8"]);
  assert.equal(fx.campaigns.length, 1);
  const c = fx.campaigns[0]!;
  assert.equal(c.trigger_norm, normalizeText(BLINDAJE_8.triggerPhrase));
  assert.match(c.first_reply ?? "", /Blindaje 8/);
  assert.match(c.first_reply ?? "", /este sábado/);
  assert.ok(!/mañana sábado/.test(c.first_reply ?? ""), "no hardcoded day in the canned welcome");
  assert.match(c.ad_keywords ?? "", /blindaje/);
  assert.match(c.info, /book_trial/);
  assert.match(c.info, /16 años/);
  assert.equal(fx.kv.get(BLINDAJE_8.key), "created");
  assert.equal(notes.length, 1);
  const again = await seedCampaigns(env(fx.db), { postNote: async (t) => { notes.push(t); } });
  assert.deepEqual(again, []);
  assert.equal(fx.campaigns.length, 1);
  assert.equal(notes.length, 1);
});

test("seedCampaigns: an existing campaign with the same trigger is left alone", async () => {
  const fx = fakeDb([{
    id: 7, name: "Blindaje (manual)", trigger_phrase: BLINDAJE_8.triggerPhrase,
    trigger_norm: normalizeText(BLINDAJE_8.triggerPhrase), info: "x", status: "active",
    ends_at: null, ad_id: null, first_reply: null, ad_keywords: null, created_at: 0, updated_at: 0,
  } as Campaign]);
  const created = await seedCampaigns(env(fx.db), { postNote: async () => {} });
  assert.deepEqual(created, []);
  assert.equal(fx.campaigns.length, 1);
  assert.equal(fx.kv.get(BLINDAJE_8.key), "exists:7");
});

test("the seeded trigger phrase and keywords match the ad's prefill and a loose variant", () => {
  const c = {
    id: 1, name: "Blindaje 8", trigger_phrase: BLINDAJE_8.triggerPhrase,
    trigger_norm: normalizeText(BLINDAJE_8.triggerPhrase), info: "", status: "active",
    ends_at: null, ad_id: null, first_reply: BLINDAJE_8.firstReply, ad_keywords: BLINDAJE_8.adKeywords,
    created_at: 0, updated_at: 0,
  } as Campaign;
  const m = (text: string) =>
    matchCampaignTiered({ sourceId: null, adTextNorm: "", bodyNorm: normalizeText(text), campaigns: [c] });
  assert.equal(m("Hola! Quiero apartar mi lugar para la clase gratis de Blindaje 8")?.id, 1);
  assert.equal(m("Quiero apartar mi lugar para la clase gratis de Blindaje 8")?.id, 1);
});
