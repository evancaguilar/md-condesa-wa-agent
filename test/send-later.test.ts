// F2 "send later": staff_later followup rows written by the dashboard composer
// and fired (or cancelled) by the cron tick.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseStaffLaterNote,
  staffLaterNote,
  STAFF_LATER_TOKEN_RE,
} from "../src/services/staff-send.js";
import { runDueFollowups } from "../src/cron/followups.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { Env, Followup } from "../src/types.js";

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

function envWith(db: D1Database): Env {
  return {
    DB: db,
    AIRTABLE_BASE_ID: "appTest",
    AIRTABLE_TRIALS_TABLE: "Trials",
  } as unknown as Env;
}

const PHONE = "5215512345678";

function laterRow(over: Partial<Followup> = {}): Followup {
  return {
    id: 7,
    phone: PHONE,
    kind: "staff_later",
    due_at: 0,
    status: "scheduled",
    airtable_record_id: "later:tok-abcdef",
    note: staffLaterNote("Te esperamos mañana 💪", "ana"),
    created_at: 1000,
    ...over,
  };
}

function contactRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { phone: PHONE, status: "lead", lang: "es", name: "Ana", ...over };
}

interface Recorder {
  marks: { id: unknown; status: unknown }[];
  reschedules: { id: unknown; dueAt: unknown }[];
  notes: string[];
}

/** Scripts the fake DB for one due staff_later row. */
function scenario(opts: {
  row?: Partial<Followup>;
  contact?: Record<string, unknown>;
  claimWins?: boolean;
}): { env: Env; rec: Recorder; slack: { postNote(t: string): Promise<void>; postAttendanceCheck(): Promise<void> } } {
  const rec: Recorder = { marks: [], reschedules: [], notes: [] };
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'")) {
      return { all: [laterRow(opts.row)] };
    }
    if (sql.includes("SELECT * FROM contacts")) {
      return { first: contactRow(opts.contact) };
    }
    if (sql.includes("INSERT OR IGNORE INTO kv")) {
      return { changes: opts.claimWins === false ? 0 : 1 };
    }
    if (sql.includes("UPDATE followups SET status = ?2")) {
      rec.marks.push({ id: binds[0], status: binds[1] });
      return {};
    }
    if (sql.includes("UPDATE followups SET due_at = ?2")) {
      rec.reschedules.push({ id: binds[0], dueAt: binds[1] });
      return {};
    }
    return {};
  });
  return {
    env: envWith(db),
    rec,
    slack: {
      async postNote(t: string) {
        rec.notes.push(t);
      },
      async postAttendanceCheck() {},
    },
  };
}

/** Runs `fn` with Date.now() pinned to `epoch` seconds. */
async function atClock(epoch: number, fn: () => Promise<void>): Promise<void> {
  const real = Date.now;
  Date.now = () => epoch * 1000;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

// 2026-07-13 CDMX reference instants.
const DAYTIME = cdmxToEpoch(2026, 7, 13, 14, 0, 0);
const QUIET_NIGHT = cdmxToEpoch(2026, 7, 13, 23, 0, 0);
const NEXT_8AM = cdmxToEpoch(2026, 7, 14, 8, 0, 0);

function failFetch(): void {
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error("no send expected in this test");
  };
}

function okFetch(): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { messages: [{ id: "wamid.later1" }] };
    },
    async text() {
      return "";
    },
  });
}

// ---- note codec ----

test("staff_later note survives the bumpAttempts '|attempts:N' suffix", () => {
  const note = staffLaterNote("Hola|attempts:9 sigue aquí", "ana");
  const bumped = `${note}|attempts:2`;
  assert.deepEqual(parseStaffLaterNote(bumped), {
    text: "Hola|attempts:9 sigue aquí",
    by: "ana",
  });
  // ...and the plain round trip.
  assert.deepEqual(parseStaffLaterNote(note), {
    text: "Hola|attempts:9 sigue aquí",
    by: "ana",
  });
});

test("staff_later note: unparseable / empty payloads return null", () => {
  assert.equal(parseStaffLaterNote(null), null);
  assert.equal(parseStaffLaterNote(""), null);
  assert.equal(parseStaffLaterNote("attendance_check"), null);
  assert.equal(parseStaffLaterNote('{"text":"   ","by":"ana"}'), null);
  assert.equal(parseStaffLaterNote('{"by":"ana"}'), null);
  assert.equal(parseStaffLaterNote("[]"), null);
  // A note written before `by` existed still yields usable text.
  assert.deepEqual(parseStaffLaterNote('{"text":"hola"}'), { text: "hola", by: "" });
});

