// Customer-list audiences (src/services/meta-audiences.ts, src/cron/audiences.ts):
// the normalizers Meta's matching depends on, the selections, hashing + diff,
// the Graph payloads, and the daily sync against fake Airtable + fake Graph.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIENCE_BATCH,
  audiencePayloads,
  audienceToken,
  createCustomAudience,
  diffMembers,
  hashMembers,
  normalizeEmails,
  normalizePhoneForMeta,
  selectActiveStudents,
  selectPaidStudents,
  sendAudienceUsers,
  sha256Hex,
  type StudentColumns,
} from "../src/services/meta-audiences.js";
import {
  KV_AUD_ID_PREFIX,
  KV_AUD_LAST_ERROR,
  KV_AUD_LAST_OK,
  KV_AUD_MEMBERS_PREFIX,
  audienceConfig,
  runAudienceSync,
} from "../src/cron/audiences.js";
import { CLIENT } from "../src/client.gen.js";
import type { Env } from "../src/types.js";

const NOW = 1_789_000_000;

const COLS: StudentColumns = {
  phone: "Teléfono",
  email: "Email",
  totalPaid: "Total Pagado",
  status: "Status",
  activeFlag: "Vigencia por Fecha Activa",
  excludedStatuses: ["Profesor", "Seminario", "Visitantes de Pago"],
};

// ---- fake D1 (kv only) ----

function fakeDb(kv: Map<string, string>): D1Database {
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
        return { results: [] as T[], success: true, meta: {} };
      },
      async run() {
        if (sql.includes("INSERT INTO kv")) kv.set(String(binds[0]), String(binds[1]));
        if (sql.startsWith("DELETE FROM kv")) kv.delete(String(binds[0]));
        return { success: true, meta: { changes: 1 } };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { prepare: make } as unknown as D1Database;
}

