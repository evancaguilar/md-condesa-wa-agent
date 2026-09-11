// listConversations / conversationsEtag / ensureIndexes against a REAL SQLite
// (node:sqlite) loaded from src/db/schema.sql. Exists because of the
// 2026-09-10 D1 free-tier incident: the inbox query used to full-scan
// `messages` three times per call and the dashboard polled it every 5s.
// Beyond result shape, this pins the query PLAN: no full scan of messages or
// pending_approvals may ever creep back in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  conversationsEtag,
  conversationsSql,
  listConversations,
} from "../src/db/queries-admin.js";
import {
  ensureIndexes,
  INDEX_MIGRATION_KEY,
  INDEX_SQL,
  resetIndexMemoForTests,
} from "../src/db/indexes.js";
import { HOLDING_LINE } from "../src/services/slack-timeouts.js";

interface Fx {
  raw: DatabaseSync;
  db: D1Database;
  sqls: { sql: string; binds: unknown[] }[];
}

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

function openDb(withIndexes: boolean): Fx {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of schemaStatements()) raw.exec(stmt);
  if (withIndexes) for (const sql of INDEX_SQL) raw.exec(sql);
  const sqls: Fx["sqls"] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        sqls.push({ sql, binds });
        return (raw.prepare(sql).get(...binds) ?? null) as T | null;
      },
      async run() {
        sqls.push({ sql, binds });
        const r = raw.prepare(sql).run(...binds);
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        sqls.push({ sql, binds });
        return { results: raw.prepare(sql).all(...binds) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { raw, db: { prepare: make } as D1Database, sqls };
}

const A = "5215550000001";
const B = "5215550000002";
const C = "5215550000003"; // CRM-only: no messages
const D = "5215550000004"; // only the holding line

function seed(raw: DatabaseSync): void {
  const contact = raw.prepare(
    `INSERT INTO contacts(phone, name, status, campaign_id, created_at, updated_at)
     VALUES(?1, ?2, 'lead', ?3, ?4, ?4)`,
  );
  contact.run(A, "Ana", 1, 100);
  contact.run(B, "Beto", null, 200);
  contact.run(C, "Carla", null, 5000);
  contact.run(D, "Dani", null, 300);
  raw.prepare(
    `INSERT INTO campaigns(id, name, trigger_phrase, trigger_norm, info, created_at, updated_at)
     VALUES(1, 'Reto', 'reto', 'reto', '', 0, 0)`,
  ).run();
  const msg = raw.prepare(
    `INSERT INTO messages(wamid, phone, direction, body, ts, meta) VALUES(?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  msg.run("a1", A, "in", "hola, precio?", 1000, null);
  msg.run("a2", A, "out_bot", "respuesta", 1500, null);
  msg.run("b1", B, "in", "precio", 2000, null);
  msg.run("b2", B, "in", "más info", 2500, null);
  // Same-ts pair: the old JOIN-on-MAX(ts) query duplicated this contact.
  msg.run("b3", B, "in", "primero", 3000, null);
  msg.run("b4", B, "out_bot", "último", 3000, null);
  // D: only a tagged holding line → must NOT count as activity.
  msg.run("d1", D, "out_bot", HOLDING_LINE, 4000, '{"holding":1}');
  const pa = raw.prepare(
    `INSERT INTO pending_approvals(phone, draft, confidence, status, created_at)
     VALUES(?1, 'x', ?2, ?3, ?4)`,
  );
  pa.run(A, "high", "pending", 10);
  pa.run(A, "high", "approved", 11);
  pa.run(B, "low", "discarded", 12);
}

test("listConversations: order, last message, counts, holding-line exclusion", async () => {
  const fx = openDb(true);
  seed(fx.raw);
  const rows = await listConversations(fx.db, 100, 0, null);
  assert.deepEqual(
    rows.map((r) => r.phone),
    [C, B, A, D],
    "COALESCE(lastTs, updated_at) DESC — CRM-only contact sorts by updated_at",
  );
  assert.equal(rows.length, 4, "one row per contact even with a same-ts pair");
  const byPhone = Object.fromEntries(rows.map((r) => [r.phone, r]));
  assert.equal(byPhone[B].lastTs, 3000);
  assert.equal(byPhone[B].lastBody, "último", "tie → newest inserted row");
  assert.equal(byPhone[B].lastDirection, "out_bot");
  assert.equal(byPhone[B].inboundCount, 3);
  assert.equal(byPhone[A].lastBody, "respuesta");
  assert.equal(byPhone[A].pendingCount, 1);
  assert.equal(byPhone[A].hiConfCount, 2);
  assert.equal(byPhone[A].approvedAsIsCount, 1);
  assert.equal(byPhone[A].inboundCount, 1);
  assert.equal(byPhone[A].campaignName, "Reto");
  assert.equal(byPhone[B].campaignName, null);
  assert.equal(byPhone[C].lastTs, null);
  assert.equal(byPhone[C].lastBody, null);
  assert.equal(byPhone[D].lastTs, null, "holding line is not activity");
  assert.equal(byPhone[D].pendingCount, 0);
  assert.equal(byPhone[A].readAt, null, "tier-2 column present");
});

test("listConversations: paging and search (text + digits)", async () => {
  const fx = openDb(true);
  seed(fx.raw);
  const page2 = await listConversations(fx.db, 2, 2, null);
  assert.deepEqual(page2.map((r) => r.phone), [A, D]);
  const byText = await listConversations(fx.db, 100, 0, "precio");
  assert.deepEqual(byText.map((r) => r.phone).sort(), [A, B].sort());
  assert.equal(byText.find((r) => r.phone === B)?.matchBody, "precio");
  const byDigits = await listConversations(fx.db, 100, 0, "(555) 000-0003");
  assert.deepEqual(byDigits.map((r) => r.phone), [C], "CRM-only contact findable by phone");
  const byName = await listConversations(fx.db, 100, 0, "dani");
  assert.deepEqual(byName.map((r) => r.phone), [D]);
});

test("listConversations: falls back a tier when read_at / assigned_to are missing", async () => {
  const fx = openDb(true);
  seed(fx.raw);
  fx.raw.exec(`ALTER TABLE contacts DROP COLUMN read_at`);
  const rows = await listConversations(fx.db, 100, 0, null);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].readAt, undefined);
  assert.equal(rows.find((r) => r.phone === A)?.pendingCount, 1);
});

test("query plan: never a full scan of messages or pending_approvals", () => {
  const fx = openDb(true);
  seed(fx.raw);
  for (const search of [false, true]) {
    const sql = conversationsSql(2, search);
    const binds = search ? [100, 0, "%precio%", "%0001%"] : [100, 0];
    const plan = fx.raw
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...binds)
      .map((r) => String(r.detail));
    const scans = plan.filter((d) => /^SCAN /.test(d));
    // Only the contacts driver (`c`) and the paged subquery may scan.
    for (const d of scans) {
      assert.match(d, /^SCAN (c|p|SUBQUERY|\(subquery)/, `unexpected scan: ${d}\n${plan.join("\n")}`);
    }
    assert.ok(
      plan.some((d) => /SEARCH m USING (COVERING )?INDEX idx_messages_phone_ts/.test(d)),
      `last-message probe must use idx_messages_phone_ts:\n${plan.join("\n")}`,
    );
    assert.ok(
      plan.some((d) => /SEARCH pa USING (COVERING )?INDEX idx_pending_approvals_phone/.test(d)),
      `approval counts must use idx_pending_approvals_phone:\n${plan.join("\n")}`,
    );
  }
});

test("conversationsEtag: moves on every write the inbox renders, stable otherwise", async () => {
  const fx = openDb(true);
  seed(fx.raw);
  const e0 = await conversationsEtag(fx.db);
  assert.equal(await conversationsEtag(fx.db), e0, "no-op poll → same etag");
  fx.raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('n1', ?1, 'in', 'hey', 9000)`).run(B);
  const e1 = await conversationsEtag(fx.db);
  assert.notEqual(e1, e0, "new message");
  fx.raw.prepare(`UPDATE pending_approvals SET status = 'approved' WHERE phone = ?1 AND status = 'pending'`).run(A);
  const e2 = await conversationsEtag(fx.db);
  assert.notEqual(e2, e1, "approval resolved (pending count)");
  fx.raw.prepare(`INSERT INTO pending_approvals(phone, draft, confidence, status, created_at) VALUES(?1, 'y', 'high', 'pending', 20)`).run(B);
  const e3 = await conversationsEtag(fx.db);
  assert.notEqual(e3, e2, "new approval");
  fx.raw.prepare(`UPDATE contacts SET read_at = 9999, updated_at = 9999 WHERE phone = ?1`).run(A);
  const e4 = await conversationsEtag(fx.db);
  assert.notEqual(e4, e3, "contact touched (read/unread, assignment…)");
  assert.equal(await conversationsEtag(fx.db), e4);
  // The fingerprint itself must be cheap: index tips only, no table scans.
  const sql = fx.sqls[fx.sqls.length - 1].sql;
  const plan = fx.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => String(r.detail));
  for (const d of plan) assert.doesNotMatch(d, /^SCAN (messages|contacts)\b/, plan.join("\n"));
});

test("ensureIndexes: creates once, kv-guarded, memoized per isolate", async () => {
  resetIndexMemoForTests();
  const fx = openDb(false);
  assert.equal(await ensureIndexes(fx.db), true, "first call creates");
  const names = fx.raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
    .all()
    .map((r) => String(r.name));
  for (const sql of INDEX_SQL) {
    const m = /INDEX IF NOT EXISTS (\w+)/.exec(sql);
    assert.ok(m && names.includes(m[1]), `missing ${m?.[1]}`);
  }
  const guard = fx.raw.prepare(`SELECT value FROM kv WHERE key = ?1`).get(INDEX_MIGRATION_KEY);
  assert.equal(guard?.value, "1");
  const before = fx.sqls.length;
  assert.equal(await ensureIndexes(fx.db), false, "memoized: no D1 calls at all");
  assert.equal(fx.sqls.length, before);
  resetIndexMemoForTests();
  assert.equal(await ensureIndexes(fx.db), false, "new isolate: one kv read, no CREATEs");
  assert.equal(fx.sqls.length, before + 1);
  assert.match(fx.sqls[fx.sqls.length - 1].sql, /FROM kv/);
  resetIndexMemoForTests();
});
