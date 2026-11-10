// Student sync (2026-11-09): listStudents reads the client's Alumnos table
// (names from client.mjs airtableMetrics), only CURRENTLY ACTIVE rows; syncStudents
// flips existing `lead` contacts to `student` and never sends anything, never
// touches an opted-out contact, and reports a missing table/field once.
// Pure filters first; then the full sync on real in-memory SQLite (production
// schema) with fetch stubbed for Airtable and a tripwire on Graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  activeStudentRecords,
  isActiveFlag,
  listStudents,
  studentSyncColumns,
  type StudentSyncColumns,
} from "../src/services/airtable.js";
import { syncStudents } from "../src/cron/followups.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { CLIENT } from "../src/client.gen.js";
import type { Env, NoteOpts } from "../src/types.js";

const COLS: StudentSyncColumns = studentSyncColumns()!;

test("studentSyncColumns: md-condesa reads Alumnos / Teléfono / Vigencia por Fecha Activa from client config", () => {
  assert.ok(COLS, "client.gen.ts carries airtableMetrics.students");
  assert.equal(COLS.table, CLIENT.airtableMetrics!.tables.students);
  assert.equal(COLS.table, "Alumnos");
  assert.equal(COLS.phone, "Teléfono");
  assert.equal(COLS.name, "Alumno");
  assert.equal(COLS.activeFlag, "Vigencia por Fecha Activa");
  assert.equal(COLS.status, "Status");
  assert.ok(COLS.excludedStatuses.includes("Profesor"));
  // No active flag named ⇒ refuse (never guess which rows are current).
  assert.equal(
    studentSyncColumns({ tables: { students: "Alumnos" }, students: { name: "Alumno", phone: "Teléfono" } }),
    null,
  );
  assert.equal(studentSyncColumns(null), null);
});

test("isActiveFlag: 1 / '1' / true only", () => {
  for (const v of [1, "1", " 1 ", true, [1]]) assert.equal(isActiveFlag(v), true, JSON.stringify(v));
  for (const v of [0, "0", "", null, undefined, false, 2, "sí", [0], []]) assert.equal(isActiveFlag(v), false, JSON.stringify(v));
});

test("activeStudentRecords: lapsed, phoneless and excluded-status rows are dropped", () => {
  const f = (o: Record<string, unknown>) => ({ fields: o });
  const rows = [
    f({ Alumno: "Activa", "Teléfono": "55 1111 2222", "Vigencia por Fecha Activa": 1, Status: "Activo" }),
    f({ Alumno: "Vencido", "Teléfono": "5533334444", "Vigencia por Fecha Activa": 0, Status: "Activo" }),
    f({ Alumno: "Sin flag", "Teléfono": "5533334445" }),
    f({ Alumno: "Sin tel", "Vigencia por Fecha Activa": 1 }),
    f({ Alumno: "Coach", "Teléfono": "5577778888", "Vigencia por Fecha Activa": 1, Status: "profesor" }),
  ];
  assert.deepEqual(activeStudentRecords(rows, COLS), [{ name: "Activa", phone: "55 1111 2222" }]);
});

// ---- Airtable stub ----

interface Stub {
  urls: string[];
  graphCalls: number;
  restore(): void;
}

/** Query params of a request URL, in order (the test shims have no URL.searchParams.getAll). */
function params(url: string): [string, string][] {
  const q = url.split("?")[1] ?? "";
  return q
    .split("&")
    .filter(Boolean)
    .map((kv) => {
      const [k, v = ""] = kv.split("=");
      const d = (x: string) => decodeURIComponent(x.replace(/\+/g, " "));
      return [d(k!), d(v)];
    });
}
const param = (url: string, k: string): string | null => params(url).find(([n]) => n === k)?.[1] ?? null;
const paramAll = (url: string, k: string): string[] => params(url).filter(([n]) => n === k).map(([, v]) => v);

function stubAirtable(respond: (url: string) => Response): Stub {
  const real = globalThis.fetch;
  const s: Stub = { urls: [], graphCalls: 0, restore: () => void (globalThis.fetch = real) };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("graph.facebook.com")) {
      s.graphCalls++;
      return new Response("{}", { status: 200 });
    }
    s.urls.push(url);
    return respond(url);
  }) as typeof fetch;
  return s;
}

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

