// Outage redrive (src/cron/redrive.ts) against a REAL SQLite loaded from
// src/db/schema.sql + the worker-applied indexes (INDEXED BY needs them).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  findUnanswered,
  runRedrive,
  staleReplyFor,
  REDRIVE_KEY,
  REDRIVE_SINCE_EPOCH,
  type UnansweredRow,
} from "../src/cron/redrive.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { Env } from "../src/types.js";

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

function openDb(): { raw: DatabaseSync; db: D1Database; env: Env } {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of schemaStatements()) raw.exec(stmt);
  for (const sql of INDEX_SQL) raw.exec(sql);
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (raw.prepare(sql).get(...binds) ?? null) as T | null;
      },
      async run() {
        const r = raw.prepare(sql).run(...binds);
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...binds) as T[], meta: {} };
      },
    };
    return stmt;
  };
  const db = { prepare: make } as D1Database;
  return { raw, db, env: { DB: db } as Env };
}

const SINCE = cdmxToEpoch(2026, 10, 5, 22, 0, 0);
const NOW = cdmxToEpoch(2026, 10, 6, 15, 30, 0);
let n = 0;
function seedLead(
  raw: DatabaseSync,
  phone: string,
  msgs: Array<[direction: string, ts: number, body?: string]>,
  contact: { status?: string; override?: number | null } = {},
): void {
  const lastIn = Math.max(0, ...msgs.filter((m) => m[0] === "in").map((m) => m[1]));
  raw
    .prepare(
      `INSERT INTO contacts(phone, name, status, human_override_until, last_inbound_at, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(phone, "n" + phone, contact.status ?? "lead", contact.override ?? null, lastIn || null, 1, 1);
  const ins = raw.prepare(
    `INSERT INTO messages(wamid, phone, direction, body, ts, meta) VALUES(?, ?, ?, ?, ?, NULL)`,
  );
  for (const [dir, ts, body] of msgs) ins.run(`w${++n}`, phone, dir, body ?? `${dir} ${ts}`, ts);
}

test("findUnanswered: newest-is-inbound since the outage, leads only, nobody already handling", async () => {
  const { raw, db } = openDb();
  // A: welcomed, then wrote again and never got an answer → YES
  seedLead(raw, "A", [["in", SINCE + 100], ["out_bot", SINCE + 101], ["in", SINCE + 3600, "¿precio?"]]);
  // B: bot answered last → no
  seedLead(raw, "B", [["in", SINCE + 200], ["out_bot", SINCE + 300]]);
  // C: human replied from the WhatsApp Business app (echo) → no
  seedLead(raw, "C", [["in", SINCE + 200], ["out_human_echo", SINCE + 300]]);
  // D: wrote before the outage window → no
  seedLead(raw, "D", [["in", SINCE - 5000]]);
  // E: unanswered but a human took the thread (override live) → no
  seedLead(raw, "E", [["in", SINCE + 500]], { override: NOW + 3600 });
  // E2: override EXPIRED → yes
  seedLead(raw, "E2", [["in", SINCE + 501]], { override: NOW - 10 });
  // F: student on the lead line → no
  seedLead(raw, "F", [["in", SINCE + 600]], { status: "student" });
  // G: opted out → no
  seedLead(raw, "G", [["in", SINCE + 700]], { status: "opted_out" });
  // H: already has a pending approval → no
  seedLead(raw, "H", [["in", SINCE + 800]]);
  raw.prepare(`INSERT INTO pending_approvals(phone, draft, confidence, status, created_at) VALUES('H','d','low','pending',1)`).run();
  // H2: only a RESOLVED approval → yes
  seedLead(raw, "H2", [["in", SINCE + 801]]);
  raw.prepare(`INSERT INTO pending_approvals(phone, draft, confidence, status, created_at) VALUES('H2','d','low','approved',1)`).run();
  // I: a reaction, not a message → no
  seedLead(raw, "I", [["out_bot", SINCE + 900], ["in", SINCE + 901, "[reaccionó ❤️]"]]);
  // J: nothing ever went out (welcome failed too) → yes
  seedLead(raw, "J", [["in", SINCE + 50, "Hola, info del reto"]]);

  const rows = await findUnanswered(db, SINCE, 0, NOW, 50);
  assert.deepEqual(
    rows.map((r) => r.phone),
    ["J", "E2", "H2", "A"],
    JSON.stringify(rows),
  );
  assert.equal(rows[3]!.body, "¿precio?");
  // Cursor: strictly after a ts.
  assert.deepEqual((await findUnanswered(db, SINCE, SINCE + 501, NOW, 50)).map((r) => r.phone), ["H2", "A"]);
  // Limit applies after the reaction filter.
  assert.equal((await findUnanswered(db, SINCE, 0, NOW, 2)).length, 2);
});

test("runRedrive: a few per tick, cursor + counts persisted per lead, one closing note, then inert", async () => {
  const { raw, db, env } = openDb();
  for (let i = 1; i <= 7; i++) seedLead(raw, `P${i}`, [["in", SINCE + i * 10, `msg ${i}`]]);
  const turned: string[] = [];
  const notes: string[] = [];
  const deps = {
    turn: async (row: UnansweredRow) => {
      if (row.phone === "P3") throw new Error("anthropic HTTP 500");
      turned.push(row.phone);
    },
    postNote: async (t: string) => void notes.push(t),
  };
  const s1 = await runRedrive(env, deps, NOW, { sinceEpoch: SINCE, perTick: 3 });
  assert.deepEqual(turned, ["P1", "P2"]);
  assert.equal(s1.processed, 2);
  assert.equal(s1.failed, 1);
  assert.equal(s1.cursorTs, SINCE + 30);
  assert.equal(s1.done, false);
  assert.equal(notes.length, 0);
  assert.equal(JSON.parse(String(raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(REDRIVE_KEY)!.value)).cursorTs, SINCE + 30);

  // A lead that produced NO approval (failed above) is never retried: cursor moved past it.
  const s2 = await runRedrive(env, deps, NOW, { sinceEpoch: SINCE, perTick: 3 });
  assert.deepEqual(turned, ["P1", "P2", "P4", "P5", "P6"]);
  assert.equal(s2.done, false);
  const s3 = await runRedrive(env, deps, NOW, { sinceEpoch: SINCE, perTick: 3 });
  assert.deepEqual(turned, ["P1", "P2", "P4", "P5", "P6", "P7"]);
  assert.equal(s3.done, true);
  assert.equal(s3.processed, 6);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /6 chat\(s\) sin respuesta/);
  assert.match(notes[0]!, /1 fallaron/);
  assert.match(notes[0]!, /Aprobar/);

  // Done ⇒ no queries, no turns, no notes, even with new unanswered leads.
  seedLead(raw, "P8", [["in", SINCE + 999]]);
  const s4 = await runRedrive(env, deps, NOW, { sinceEpoch: SINCE, perTick: 3 });
  assert.equal(s4.done, true);
  assert.equal(turned.length, 6);
  assert.equal(notes.length, 1);
});

test("runRedrive: nothing to do ⇒ done immediately with a zero note", async () => {
  const { raw, db, env } = openDb();
  seedLead(raw, "B", [["in", SINCE + 200], ["out_bot", SINCE + 300]]);
  const notes: string[] = [];
  const s = await runRedrive(env, { turn: async () => {}, postNote: async (t) => void notes.push(t) }, NOW, { sinceEpoch: SINCE });
  assert.equal(s.done, true);
  assert.equal(s.processed, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /0 chat\(s\)/);
  void db;
});

test("constants + staleReplyFor", () => {
  assert.equal(REDRIVE_SINCE_EPOCH, cdmxToEpoch(2026, 10, 5, 22, 0, 0));
  const s = staleReplyFor({ ts: cdmxToEpoch(2026, 10, 5, 22, 14, 0) }, cdmxToEpoch(2026, 10, 6, 15, 44, 0));
  assert.equal(s.lastInboundCdmx, "5/10/2026 22:14 (hora CDMX)");
  assert.equal(Math.round(s.waitedHours * 2) / 2, 17.5);
});