test("send-later client tokens accept UUIDs and reject junk", () => {
  assert.ok(STAFF_LATER_TOKEN_RE.test("3f1a2b4c-5d6e-7f80-9012-3456789abcde"));
  assert.ok(STAFF_LATER_TOKEN_RE.test("t1770000000000-12345"));
  assert.ok(!STAFF_LATER_TOKEN_RE.test("short"));
  assert.ok(!STAFF_LATER_TOKEN_RE.test("bad token with spaces"));
  assert.ok(!STAFF_LATER_TOKEN_RE.test("x".repeat(65)));
});

// ---- cron: staff_later ----

test("staff_later: lead wrote first → cancelled, Slack note, no send", async () => {
  failFetch();
  const { env, rec, slack } = scenario({
    row: { created_at: 1000 },
    contact: { last_inbound_at: 2000 },
  });
  await atClock(DAYTIME, () => runDueFollowups(env, { slack }));
  assert.deepEqual(rec.marks, [{ id: 7, status: "cancelled" }]);
  assert.equal(rec.notes.length, 1);
  assert.ok(/escribió primero/.test(rec.notes[0]!));
  assert.ok(/ana/.test(rec.notes[0]!));
});

test("staff_later: quiet hours → rescheduled to the next 08:00, not sent", async () => {
  failFetch();
  const { env, rec, slack } = scenario({
    row: { created_at: QUIET_NIGHT - 3600 },
    contact: { last_inbound_at: QUIET_NIGHT - 7200 },
  });
  await atClock(QUIET_NIGHT, () => runDueFollowups(env, { slack }));
  assert.deepEqual(rec.reschedules, [{ id: 7, dueAt: NEXT_8AM }]);
  assert.equal(rec.marks.length, 0);
  assert.equal(rec.notes.length, 0);
});

test("staff_later: opted-out contact → skipped_optout before anything else", async () => {
  failFetch();
  const { env, rec, slack } = scenario({
    contact: { status: "opted_out", last_inbound_at: DAYTIME - 60 },
  });
  await atClock(DAYTIME, () => runDueFollowups(env, { slack }));
  assert.deepEqual(rec.marks, [{ id: 7, status: "skipped_optout" }]);
  assert.equal(rec.notes.length, 0);
});

test("staff_later: closed 24h window → cancelled + loud Slack note, no throw", async () => {
  failFetch(); // the window guard rejects before any Graph call
  const { env, rec, slack } = scenario({
    row: { created_at: DAYTIME - 3600 },
    contact: { last_inbound_at: null },
  });
  await atClock(DAYTIME, () => runDueFollowups(env, { slack }));
  assert.deepEqual(rec.marks, [{ id: 7, status: "cancelled" }]);
  assert.equal(rec.notes.length, 1);
  assert.ok(/ventana de 24h cerrada/i.test(rec.notes[0]!));
});

test("staff_later: burned idempotency claim (duplicate) → marked sent", async () => {
  failFetch();
  const { env, rec, slack } = scenario({
    row: { created_at: DAYTIME - 30 },
    contact: { last_inbound_at: DAYTIME - 600 },
    claimWins: false,
  });
  await atClock(DAYTIME, () => runDueFollowups(env, { slack }));
  assert.deepEqual(rec.marks, [{ id: 7, status: "sent" }]);
  assert.equal(rec.notes.length, 0);
});

test("staff_later: in-window send → out_human message, takeover note, marked sent", async () => {
  okFetch();
  const { env, rec, slack } = scenario({
    row: { created_at: DAYTIME - 30 },
    contact: { last_inbound_at: DAYTIME - 600 },
  });
  await atClock(DAYTIME, () => runDueFollowups(env, { slack }));
  assert.deepEqual(rec.marks, [{ id: 7, status: "sent" }]);
  assert.equal(rec.notes.length, 1);
  assert.ok(/ana/.test(rec.notes[0]!));
});

test("staff_later: unparseable note → cancelled, never throws", async () => {
  failFetch();
  const { env, rec, slack } = scenario({
    row: { note: "attendance_check|attempts:1", created_at: DAYTIME - 30 },
    contact: { last_inbound_at: DAYTIME - 600 },
  });
  await atClock(DAYTIME, () => runDueFollowups(env, { slack }));
  assert.deepEqual(rec.marks, [{ id: 7, status: "cancelled" }]);
  assert.equal(rec.notes.length, 0);
});
