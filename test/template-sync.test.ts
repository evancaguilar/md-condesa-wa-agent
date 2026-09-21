import { test } from "node:test";
import assert from "node:assert/strict";
import {
  postTrialD0TemplateInputs,
  SYNC_KEY,
  syncPostTrialD0Templates,
  templateBodyFromCopy,
} from "../src/cron/template-sync.js";
import { buildUpdateTemplatePayload } from "../src/services/blast-templates.js";
import type { Env } from "../src/types.js";
import { CLIENT } from "../src/client.gen.js";

function fakeDb(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) { binds = v; return stmt; },
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
      async all() { return { results: [], meta: {} }; },
    };
    return stmt;
  };
  return { db: { prepare: make } as D1Database, store };
}

function fakeFetch(route: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const r = route(url, init);
    const status = r.status ?? 200;
    return { ok: status < 300, status, async json() { return r.body; }, async text() { return ""; } } as unknown as Response;
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

test("templateBodyFromCopy: {who} → ' {{1}}'", () => {
  assert.equal(templateBodyFromCopy("¡Hola{who}! Qué tal"), "¡Hola {{1}}! Qué tal");
  const inputs = postTrialD0TemplateInputs();
  assert.deepEqual(inputs.map((i) => i.name), ["post_trial_d0_es", "post_trial_d0_en"]);
  assert.match(inputs[0].body, /^¡Hola \{\{1\}\}!/);
  // client.gen.ts is a build artifact — pin the transform, not the prose.
  assert.equal(inputs[0].body, templateBodyFromCopy(CLIENT.copy.postTrialD0Es));
  assert.match(inputs[0].footer ?? "", /BAJA/);
});

test("buildUpdateTemplatePayload: components only (no name/category)", () => {
  const p = buildUpdateTemplatePayload({ name: "x", language: "es", body: "Hola {{1}}", footer: "F" });
  assert.deepEqual(Object.keys(p), ["components"]);
  const comps = p.components as Record<string, unknown>[];
  assert.equal(comps[0].type, "BODY");
  assert.deepEqual(comps[1], { type: "FOOTER", text: "F" });
});

test("syncPostTrialD0Templates: edits both templates by id, sets the guard, runs once", async () => {
  const { db, store } = fakeDb();
  const notes: string[] = [];
  const { doFetch, calls } = fakeFetch((url, init) => {
    if (url.includes("/message_templates")) {
      return { body: { data: [
        { id: "T1", name: "post_trial_d0_es", language: "es", status: "PENDING", category: "MARKETING", components: [] },
        { id: "T2", name: "post_trial_d0_en", language: "en", status: "PENDING", category: "MARKETING", components: [] },
      ] } };
    }
    if (init?.method === "POST") return { body: { success: true } };
    return { status: 404, body: { error: { message: "nope" } } };
  });
  const env = { DB: db, WA_WABA_ID: "WABA1", WA_ACCESS_TOKEN: "tok" } as unknown as Env;
  await syncPostTrialD0Templates(env, { postNote: async (t) => { notes.push(t); } }, doFetch);
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => c.url.split("/").pop()), ["T1", "T2"]);
  assert.match(String((posts[0].body as { components: { text: string }[] }).components[0].text), /\{\{1\}\}/);
  assert.equal(store.get(SYNC_KEY), "ok");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^📝/);
  const before = calls.length;
  await syncPostTrialD0Templates(env, { postNote: async (t) => { notes.push(t); } }, doFetch);
  assert.equal(calls.length, before, "guarded: no second run");
});

test("syncPostTrialD0Templates: a missing template → guard 'error' + one ⚠️ note", async () => {
  const { db, store } = fakeDb();
  const notes: string[] = [];
  const { doFetch } = fakeFetch(() => ({ body: { data: [] } }));
  const env = { DB: db, WA_WABA_ID: "WABA1", WA_ACCESS_TOKEN: "tok" } as unknown as Env;
  await syncPostTrialD0Templates(env, { postNote: async (t) => { notes.push(t); } }, doFetch);
  assert.equal(store.get(SYNC_KEY), "error");
  assert.match(notes[0], /^⚠️/);
  assert.match(notes[0], /no existe/);
});
