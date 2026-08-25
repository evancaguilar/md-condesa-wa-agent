import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bookingFailureCountKey,
  bookingFailureNoteKey,
  makeBookingFailureNotifier,
  type BookingAlertDeps,
} from "../src/services/booking-alerts.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { BookingFailureEvent, Env } from "../src/types.js";

// ---- kv-backed fake D1 (fakeDb idiom from staff-send.test.ts, but stateful so
// the real kvGet/kvSet/kvSetIfAbsent helpers exercise actual throttling) ----

function kvDb(): { db: D1Database; store: Map<string, string> } {
  const store = new Map<string, string>();
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("SELECT value FROM kv")) {
          const v = store.get(String(binds[0]));
          return (v === undefined ? null : ({ value: v } as unknown as T));
        }
        return null;
      },
      async run() {
        const key = String(binds[0]);
        const value = String(binds[1]);
        let changes = 0;
        if (sql.includes("INSERT OR IGNORE INTO kv")) {
          if (!store.has(key)) {
            store.set(key, value);
            changes = 1;
          }
        } else if (sql.includes("INSERT INTO kv")) {
          store.set(key, value);
          changes = 1;
        }
        return { results: [], meta: { changes } };
      },
      async all<T>() {
        return { results: [] as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, store };
}

function envWith(db: D1Database): Env {
  return { DB: db, SLACK_CHANNEL_ID: "C1" } as unknown as Env;
}

/** Stubbed Slack + a fake clock (the notifier keys throttling by CDMX day). */
function stubDeps(nowEpoch: number): {
  deps: BookingAlertDeps;
  notes: string[];
  setNow: (e: number) => void;
} {
  const notes: string[] = [];
  let now = nowEpoch;
  return {
    notes,
    setNow: (e) => {
      now = e;
    },
    deps: {
      async postNote(_env, text) {
        notes.push(text);
      },
      now: () => now,
    },
  };
}

// 2026-08-25 10:00 CDMX and the same hour the next day.
const DAY1 = cdmxToEpoch(2026, 8, 25, 10, 0, 0);
const DAY2 = cdmxToEpoch(2026, 8, 26, 10, 0, 0);
const PHONE = "5215512345678";

function ev(over: Partial<BookingFailureEvent> = {}): BookingFailureEvent {
  return {
    phone: PHONE,
    kind: "invalid_slot",
    reason: "No jiu (adult) class at 06:00 on 2026-08-25. Same-day options: 18:00 CDMX.",
    alternatives: ["18:00", "19:00"],
    requested: {
      name: "Ana",
      discipline: "jiu",
      audience: "adult",
      trialDate: "2026-08-25",
      trialTime: "06:00",
      phone: PHONE,
    },
    ...over,
  };
}

// ---- invalid_slot throttling ----

test("first invalid_slot of the day posts one plain note", async () => {
  const { db, store } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  await makeBookingFailureNotifier(envWith(db), deps)(ev());

  assert.equal(notes.length, 1);
  const note = notes[0]!;
  assert.ok(!note.includes("<!here>"), "first note does not ping the channel");
  assert.ok(note.startsWith("⚠️ Agendado FALLIDO (horario inválido) — Ana · 5215512345678"));
  assert.ok(note.includes("Pidió: jiu · adultos · 2026-08-25 06:00"));
  assert.ok(note.includes("Motivo: No jiu (adult) class at 06:00"));
  assert.ok(note.includes("Opciones ese día: 18:00, 19:00"));
  assert.ok(note.includes("agéndalo a mano en Airtable"));

  assert.equal(store.get(bookingFailureNoteKey(PHONE, "2026-08-25")), "1");
  assert.equal(store.get(bookingFailureCountKey(PHONE, "2026-08-25")), "1");
});

test("second invalid_slot same lead+day escalates once with <!here>", async () => {
  const { db } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  const notify = makeBookingFailureNotifier(envWith(db), deps);

  await notify(ev());
  await notify(ev());

  assert.equal(notes.length, 2);
  assert.ok(notes[1]!.startsWith("<!here> ⚠️ Agendado FALLIDO"));
  assert.ok(notes[1]!.includes("loop"), "escalation explains why it pings");
});