const ENV_BASE = { AIRTABLE_BASE_ID: "appTEST", AIRTABLE_PAT: "pat", WA_ACCESS_TOKEN: "t", WA_PHONE_NUMBER_ID: "1" };

test("listStudents: hits Alumnos with an active+phone filter, pages, requests only the needed fields", async () => {
  const stub = stubAirtable((url) =>
    param(url, "offset")
      ? json({ records: [{ id: "rec2", fields: { Alumno: "B", "Teléfono": "5215522223333", "Vigencia por Fecha Activa": 1 } }] })
      : json({
          records: [{ id: "rec1", fields: { Alumno: "A", "Teléfono": "5511112222", "Vigencia por Fecha Activa": 1 } }],
          offset: "next",
        }),
  );
  try {
    const r = await listStudents(ENV_BASE as unknown as Env);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.scanned, 2);
    assert.deepEqual(r.students.map((s) => s.phone), ["5511112222", "5215522223333"]);
    const u = stub.urls[0]!;
    assert.match(decodeURIComponent(u.split("?")[0]!), /\/appTEST\/Alumnos$/);
    assert.equal(param(u, "filterByFormula"), "AND({Vigencia por Fecha Activa} = 1, {Teléfono} != '')");
    assert.deepEqual(paramAll(u, "fields[]"), ["Alumno", "Teléfono", "Vigencia por Fecha Activa", "Status"]);
    assert.equal(stub.urls.length, 2);
  } finally {
    stub.restore();
  }
});

test("listStudents: 404 → table_missing, 422 unknown field → field_missing, 5xx throws", async () => {
  let stub = stubAirtable(() => json({ error: "NOT_FOUND" }, 404));
  try {
    const r = await listStudents(ENV_BASE as unknown as Env);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "table_missing");
  } finally {
    stub.restore();
  }
  stub = stubAirtable(() =>
    json({ error: { type: "INVALID_FILTER_BY_FORMULA", message: "Unknown field names: vigencia por fecha activa" } }, 422),
  );
  try {
    const r = await listStudents(ENV_BASE as unknown as Env);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "field_missing");
  } finally {
    stub.restore();
  }
  stub = stubAirtable(() => json({ error: "boom" }, 503));
  try {
    await assert.rejects(() => listStudents(ENV_BASE as unknown as Env), /HTTP 503/);
  } finally {
    stub.restore();
  }
  const r = await listStudents(ENV_BASE as unknown as Env, null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "config_missing");
});

// ---- full sync on SQLite ----

function schemaStatements(): string[] {
  const text = readFileSync("src/db/schema.sql", "utf8")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function openDb(): { raw: DatabaseSync; env: Env } {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of schemaStatements()) raw.exec(stmt);
  for (const sql of INDEX_SQL) raw.exec(sql);
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (raw.prepare(sql).get(...(binds as never[])) ?? null) as T | null;
      },
      async run() {
        const r = raw.prepare(sql).run(...(binds as never[]));
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(binds as never[])) as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { raw, env: { DB: { prepare: make } as unknown as D1Database, ...ENV_BASE } as unknown as Env };
}

function addContact(raw: DatabaseSync, phone: string, status: string): void {
  raw
    .prepare(
      `INSERT INTO contacts(phone, name, lang, status, last_inbound_at, created_at, updated_at)
       VALUES(?, 'X', 'es', ?, 1, 1, 1)`,
    )
    .run(phone, status);
}

function statusOf(raw: DatabaseSync, phone: string): string | undefined {
  return (raw.prepare(`SELECT status FROM contacts WHERE phone = ?`).get(phone) as { status: string } | undefined)?.status;
}

