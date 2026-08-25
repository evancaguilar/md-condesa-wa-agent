import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bookingRecordedKey,
  finalizeBooking,
  parseBookingRecordedMarker,
  planBookingSequences,
  registerBooking,
  type BookingCoreDeps,
} from "../src/services/booking-core.js";
import { validateSlot } from "../src/brain/tools.js";
import type { BookTrialInput, Env } from "../src/types.js";

// ---- fakes (fakeDb idiom from staff-send.test.ts / booking-alerts.test.ts) ---

function fakeDb(): { db: D1Database; calls: { sql: string; binds: unknown[] }[] } {
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
        return null as T | null;
      },
      async run() {
        calls.push({ sql, binds });
        return { results: [], meta: { changes: 1 } };
      },
      async all<T>() {
        calls.push({ sql, binds });
        return { results: [] as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, calls };
}

function envWith(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

interface CoreLog {
  fyi: BookTrialInput[];
  notes: string[];
  sequences: { phone: string; recordId: string; iso: string; opts: unknown }[];
  qualifications: { phone: string; json: string }[];
  syncs: { phone: string; event: string }[];
  booked: BookTrialInput[];
  videos: string[];
  kv: { key: string; value: string }[];
}

const NOW = 1_756_000_000;

function harness(over: Partial<BookingCoreDeps> = {}): {
  deps: BookingCoreDeps;
  log: CoreLog;
  slack: { postBookingFyi(b: BookTrialInput): Promise<void>; postNote(t: string): Promise<void> };
} {
  const log: CoreLog = {
    fyi: [],
    notes: [],
    sequences: [],
    qualifications: [],
    syncs: [],
    booked: [],
    videos: [],
    kv: [],
  };
  const deps: BookingCoreDeps = {
    async scheduleTrialSequence(_env, phone, recordId, iso, opts) {
      log.sequences.push({ phone, recordId, iso, opts });
    },
    async setQualification(_db, phone, json) {
      log.qualifications.push({ phone, json });
    },
    async syncLead(_env, phone, event) {
      log.syncs.push({ phone, event });
    },
    async bookTrial(_env, input) {
      log.booked.push(input);
      return "recHUMAN1";
    },
    validateSlot,
    async sendBookingVideo(_env, phone) {
      log.videos.push(phone);
    },
    async kvSet(_db, key, value) {
      log.kv.push({ key, value });
    },
    now: () => NOW,
    ...over,
  };
  const slack = {
    async postBookingFyi(b: BookTrialInput) {
      log.fyi.push(b);
    },
    async postNote(t: string) {
      log.notes.push(t);
    },
  };
  return { deps, log, slack };
}

const PHONE = "5215512345678";
// Monday 2026-08-24 19:00 is a real adult Jiu-Jitsu slot (brain/slots.gen.ts).
const VALID: BookTrialInput = {
  name: "Ana",
  discipline: "jiu",
  audience: "adult",
  trialDate: "2026-08-24",
  trialTime: "19:00",
  phone: PHONE,
};

// ---- finalizeBooking: the extracted routeResult `book` branch ---------------

test("finalizeBooking: FYI card, sequence (includeConfirm:false), qualification, lead sync", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  await finalizeBooking(
    envWith(db),
    slack,
    { ...VALID, recordId: "recX" },
    deps,
  );

  assert.equal(log.fyi.length, 1);
  assert.deepEqual(log.fyi[0], VALID); // exactly the six card fields
  assert.equal(log.sequences.length, 1);
  assert.equal(log.sequences[0]!.recordId, "recX");
  assert.equal(log.sequences[0]!.iso, "2026-08-24T19:00:00-06:00");
  assert.deepEqual(log.sequences[0]!.opts, { includeConfirm: false });
  assert.equal(log.qualifications.length, 1);
  assert.deepEqual(JSON.parse(log.qualifications[0]!.json), {
    discipline: "jiu",
    audience: "adult",
    name: "Ana",
  });
  assert.deepEqual(log.syncs, [{ phone: PHONE, event: "booking_created" }]);
});

