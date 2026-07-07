import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeNudgeTimes,
  underNudgeCap,
  recordNudgeSend,
  nudgeCopy,
  armNudges,
  cancelNudges,
  processNudge,
  NUDGE_KINDS,
  NUDGE_CAP,
  NUDGE_CAP_WINDOW_SECONDS,
} from "../src/cron/nudges.js";
import { classifyResult, normalizeResult } from "../src/services/airtable.js";
import { syncBookings } from "../src/cron/followups.js";
import { cdmxParts, cdmxToEpoch, DAY } from "../src/cron/time.js";
import type { Contact, Env } from "../src/types.js";

/** Next 09:00 CDMX strictly after `now` — a deterministic daytime base so the
 *  quiet-aware day-1 plan always yields all three nudges (no quiet shifting). */
function next9amBase(now: number): number {
  const p = cdmxParts(now);
  let base = cdmxToEpoch(p.year, p.month, p.day, 9, 0, 0);
  while (base <= now) base += DAY;
  return base;
}

// ---- tiny scriptable fake D1 (mirrors cron.test.ts) ----

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

function contact(over: Partial<Contact>): Contact {
  return {
    phone: "5215512345678",
    name: null,
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: null,
    campaign_id: null,
    ad_ref: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

// ---- computeNudgeTimes ----

test("computeNudgeTimes returns +1h, +6h, +8h in order", () => {
  const base = 1_000_000;
  const times = computeNudgeTimes(base);
  assert.deepEqual(
    times.map((t) => [t.kind, t.dueAt]),
    [
      ["nudge_1h", base + 3600],
      ["nudge_6h", base + 6 * 3600],
      ["nudge_8h", base + 8 * 3600],
    ],
  );
});

// ---- cap logic ----

test("underNudgeCap: empty kv is under cap", () => {
  assert.equal(underNudgeCap(null, 1000), true);
  assert.equal(underNudgeCap("{}", 1000), true);
  assert.equal(underNudgeCap("garbage-not-json", 1000), true);
});

test("underNudgeCap: at cap within window is NOT under", () => {
  const now = 10_000_000;
  const sends = [now - 10, now - 20, now - 30]; // 3 recent sends == NUDGE_CAP
  const kv = JSON.stringify({ sends });
  assert.equal(underNudgeCap(kv, now), false);
});

test("underNudgeCap: old sends outside 7-day window don't count", () => {
  const now = 10_000_000;
  const old = now - NUDGE_CAP_WINDOW_SECONDS - 100;
  const kv = JSON.stringify({ sends: [old, old, old] });
  assert.equal(underNudgeCap(kv, now), true);
});

test("recordNudgeSend appends and drops stale entries", () => {
  const now = 10_000_000;
  const stale = now - NUDGE_CAP_WINDOW_SECONDS - 5;
  const kv = JSON.stringify({ sends: [stale, now - 100] });
  const next = JSON.parse(recordNudgeSend(kv, now)) as { sends: number[] };
  // stale dropped, previous kept, new appended
  assert.deepEqual(next.sends, [now - 100, now]);
});

test("cap: NUDGE_CAP is 3", () => {
  assert.equal(NUDGE_CAP, 3);
});

// ---- copy ----

test("nudgeCopy: step 3 mentions free trial + adult booking link, personalizes", () => {
  const c = contact({
    name: "María López",
    qualification: JSON.stringify({ name: "María", discipline: "BJJ", audience: "adult" }),
  });
  const s1 = nudgeCopy(c, "nudge_1h");
  const s3 = nudgeCopy(c, "nudge_8h");
  assert.ok(s1.includes("María"));
  assert.ok(s1.includes("BJJ"));
  assert.ok(/gratis/i.test(s3));
  assert.ok(s3.includes("https://mdcondesa.com/clase-prueba-adultos/"));
});

test("nudgeCopy: kids audience → kids link", () => {
  const c = contact({
    qualification: JSON.stringify({ audience: "kid" }),
  });
  assert.ok(nudgeCopy(c, "nudge_8h").includes("https://mdcondesa.com/clase-prueba-ninos/"));
});

test("nudgeCopy: english lead gets english copy", () => {
  const c = contact({ lang: "en", name: "John" });
  const s3 = nudgeCopy(c, "nudge_8h");
  assert.ok(/free trial/i.test(s3));
  assert.ok(s3.includes("John"));
});

// ---- resultado normalization / classification ----

test("normalizeResult strips accents, lowercases, collapses whitespace", () => {
  assert.equal(normalizeResult("No asistió"), "no asistio");
  assert.equal(normalizeResult("  SE   INSCRIBIÓ "), "se inscribio");
  assert.equal(normalizeResult(null), "");
});

test("classifyResult matches all accent/case variants", () => {
  assert.equal(classifyResult("No asistió"), "no_show");
  assert.equal(classifyResult("no asistio"), "no_show");
  assert.equal(classifyResult("NO ASISTIÓ"), "no_show");
  assert.equal(classifyResult("Se inscribió"), "enrolled");
  assert.equal(classifyResult("se inscribio"), "enrolled");
  assert.equal(classifyResult("SE INSCRIBIÓ"), "enrolled");
  assert.equal(classifyResult("Pendiente"), null);
  assert.equal(classifyResult(""), null);
  assert.equal(classifyResult(null), null);
});

// ---- armNudges: cancels then inserts fresh for an eligible lead ----

test("armNudges: lead, no booking, under cap → cancels then schedules 3 nudges", async () => {
  const inserted: { kind: unknown; recordId: unknown }[] = [];
  let cancelledNudges = false;
  // Daytime base so all three nudges land outside quiet hours (deterministic).
  const nowEpoch = next9amBase(Math.floor(Date.now() / 1000));
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM contacts"))
      return {
        first: contact({ last_inbound_at: nowEpoch, status: "lead" }),
      };
    // cancelFollowupsByKinds (re-arm clear)
    if (sql.startsWith("UPDATE followups SET status") && sql.includes("kind IN")) {
      cancelledNudges = true;
      return {};
    }
    // hasScheduledFollowupOfKind (booking check) → none
    if (sql.includes("SELECT 1 AS n FROM followups")) return { first: null };
    // kv cap read → empty
    if (sql.includes("SELECT value FROM kv")) return { first: null };
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      inserted.push({ kind: binds[1], recordId: binds[3] });
      return {};
    }
    return {};
  });

  await armNudges(envWith(db), "5215512345678");
  assert.equal(cancelledNudges, true);
  assert.deepEqual(
    inserted.map((i) => i.kind),
    [...NUDGE_KINDS],
  );
  // record id is '' for nudges (dedupe key)
  assert.ok(inserted.every((i) => i.recordId === ""));
});

