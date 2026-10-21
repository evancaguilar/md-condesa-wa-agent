// Fixes for the recurring defects the nightly Opus audits (2026-10-07 … 10-21)
// kept reporting. One file so the regression pins for that review live
// together; each block names the audit finding it pins.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  armNudges,
  bandSlot,
  BOOKING_KINDS,
  bookingMarkerLive,
  copyInputsForBand,
  gateNudge,
  gateOnStaffReply,
  hasBookingHistory,
  PAST_BOOKING_KINDS,
  processNudge,
  STAFF_REPLY_GUARD_SECONDS,
} from "../src/cron/nudges.js";
import { POST_TRIAL_ALL_KINDS } from "../src/cron/post-trial.js";
import {
  classifyProgram,
  disciplineFromCampaign,
  isKidsCampaign,
  nudgeCopy,
} from "../src/cron/nudge-copy.js";
import { runDueFollowups } from "../src/cron/followups.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { Contact, Env } from "../src/types.js";

// ---- tiny scriptable fake D1 (mirrors nudges.test.ts) ----

type Handler = (sql: string, binds: unknown[]) => { first?: unknown; all?: unknown[]; changes?: number };

function fakeDb(handler: Handler): { db: D1Database; calls: { sql: string; binds: unknown[] }[] } {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
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
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { db: { prepare: make } as unknown as D1Database, calls };
}

function contact(over: Partial<Contact> = {}): Contact {
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
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const q = (o: Record<string, unknown>): Contact => contact({ qualification: JSON.stringify(o) });

// Mon 2026-08-24 10:00 CDMX.
const MON10 = cdmxToEpoch(2026, 8, 24, 10, 0, 0);

// ---- 2. nudge discipline falls back to the campaign ----

test("disciplineFromCampaign: one named discipline, else null", () => {
  assert.equal(disciplineFromCampaign("fw mma"), "mma");
  assert.equal(disciplineFromCampaign("Muay Thai octubre"), "muay");
  assert.equal(disciplineFromCampaign("BJJ adultos"), "jiu");
  assert.equal(disciplineFromCampaign("Box sábado"), "box");
  assert.equal(disciplineFromCampaign("MMA y Jiu-Jitsu"), null, "two disciplines ⇒ no guess");
  assert.equal(disciplineFromCampaign("Kids septiembre"), null);
  assert.equal(disciplineFromCampaign("Baby Fight Club"), null, "baby is a band, not a discipline pick");
  assert.equal(disciplineFromCampaign("Reto 8 semanas"), null);
  assert.equal(disciplineFromCampaign(null), null);
  assert.equal(disciplineFromCampaign(""), null);
});

test("an MMA-campaign lead with no stated discipline is offered MMA, not Jiu-Jitsu 6 pm", () => {
  const lead = q({ audience: "adult" });
  // Without a campaign: the soonest adult class (Mon 18:00 Jiu-Jitsu/Muay Thai).
  const plain = bandSlot(lead, null, "adults", MON10);
  assert.equal(plain?.time, "18:00");
  // From «fw mma»: Monday's MMA is 9 am (past the lead time) → 8 pm.
  const mma = bandSlot(lead, "fw mma", "adults", MON10);
  assert.equal(mma?.discipline, "mma");
  assert.equal(mma?.time, "20:00");
  const body = nudgeCopy(lead, "nudge_1h", "fw mma", MON10);
  assert.match(body, /lugar en MMA hoy a las 8:00 pm/);
  assert.doesNotMatch(body, /Jiu-Jitsu/);
  // The lead's OWN discipline still wins over the campaign's.
  const own = bandSlot(q({ audience: "adult", discipline: "muay" }), "fw mma", "adults", MON10);
  assert.equal(own?.discipline, "muay");
});

test("an adult Jiu-Jitsu lead never reads the Kids copy", () => {
  // A mixed campaign says nothing about who is writing.
  assert.equal(isKidsCampaign("Jiu-Jitsu niños y adultos"), false);
  assert.equal(isKidsCampaign("Kids septiembre"), true);
  assert.equal(classifyProgram(q({ discipline: "jiu" }), "Jiu-Jitsu niños y adultos"), "adults");
  // A stated adult audience beats a kids campaign.
  assert.equal(classifyProgram(q({ discipline: "jiu", audience: "adult" }), "Kids septiembre"), "adults");
  const body = nudgeCopy(q({ discipline: "jiu" }), "nudge_1h", "Jiu-Jitsu niños y adultos", MON10);
  assert.doesNotMatch(body, /peque|Kids/);
  assert.match(body, /Jiu-Jitsu/);
  // copyInputsForBand keeps a mixed campaign for an adult (utm + discipline).
  assert.equal(copyInputsForBand(q({}), "Jiu-Jitsu niños y adultos", "adults").campaignName, "Jiu-Jitsu niños y adultos");
  assert.equal(copyInputsForBand(q({}), "Kids septiembre", "adults").campaignName, null);
});

// ---- 3. a staff reply defers the automatic nudge ----

test("gateOnStaffReply / gateNudge: a staff message < 60 min old holds the nudge back", () => {
  const now = 1_000_000;
  assert.deepEqual(gateOnStaffReply(null, now), { send: true });
  assert.deepEqual(gateOnStaffReply(now - 10 * 60, now), { send: false, retryAt: now + 50 * 60 });
  assert.deepEqual(gateOnStaffReply(now - STAFF_REPLY_GUARD_SECONDS, now), { send: true });
  // Both guards: the later retry wins.
  const botQ = { body: "¿Te late mañana?", ts: now - 30 * 60 }; // lifts at +90 min
  assert.deepEqual(gateNudge(botQ, now - 50 * 60, now), { send: false, retryAt: now + 90 * 60 });
  assert.deepEqual(gateNudge(null, now - 50 * 60, now), { send: false, retryAt: now + 10 * 60 });
  assert.deepEqual(gateNudge({ body: "Listo.", ts: now - 60 }, null, now), { send: true });
});

test("runDueFollowups: a due nudge right after a staff reply is rescheduled, never sent", async () => {
  // Wed 2026-10-21 12:00 CDMX — daytime, so quiet hours don't interfere.
  const now = cdmxToEpoch(2026, 10, 21, 12, 0, 0);
  const realNow = Date.now;
  Date.now = () => now * 1000;
  try {
    let rescheduledTo: unknown = null;
    let sent = false;
    (globalThis as { fetch: unknown }).fetch = async () => {
      sent = true;
      throw new Error("no network in tests");
    };
    const { db } = fakeDb((sql, binds) => {
      if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'")) {
        return {
          all: [{ id: 7, phone: "5215512345678", kind: "nudge_1h", due_at: now - 60, status: "scheduled", airtable_record_id: "", note: null, created_at: now - 3600 }],
        };
      }
      if (sql.includes("SELECT * FROM contacts")) return { first: contact({ last_inbound_at: now - 3600 }) };
      if (sql.includes("direction IN ('out_human', 'out_human_echo')")) return { first: { ts: now - 10 * 60 } };
      if (sql.includes("direction = 'out_bot'")) return { first: { body: "Claro, te explico.", ts: now - 70 * 60 } };
      if (sql.startsWith("UPDATE followups SET due_at")) {
        rescheduledTo = binds[1];
        return {};
      }
      return {};
    });
    await runDueFollowups({ DB: db } as unknown as Env, { slack: { async postNote() {}, async postAttendanceCheck() {} } });
    assert.equal(rescheduledTo, now + 50 * 60);
    assert.equal(sent, false);
  } finally {
    Date.now = realNow;
  }
});

