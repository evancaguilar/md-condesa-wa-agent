import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sendStaffText,
  STAFF_TAKEOVER_HOURS,
  STAFF_TEXT_MAX,
  type StaffSendDeps,
} from "../src/services/staff-send.js";
import type { Contact, Env } from "../src/types.js";

// ---- tiny scriptable fake D1 (mirrors nudges.test.ts) ----

type Handler = (sql: string, binds: unknown[]) => {
  first?: unknown;
  all?: unknown[];
  changes?: number;
};

function fakeDb(handler: Handler): {
  db: D1Database;
  calls: { sql: string; binds: unknown[] }[];
} {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        calls.push({ sql, binds });
        return (handler(sql, binds).first ?? null) as T | null;
      },
      async run() {
        calls.push({ sql, binds });
        return { results: [], meta: { changes: handler(sql, binds).changes ?? 1 } };
      },
      async all<T>() {
        calls.push({ sql, binds });
        return { results: (handler(sql, binds).all ?? []) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, calls };
}

const CONTACT: Partial<Contact> = {
  phone: "5215512345678",
  status: "lead",
  last_inbound_at: 1_700_000_000,
};

function envWith(db: D1Database): Env {
  return { DB: db, HUMAN_SNOOZE_HOURS: "8" } as unknown as Env;
}

interface DepsLog {
  sends: { phone: string; body: string; opts: unknown }[];
  notes: string[];
}

function makeDeps(over: Partial<StaffSendDeps> = {}): { deps: StaffSendDeps; log: DepsLog } {
  const log: DepsLog = { sends: [], notes: [] };
  const deps: StaffSendDeps = {
    async sendText(_env, phone, body, opts) {
      log.sends.push({ phone, body, opts });
      return "wamid.STAFF1";
    },
    isWindowClosed: (err) =>
      err instanceof Error && err.name === "WindowClosedError",
    async postNote(_env, text) {
      log.notes.push(text);
    },
    ...over,
  };
  return { deps, log };
}

function windowClosedErr(): Error {
  const e = new Error("closed");
  e.name = "WindowClosedError";
  return e;
}

// ---- happy path ----

test("sendStaffText: claims token, sends out_human with by, takes over, notes", async () => {
  const { db, calls } = fakeDb((sql) => {
    if (sql.includes("FROM contacts")) return { first: CONTACT };
    return { changes: 1 };
  });
  const { deps, log } = makeDeps();

  const r = await sendStaffText(
    envWith(db),
    "5215512345678",
    "  Hola Joshua! ",
    "fer",
    "tok-1",
    deps,
  );

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.direction, "out_human");
  assert.equal(r.message.body, "Hola Joshua!"); // trimmed
  assert.equal(r.message.wamid, "wamid.STAFF1");
  assert.equal(JSON.parse(r.message.meta ?? "{}").by, "fer");

  // Send carried the staff direction + attribution.
  assert.equal(log.sends.length, 1);
  const opts = log.sends[0]!.opts as { direction: string; metaExtra: { by: string } };
  assert.equal(opts.direction, "out_human");
  assert.equal(opts.metaExtra.by, "fer");

  // Slack note mentions the author.
  assert.equal(log.notes.length, 1);
  assert.ok(log.notes[0]!.includes("fer"));

  // DB op order: contact read → kv claim → override → cancel approvals.
  const sqls = calls.map((c) => c.sql);
  const idxClaim = sqls.findIndex((s) => s.includes("INSERT OR IGNORE INTO kv"));
  const idxOverride = sqls.findIndex((s) => s.includes("human_override_until"));
  const idxCancel = sqls.findIndex((s) => s.includes("pending_approvals"));
  assert.ok(idxClaim >= 0 && idxOverride > idxClaim && idxCancel > idxOverride);

  // Override is the "until Reanudar" 1-year snooze, not the 8h default.
  const overrideCall = calls[idxOverride]!;
  const until = overrideCall.binds[1] as number;
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(
    until > nowSec + (STAFF_TAKEOVER_HOURS - 1) * 3600,
    "override extends ~1 year out",
  );

  // Approvals cancelled as taken_over.
  assert.ok(calls[idxCancel]!.binds.includes("taken_over"));
});

