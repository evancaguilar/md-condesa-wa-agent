import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampToWindow,
  cdmxToEpoch,
  cdmxParts,
  cdmxIso,
  cdmxDateStr,
  cdmxMonthStr,
  CDMX_OFFSET_SECONDS,
} from "../src/cron/time.js";
import { computeTrialSequence, syncBookings, runDueFollowups } from "../src/cron/followups.js";
import { normalizeMxPhone } from "../src/services/airtable.js";
import { runBudgetReport } from "../src/cron/budget.js";
import type { Env, Followup } from "../src/types.js";

// ---- a tiny scriptable fake D1 ----

type Handler = (sql: string, binds: unknown[]) => {
  first?: unknown;
  all?: unknown[];
  changes?: number;
};

function fakeDb(handler: Handler): { db: D1Database; calls: { sql: string; binds: unknown[] }[] } {
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

// A representative CDMX moment: 2026-07-12 (Sunday) 14:00 CDMX == 20:00 UTC.
const JUL12_1400 = cdmxToEpoch(2026, 7, 12, 14, 0, 0);

// ---- time math ----

test("CDMX offset is a fixed UTC-6", () => {
  assert.equal(CDMX_OFFSET_SECONDS, -6 * 3600);
  const p = cdmxParts(JUL12_1400);
  assert.equal(p.hour, 14);
  assert.equal(p.day, 12);
  // round-trip
  assert.equal(cdmxToEpoch(p.year, p.month, p.day, p.hour, 0, 0), JUL12_1400);
});

test("cdmxIso emits fixed -06:00 offset", () => {
  assert.equal(cdmxIso("2026-07-12", "18:30"), "2026-07-12T18:30:00-06:00");
});

test("cdmxDateStr / cdmxMonthStr", () => {
  assert.equal(cdmxDateStr(JUL12_1400), "2026-07-12");
  assert.equal(cdmxMonthStr(JUL12_1400), "2026-07");
  // 23:30 UTC on the 12th is still 17:30 CDMX same day
  const late = cdmxToEpoch(2026, 7, 12, 23, 30, 0);
  assert.equal(cdmxDateStr(late), "2026-07-12");
});

test("clampToWindow: before 09:00 pushes to 09:00 same day", () => {
  const early = cdmxToEpoch(2026, 7, 12, 6, 0, 0); // 6am CDMX
  assert.equal(clampToWindow(early), cdmxToEpoch(2026, 7, 12, 9, 0, 0));
});

test("clampToWindow: at/after 21:00 pushes to 09:00 next day", () => {
  const night = cdmxToEpoch(2026, 7, 12, 22, 0, 0);
  assert.equal(clampToWindow(night), cdmxToEpoch(2026, 7, 13, 9, 0, 0));
  const exactly9pm = cdmxToEpoch(2026, 7, 12, 21, 0, 0);
  assert.equal(clampToWindow(exactly9pm), cdmxToEpoch(2026, 7, 13, 9, 0, 0));
});

test("clampToWindow: inside window unchanged", () => {
  assert.equal(clampToWindow(JUL12_1400), JUL12_1400);
});

// ---- sequence timing ----

test("computeTrialSequence positions all four steps in-window", () => {
  const trial = cdmxToEpoch(2026, 7, 15, 19, 0, 0); // Wed 7pm CDMX
  const steps = computeTrialSequence(trial);
  const byKind = Object.fromEntries(
    steps.map((s) => [s.note === "attendance_check" ? "attendance" : s.kind, s]),
  );

  // trial_confirm at T+0, but 7pm is in-window so unchanged
  assert.equal(byKind["trial_confirm"].dueAt, trial);
  // day_before 18:00 the previous day (14th)
  assert.equal(byKind["day_before"].dueAt, cdmxToEpoch(2026, 7, 14, 18, 0, 0));
  // same_day −4h == 15:00 CDMX, in-window
  assert.equal(byKind["same_day"].dueAt, cdmxToEpoch(2026, 7, 15, 15, 0, 0));
  // attendance T+3h == 22:00 → clamped to 09:00 next day
  assert.equal(byKind["attendance"].dueAt, cdmxToEpoch(2026, 7, 16, 9, 0, 0));
  assert.equal(byKind["attendance"].kind, "attendance_check");
});

test("computeTrialSequence clamps an early-morning trial confirm", () => {
  const trial = cdmxToEpoch(2026, 7, 15, 7, 0, 0); // 7am class
  const steps = computeTrialSequence(trial);
  const confirm = steps.find((s) => s.kind === "trial_confirm")!;
  assert.equal(confirm.dueAt, cdmxToEpoch(2026, 7, 15, 9, 0, 0)); // clamped to 9am
});

// ---- phone normalization ----

test("normalizeMxPhone shapes to 521 + 10 digits", () => {
  assert.equal(normalizeMxPhone("5512345678"), "5215512345678"); // bare local
  assert.equal(normalizeMxPhone("525512345678"), "5215512345678"); // 52 + 10
  assert.equal(normalizeMxPhone("5215512345678"), "5215512345678"); // already ok
  assert.equal(normalizeMxPhone("+52 55 1234 5678"), "5215512345678"); // punctuation
  assert.equal(normalizeMxPhone("0052 55 1234 5678"), "5215512345678"); // 00 intl prefix
});

// ---- sync cursor logic ----

test("syncBookings skips past/phoneless records, schedules future ones, advances cursor", async () => {
  const scheduled: { kind: string; recordId: unknown }[] = [];
  let cursorWritten: string | null = null;
  const nowEpoch = Math.floor(Date.now() / 1000);
  const futureIso = new Date((nowEpoch + 3 * 86400) * 1000).toISOString();
  const pastIso = new Date((nowEpoch - 86400) * 1000).toISOString();

  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT value FROM kv")) return { first: { value: "2026-07-01T00:00:00Z" } };
    if (sql.startsWith("INSERT INTO kv")) {
      cursorWritten = String(binds[1]);
      return {};
    }
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      scheduled.push({ kind: binds[1] as string, recordId: binds[3] });
      return {};
    }
    if (sql.includes("SELECT * FROM contacts")) return { first: null };
    return {};
  });

  const fakeAirtable = {
    async listRecentBookings() {
      return [
        { id: "recFUT", phone: "5512345678", name: "Ana", trialDateTimeIso: futureIso },
        { id: "recPAST", phone: "5512340000", name: "Beto", trialDateTimeIso: pastIso },
        { id: "recNOPHONE", phone: null, name: "X", trialDateTimeIso: futureIso },
      ];
    },
  };

  const count = await syncBookings(envWith(db), fakeAirtable);
  assert.equal(count, 1); // only the future, phone-bearing record
  assert.ok(scheduled.some((s) => s.kind === "trial_confirm" && s.recordId === "recFUT"));
  assert.ok(!scheduled.some((s) => s.recordId === "recPAST"));
  assert.ok(cursorWritten !== null); // cursor advanced
});

