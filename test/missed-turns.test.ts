// Missed-turn rescue (src/cron/missed-turns.ts) against a REAL SQLite loaded
// from src/db/schema.sql + the worker-applied indexes (INDEXED BY needs them).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  findMissedTurns,
  isRescuable,
  rescueTurnOptions,
  runMissedTurnRescue,
  RESCUE_MAX_AGE_SEC,
  RESCUE_MIN_AGE_SEC,
  RESCUE_REVIEW_AFTER_SEC,
} from "../src/cron/missed-turns.js";
import type { UnansweredRow } from "../src/cron/redrive.js";
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

const NOW = cdmxToEpoch(2026, 10, 22, 10, 30, 0);
const T = NOW - 10 * 60; // a message 10 min old: inside the rescue window
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

test("findMissedTurns: newest-is-inbound, 4 min–3 h old, nobody handled it", async () => {
  const { raw, db } = openDb();
  // A: names sent, turn died → YES
  seedLead(raw, "A", [["out_bot", T - 60], ["in", T, "Juan Carlos Martinez"]]);
  // B: too fresh — the live turn may still be running → no
  seedLead(raw, "B", [["in", NOW - RESCUE_MIN_AGE_SEC + 30]]);
  // C: older than the window → no
  seedLead(raw, "C", [["in", NOW - RESCUE_MAX_AGE_SEC - 60]]);
  // D: bot answered → no
  seedLead(raw, "D", [["in", T], ["out_bot", T + 20]]);
  // E: human override live → no
  seedLead(raw, "E", [["in", T]], { override: NOW + 3600 });
  // F: student → no
  seedLead(raw, "F", [["in", T]], { status: "student" });
  // G: an approval (any status) was created for this message → no (a human decided)
  seedLead(raw, "G", [["in", T]]);
  raw.prepare(`INSERT INTO pending_approvals(phone, draft, confidence, status, created_at) VALUES('G','d','low','discarded',?)`).run(T + 25);
  // H: only an OLDER resolved approval → YES
  seedLead(raw, "H", [["in", T + 1]]);
  raw.prepare(`INSERT INTO pending_approvals(phone, draft, confidence, status, created_at) VALUES('H','d','low','approved',?)`).run(T - 600);
  // I: an older approval still pending → no
  seedLead(raw, "I", [["in", T]]);
  raw.prepare(`INSERT INTO pending_approvals(phone, draft, confidence, status, created_at) VALUES('I','d','low','pending',?)`).run(T - 600);
  // J: "Ahí estaré" (silence on purpose) and K: a reaction → no
  seedLead(raw, "J", [["out_bot", T - 60], ["in", T, "Ahí estaré 👍"]]);
  seedLead(raw, "K", [["out_bot", T - 60], ["in", T, "[reaccionó ❤️]"]]);
  // L: already rescued once (claim) → no
  seedLead(raw, "L", [["in", T + 2]]);
  const lw = (raw.prepare(`SELECT wamid FROM messages WHERE phone='L'`).get() as { wamid: string }).wamid;
  raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run("rescue:" + lw, String(NOW - 300));

  const rows = await findMissedTurns(db, NOW, 10);
  assert.deepEqual(rows.map((r) => r.phone), ["A", "H"], JSON.stringify(rows));
  assert.equal(rows[0]!.body, "Juan Carlos Martinez");
});

test("isRescuable: reactions and reminder confirmations stay silent", () => {
  assert.equal(isRescuable("3"), true);
  assert.equal(isRescuable("[reaccionó 👍]"), false);
  assert.equal(isRescuable("Ahí estaré"), false);
});

test("rescueTurnOptions: normal routing under an hour, Aprobar + late note after; origin hint anchored on the message", () => {
  assert.deepEqual(rescueTurnOptions({ ts: T }, NOW, null), {});
  const late = rescueTurnOptions({ ts: NOW - RESCUE_REVIEW_AFTER_SEC - 60 }, NOW, null);
  assert.equal(late.forceReview, true);
  assert.ok(late.stale && late.stale.waitedHours > 1);
  // "3" answered the origin question: answeredAt = the message ts.
  assert.deepEqual(rescueTurnOptions({ ts: T }, NOW, { askedAt: T - 16, answeredAt: T, canal: "Google Maps" }).originAnswer, {
    canal: "Google Maps",
  });
  // Answered long before this message → no hint.
  assert.equal(rescueTurnOptions({ ts: T }, NOW, { askedAt: T - 9000, answeredAt: T - 8000, canal: "Google" }).originAnswer, undefined);
});

test("runMissedTurnRescue: one retry per message, ops note on success, task when the retry fails too", async () => {
  const { raw, db, env } = openDb();
  seedLead(raw, "A", [["in", T, "Juan Carlos Martinez"]]);
  seedLead(raw, "B", [["in", T + 5, "3"]]);
  const turned: string[] = [];
  const notes: string[] = [];
  const tasks: string[] = [];
  const deps = {
    turn: async (row: UnansweredRow) => {
      turned.push(row.phone);
      if (row.phone === "B") throw new Error("anthropic timeout");
    },
    postNote: async (t: string) => void notes.push(t),
    postTask: async (t: string) => void tasks.push(t),
  };
  assert.equal(await runMissedTurnRescue(env, deps, NOW), 1);
  assert.deepEqual(turned, ["A", "B"]);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^🛟 A: su mensaje de las 10:20/);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0]!, /contéstale a mano/);
  // Next tick: both claimed (even the failed one) → nothing runs again.
  assert.equal(await runMissedTurnRescue(env, deps, NOW + 300), 0);
  assert.deepEqual(turned, ["A", "B"]);
  void db;
});

test("runMissedTurnRescue: inert while the bot is switched off", async () => {
  const { raw, env } = openDb();
  seedLead(raw, "A", [["in", T]]);
  raw.prepare(`INSERT INTO kv(key, value) VALUES('bot_enabled', 'false')`).run();
  let called = 0;
  const n = await runMissedTurnRescue(
    env,
    { turn: async () => void called++, postNote: async () => {}, postTask: async () => {} },
    NOW,
  );
  assert.equal(n, 0);
  assert.equal(called, 0);
});
