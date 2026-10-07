// Airtable side of the Conversions API (src/services/capi-airtable.ts,
// src/cron/capi-sweep.ts, the drain's marking in src/cron/capi.ts, and
// ensureDataset): the sweep formula, row → events, marking only after a 2xx,
// claim release on give-up, and the dataset get-or-create — all against fakes.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EVENT_LABELS,
  capiEventLabel,
  capiEventsForLead,
  capiLeadColumns,
  capiSweepFields,
  capiSweepFormula,
  type CapiLeadColumns,
} from "../src/services/capi-airtable.js";
import {
  capiClaimKey,
  enqueueCapiEvent,
  ensureDataset,
  parseQueuedEvent,
} from "../src/services/meta-capi.js";
import { runCapiDrain } from "../src/cron/capi.js";
import { runCapiFunnelSweep } from "../src/cron/capi-sweep.js";
import { leadsMap } from "../src/services/airtable.js";
import { CLIENT } from "../src/client.gen.js";
import type { Env } from "../src/types.js";

const NOW = 1_789_000_000;
const CLID = "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0";
const MAP = leadsMap();
const COLS = capiLeadColumns(MAP)!;

// ---- fake D1 (kv + contacts) ----

interface World {
  kv: Map<string, string>;
  contacts: Map<string, { ad_ref: string | null }>;
}

function fakeDb(w: World): D1Database {
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const exec = (): { first?: unknown; all?: unknown[]; changes?: number } => {
      if (sql.includes("SELECT key, value FROM kv") && sql.includes("LIKE")) {
        const m = /LIKE '([^']+)%'/.exec(sql);
        const prefix = (m?.[1] ?? "").replace(/%$/, "");
        const limit = Number(binds[0] ?? 100);
        const rows = [...w.kv]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .slice(0, limit)
          .map(([key, value]) => ({ key, value }));
        return { all: rows };
      }
      if (sql.includes("COUNT(*)") && sql.includes("FROM kv")) return { first: { n: 0 } };
      if (sql.includes("SELECT value FROM kv")) {
        const v = w.kv.get(String(binds[0]));
        return { first: v === undefined ? null : { value: v } };
      }
      if (sql.startsWith("INSERT OR IGNORE INTO kv")) {
        const key = String(binds[0]);
        if (w.kv.has(key)) return { changes: 0 };
        w.kv.set(key, String(binds[1]));
        return { changes: 1 };
      }
      if (sql.includes("INSERT INTO kv")) {
        w.kv.set(String(binds[0]), String(binds[1]));
        return { changes: 1 };
      }
      if (sql.startsWith("DELETE FROM kv")) {
        w.kv.delete(String(binds[0]));
        return { changes: 1 };
      }
      if (sql.includes("FROM contacts")) {
        const c = w.contacts.get(String(binds[0]));
        return { first: c ? { phone: binds[0], ...c } : null };
      }
      return {};
    };
    const stmt = {
      bind(...args: unknown[]) {
        binds = args;
        return stmt;
      },
      async first<T>() {
        return (exec().first ?? null) as T;
      },
      async all<T>() {
        return { results: (exec().all ?? []) as T[], success: true, meta: {} };
      },
      async run() {
        const r = exec();
        return { success: true, meta: { changes: r.changes ?? 0 } };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { prepare: make } as unknown as D1Database;
}

function envWith(w: World, over: Partial<Env> = {}): Env {
  return {
    DB: fakeDb(w),
    WA_WABA_ID: "1717538906028335",
    META_CAPI_DATASET_ID: "999000111",
    META_CAPI_TOKEN: "TOKEN-SECRET-ABC123",
    AIRTABLE_TRIALS_TABLE: "Leads",
    ...over,
  } as unknown as Env;
}

function world(): World {
  return { kv: new Map(), contacts: new Map() };
}

function fakeRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  } as unknown as Response;
}