test("armNudges: contact with active booking → clears nudges, schedules nothing", async () => {
  const inserted: unknown[] = [];
  const nowEpoch = Math.floor(Date.now() / 1000);
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ last_inbound_at: nowEpoch, status: "lead" }) };
    if (sql.includes("SELECT 1 AS n FROM followups")) return { first: { n: 1 } }; // booking exists
    if (sql.includes("SELECT value FROM kv")) return { first: null };
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      inserted.push(binds);
      return {};
    }
    return {};
  });
  await armNudges(envWith(db), "5215512345678");
  assert.equal(inserted.length, 0);
});

test("armNudges: student status → no schedule", async () => {
  const inserted: unknown[] = [];
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ status: "student" }) };
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      inserted.push(binds);
      return {};
    }
    return {};
  });
  await armNudges(envWith(db), "5215512345678");
  assert.equal(inserted.length, 0);
});

test("armNudges: over cap → no schedule", async () => {
  const inserted: unknown[] = [];
  const nowEpoch = Math.floor(Date.now() / 1000);
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ last_inbound_at: nowEpoch, status: "lead" }) };
    if (sql.includes("SELECT 1 AS n FROM followups")) return { first: null };
    if (sql.includes("SELECT value FROM kv"))
      return { first: { value: JSON.stringify({ sends: [nowEpoch, nowEpoch, nowEpoch] }) } };
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      inserted.push(binds);
      return {};
    }
    return {};
  });
  await armNudges(envWith(db), "5215512345678");
  assert.equal(inserted.length, 0);
});

test("cancelNudges: issues a kind-scoped cancel UPDATE", async () => {
  let sawKindCancel = false;
  const { db } = fakeDb((sql) => {
    if (sql.startsWith("UPDATE followups SET status") && sql.includes("kind IN")) {
      sawKindCancel = true;
    }
    return {};
  });
  await cancelNudges(envWith(db), "5215512345678");
  assert.equal(sawKindCancel, true);
});

// ---- processNudge (send-time re-verify) ----

test("processNudge: eligible lead → sends and records cap, returns sent", async () => {
  stubFetchOk();
  let kvWrote = false;
  const nowEpoch = Math.floor(Date.now() / 1000);
  const { db } = fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ status: "lead", last_inbound_at: nowEpoch }) };
    if (sql.includes("SELECT 1 AS n FROM followups")) return { first: null }; // no booking
    if (sql.includes("SELECT value FROM kv")) return { first: null };
    if (sql.startsWith("INSERT INTO kv")) {
      kvWrote = true;
      return {};
    }
    return {};
  });
  const res = await processNudge(envWith(db), "5215512345678", "nudge_1h", {
    sendText: async () => "wamid.1",
    isWindowClosed: () => false,
  });
  assert.equal(res, "sent");
  assert.equal(kvWrote, true);
});

test("processNudge: booking appeared before send → cancelled, no send", async () => {
  let sent = false;
  const { db } = fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ status: "lead", last_inbound_at: 1 }) };
    if (sql.includes("SELECT 1 AS n FROM followups")) return { first: { n: 1 } }; // booking now exists
    if (sql.includes("SELECT value FROM kv")) return { first: null };
    return {};
  });
  const res = await processNudge(envWith(db), "5215512345678", "nudge_6h", {
    sendText: async () => {
      sent = true;
      return "wamid";
    },
    isWindowClosed: () => false,
  });
  assert.equal(res, "cancelled");
  assert.equal(sent, false);
});