test("syncStudents: only active Alumnos flip lead → student; opted-out, lapsed and unknown untouched; nothing sent", async () => {
  const { raw, env } = openDb();
  addContact(raw, "5215511112222", "lead"); // active, stored as "55 1111 2222" → 521 shape
  addContact(raw, "5215533334444", "lead"); // lapsed (flag 0) → keeps lead flows
  addContact(raw, "5215566667777", "opted_out"); // active but a baja → stays opted_out
  addContact(raw, "5215588889999", "student"); // already student
  addContact(raw, "5215577778888", "lead"); // active Profesor → excluded status
  const before = (raw.prepare(`SELECT COUNT(*) AS n FROM followups`).get() as { n: number }).n;
  const stub = stubAirtable(() =>
    json({
      records: [
        { id: "r1", fields: { Alumno: "A", "Teléfono": "+52 55 1111 2222", "Vigencia por Fecha Activa": 1, Status: "Activo" } },
        // Airtable's filter should not return this, but the local re-check must drop it anyway.
        { id: "r2", fields: { Alumno: "B", "Teléfono": "5533334444", "Vigencia por Fecha Activa": 0 } },
        { id: "r3", fields: { Alumno: "C", "Teléfono": "52 55 6666 7777", "Vigencia por Fecha Activa": 1 } },
        { id: "r4", fields: { Alumno: "D", "Teléfono": "5588889999", "Vigencia por Fecha Activa": 1 } },
        { id: "r5", fields: { Alumno: "E", "Teléfono": "5577778888", "Vigencia por Fecha Activa": 1, Status: "Profesor" } },
        { id: "r6", fields: { Alumno: "F", "Teléfono": "5599990000", "Vigencia por Fecha Activa": 1 } }, // no contact
      ],
    }),
  );
  const notes: { text: string; opts?: NoteOpts }[] = [];
  try {
    const r = await syncStudents(env, { postNote: async (text, opts) => void notes.push({ text, opts }) });
    assert.equal(r.problem, null);
    assert.equal(r.marked, 1);
    assert.equal(r.active, 4, "r1, r3, r4, r6 (r2 lapsed, r5 Profesor)");
    assert.equal(statusOf(raw, "5215511112222"), "student");
    assert.equal(statusOf(raw, "5215533334444"), "lead");
    assert.equal(statusOf(raw, "5215566667777"), "opted_out");
    assert.equal(statusOf(raw, "5215588889999"), "student");
    assert.equal(statusOf(raw, "5215577778888"), "lead");
    assert.equal(statusOf(raw, "5215599990000"), undefined, "never creates a contact");
    assert.equal(stub.graphCalls, 0, "no WhatsApp send");
    const after = (raw.prepare(`SELECT COUNT(*) AS n FROM followups`).get() as { n: number }).n;
    assert.equal(after, before, "no followup armed");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.opts?.level, "info");
  } finally {
    stub.restore();
  }
});

test("syncStudents: a missing Alumnos table or field posts ONE warn note and changes nothing", async () => {
  for (const [status, body] of [
    [404, { error: "NOT_FOUND" }],
    [422, { error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Teléfono"' } }],
  ] as const) {
    const { raw, env } = openDb();
    addContact(raw, "5215511112222", "lead");
    const stub = stubAirtable(() => json(body, status));
    const notes: { text: string; opts?: NoteOpts }[] = [];
    try {
      const r = await syncStudents(env, { postNote: async (text, opts) => void notes.push({ text, opts }) });
      assert.ok(r.problem, String(status));
      assert.equal(r.marked, 0);
      assert.equal(notes.length, 1, String(status));
      assert.equal(notes[0]!.opts?.level, "warn");
      assert.match(notes[0]!.text, /Sync de alumnos NO corrió/);
      assert.equal(statusOf(raw, "5215511112222"), "lead");
    } finally {
      stub.restore();
    }
  }
});

test("syncStudents: chunks the contact update under D1's 100-parameter cap", async () => {
  const { raw, env } = openDb();
  const records: { id: string; fields: Record<string, unknown> }[] = [];
  for (let i = 0; i < 250; i++) {
    const local = `55${String(10000000 + i)}`;
    addContact(raw, `521${local}`, "lead");
    records.push({ id: `r${i}`, fields: { Alumno: `S${i}`, "Teléfono": local, "Vigencia por Fecha Activa": 1 } });
  }
  const binds: number[] = [];
  const realPrepare = env.DB.prepare.bind(env.DB);
  (env.DB as unknown as { prepare: (sql: string) => D1PreparedStatement }).prepare = (sql: string) => {
    const st = realPrepare(sql);
    if (!sql.startsWith("UPDATE contacts")) return st;
    const bind = st.bind.bind(st);
    (st as unknown as { bind: (...v: unknown[]) => D1PreparedStatement }).bind = (...v: unknown[]) => {
      binds.push(v.length);
      return bind(...v);
    };
    return st;
  };
  const stub = stubAirtable(() => json({ records }));
  try {
    const r = await syncStudents(env, {});
    assert.equal(r.marked, 250);
    assert.ok(binds.every((n) => n <= 100), JSON.stringify(binds));
    assert.equal(binds.length, 3);
  } finally {
    stub.restore();
  }
});