test("finalizeBooking: a Slack failure never throws and skips NOTHING after it", async () => {
  const { db } = fakeDb();
  const { deps, log } = harness();
  const slack = {
    async postBookingFyi() {
      throw new Error("slack down");
    },
    async postNote() {},
  };

  await finalizeBooking(envWith(db), slack, { ...VALID, recordId: "recX" }, deps);

  // The anti-no-show sequence is the step that actually gets people to show up:
  // a Slack outage must never cost the lead their reminders.
  assert.equal(log.sequences.length, 1);
  assert.equal(log.qualifications.length, 1);
  assert.equal(log.syncs.length, 1);
});

test("finalizeBooking: a sequence failure still qualifies and syncs the lead", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness({
    async scheduleTrialSequence() {
      throw new Error("d1 down");
    },
  });

  await finalizeBooking(envWith(db), slack, { ...VALID, recordId: "recX" }, deps);

  assert.equal(log.fyi.length, 1);
  assert.equal(log.qualifications.length, 1);
  assert.deepEqual(log.syncs, [{ phone: PHONE, event: "booking_created" }]);
});

test("finalizeBooking: a qualification failure still runs the lead sync", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness({
    async setQualification() {
      throw new Error("d1 down");
    },
  });

  await finalizeBooking(envWith(db), slack, { ...VALID, recordId: "recX" }, deps);

  assert.equal(log.sequences.length, 1);
  assert.equal(log.syncs.length, 1);
});

test("finalizeBooking: a sync failure is swallowed (isolated try/catch)", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness({
    async syncLead() {
      throw new Error("airtable 500");
    },
  });

  await finalizeBooking(envWith(db), slack, { ...VALID, recordId: "recX" }, deps);

  assert.equal(log.fyi.length, 1);
  assert.equal(log.sequences.length, 1);
});

// ---- group bookings (slice 5) ----------------------------------------------

const REC = "recGROUP";
/** Bookings as the brain emits them: same phone, same Airtable row, one per person. */
function person(name: string, trialDate: string, trialTime: string) {
  return { ...VALID, name, trialDate, trialTime, recordId: REC };
}

test("planBookingSequences: two people, same slot → ONE sequence on the bare id", () => {
  const plans = planBookingSequences([
    person("Ana", "2026-08-24", "19:00"),
    person("Luis", "2026-08-24", "19:00"),
  ]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.sequenceKey, REC);
  assert.equal(plans[0]!.booking.name, "Ana"); // first one wins the slot
});

test("planBookingSequences: two different slots → the 2nd key is suffixed #1", () => {
  const plans = planBookingSequences([
    person("Ana", "2026-08-24", "19:00"),
    person("Luis", "2026-08-25", "19:00"),
  ]);
  assert.deepEqual(
    plans.map((p) => [p.booking.name, p.sequenceKey]),
    [
      ["Ana", REC],
      ["Luis", `${REC}#1`],
    ],
  );
});

test("planBookingSequences: three bookings over two slots → two sequences", () => {
  const plans = planBookingSequences([
    person("Ana", "2026-08-24", "19:00"),
    person("Luis", "2026-08-25", "19:00"),
    person("Sofi", "2026-08-24", "19:00"), // shares Ana's slot
  ]);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.sequenceKey), [REC, `${REC}#1`]);
});

test("planBookingSequences: empty in, empty out", () => {
  assert.deepEqual(planBookingSequences([]), []);
});

test("finalizeBooking: sequenceKey null skips the sequence, keeps the FYI", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  await finalizeBooking(envWith(db), slack, { ...VALID, recordId: REC }, deps, {
    sequenceKey: null,
    skipLeadSync: true,
  });

  assert.equal(log.fyi.length, 1); // every person still gets their own card
  assert.equal(log.sequences.length, 0);
  assert.equal(log.qualifications.length, 0);
  assert.equal(log.syncs.length, 0);
});

test("finalizeBooking: an explicit sequenceKey overrides the record id", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  await finalizeBooking(envWith(db), slack, { ...VALID, recordId: REC }, deps, {
    sequenceKey: `${REC}#1`,
  });

  assert.equal(log.sequences[0]!.recordId, `${REC}#1`);
  assert.equal(log.syncs.length, 1); // lead sync untouched
});

// ---- the booking_recorded marker -------------------------------------------