test("processNudge: opted-out → skipped_optout", async () => {
  const { db } = fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ status: "opted_out" }) };
    return {};
  });
  const res = await processNudge(envWith(db), "5215512345678", "nudge_8h", {
    sendText: async () => "x",
    isWindowClosed: () => false,
  });
  assert.equal(res, "skipped_optout");
});

// ---- F2/F4: syncBookings result watcher + nudge cancel-on-booking ----

test("syncBookings: future booking cancels nudge_* rows", async () => {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const futureIso = new Date((nowEpoch + 3 * 86400) * 1000).toISOString();
  let nudgeCancelForBooking = false;
  const { db } = fakeDb((sql) => {
    if (sql.includes("SELECT value FROM kv")) return { first: { value: "2026-01-01T00:00:00Z" } };
    if (sql.startsWith("UPDATE followups SET status") && sql.includes("kind IN"))
      nudgeCancelForBooking = true;
    if (sql.includes("SELECT * FROM contacts")) return { first: null };
    return {};
  });
  const fakeAirtable = {
    async listRecentBookings() {
      return [
        { id: "recX", phone: "5512345678", name: "Ana", trialDateTimeIso: futureIso, result: null },
      ];
    },
  };
  const count = await syncBookings(envWith(db), fakeAirtable);
  assert.equal(count, 1);
  assert.equal(nudgeCancelForBooking, true);
});

test("syncBookings: 'No asistió' result → cancels all followups, sends reschedule, marks kv once", async () => {
  stubFetchOk();
  let cancelledAll = false;
  let kvMark: string | null = null;
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT value FROM kv")) {
      if (String(binds[0]).startsWith("resultado:")) return { first: null }; // not acted yet
      return { first: { value: "2026-01-01T00:00:00Z" } };
    }
    if (sql.startsWith("UPDATE followups SET status") && !sql.includes("kind IN"))
      cancelledAll = true; // cancelFollowups (all kinds)
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ status: "lead", last_inbound_at: Math.floor(Date.now() / 1000) }) };
    if (sql.startsWith("INSERT INTO kv")) {
      if (String(binds[0]).startsWith("resultado:")) kvMark = String(binds[1]);
      return {};
    }
    return {};
  });
  const fakeAirtable = {
    async listRecentBookings() {
      return [
        { id: "recNS", phone: "5512345678", name: "Ana", trialDateTimeIso: null, result: "No asistió" },
      ];
    },
  };
  await syncBookings(envWith(db), fakeAirtable);
  assert.equal(cancelledAll, true);
  assert.equal(kvMark, "no_show");
});

test("syncBookings: 'Se inscribió' result → sets student, marks kv enrolled", async () => {
  stubFetchOk();
  let setStudent = false;
  let kvMark: string | null = null;
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT value FROM kv")) {
      if (String(binds[0]).startsWith("resultado:")) return { first: null };
      return { first: { value: "2026-01-01T00:00:00Z" } };
    }
    if (sql.startsWith("UPDATE contacts SET status") && binds[1] === "student") setStudent = true;
    if (sql.includes("SELECT * FROM contacts"))
      return { first: contact({ status: "lead", last_inbound_at: Math.floor(Date.now() / 1000) }) };
    if (sql.startsWith("INSERT INTO kv")) {
      if (String(binds[0]).startsWith("resultado:")) kvMark = String(binds[1]);
      return {};
    }
    return {};
  });
  const fakeAirtable = {
    async listRecentBookings() {
      return [
        { id: "recEN", phone: "5512345678", name: "Ana", trialDateTimeIso: null, result: "Se inscribió" },
      ];
    },
  };
  await syncBookings(envWith(db), fakeAirtable);
  assert.equal(setStudent, true);
  assert.equal(kvMark, "enrolled");
});

test("syncBookings: result already acted (kv marker matches) → no re-send", async () => {
  let sent = false;
  (globalThis as { fetch: unknown }).fetch = async () => {
    sent = true;
    return { ok: true, status: 200, async json() { return { messages: [{ id: "w" }] }; }, async text() { return ""; } };
  };
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT value FROM kv")) {
      if (String(binds[0]).startsWith("resultado:")) return { first: { value: "no_show" } };
      return { first: { value: "2026-01-01T00:00:00Z" } };
    }
    if (sql.includes("SELECT * FROM contacts")) return { first: contact({}) };
    return {};
  });
  const fakeAirtable = {
    async listRecentBookings() {
      return [
        { id: "recNS", phone: "5512345678", name: "Ana", trialDateTimeIso: null, result: "no asistio" },
      ];
    },
  };
  await syncBookings(envWith(db), fakeAirtable);
  assert.equal(sent, false);
});