async function withFeatureOn(fn: () => Promise<void>): Promise<void> {
  const flags = CLIENT.features as { metaCapi?: boolean };
  const prev = flags.metaCapi;
  flags.metaCapi = true;
  try {
    await fn();
  } finally {
    flags.metaCapi = prev;
  }
}

// ---- config ----

test("md-condesa maps every column the sweep needs (names come from client.mjs, never code)", () => {
  assert.deepEqual(COLS, {
    phone: "# de Teléfono",
    ctwaClid: "CTWA Click ID",
    booked: "Agendó",
    attended: "Asistió",
    closed: "Cerró",
    metaEventsSent: "Eventos Meta Enviados",
    trialDateTime: "Fecha Clase Prueba",
    leadIncome: "Ingresos Lead",
  });
  assert.equal(capiLeadColumns({ ...MAP, booked: undefined }), null);
  assert.equal(capiEventLabel("purchase"), "Compró");
  assert.deepEqual(DEFAULT_EVENT_LABELS, { booked: "Agendó", attended: "Asistió", purchase: "Compró" });
  assert.equal(
    capiEventLabel("booked", { ...MAP, metaEventsSentValues: { booked: "B", attended: "A", purchase: "P" } }),
    "B",
  );
});

// ---- formula ----

test("capiSweepFormula: click id present, touched in-window, and at least one unsent flag", () => {
  const f = capiSweepFormula("2026-09-30T00:00:00.000Z")!;
  assert.ok(f.startsWith("AND({CTWA Click ID} != '', IS_AFTER(LAST_MODIFIED_TIME(), '2026-09-30T00:00:00.000Z'), OR("));
  assert.ok(f.includes("AND({Agendó} = 1, NOT(FIND('Agendó', ARRAYJOIN({Eventos Meta Enviados}) & '')))"));
  assert.ok(f.includes("AND({Asistió} = 1, NOT(FIND('Asistió', ARRAYJOIN({Eventos Meta Enviados}) & '')))"));
  assert.ok(f.includes("AND({Cerró} = 1, NOT(FIND('Compró', ARRAYJOIN({Eventos Meta Enviados}) & '')))"));
  assert.equal(capiSweepFormula("x", { ...MAP, metaEventsSent: undefined }), null);
  assert.deepEqual(capiSweepFields(COLS), [
    "# de Teléfono",
    "CTWA Click ID",
    "Agendó",
    "Asistió",
    "Cerró",
    "Eventos Meta Enviados",
    "Fecha Clase Prueba",
    "Ingresos Lead",
  ]);
});

// ---- row → events ----

test("capiEventsForLead: flags minus what was already sent; attended at the trial time; purchase carries Ingresos Lead", () => {
  const trialIso = new Date((NOW - 3 * 86400) * 1000).toISOString();
  const all = capiEventsForLead(
    {
      "Agendó": 1,
      "Asistió": 1,
      "Cerró": 1,
      "Ingresos Lead": 2900,
      "Fecha Clase Prueba": trialIso,
      "Eventos Meta Enviados": [],
    },
    COLS,
    NOW,
  );
  assert.deepEqual(all, [
    { kind: "booked", eventTimeSec: NOW },
    { kind: "attended", eventTimeSec: Math.floor(Date.parse(trialIso) / 1000) },
    { kind: "purchase", eventTimeSec: NOW, value: 2900 },
  ]);

  // Already-sent labels are skipped (the formula says the same; this is the belt).
  const rest = capiEventsForLead(
    { "Agendó": 1, "Asistió": 1, "Cerró": 0, "Eventos Meta Enviados": ["Agendó"] },
    COLS,
    NOW,
  );
  assert.deepEqual(rest.map((e) => e.kind), ["attended"]);
  // No trial datetime, or one in the future ⇒ attended is stamped now.
  assert.equal(rest[0]!.eventTimeSec, NOW);
  const future = new Date((NOW + 86400) * 1000).toISOString();
  assert.equal(
    capiEventsForLead({ "Asistió": 1, "Fecha Clase Prueba": future }, COLS, NOW)[0]!.eventTimeSec,
    NOW,
  );
  // Cerró with no readable amount ⇒ Purchase without value (never 0).
  const p = capiEventsForLead({ "Cerró": "1", "Ingresos Lead": 0 }, COLS, NOW);
  assert.deepEqual(p, [{ kind: "purchase", eventTimeSec: NOW }]);
  // Flags as strings / booleans tolerated; anything else is "not set".
  assert.deepEqual(capiEventsForLead({ "Agendó": "0", "Asistió": false }, COLS, NOW), []);
});

