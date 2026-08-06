import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAdminUser,
  getAdminUserSoft,
  listAdminUsersSoft,
  setAssignedToSoft,
  setReadAtSoft,
  listConversations,
} from "../src/db/queries-admin.js";

// ---- tiny scriptable fake D1 (mirrors nudges.test.ts) ----

type Handler = (sql: string, binds: unknown[]) => {
  first?: unknown;
  all?: unknown[];
  changes?: number;
  throw?: Error;
};

function fakeDb(handler: Handler): {
  db: D1Database;
  calls: { sql: string; binds: unknown[] }[];
} {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const run = (sqlText: string) => {
      const r = handler(sqlText, binds);
      if (r.throw) throw r.throw;
      return r;
    };
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        calls.push({ sql, binds });
        return (run(sql).first ?? null) as T | null;
      },
      async run() {
        calls.push({ sql, binds });
        return { results: [], meta: { changes: run(sql).changes ?? 1 } };
      },
      async all<T>() {
        calls.push({ sql, binds });
        return { results: (run(sql).all ?? []) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, calls };
}

const NO_TABLE = new Error("D1_ERROR: no such table: admin_users");
const NO_COLUMN = new Error("D1_ERROR: no such column: assigned_to");
const READ_AT_NO_COLUMN = new Error("D1_ERROR: no such column: read_at");

// ---- fail-soft: table missing ----

test("getAdminUserSoft returns null pre-migration (no such table)", async () => {
  const { db } = fakeDb(() => ({ throw: NO_TABLE }));
  assert.equal(await getAdminUserSoft(db, "fer"), null);
});

test("listAdminUsersSoft returns [] pre-migration", async () => {
  const { db } = fakeDb(() => ({ throw: NO_TABLE }));
  assert.deepEqual(await listAdminUsersSoft(db), []);
});

test("createAdminUser maps missing table to users_table_missing", async () => {
  const { db } = fakeDb(() => ({ throw: NO_TABLE }));
  await assert.rejects(
    () =>
      createAdminUser(db, {
        username: "fer",
        displayName: "Fer",
        passSalt: "aa",
        passHash: "bb",
        role: "staff",
      }),
    /users_table_missing/,
  );
});

test("getAdminUserSoft rethrows unrelated errors", async () => {
  const { db } = fakeDb(() => ({ throw: new Error("D1_ERROR: disk I/O") }));
  await assert.rejects(() => getAdminUserSoft(db, "fer"), /disk I\/O/);
});

// ---- fail-soft: assigned_to column missing ----

test("setAssignedToSoft is a no-op pre-migration (no such column)", async () => {
  const { db } = fakeDb(() => ({ throw: NO_COLUMN }));
  await setAssignedToSoft(db, "521555", "fer"); // must not throw
});

test("listConversations falls back to the base query when both columns are absent", async () => {
  const tried: string[] = [];
  const { db } = fakeDb((sql) => {
    const cols = [
      sql.includes("assigned_to") ? "assigned_to" : "",
      sql.includes("read_at") ? "read_at" : "",
    ]
      .filter(Boolean)
      .join("+");
    tried.push(cols);
    if (cols) return { throw: NO_COLUMN };
    return { all: [{ phone: "521555", pendingCount: 0 }] };
  });
  const rows = await listConversations(db, 50, 0);
  assert.deepEqual(tried, ["assigned_to+read_at", "assigned_to", ""]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.phone, "521555");
});

test("listConversations keeps assigned_to when only read_at is absent", async () => {
  let attempts = 0;
  const { db } = fakeDb((sql) => {
    attempts++;
    if (sql.includes("read_at")) return { throw: READ_AT_NO_COLUMN };
    return { all: [{ phone: "521555", pendingCount: 0, assignedTo: "fer" }] };
  });
  const rows = await listConversations(db, 50, 0);
  assert.equal(attempts, 2, "only the read_at tier is discarded");
  assert.equal(rows[0]!.assignedTo, "fer");
});

test("listConversations with q adds the search WHERE + matchBody and binds patterns", async () => {
  const { db, calls } = fakeDb((sql) => {
    assert.ok(/WHERE \(c\.name LIKE \?3/.test(sql), "search WHERE present");
    assert.ok(sql.includes("AS matchBody"), "matchBody column present");
    return { all: [{ phone: "5215647558301", pendingCount: 0, matchBody: "hola" }] };
  });
  const rows = await listConversations(db, 50, 0, "(564) 755-8301");
  assert.equal(rows[0]!.matchBody, "hola");
  // ?3 = literal pattern (wildcards escaped), ?4 = digits-only phone pattern
  assert.deepEqual(calls[0]!.binds, [50, 0, "%(564) 755-8301%", "%5647558301%"]);
});

test("listConversations with q escapes LIKE wildcards literally", async () => {
  const { db, calls } = fakeDb(() => ({ all: [] }));
  await listConversations(db, 50, 0, "50%_off");
  assert.equal(calls[0]!.binds![2], "%50\\%\\_off%");
  // <4 digits in q → digits pattern falls back to the literal pattern
  assert.equal(calls[0]!.binds![3], "%50\\%\\_off%");
});

test("listConversations without q keeps the original 2-bind shape", async () => {
  const { db, calls } = fakeDb((sql) => {
    assert.ok(!sql.includes("matchBody"), "no matchBody without q");
    assert.ok(!/WHERE \(c\.name/.test(sql), "no search WHERE without q");
    return { all: [] };
  });
  await listConversations(db, 50, 0);
  assert.deepEqual(calls[0]!.binds, [50, 0]);
});

test("listConversations rethrows unrelated errors instead of downgrading", async () => {
  const { db } = fakeDb(() => ({ throw: new Error("D1_ERROR: disk I/O") }));
  await assert.rejects(() => listConversations(db, 50, 0), /disk I\/O/);
});

// ---- fail-soft: read_at column missing ----

test("setReadAtSoft is a no-op pre-migration (no such column)", async () => {
  const { db } = fakeDb(() => ({ throw: READ_AT_NO_COLUMN }));
  await setReadAtSoft(db, "521555", 0); // must not throw
});

test("setReadAtSoft writes the marker verbatim (0 = marked unread)", async () => {
  const { db, calls } = fakeDb(() => ({ changes: 1 }));
  await setReadAtSoft(db, "521555", 0);
  assert.ok(/UPDATE contacts SET read_at = \?2/.test(calls[0]!.sql));
  assert.equal(calls[0]!.binds[0], "521555");
  assert.equal(calls[0]!.binds[1], 0);
});

// ---- happy path row reads ----

test("getAdminUserSoft returns the row when the table exists", async () => {
  const row = {
    username: "vale",
    display_name: "Vale",
    pass_salt: "aa",
    pass_hash: "bb",
    role: "staff",
    disabled: 0,
    created_at: 1,
    updated_at: 1,
  };
  const { db } = fakeDb(() => ({ first: row }));
  const got = await getAdminUserSoft(db, "vale");
  assert.deepEqual(got, row);
});