// ---- 4. no "todavía no has agendado" once the lead has booked, ever ----

test("PAST_BOOKING_KINDS covers the reminders and both post-trial chains", () => {
  const set = new Set<string>(PAST_BOOKING_KINDS);
  for (const k of [...BOOKING_KINDS, ...POST_TRIAL_ALL_KINDS]) assert.ok(set.has(k), k);
  assert.ok(!set.has("nudge_1h"));
});

test("hasBookingHistory: a marker of ANY age, or any booking-kind row", () => {
  assert.equal(hasBookingHistory(null, false), false);
  assert.equal(hasBookingHistory(null, true), true);
  // A class long gone still counts (bookingMarkerLive would say false).
  const past = JSON.stringify({ ts: 1_700_000_000, trialDate: "2026-10-01", trialTime: "18:00" });
  assert.equal(hasBookingHistory(past, false), true);
  assert.equal(bookingMarkerLive(past, cdmxToEpoch(2026, 10, 21, 12, 0, 0)), false);
  assert.equal(hasBookingHistory("1700000000", false), true); // legacy bare epoch
  assert.equal(hasBookingHistory("garbage", false), false);
});

/** A nudge-eligible lead whose ONLY booking signal is `signal`. */
function historyDb(signal: "marker" | "row" | "none" | "probe_fails", sink: { inserted: number }) {
  return fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts")) return { first: contact({ last_inbound_at: Math.floor(Date.now() / 1000) }) };
    if (sql.includes("SELECT 1 AS n FROM followups") && sql.includes("status = 'scheduled'")) return { first: null };
    if (sql.includes("SELECT 1 AS n FROM followups")) {
      if (signal === "probe_fails") throw new Error("D1 overloaded");
      return { first: signal === "row" ? { n: 1 } : null };
    }
    if (sql.includes("SELECT value FROM kv") && signal === "marker") {
      return { first: { value: JSON.stringify({ ts: 1_700_000_000, trialDate: "2026-10-01", trialTime: "18:00" }) } };
    }
    if (sql.includes("SELECT value FROM kv")) return { first: null };
    if (sql.includes("INSERT OR IGNORE INTO followups")) sink.inserted++;
    return {};
  });
}

test("armNudges: a past trial (old marker or an old reminder row) arms nothing; fails soft on a probe error", async () => {
  for (const [signal, want] of [["marker", 0], ["row", 0], ["none", 2], ["probe_fails", 2]] as const) {
    const sink = { inserted: 0 };
    const { db } = historyDb(signal, sink);
    await armNudges({ DB: db } as unknown as Env, "5215512345678");
    // Day-1 plan may drop a step at night; what matters is none vs some.
    assert.equal(sink.inserted > 0, want > 0, signal);
  }
});

test("processNudge: a lead whose trial already passed is never told 'todavía no has agendado'", async () => {
  for (const signal of ["marker", "row"] as const) {
    let sent = false;
    const { db } = historyDb(signal, { inserted: 0 });
    const res = await processNudge({ DB: db } as unknown as Env, "5215512345678", "nudge_1h", {
      sendText: async () => {
        sent = true;
        return "wamid";
      },
      isWindowClosed: () => false,
    });
    assert.equal(res, "cancelled", signal);
    assert.equal(sent, false, signal);
  }
});