// ---- the sweep ----

test("sweep: lists owed rows once, enqueues each event with the record id, dedupes via the claim", async () => {
  await withFeatureOn(async () => {
    const w = world();
    const env = envWith(w);
    const trialIso = new Date((NOW - 86400) * 1000).toISOString();
    const calls: { table: string; o: Record<string, unknown> }[] = [];
    const list = (async (_e: Env, table: string, o: Record<string, unknown>) => {
      calls.push({ table, o });
      return [
        {
          id: "recA",
          fields: {
            "# de Teléfono": "+52 55 1234 5678",
            "CTWA Click ID": CLID,
            "Agendó": 1,
            "Asistió": 1,
            "Fecha Clase Prueba": trialIso,
            "Eventos Meta Enviados": ["Agendó"],
          },
        },
        {
          id: "recB",
          fields: { "# de Teléfono": "5215599999999", "CTWA Click ID": CLID, "Cerró": 1, "Ingresos Lead": 1500 },
        },
        { id: "recC", fields: { "# de Teléfono": "", "CTWA Click ID": CLID, "Agendó": 1 } },
      ];
    }) as unknown as typeof import("../src/services/metrics-airtable.js").listRecords;

    const res = await runCapiFunnelSweep(env, NOW, { postNote: async () => {} }, list);
    assert.equal(calls.length, 1, "one Airtable list per tick");
    assert.equal(calls[0]!.table, "Leads");
    assert.match(String(calls[0]!.o.filterByFormula), /^AND\({CTWA Click ID} != ''/);
    assert.equal(calls[0]!.o.maxRecords, 100);
    assert.deepEqual(
      { scanned: res.scanned, queued: res.queued, duplicate: res.duplicate, noClid: res.noClid },
      { scanned: 3, queued: 2, duplicate: 0, noClid: 1 },
    );
    const rows = [...w.kv.entries()]
      .filter(([k]) => k.startsWith("capi_q:"))
      .map(([k, v]) => [k, parseQueuedEvent(v)!] as const);
    assert.deepEqual(rows.map(([k]) => k).sort(), ["capi_q:recA-QualifiedLead", "capi_q:recB-Purchase"]);
    const attended = rows.find(([k]) => k.endsWith("QualifiedLead"))![1];
    assert.equal(attended.phone, "5215512345678", "phones are normalized to the 521 shape");
    assert.equal(attended.eventTime, Math.floor(Date.parse(trialIso) / 1000));
    assert.equal(attended.ctwaClid, CLID);
    const purchase = rows.find(([k]) => k.endsWith("Purchase"))![1];
    assert.equal(purchase.value, 1500);
    assert.equal(purchase.currency, "MXN");
    assert.equal(w.kv.get("capi_pending"), "1");
    assert.match(w.kv.get("capi_sweep_last_ok")!, /scanned=3 queued=2/);

    // Second pass (Airtable not yet marked, e.g. the drain has not run): no
    // second event — the claim turns it into a duplicate.
    const again = await runCapiFunnelSweep(env, NOW + 900, { postNote: async () => {} }, list);
    assert.equal(again.queued, 0);
    assert.equal(again.duplicate, 2);
  });
});

test("sweep: no-op while the feature is off; a missing column notes Slack once a day", async () => {
  const w = world();
  const off = await runCapiFunnelSweep(envWith(w), NOW, { postNote: async () => {} });
  assert.equal(off.skipped, "disabled");
  await withFeatureOn(async () => {
    const { MetricsSchemaError } = await import("../src/services/metrics-airtable.js");
    const notes: string[] = [];
    const boom = (async () => {
      throw new MetricsSchemaError("Leads: Unknown field name: \"Cerró\"", "Leads");
    }) as unknown as typeof import("../src/services/metrics-airtable.js").listRecords;
    const deps = { postNote: async (t: string) => void notes.push(t) };
    const a = await runCapiFunnelSweep(envWith(w), NOW, deps, boom);
    assert.match(a.error!, /Cerró/);
    const b = await runCapiFunnelSweep(envWith(w), NOW + 900, deps, boom);
    assert.match(b.error!, /Cerró/);
    assert.equal(notes.length, 1);
    assert.match(w.kv.get("capi_sweep_error")!, /Cerró/);
  });
});

// ---- the drain marks Airtable only after a 2xx, and releases the claim on give-up ----

test("drain: marks `Eventos Meta Enviados` after Meta's 2xx, never on failure", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("p1", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    await enqueueCapiEvent(env, { kind: "booked", phone: "p1", recordId: "recA" }, NOW);
    await enqueueCapiEvent(env, { kind: "attended", phone: "p1", recordId: "recA" }, NOW);
    const marks: string[] = [];
    const markSent = (async (_e: Env, recordId: string, kind: string) => {
      marks.push(`${recordId}:${kind}`);
      return "marked" as const;
    }) as unknown as typeof import("../src/services/capi-airtable.js").markEventSentInAirtable;

    // booked succeeds, attended fails
    const res = await runCapiDrain(env, NOW, { postNote: async () => {}, markSent }, async (_e, ev) => {
      const ok = ev[0]!.event_name === "LeadSubmitted";
      return ok
        ? { ok: true, received: 1, status: 200, error: null, skipped: null }
        : { ok: false, received: 0, status: 400, error: "bad (code 100)", skipped: null };
    });
    assert.equal(res.sent, 1);
    assert.equal(res.marked, 1);
    assert.equal(res.failed, 1);
    assert.deepEqual(marks, ["recA:booked"], "the failed event is NOT marked");
  });
});

