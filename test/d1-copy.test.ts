// d1-copy against two REAL SQLite databases (node:sqlite): schema copy,
// resumable row copy, idempotence (INSERT OR IGNORE), counts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  copySchema,
  copyStep,
  idempotentCreate,
  listTables,
  startCursor,
  tableCounts,
  type DbLike,
} from "../src/services/d1-copy.js";
import { INDEX_SQL } from "../src/db/indexes.js";

function shim(raw: DatabaseSync): DbLike {
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
      __run: () => raw.prepare(sql).run(...(binds as never[])),
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return {
    prepare: make,
    async batch(statements) {
      for (const s of statements) (s as unknown as { __run(): void }).__run();
      return [];
    },
  };
}

function sourceDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  const text = readFileSync("src/db/schema.sql", "utf8").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  for (const s of text.split(";").map((s) => s.trim()).filter(Boolean)) raw.exec(s);
  for (const s of INDEX_SQL) raw.exec(s);
  raw.exec("BEGIN");
  const ic = raw.prepare("INSERT INTO contacts(phone,name,status,created_at,updated_at) VALUES(?,?,?,?,?)");
  for (let i = 0; i < 1234; i++) ic.run(`52155${String(i).padStart(8, "0")}`, i % 7 ? `n${i}` : null, "lead", i, i);
  const im = raw.prepare("INSERT INTO messages(wamid,phone,direction,body,ts,meta) VALUES(?,?,?,?,?,?)");
  for (let i = 0; i < 3000; i++) im.run(`w${i}`, `52155${String(i % 1234).padStart(8, "0")}`, i % 3 ? "out_bot" : "in", `hola "quoted" ${i}`, 1.7e9 + i, i % 5 ? null : '{"holding":1}');
  raw.prepare("INSERT INTO kv(key,value) VALUES('a','1'),('b','2')").run();
  raw.prepare("INSERT INTO pending_approvals(phone,draft,confidence,status,created_at) VALUES('x','d','low','pending',1)").run();
  raw.exec("COMMIT");
  return raw;
}

test("idempotentCreate", () => {
  assert.equal(idempotentCreate("CREATE TABLE kv(key TEXT PRIMARY KEY)"), "CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY)");
  assert.equal(idempotentCreate("CREATE INDEX idx ON t(a)"), "CREATE INDEX IF NOT EXISTS idx ON t(a)");
  assert.equal(idempotentCreate("CREATE UNIQUE INDEX idx ON t(a)"), "CREATE UNIQUE INDEX IF NOT EXISTS idx ON t(a)");
  assert.equal(idempotentCreate("CREATE TABLE IF NOT EXISTS kv(k)"), "CREATE TABLE IF NOT EXISTS kv(k)");
});

test("copySchema + copyStep: full copy, resumable, idempotent, counts match", async () => {
  const srcRaw = sourceDb();
  const dstRaw = new DatabaseSync(":memory:");
  const src = shim(srcRaw);
  const dst = shim(dstRaw);

  const ran = await copySchema(src, dst);
  assert.ok(ran.some((r) => r === "table messages"));
  assert.ok(ran.some((r) => r === "index idx_messages_phone_ts"));
  assert.deepEqual(await listTables(dst), await listTables(src));
  // Idempotent.
  await copySchema(src, dst);

  // Tiny time budget ⇒ several steps, each resumes from the cursor.
  let t = 0;
  const now = () => (t += 10_000); // every step "takes" 10 s ⇒ budget hit after one select
  let cursor = await startCursor(src);
  let steps = 0;
  for (;;) {
    const r = await copyStep(src, dst, cursor, 5_000, now);
    steps++;
    cursor = r.cursor;
    if (r.done) break;
    assert.ok(steps < 500);
  }
  assert.ok(steps > 5, `expected many small steps, got ${steps}`);
  assert.equal(cursor.copied, 1234 + 3000 + 2 + 1);

  const counts = await tableCounts(src, dst);
  for (const c of counts) assert.equal(c.dst, c.src, c.table);
  // Row fidelity: nulls, quotes, JSON meta, ids.
  const m = dstRaw.prepare("SELECT * FROM messages WHERE wamid='w0'").get() as Record<string, unknown>;
  assert.equal(m.body, 'hola "quoted" 0');
  assert.equal(m.meta, '{"holding":1}');
  assert.equal((dstRaw.prepare("SELECT name FROM contacts WHERE phone='5215500000000'").get() as { name: unknown }).name, null);
  assert.equal((dstRaw.prepare("SELECT id FROM pending_approvals").get() as { id: number }).id, 1);

  // Delta: source gains rows, a full re-copy adds only those.
  srcRaw.prepare("INSERT INTO messages(wamid,phone,direction,body,ts,meta) VALUES('w-new','5215500000001','in','nuevo',2e9,NULL)").run();
  const again = await copyStep(src, dst, await startCursor(src), 60_000);
  assert.equal(again.done, true);
  assert.equal((dstRaw.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 3001);
  assert.equal((dstRaw.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n, 1234);
});