// ---- followup state transitions ----

// Stub the WA HTTP layer so sendText/sendTemplate succeed without real network.
function stubFetchOk(): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { messages: [{ id: `wamid.${Math.random()}` }] };
    },
    async text() {
      return "";
    },
  });
}

function followupRow(over: Partial<Followup>): Followup {
  return {
    id: 1,
    phone: "5215512345678",
    kind: "day_before",
    due_at: 0,
    status: "scheduled",
    airtable_record_id: "recX",
    note: null,
    created_at: 0,
    ...over,
  };
}

test("runDueFollowups: opted-out contact → skipped_optout, no send", async () => {
  stubFetchOk();
  const marks: { id: unknown; status: unknown }[] = [];
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'"))
      return { all: [followupRow({ kind: "day_before" })] };
    if (sql.includes("SELECT * FROM contacts"))
      return { first: { phone: "5215512345678", status: "opted_out", lang: "es", name: "Ana" } };
    if (sql.startsWith("UPDATE followups SET status")) {
      marks.push({ id: binds[0], status: binds[1] });
      return {};
    }
    return {};
  });
  await runDueFollowups(envWith(db), { slack: noopSlack() });
  assert.deepEqual(marks, [{ id: 1, status: "skipped_optout" }]);
});

test("runDueFollowups: no_show_1 with attendance=yes → cancelled (no template)", async () => {
  stubFetchOk();
  const marks: { status: unknown }[] = [];
  const { db } = fakeDb((sql) => {
    if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'"))
      return { all: [followupRow({ kind: "no_show_1" })] };
    if (sql.includes("SELECT * FROM contacts"))
      return { first: { phone: "5215512345678", status: "lead", lang: "es", name: "Ana" } };
    if (sql.includes("SELECT value FROM kv")) return { first: { value: "yes" } };
    if (sql.startsWith("UPDATE followups SET status")) {
      marks.push({ status: "cancelled" });
      return {};
    }
    return {};
  });
  await runDueFollowups(envWith(db), { slack: noopSlack() });
  assert.equal(marks.length, 1);
});