test("parseBookingRecordedMarker: reads a LEGACY bare-epoch row (no slot)", () => {
  assert.deepEqual(parseBookingRecordedMarker("1756000000"), { ts: 1756000000 });
});

test("parseBookingRecordedMarker: garbage and absence read as null", () => {
  assert.equal(parseBookingRecordedMarker(null), null);
  assert.equal(parseBookingRecordedMarker(""), null);
  assert.equal(parseBookingRecordedMarker("ayer"), null);
  assert.equal(parseBookingRecordedMarker("{no json"), null);
  assert.equal(parseBookingRecordedMarker('{"trialDate":"2026-08-24"}'), null);
});

// ---- registerBooking: the human entry point --------------------------------

test("registerBooking: books, marks booking_recorded, finalizes, sends the video", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  const r = await registerBooking(envWith(db), slack, VALID, undefined, deps);

  assert.deepEqual(r, { ok: true, recordId: "recHUMAN1" });
  assert.equal(log.booked.length, 1);
  // The marker carries the SLOT, so the capture guard can tell a re-confirmation
  // of this class from a promise about a different one.
  assert.equal(log.kv.length, 1);
  assert.equal(log.kv[0]!.key, bookingRecordedKey(PHONE));
  assert.deepEqual(JSON.parse(log.kv[0]!.value), {
    ts: NOW,
    trialDate: "2026-08-24",
    trialTime: "19:00",
  });
  assert.deepEqual(parseBookingRecordedMarker(log.kv[0]!.value), {
    ts: NOW,
    trialDate: "2026-08-24",
    trialTime: "19:00",
  });
  assert.equal(log.sequences.length, 1);
  assert.deepEqual(log.videos, [PHONE]); // sendVideo defaults to TRUE
  assert.equal(log.notes.length, 0); // no `by` ⇒ no attribution note
});

test("registerBooking: `by` adds the attribution note; sendVideo:false skips the video", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  await registerBooking(
    envWith(db),
    slack,
    VALID,
    { by: "fer", sendVideo: false },
    deps,
  );

  assert.equal(log.videos.length, 0);
  assert.equal(log.notes.length, 1);
  assert.ok(log.notes[0]!.includes("fer"));
  assert.ok(log.notes[0]!.includes("recHUMAN1"));
});

test("registerBooking: invalid slot → {ok:false, invalid_slot} with alternatives, no write", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  const r = await registerBooking(
    envWith(db),
    slack,
    { ...VALID, trialTime: "05:00" },
    undefined,
    deps,
  );

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "invalid_slot");
  assert.ok((r.alternatives ?? []).includes("19:00"));
  assert.equal(log.booked.length, 0);
  assert.equal(log.kv.length, 0);
  assert.equal(log.sequences.length, 0);
});

test("registerBooking: force skips validateSlot and books anyway", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  const r = await registerBooking(
    envWith(db),
    slack,
    { ...VALID, trialTime: "05:00" },
    { force: true },
    deps,
  );

  assert.deepEqual(r, { ok: true, recordId: "recHUMAN1" });
  assert.equal(log.booked.length, 1);
  assert.equal(log.booked[0]!.trialTime, "05:00");
  assert.equal(log.sequences.length, 1);
});

test("registerBooking: Airtable throw → {ok:false, airtable_error}, nothing finalized", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness({
    async bookTrial() {
      throw new Error("airtable create failed: Unknown field name");
    },
  });

  const r = await registerBooking(envWith(db), slack, VALID, undefined, deps);

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "airtable_error");
  assert.match(r.detail, /Unknown field name/);
  assert.equal(log.kv.length, 0);
  assert.equal(log.fyi.length, 0);
  assert.equal(log.sequences.length, 0);
  assert.equal(log.videos.length, 0);
});

test("registerBooking: a label discipline is normalized to the service key", async () => {
  const { db } = fakeDb();
  const { deps, log, slack } = harness();

  const r = await registerBooking(
    envWith(db),
    slack,
    { ...VALID, discipline: "Jiu-Jitsu" },
    undefined,
    deps,
  );

  assert.equal(r.ok, true);
  assert.equal(log.booked[0]!.discipline, "jiu");
});