function envWith(kv: Map<string, string>, over: Partial<Env> = {}): Env {
  return {
    DB: fakeDb(kv),
    META_AD_ACCOUNT_ID: "act_1334257084455191",
    ADS_ACCESS_TOKEN: "TOKEN-SECRET-ABC123",
    AIRTABLE_TRIALS_TABLE: "Leads",
    ...over,
  } as unknown as Env;
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

// ---- normalizers ----

test("normalizeEmails: lowercase, trim, split multi-address cells, drop junk, dedupe", () => {
  assert.deepEqual(normalizeEmails("  Ana.Lopez@Gmail.com "), ["ana.lopez@gmail.com"]);
  assert.deepEqual(normalizeEmails("a@x.com, B@Y.ORG; c@z.mx / a@x.com\nd@w.co"), [
    "a@x.com",
    "b@y.org",
    "c@z.mx",
    "d@w.co",
  ]);
  assert.deepEqual(normalizeEmails("no-email"), []);
  assert.deepEqual(normalizeEmails("sin arroba.com, @nope.com, x@"), []);
  assert.deepEqual(normalizeEmails(null), []);
  assert.deepEqual(normalizeEmails(["A@B.COM"]), ["a@b.com"]);
});

test("normalizePhoneForMeta: the academy's rules (10 → 52…, 521… → 52…, other codes kept)", () => {
  assert.equal(normalizePhoneForMeta("55 1234 5678"), "525512345678");
  assert.equal(normalizePhoneForMeta("(55) 1234-5678"), "525512345678");
  assert.equal(normalizePhoneForMeta("+52 1 55 1234 5678"), "525512345678");
  assert.equal(normalizePhoneForMeta("5215512345678"), "525512345678");
  assert.equal(normalizePhoneForMeta("+52 55 1234 5678"), "525512345678");
  assert.equal(normalizePhoneForMeta("+1 (415) 555-0100"), "14155550100");
  assert.equal(normalizePhoneForMeta("0034 600 111 222"), "34600111222");
  assert.equal(normalizePhoneForMeta("12345"), null);
  assert.equal(normalizePhoneForMeta(""), null);
  assert.equal(normalizePhoneForMeta(undefined), null);
});

test("sha256Hex is the standard digest (lowercase hex)", async () => {
  assert.equal(
    await sha256Hex("test@example.com"),
    "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b",
  );
});

// ---- selection ----

const ROWS = [
  { fields: { "Teléfono": "5512345678", "Email": "A@x.com", "Total Pagado": 2900, "Status": "Active", "Vigencia por Fecha Activa": 1 } },
  { fields: { "Teléfono": "5500000001", "Email": "", "Total Pagado": 500, "Status": "Inactive", "Vigencia por Fecha Activa": 0 } },
  { fields: { "Teléfono": "5500000002", "Email": "p@x.com", "Total Pagado": 9000, "Status": "Profesor", "Vigencia por Fecha Activa": 1 } },
  { fields: { "Teléfono": "5500000003", "Email": "s@x.com", "Total Pagado": 300, "Status": "Seminario", "Vigencia por Fecha Activa": 0 } },
  { fields: { "Teléfono": "5500000004", "Email": "v@x.com", "Total Pagado": 150, "Status": "Visitantes de Pago", "Vigencia por Fecha Activa": 0 } },
  { fields: { "Teléfono": "5500000005", "Email": "", "Total Pagado": 0, "Status": "Lead", "Vigencia por Fecha Activa": 0 } },
  { fields: { "Teléfono": "", "Email": "junk", "Total Pagado": 100, "Status": "Active", "Vigencia por Fecha Activa": 1 } },
  { fields: { "Teléfono": "5500000007", "Email": "", "Total Pagado": "$1,200.00", "Status": "Becado", "Vigencia por Fecha Activa": "1" } },
];

test("selectPaidStudents: Total Pagado > 0 minus excluded statuses, rows with no identifier dropped", () => {
  const paid = selectPaidStudents(ROWS, COLS);
  assert.deepEqual(paid.map((m) => m.phone), ["525512345678", "525500000001", "525500000007"]);
  assert.deepEqual(paid[0]!.emails, ["a@x.com"]);
});

test("selectActiveStudents: Vigencia por Fecha Activa = 1 (staff included — they are on the mat)", () => {
  const active = selectActiveStudents(ROWS, COLS);
  assert.deepEqual(active.map((m) => m.phone), ["525512345678", "525500000002", "525500000007"]);
});

// ---- hashing, diff, payloads ----

test("hashMembers: one row per email (each with the phone), phone-only rows, sorted + deduped", async () => {
  const rows = await hashMembers([
    { emails: ["a@x.com", "b@x.com"], phone: "525512345678" },
    { emails: [], phone: "525500000001" },
    { emails: ["a@x.com"], phone: "525512345678" }, // duplicate student
  ]);
  const pa = await sha256Hex("525512345678");
  const pb = await sha256Hex("525500000001");
  assert.deepEqual(
    rows,
    [`${await sha256Hex("a@x.com")}|${pa}`, `${await sha256Hex("b@x.com")}|${pa}`, `|${pb}`].sort(),
  );
  for (const r of rows) assert.ok(!/@|^52/.test(r), "no raw identifier survives hashing");
});

test("diffMembers + audiencePayloads: adds/removes, EMAIL+PHONE schema, ≤10k rows per request", () => {
  const d = diffMembers(["a|1", "b|2"], ["b|2", "c|3"]);
  assert.deepEqual(d, { adds: ["c|3"], removes: ["a|1"] });
  const p = audiencePayloads(["e1|p1", "|p2", "e3|"]);
  assert.deepEqual(p, [{ schema: ["EMAIL", "PHONE"], data: [["e1", "p1"], ["", "p2"], ["e3", ""]] }]);
  const many = audiencePayloads(Array.from({ length: AUDIENCE_BATCH + 1 }, (_, i) => `e${i}|p${i}`));
  assert.equal(many.length, 2);
  assert.equal(many[0]!.data.length, AUDIENCE_BATCH);
  assert.equal(many[1]!.data.length, 1);
});

// ---- Graph client ----

test("createCustomAudience / sendAudienceUsers: documented bodies, Bearer header, token never in URL or error", async () => {
  const seen: { url: string; method: string; body: unknown; auth: string }[] = [];
  const doFetch = async (url: string, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>;
    seen.push({ url, method: String(init?.method), body: JSON.parse(String(init?.body ?? "{}")), auth: h.Authorization });
    if (url.endsWith("/customaudiences")) return fakeRes(200, { id: "AUD1" });
    if (url.includes("/users")) {
      return init?.method === "DELETE"
        ? fakeRes(200, { num_received: 1, num_invalid_entries: 0 })
        : fakeRes(400, { error: { message: "needs TOKEN-SECRET-ABC123 and ToS", code: 2650 } });
    }
    return fakeRes(404, {});
  };
  const c = await createCustomAudience("TOKEN-SECRET-ABC123", "1334257084455191", "N", "D", doFetch);
  assert.deepEqual(c, { ok: true, data: { id: "AUD1" }, error: null });
  assert.equal(seen[0]!.url, "https://graph.facebook.com/v23.0/act_1334257084455191/customaudiences");
  assert.deepEqual(seen[0]!.body, { name: "N", description: "D", subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY" });
  assert.equal(seen[0]!.auth, "Bearer TOKEN-SECRET-ABC123");

  const add = await sendAudienceUsers("TOKEN-SECRET-ABC123", "AUD1", "add", ["e|p"], doFetch);
  assert.equal(add.ok, false);
  assert.match(add.error!, /ToS \(code 2650\)/);
  assert.ok(!add.error!.includes("TOKEN-SECRET"));
  assert.deepEqual(seen[1]!.body, { payload: { schema: ["EMAIL", "PHONE"], data: [["e", "p"]] } });

  const rm = await sendAudienceUsers("TOKEN-SECRET-ABC123", "AUD1", "remove", ["e|p"], doFetch);
  assert.deepEqual(rm, { ok: true, received: 1, invalid: 0, error: null });
  assert.equal(seen[2]!.method, "DELETE");
  assert.ok(seen[2]!.url.endsWith("/AUD1/users"));
  for (const s of seen) assert.ok(!s.url.includes("TOKEN"));
});

// ---- config + the daily sync ----

test("audienceConfig: ships OFF; the md-condesa map is complete; token precedence ADS > CAPI", () => {
  const cfg = audienceConfig(envWith(new Map()));
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, "feature_off");
  assert.deepEqual(cfg.columns, COLS);
  assert.deepEqual(cfg.names, CLIENT.metaAudiences);
  assert.equal(audienceToken({ ADS_ACCESS_TOKEN: "ads" } as unknown as Env), "ads");
  assert.equal(audienceToken({ META_CAPI_TOKEN: "capi", ADS_ACCESS_TOKEN: "ads" } as unknown as Env), "ads");
  assert.equal(audienceToken({ META_CAPI_TOKEN: "capi" } as unknown as Env), "capi");
  assert.equal(audienceToken({} as unknown as Env), null);
  assert.equal(audienceConfig(envWith(new Map(), { ADS_ACCESS_TOKEN: "", META_AD_ACCOUNT_ID: "" })).reason, "feature_off");
});

test("sync: dry run computes the diff and touches nothing; live run creates, uploads, removes, snapshots", async () => {
  const kv = new Map<string, string>();
  const env = envWith(kv);
  const list = (async () => ROWS) as unknown as typeof import("../src/services/metrics-airtable.js").listRecords;
  const graph: { url: string; method: string; body: unknown }[] = [];
  const doFetch = async (url: string, init?: RequestInit) => {
    graph.push({ url, method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/customaudiences?")) {
      return fakeRes(200, { data: [{ id: "PAID1", name: CLIENT.metaAudiences!.paid, subtype: "CUSTOM" }] });
    }
    if (url.endsWith("/customaudiences")) return fakeRes(200, { id: "ACT1" });
    if (url.includes("/users")) return fakeRes(200, { num_received: 3, num_invalid_entries: 0 });
    return fakeRes(404, {});
  };

  // feature off and no force ⇒ skipped
  const off = await runAudienceSync(env, NOW, { postNote: async () => {} }, { list, doFetch });
  assert.equal(off.skipped, "feature_off");

  // dry run (forced)
  const dry = await runAudienceSync(env, NOW, { postNote: async () => {} }, { list, doFetch, dryRun: true, force: true });
  assert.equal(dry.skipped, null);
  assert.equal(dry.students, ROWS.length);
  assert.deepEqual(
    dry.audiences.map((a) => ({ slug: a.slug, members: a.members, rows: a.rows, adds: a.adds, removes: a.removes, id: a.audienceId })),
    [
      { slug: "paid", members: 3, rows: 3, adds: 3, removes: 0, id: null },
      { slug: "active", members: 3, rows: 3, adds: 3, removes: 0, id: null },
    ],
  );
  assert.equal(graph.length, 0, "dry run makes no Graph call");
  assert.equal(kv.size, 0, "dry run writes nothing");

  // live
  const live = await runAudienceSync(env, NOW, { postNote: async () => {} }, { list, doFetch, force: true });
  assert.equal(live.error, null);
  const paid = live.audiences[0]!;
  const active = live.audiences[1]!;
  assert.deepEqual({ id: paid.audienceId, created: paid.created, adds: paid.adds }, { id: "PAID1", created: false, adds: 3 });
  assert.deepEqual({ id: active.audienceId, created: active.created, adds: active.adds }, { id: "ACT1", created: true, adds: 3 });
  assert.equal(kv.get(`${KV_AUD_ID_PREFIX}paid`), "PAID1");
  assert.equal(kv.get(`${KV_AUD_ID_PREFIX}active`), "ACT1");
  assert.equal(JSON.parse(kv.get(`${KV_AUD_MEMBERS_PREFIX}paid`)!).length, 3);
  assert.match(kv.get(KV_AUD_LAST_OK)!, /paid=3\(\+3\/-0\) active=3\(\+3\/-0\)/);
  const methods = graph.map((g) => `${g.method} ${g.url.split("/v23.0/")[1]}`);
  assert.deepEqual(methods, [
    "GET act_1334257084455191/customaudiences?fields=id,name,subtype&limit=200",
    "POST PAID1/users",
    "POST act_1334257084455191/customaudiences",
    "POST ACT1/users",
  ]);
  // the upload is hashes only
  const uploaded = JSON.stringify(graph[1]!.body);
  assert.ok(!uploaded.includes("@") && !uploaded.includes("5512345678"));

  // next day: one student lapsed from ACTIVE ⇒ one DELETE, no re-upload of the rest
  graph.length = 0;
  const lapsed = ROWS.map((r) =>
    r.fields["Teléfono"] === "5500000007" ? { fields: { ...r.fields, "Vigencia por Fecha Activa": 0 } } : r,
  );
  const next = await runAudienceSync(env, NOW + 86400, { postNote: async () => {} }, {
    list: (async () => lapsed) as unknown as typeof list,
    doFetch,
    force: true,
  });
  assert.deepEqual(next.audiences.map((a) => [a.adds, a.removes]), [[0, 0], [0, 1]]);
  assert.deepEqual(graph.map((g) => `${g.method} ${g.url.split("/v23.0/")[1]}`), ["DELETE ACT1/users"]);
  assert.equal(JSON.parse(kv.get(`${KV_AUD_MEMBERS_PREFIX}active`)!).length, 2);
});

test("sync: a Graph failure keeps the old snapshot, records the error, notes Slack once", async () => {
  const kv = new Map<string, string>();
  const env = envWith(kv);
  const list = (async () => ROWS) as unknown as typeof import("../src/services/metrics-airtable.js").listRecords;
  const doFetch = async (url: string) =>
    url.includes("/customaudiences?")
      ? fakeRes(403, { error: { message: "(#294) Managing advertisements requires ads_management", code: 294 } })
      : fakeRes(500, {});
  const notes: string[] = [];
  const deps = { postNote: async (t: string) => void notes.push(t) };
  const a = await runAudienceSync(env, NOW, deps, { list, doFetch, force: true });
  assert.match(a.error!, /paid: .*ads_management/);
  assert.equal(kv.has(`${KV_AUD_MEMBERS_PREFIX}paid`), false);
  assert.match(kv.get(KV_AUD_LAST_ERROR)!, /ads_management/);
  await runAudienceSync(env, NOW + 60, deps, { list, doFetch, force: true });
  assert.equal(notes.length, 1);
});