test("drain: after CAPI_MAX_ATTEMPTS the claim is released so the sweep can retry later", async () => {
  await withFeatureOn(async () => {
    const w = world();
    w.contacts.set("p1", { ad_ref: JSON.stringify({ ctwaClid: CLID }) });
    const env = envWith(w);
    await enqueueCapiEvent(env, { kind: "purchase", phone: "p1", recordId: "recA", value: 900 }, NOW);
    assert.ok(w.kv.has(capiClaimKey("purchase", "p1")));
    const fail = async () => ({ ok: false, received: 0, status: 500, error: "down", skipped: null });
    const deps = { postNote: async () => {}, markSent: async () => "skipped" as const };
    await runCapiDrain(env, NOW, deps, fail);
    await runCapiDrain(env, NOW + 300, deps, fail);
    const third = await runCapiDrain(env, NOW + 600, deps, fail);
    assert.equal(third.dropped, 1);
    assert.ok(!w.kv.has(capiClaimKey("purchase", "p1")), "claim released");
    assert.ok(!w.kv.has("capi_q:recA-Purchase"));
    // …and a later enqueue (the sweep still sees Cerró=1, Airtable unmarked) is accepted again.
    assert.equal(
      await enqueueCapiEvent(env, { kind: "purchase", phone: "p1", recordId: "recA", value: 900 }, NOW + 900),
      "queued",
    );
  });
});

// ---- ensureDataset ----

