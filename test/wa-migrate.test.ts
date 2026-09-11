import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KV_NEW_PHONE_ID,
  MIGRATE_CONFIRM,
  runMigrationStep,
  splitMxDisplayNumber,
} from "../src/services/wa-migrate.js";
import type { Env } from "../src/types.js";

function fakeDb(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM kv")) {
          const v = store.get(String(binds[0]));
          return (v === undefined ? null : ({ value: v } as unknown as T)) as T | null;
        }
        return null;
      },
      async run() {
        if (sql.includes("INTO kv")) store.set(String(binds[0]), String(binds[1]));
        return { results: [], meta: { changes: 1 } };
      },
      async all() {
        return { results: [], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make } as D1Database, store };
}

function envWith(db: D1Database): Env {
  return {
    DB: db,
    WA_ACCESS_TOKEN: "tok",
    WA_PHONE_NUMBER_ID: "OLD1",
    AIRTABLE_BASE_ID: "",
    AIRTABLE_TRIALS_TABLE: "",
    TRAINING_WHEELS: "1",
    HUMAN_SNOOZE_HOURS: "8",
    SLACK_CHANNEL_ID: "",
    META_APP_SECRET: "",
    WA_VERIFY_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    SLACK_BOT_TOKEN: "",
    SLACK_SIGNING_SECRET: "",
    AIRTABLE_PAT: "",
    ADMIN_PASSWORD: "",
  } as Env;
}

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown };

function fakeFetch(route: Route) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const doFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const r = route(url, init);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return r.body;
      },
      async text() {
        return JSON.stringify(r.body);
      },
    } as unknown as Response;
  };
  return { doFetch, calls };
}

test("splitMxDisplayNumber: +52 display → cc + national number", () => {
  assert.deepEqual(splitMxDisplayNumber("+52 1 56 4199 2274"), { cc: "52", phone: "15641992274" });
  assert.equal(splitMxDisplayNumber("+1 555-089-6235"), null);
});

test("check: reads old number + new WABA, reports readiness, sends the token", async () => {
  const { db } = fakeDb();
  const { doFetch, calls } = fakeFetch((url) => {
    if (url.includes("/OLD1?")) return { body: { id: "OLD1", display_phone_number: "+52 1 56 4199 2274" } };
    if (url.includes("/NEWWABA?")) return { body: { id: "NEWWABA", name: "MD", primary_funding_id: "F1" } };
    if (url.endsWith("/NEWWABA/subscribed_apps")) return { body: { data: [{ id: "APP" }] } };
    return { body: { data: [] } };
  });
  const r = await runMigrationStep(envWith(db), { step: "check", newWabaId: "NEWWABA" }, doFetch);
  assert.equal(r.ok, true);
  const d = r.data as { readiness: Record<string, unknown>; willSend: unknown };
  assert.deepEqual(d.willSend, { cc: "52", phone: "15641992274" });
  assert.equal(d.readiness.newWabaHasFunding, true);
  assert.equal(d.readiness.newWabaAppSubscribed, true);
  assert.equal(d.readiness.oldNumberIsMx, true);
  assert.ok(calls.every((c) => c.method === "GET"), "check is read-only");
});

test("migrate: refuses without the exact confirm phrase and never calls Meta", async () => {
  const { db } = fakeDb();
  const { doFetch, calls } = fakeFetch(() => ({ body: {} }));
  const r = await runMigrationStep(envWith(db), { step: "migrate", newWabaId: "NEWWABA", confirm: "si" }, doFetch);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /confirm/);
  assert.equal(calls.length, 0);
});

test("migrate: posts cc/phone/migrate flag, remembers the new id; later steps use it", async () => {
  const { db, store } = fakeDb();
  const { doFetch, calls } = fakeFetch((url, init) => {
    if (url.includes("/OLD1?")) return { body: { id: "OLD1", display_phone_number: "+52 1 56 4199 2274" } };
    if (url.endsWith("/NEWWABA/phone_numbers") && init?.method === "POST") return { body: { id: "NEW9" } };
    if (url.endsWith("/NEW9/request_code")) return { body: { success: true } };
    if (url.endsWith("/NEW9/verify_code")) return { body: { success: true } };
    if (url.endsWith("/NEW9/register")) return { body: { success: true } };
    if (url.endsWith("/NEWWABA/subscribed_apps")) return { body: init?.method === "POST" ? { success: true } : { data: [{ id: "APP" }] } };
    if (url.includes("/NEW9?")) return { body: { id: "NEW9", status: "CONNECTED" } };
    return { status: 404, body: { error: { message: "nope" } } };
  });
  const env = envWith(db);
  const m = await runMigrationStep(env, { step: "migrate", newWabaId: "NEWWABA", confirm: MIGRATE_CONFIRM }, doFetch);
  assert.equal(m.ok, true, JSON.stringify(m));
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post?.body, { cc: "52", phone_number: "15641992274", migrate_phone_number: true });
  assert.equal(store.get(KV_NEW_PHONE_ID), "NEW9");

  const rc = await runMigrationStep(env, { step: "request_code" }, doFetch);
  assert.equal(rc.ok, true);
  assert.deepEqual(calls[calls.length - 1].body, { code_method: "SMS", language: "es" });

  const bad = await runMigrationStep(env, { step: "verify_code", code: "12" }, doFetch);
  assert.equal(bad.ok, false);
  const vc = await runMigrationStep(env, { step: "verify_code", code: "123-456" }, doFetch);
  assert.equal(vc.ok, true);
  assert.deepEqual(calls[calls.length - 1].body, { code: "123456" });

  const badPin = await runMigrationStep(env, { step: "register", pin: "12" }, doFetch);
  assert.equal(badPin.ok, false);
  const reg = await runMigrationStep(env, { step: "register", pin: "654321" }, doFetch);
  assert.equal(reg.ok, true);
  assert.deepEqual(calls[calls.length - 1].body, { messaging_product: "whatsapp", pin: "654321" });

  const sub = await runMigrationStep(env, { step: "subscribe", newWabaId: "NEWWABA" }, doFetch);
  assert.equal(sub.ok, true);

  const pc = await runMigrationStep(env, { step: "post_check" }, doFetch);
  assert.equal(pc.ok, true);
  assert.match(String((pc.data as { nextStep: string }).nextStep), /WA_PHONE_NUMBER_ID=NEW9/);
  // The token went out on every call, and only to graph.facebook.com.
  assert.ok(calls.every((c) => c.url.startsWith("https://graph.facebook.com/")));
});

test("steps after migrate fail clearly when no new id is known", async () => {
  const { db } = fakeDb();
  const { doFetch, calls } = fakeFetch(() => ({ body: {} }));
  const r = await runMigrationStep(envWith(db), { step: "register", pin: "123456" }, doFetch);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /migrate/);
  assert.equal(calls.length, 0);
});

test("Meta errors are passed through with the Graph error object", async () => {
  const { db } = fakeDb();
  const { doFetch } = fakeFetch((url, init) => {
    if (url.includes("/OLD1?")) return { body: { id: "OLD1", display_phone_number: "+52 1 56 4199 2274" } };
    if (init?.method === "POST") return { status: 400, body: { error: { message: "(#100) payment method required", code: 100 } } };
    return { body: {} };
  });
  const r = await runMigrationStep(envWith(db), { step: "migrate", newWabaId: "NEWWABA", confirm: MIGRATE_CONFIRM }, doFetch);
  assert.equal(r.ok, false);
  assert.equal(r.graphError?.code, 100);
  assert.match(r.graphError?.message ?? "", /payment method/);
});