// ---- guard rails ----

test("sendStaffText: empty and whitespace-only text rejected before any DB work", async () => {
  const { db, calls } = fakeDb(() => ({}));
  const { deps, log } = makeDeps();
  const r1 = await sendStaffText(envWith(db), "521", "", "fer", "t", deps);
  const r2 = await sendStaffText(envWith(db), "521", "   \n ", "fer", "t", deps);
  assert.deepEqual(r1, { ok: false, reason: "empty" });
  assert.deepEqual(r2, { ok: false, reason: "empty" });
  assert.equal(calls.length, 0);
  assert.equal(log.sends.length, 0);
});

test("sendStaffText: over-limit text rejected", async () => {
  const { db, calls } = fakeDb(() => ({}));
  const { deps } = makeDeps();
  const r = await sendStaffText(
    envWith(db),
    "521",
    "x".repeat(STAFF_TEXT_MAX + 1),
    "fer",
    "t",
    deps,
  );
  assert.deepEqual(r, { ok: false, reason: "too_long" });
  assert.equal(calls.length, 0);
});

test("sendStaffText: unknown contact → no_contact, no claim burned", async () => {
  const { db, calls } = fakeDb((sql) => {
    if (sql.includes("FROM contacts")) return { first: undefined };
    return { changes: 1 };
  });
  const { deps, log } = makeDeps();
  const r = await sendStaffText(envWith(db), "521999", "hola", "vale", "t", deps);
  assert.deepEqual(r, { ok: false, reason: "no_contact" });
  assert.equal(log.sends.length, 0);
  assert.equal(
    calls.filter((c) => c.sql.includes("INSERT OR IGNORE INTO kv")).length,
    0,
  );
});

test("sendStaffText: duplicate token → no send, no takeover", async () => {
  const { db, calls } = fakeDb((sql) => {
    if (sql.includes("FROM contacts")) return { first: CONTACT };
    if (sql.includes("INSERT OR IGNORE INTO kv")) return { changes: 0 }; // lost claim
    return { changes: 1 };
  });
  const { deps, log } = makeDeps();
  const r = await sendStaffText(envWith(db), "5215512345678", "hola", "fer", "tok-dup", deps);
  assert.deepEqual(r, { ok: false, reason: "duplicate" });
  assert.equal(log.sends.length, 0);
  assert.equal(calls.filter((c) => c.sql.includes("human_override_until")).length, 0);
});

test("sendStaffText: window closed → clean result, NO override/cancel writes", async () => {
  const { db, calls } = fakeDb((sql) => {
    if (sql.includes("FROM contacts")) return { first: CONTACT };
    return { changes: 1 };
  });
  const { deps, log } = makeDeps({
    async sendText() {
      throw windowClosedErr();
    },
  });
  const r = await sendStaffText(envWith(db), "5215512345678", "hola", "evan", "tok-w", deps);
  assert.deepEqual(r, { ok: false, reason: "window_closed" });
  assert.equal(log.notes.length, 0);
  assert.equal(calls.filter((c) => c.sql.includes("human_override_until")).length, 0);
  assert.equal(calls.filter((c) => c.sql.includes("pending_approvals")).length, 0);
});

test("sendStaffText: non-window send failure rethrows (token stays burned)", async () => {
  const { db } = fakeDb((sql) => {
    if (sql.includes("FROM contacts")) return { first: CONTACT };
    return { changes: 1 };
  });
  const { deps } = makeDeps({
    async sendText() {
      throw new Error("graph 500");
    },
  });
  await assert.rejects(
    () => sendStaffText(envWith(db), "5215512345678", "hola", "evan", "tok-e", deps),
    /graph 500/,
  );
});

test("sendStaffText: slack note failure does not break the send", async () => {
  const { db } = fakeDb((sql) => {
    if (sql.includes("FROM contacts")) return { first: CONTACT };
    return { changes: 1 };
  });
  const { deps } = makeDeps({
    async postNote() {
      throw new Error("slack down");
    },
  });
  const r = await sendStaffText(envWith(db), "5215512345678", "hola", "evan", "tok-s", deps);
  assert.equal(r.ok, true);
});