test("ensureDataset: returns the linked dataset when one exists, POSTs to create otherwise, never leaks the token", async () => {
  const w = world();
  const env = envWith(w, { META_CAPI_DATASET_ID: "" });
  const seen: { url: string; method: string; auth: string }[] = [];
  const mk =
    (getBody: unknown, getStatus: number, postBody: unknown, postStatus = 200) =>
    async (url: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      seen.push({ url, method: String(init?.method), auth: h.Authorization });
      return init?.method === "POST" ? fakeRes(postStatus, postBody) : fakeRes(getStatus, getBody);
    };

  // already linked
  const a = await ensureDataset(env, mk({ data: [{ id: "D1" }] }, 200, { id: "NEW" }));
  assert.deepEqual({ ok: a.ok, ids: a.datasetIds, created: a.created }, { ok: true, ids: ["D1"], created: false });
  assert.equal(seen.filter((s) => s.method === "POST").length, 0);

  // none linked ⇒ create
  seen.length = 0;
  const b = await ensureDataset(env, mk({ data: [] }, 200, { id: "NEW" }));
  assert.deepEqual({ ok: b.ok, ids: b.datasetIds, created: b.created }, { ok: true, ids: ["NEW"], created: true });
  assert.equal(seen[1]!.method, "POST");
  assert.ok(seen[1]!.url.endsWith("/1717538906028335/dataset"));
  assert.ok(!seen[1]!.url.includes("TOKEN-SECRET"));
  assert.equal(seen[1]!.auth, "Bearer TOKEN-SECRET-ABC123");

  // permission error on the read ⇒ reported, token scrubbed, no POST
  seen.length = 0;
  const denied = { error: { message: "(#200) needs TOKEN-SECRET-ABC123 scope", code: 200 } };
  const c = await ensureDataset(env, mk(denied, 403, denied, 403));
  assert.equal(c.ok, false);
  assert.match(c.error!, /\(#200\)/);
  assert.ok(!c.error!.includes("TOKEN-SECRET"));
  assert.equal(seen.length, 2, "the create is still attempted (a read-only token may lack the read edge)");
});

// ---- getLeadRecord + backfill (fake global fetch) ----

function withFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { fetch: typeof fetch };
  const prev = g.fetch;
  g.fetch = impl as typeof fetch;
  return fn().finally(() => {
    g.fetch = prev;
  });
}

function backfillDb(rows: { phone: string; ad_ref: string | null; airtable_lead_id: string }[], kv: Map<string, string>): D1Database {
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        binds = args;
        return stmt;
      },
      async first<T>() {
        if (sql.includes("SELECT value FROM kv")) {
          const v = kv.get(String(binds[0]));
          return (v === undefined ? null : { value: v }) as T;
        }
        return null as T;
      },
      async all<T>() {
        const after = String(binds[0]);
        const limit = Number(binds[1]);
        const page = rows
          .filter((r) => r.phone > after && r.airtable_lead_id && (r.ad_ref ?? "").includes('"ctwaClid":"'))
          .sort((a, b) => (a.phone < b.phone ? -1 : 1))
          .slice(0, limit);
        return { results: page as T[], success: true, meta: {} };
      },
      async run() {
        if (sql.includes("INSERT INTO kv")) kv.set(String(binds[0]), String(binds[1]));
        return { success: true, meta: { changes: 1 } };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { prepare: make } as unknown as D1Database;
}

test("getLeadRecord: plain GET /<table>/<recordId> — no fields[] (the single-record endpoint rejects it)", async () => {
  const { getLeadRecord } = await import("../src/services/capi-airtable.js");
  const env = { AIRTABLE_PAT: "pat", AIRTABLE_BASE_ID: "appX", AIRTABLE_TRIALS_TABLE: "Leads" } as unknown as Env;
  const urls: string[] = [];
  const rec = await withFetch(
    async (url) => {
      urls.push(url);
      return url.endsWith("/recMissing")
        ? fakeRes(404, {})
        : fakeRes(200, { id: "recA", fields: { "CTWA Click ID": "", "Nombre de Lead": "Ana" } });
    },
    async () => getLeadRecord(env, "recA"),
  );
  assert.equal(urls[0], "https://api.airtable.com/v0/appX/Leads/recA");
  assert.ok(!urls[0]!.includes("?"), "no query string at all");
  assert.deepEqual(rec, { id: "recA", fields: { "CTWA Click ID": "", "Nombre de Lead": "Ana" } });
  const missing = await withFetch(async () => fakeRes(404, {}), async () => getLeadRecord(env, "recMissing"));
  assert.equal(missing, null);
  // A stale record id (deleted lead) comes back as 403 "model was not found" — also "missing".
  const stale = await withFetch(
    async () =>
      fakeRes(403, {
        error: {
          type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
          message: "Invalid permissions, or the requested model was not found. Check that both your user and your token have the required permissions, and that the model names and/or ids are correct.",
        },
      }),
    async () => getLeadRecord(env, "recGone"),
  );
  assert.equal(stale, null);
  await assert.rejects(
    () =>
      withFetch(
        async () => fakeRes(422, { error: { type: "INVALID_REQUEST_UNKNOWN", message: "Unknown parameter fields" } }),
        async () => getLeadRecord(env, "recA"),
      ),
    /HTTP 422.*Unknown parameter/,
  );
});

test("backfill: writes only blank cells, reports firstError, never advances past an all-error page, reset restarts", async () => {
  const { backfillCtwaClids, KV_CAPI_BACKFILL_CURSOR } = await import("../src/services/capi-airtable.js");
  const kv = new Map<string, string>();
  const rows = [
    { phone: "5215500000001", ad_ref: JSON.stringify({ ctwaClid: "C1" }), airtable_lead_id: "rec1" },
    { phone: "5215500000002", ad_ref: JSON.stringify({ ctwaClid: "C2" }), airtable_lead_id: "rec2" },
    { phone: "5215500000003", ad_ref: JSON.stringify({ ctwaClid: null }), airtable_lead_id: "rec3" },
    { phone: "5215500000004", ad_ref: JSON.stringify({ ctwaClid: "C4" }), airtable_lead_id: "rec4" },
  ];
  const env = {
    DB: backfillDb(rows, kv),
    AIRTABLE_PAT: "pat",
    AIRTABLE_BASE_ID: "appX",
    AIRTABLE_TRIALS_TABLE: "Leads",
  } as unknown as Env;

  // 1) Airtable rejects everything (the bug we shipped): errors surface, cursor stays put.
  const broken = await withFetch(
    async () => fakeRes(422, { error: { type: "INVALID_REQUEST_UNKNOWN", message: "Unknown parameter" } }),
    async () => backfillCtwaClids(env, { limit: 10 }),
  );
  assert.equal(broken.written, 0);
  assert.ok(broken.errors >= 1);
  assert.match(broken.firstError!, /HTTP 422 .*Unknown parameter/);
  assert.equal(broken.done, false);
  assert.equal(broken.cursor, "", "an all-error page does not move the cursor");
  assert.equal(kv.get(KV_CAPI_BACKFILL_CURSOR), "");

  // 2) Working Airtable: rec1 blank → written; rec2 already set → skipped; rec4 missing.
  const patched: { url: string; body: unknown }[] = [];
  const ok = await withFetch(
    async (url, init) => {
      if (init?.method === "PATCH") {
        patched.push({ url, body: JSON.parse(String(init.body)) });
        return fakeRes(200, { id: url.split("/").pop(), fields: {} });
      }
      if (url.endsWith("/rec1")) return fakeRes(200, { id: "rec1", fields: {} });
      if (url.endsWith("/rec2")) return fakeRes(200, { id: "rec2", fields: { "CTWA Click ID": "OLD" } });
      return fakeRes(404, {});
    },
    async () => backfillCtwaClids(env, { limit: 10, reset: true }),
  );
  assert.deepEqual(
    { scanned: ok.scanned, written: ok.written, alreadySet: ok.alreadySet, missing: ok.missing, errors: ok.errors, done: ok.done },
    { scanned: 3, written: 1, alreadySet: 1, missing: 1, errors: 0, done: true },
  );
  assert.equal(patched.length, 1);
  assert.ok(patched[0]!.url.endsWith("/Leads/rec1"));
  assert.deepEqual(patched[0]!.body, { fields: { "CTWA Click ID": "C1" }, typecast: true });
  assert.equal(ok.firstError, null);
});
