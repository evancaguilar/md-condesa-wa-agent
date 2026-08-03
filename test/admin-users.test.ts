import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAdminUser,
  getAdminUserSoft,
  listAdminUsersSoft,
  setAssignedToSoft,
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

test("listConversations falls back to the no-assigned_to query pre-migration", async () => {
  let attempts = 0;
  const { db } = fakeDb((sql) => {
    if (sql.includes("assigned_to")) {
      attempts++;
      return { throw: NO_COLUMN };
    }
    return { all: [{ phone: "521555", pendingCount: 0 }] };
  });
  const rows = await listConversations(db, 50, 0);
  assert.equal(attempts, 1, "primary variant tried once");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.phone, "521555");
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