test("third+ invalid_slot the same day is silent (log only)", async () => {
  const { db, store } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  const notify = makeBookingFailureNotifier(envWith(db), deps);

  await notify(ev());
  await notify(ev());
  await notify(ev());
  await notify(ev());

  assert.equal(notes.length, 2, "still just the note + the one escalation");
  assert.equal(store.get(bookingFailureCountKey(PHONE, "2026-08-25")), "4");
});

test("a different lead the same day gets its own note", async () => {
  const { db } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  const notify = makeBookingFailureNotifier(envWith(db), deps);

  await notify(ev());
  await notify(ev({ phone: "5215599999999" }));

  assert.equal(notes.length, 2);
  assert.ok(!notes[1]!.includes("<!here>"), "per-lead throttle, not per-channel");
  assert.ok(notes[1]!.includes("5215599999999"));
});

test("the next CDMX day posts a plain note again", async () => {
  const { db } = kvDb();
  const { deps, notes, setNow } = stubDeps(DAY1);
  const notify = makeBookingFailureNotifier(envWith(db), deps);

  await notify(ev());
  await notify(ev()); // escalation, same day
  setNow(DAY2);
  await notify(ev());

  assert.equal(notes.length, 3);
  assert.ok(!notes[2]!.includes("<!here>"), "new day starts a fresh plain note");
});

test("missing alternatives render as an em dash", async () => {
  const { db } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  await makeBookingFailureNotifier(envWith(db), deps)(
    ev({ alternatives: undefined, reason: "Invalid trial_date 'mañana' (expected YYYY-MM-DD)." }),
  );
  assert.ok(notes[0]!.includes("Opciones ese día: —"));
});

test("kid bookings name the child alongside the contact", async () => {
  const { db } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  await makeBookingFailureNotifier(envWith(db), deps)(
    ev({
      requested: {
        name: "Ana",
        childName: "Emilia",
        discipline: "muay",
        audience: "kid",
        trialDate: "2026-08-25",
        trialTime: "15:00",
        phone: PHONE,
      },
    }),
  );
  assert.ok(notes[0]!.includes("Ana (menor: Emilia) · 5215512345678"));
  assert.ok(notes[0]!.includes("Pidió: muay · niños · 2026-08-25 15:00"));
});

// ---- airtable_error: never throttled ----

test("airtable_error always pings <!here>, every time, untouched by kv", async () => {
  const { db, store } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  const notify = makeBookingFailureNotifier(envWith(db), deps);
  const boom = ev({ kind: "airtable_error", reason: "airtable 422 UNKNOWN_FIELD_NAME" });

  await notify(boom);
  await notify(boom);
  await notify(boom);

  assert.equal(notes.length, 3, "a lost booking is never throttled");
  for (const n of notes) {
    assert.ok(n.startsWith("<!here> 🔴 Airtable RECHAZÓ el agendado — Ana · 5215512345678"));
    assert.ok(n.includes("Error: airtable 422 UNKNOWN_FIELD_NAME"));
    assert.ok(n.includes("la secuencia anti-no-show NO está activa"));
  }
  assert.equal(store.size, 0, "no kv writes on the airtable_error path");
});

test("airtable_error truncates a huge error at 200 chars", async () => {
  const { db } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  await makeBookingFailureNotifier(envWith(db), deps)(
    ev({ kind: "airtable_error", reason: "x".repeat(500) }),
  );
  const line = notes[0]!.split("\n").find((l) => l.startsWith("Error: "))!;
  assert.equal(line, `Error: ${"x".repeat(200)}`);
});

test("an invalid_slot alert does not consume the airtable_error budget", async () => {
  const { db } = kvDb();
  const { deps, notes } = stubDeps(DAY1);
  const notify = makeBookingFailureNotifier(envWith(db), deps);

  await notify(ev());
  await notify(ev());
  await notify(ev());
  await notify(ev({ kind: "airtable_error", reason: "boom" }));

  assert.equal(notes.length, 3);
  assert.ok(notes[2]!.includes("🔴 Airtable RECHAZÓ"));
});