test("runDueFollowups: attendance_check custom → posts Slack card, marks sent", async () => {
  stubFetchOk();
  let posted: { name: string; recordId: string } | null = null;
  let marked: unknown = null;
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'"))
      return { all: [followupRow({ kind: "custom", note: "attendance_check" })] };
    if (sql.includes("SELECT * FROM contacts"))
      return { first: { phone: "5215512345678", status: "lead", lang: "es", name: "Ana" } };
    if (sql.startsWith("UPDATE followups SET status")) {
      marked = binds[1];
      return {};
    }
    return {};
  });
  const slack = {
    ...noopSlack(),
    async postAttendanceCheck(a: { phone: string; name: string; recordId: string }) {
      posted = { name: a.name, recordId: a.recordId };
    },
  };
  await runDueFollowups(envWith(db), { slack });
  assert.deepEqual(posted, { name: "Ana", recordId: "recX" });
  assert.equal(marked, "sent");
});

test("runDueFollowups: send failure re-arms (stays scheduled), gives up after 3", async () => {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: false,
    status: 500,
    async json() {
      return { error: { message: "boom" } };
    },
    async text() {
      return "";
    },
  });
  const noteWrites: string[] = [];
  let cancelled = false;
  const attemptsSeen: number[] = [];
  const makeHandler = (startNote: string | null): Handler => (sql, binds) => {
    if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'"))
      return { all: [followupRow({ kind: "day_before", note: startNote })] };
    if (sql.includes("SELECT * FROM contacts"))
      return { first: { phone: "5215512345678", status: "lead", lang: "es", name: "Ana" } };
    if (sql.startsWith("UPDATE followups SET note")) {
      noteWrites.push(String(binds[1]));
      return {};
    }
    if (sql.startsWith("UPDATE followups SET status")) {
      if (binds[1] === "cancelled") cancelled = true;
      return {};
    }
    return {};
  };

  // attempt 1 (note null → attempts:1), should NOT cancel
  let h = fakeDb(makeHandler(null));
  await runDueFollowups(envWith(h.db), { slack: noopSlack() });
  attemptsSeen.push(1);
  assert.equal(cancelled, false);
  assert.ok(noteWrites.some((n) => n.includes("attempts:1")));

  // attempt 3 (note attempts:2 → bump to 3) should cancel
  cancelled = false;
  h = fakeDb(makeHandler("attempts:2"));
  await runDueFollowups(envWith(h.db), { slack: noopSlack() });
  assert.equal(cancelled, true);
});

// ---- budget report ----

test("runBudgetReport: posts daily note and fires $30 alert once", async () => {
  const notes: string[] = [];
  const kvWrites: string[] = [];
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SUM(cost_usd)")) return { first: { cost: 34.5, days: 120 } };
    if (sql.includes("FROM usage_log WHERE day = ?1"))
      return { first: { cost: 1.2, input: 5000, output: 900 } };
    if (sql.includes("SELECT value FROM kv")) return { first: null }; // no marks yet
    if (sql.startsWith("INSERT INTO kv")) {
      kvWrites.push(String(binds[0]));
      return {};
    }
    return {};
  });
  const slack = {
    ...noopSlack(),
    async postNote(t: string) {
      notes.push(t);
    },
  };
  await runBudgetReport(envWith(db), { slack }, JUL12_1400);
  assert.ok(notes.some((n) => n.includes("a la fecha")));
  assert.ok(notes.some((n) => n.includes("$30")));
  assert.ok(kvWrites.some((k) => k.includes("budget_alert_30:2026-07")));
});

// ---- helpers ----

function noopSlack() {
  return {
    async postNote() {},
    async postAttendanceCheck() {},
  };
}
