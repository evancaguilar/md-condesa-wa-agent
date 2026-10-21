// One booking confirmation (+ video) per phone + trial slot (2026-10-21).
// Reproduces the duplicate confirmations the nightly auditor reported on
// 10-13/15/18/21 (last-4 only): …6562 / …0711 / …8321 (two overlapping book
// turns), …2064 (a parallel non-book turn restating the booking) and …9313
// (syncBookings armed trial_confirm on a brain-made record).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookingConfirmKey,
  bookingSlot,
  claimBookingConfirmation,
  CONFIRM_DEDUPE_WINDOW_SECONDS,
  isStaleBookingRestatement,
  lastConfirmationAt,
  normalizeSlotTime,
  releaseBookingConfirmation,
  slotFromEpoch,
  slotFromIso,
} from "../src/services/confirm-once.js";
import { runDueFollowups } from "../src/cron/followups.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { BookingRecord } from "../src/services/airtable.js";
import type { Env, Followup } from "../src/types.js";

// ---- an in-memory kv that honors the real claim SQL ------------------------

interface World {
  kv: Map<string, string>;
  followups: Followup[];
  marks: { id: unknown; status: unknown }[];
  contact: Record<string, unknown> | null;
}

function memDb(w: World): D1Database {
  const make = (sql: string): D1PreparedStatement => {
    let b: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        b = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("SELECT value FROM kv")) {
          const v = w.kv.get(String(b[0]));
          return v === undefined ? null : ({ value: v } as T);
        }
        if (sql.includes("FROM contacts")) return (w.contact as T) ?? null;
        return null;
      },
      async run() {
        let changes = 1;
        const key = String(b[0]);
        if (/ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value\s+WHERE/.test(sql)) {
          // kvClaimIfAbsentOrOlder(key, now, minAge)
          const cur = w.kv.get(key);
          const now = Number(b[1]);
          if (cur === undefined || Number(cur) <= now - Number(b[2])) w.kv.set(key, String(now));
          else changes = 0;
        } else if (sql.includes("INSERT OR IGNORE INTO kv")) {
          if (w.kv.has(key)) changes = 0;
          else w.kv.set(key, String(b[1]));
        } else if (sql.includes("INSERT INTO kv")) {
          w.kv.set(key, String(b[1]));
        } else if (sql.includes("DELETE FROM kv")) {
          w.kv.delete(key);
        } else if (sql.startsWith("UPDATE followups SET status")) {
          w.marks.push({ id: b[0], status: b[1] });
        }
        return { results: [], meta: { changes } };
      },
      async all<T>() {
        if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'")) {
          return { results: w.followups as T[], meta: {} };
        }
        return { results: [] as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { prepare: make } as unknown as D1Database;
}

function world(over: Partial<World> = {}): World {
  return { kv: new Map(), followups: [], marks: [], contact: null, ...over };
}

const PHONE = "5215512349313";
const T0 = 1_792_269_959; // 2026-10-17 20:45:59 UTC — …9313's first confirmation

// ---- slot keys agree across every path -------------------------------------

test("slot: brain (date + HH:mm), booking marker, and Airtable ISO all key the same class", () => {
  assert.equal(bookingSlot("2026-10-21", "13:00"), "2026-10-21T13:00");
  assert.equal(bookingSlot("2026-10-21", "9:00"), "2026-10-21T09:00");
  assert.equal(bookingSlot("2026-10-21", "1 pm"), "2026-10-21T13:00");
  assert.equal(slotFromIso("2026-10-21T13:00:00-06:00"), "2026-10-21T13:00");
  assert.equal(slotFromIso("2026-10-21T19:00:00.000Z"), "2026-10-21T13:00");
  assert.equal(slotFromEpoch(cdmxToEpoch(2026, 10, 21, 13, 0, 0)), "2026-10-21T13:00");
  // unreadable halves → no key (the guard then never blocks)
  assert.equal(bookingSlot("", "13:00"), null);
  assert.equal(bookingSlot("2026-10-21", "a las 9"), null);
  assert.equal(slotFromIso("not a date"), null);
  assert.equal(normalizeSlotTime("12 am"), "00:00");
  assert.equal(normalizeSlotTime("12:30 p.m."), "12:30");
  assert.equal(normalizeSlotTime("9"), null);
});

// ---- the claim itself --------------------------------------------------------

test("claim: first wins, a parallel second loses, the window reopens; other slots unaffected", async () => {
  const w = world();
  const db = memDb(w);
  const slot = "2026-10-21T13:00";
  assert.equal(await claimBookingConfirmation(db, PHONE, slot, T0), true);
  assert.equal(await claimBookingConfirmation(db, PHONE, slot, T0 + 5), false, "overlapping turn");
  assert.equal(await claimBookingConfirmation(db, PHONE, slot, T0 + 291), false, "trial_confirm 5 min later");
  assert.equal(await claimBookingConfirmation(db, PHONE, "2026-10-23T08:00", T0 + 10), true, "a rebook to another slot");
  assert.equal(await claimBookingConfirmation(db, "5215500000000", slot, T0 + 10), true, "another phone");
  assert.equal(
    await claimBookingConfirmation(db, PHONE, slot, T0 + CONFIRM_DEDUPE_WINDOW_SECONDS),
    true,
    "a re-booking of the same class hours later confirms again",
  );
  assert.equal(await lastConfirmationAt(db, PHONE), T0 + CONFIRM_DEDUPE_WINDOW_SECONDS);
});

test("claim: release gives it back (send failed / became a draft); null slot always wins", async () => {
  const w = world();
  const db = memDb(w);
  const slot = "2026-10-21T13:00";
  assert.equal(await claimBookingConfirmation(db, PHONE, slot, T0), true);
  await releaseBookingConfirmation(db, PHONE, slot);
  assert.equal(w.kv.has(bookingConfirmKey(PHONE, slot)), false);
  assert.equal(await claimBookingConfirmation(db, PHONE, slot, T0 + 3), true);
  assert.equal(await claimBookingConfirmation(db, PHONE, null, T0 + 4), true);
  assert.equal(await claimBookingConfirmation(db, PHONE, null, T0 + 5), true);
});

test("claim: a D1 failure fails OPEN — never a lead without a confirmation", async () => {
  const broken = {
    prepare() {
      throw new Error("D1_ERROR: overloaded");
    },
  } as unknown as D1Database;
  assert.equal(await claimBookingConfirmation(broken, PHONE, "2026-10-21T13:00", T0), true);
  assert.equal(await lastConfirmationAt(broken, PHONE), null);
});

// ---- race 1: two overlapping brain turns ------------------------------------

test("race 1 (…8321, 10-14): two overlapping book turns → exactly ONE confirmation + video", async () => {
  // Name at 18:14:43, child's name at 18:14:53: both turns pass the 8 s
  // debounce, both book Saturday 2 pm, both reach routeResult's direct send.
  const w = world();
  const db = memDb(w);
  const sent: string[] = [];
  const turn = async (at: number, text: string) => {
    const slot = bookingSlot("2026-10-17", "14:00"); // what each turn's book result carries
    if (!(await claimBookingConfirmation(db, PHONE, slot, at))) return; // routeResult: suppressed
    sent.push(text, "video");
  };
  await Promise.all([turn(T0, "¡Perfecto José! Ya quedó agendado…"), turn(T0 + 7, "¡Perfecto José! Ya quedó agendado…")]);
  assert.deepEqual(sent, ["¡Perfecto José! Ya quedó agendado…", "video"]);
});

test("race 1, non-book variant (…2064, 10-20): a restatement written before the confirmation landed is dropped", () => {
  // Turn A (book) claimed at 18:09:30; turn B read its history at 18:09:27
  // and wrote "Ya tienes tu lugar, Beto! Nos vemos el viernes a las 8 am…".
  const confirmAt = cdmxToEpoch(2026, 10, 20, 12, 9, 30);
  const restated = "Ya tienes tu lugar, Beto! 🙌 Nos vemos el viernes a las 8 am para tu primera clase de Jiu-Jitsu. Cualquier duda, aquí estoy 🙏";
  assert.equal(isStaleBookingRestatement({ text: restated, turnStartedAt: confirmAt - 3, lastConfirmAt: confirmAt }), true);
  // …but a turn that started well AFTER the confirmation saw it in its history.
  assert.equal(isStaleBookingRestatement({ text: restated, turnStartedAt: confirmAt + 20, lastConfirmAt: confirmAt }), false);
  // …and a parallel reply that answers something else is never dropped.
  assert.equal(
    isStaleBookingRestatement({
      text: "Trae ropa deportiva cómoda y agua 💧 Estamos en Av. México 49, arriba de Santas Conchas.",
      turnStartedAt: confirmAt - 3,
      lastConfirmAt: confirmAt,
    }),
    false,
  );
  // No confirmation on record → nothing to compare against.
  assert.equal(isStaleBookingRestatement({ text: restated, turnStartedAt: confirmAt, lastConfirmAt: null }), false);
});

// ---- race 2: syncBookings armed trial_confirm on a brain-made record --------

const REC = "recBrain9313";
const TRIAL_ISO = "2026-10-21T13:00:00-06:00"; // miércoles 1 pm BFC

function trialConfirmRow(): Followup {
  return {
    id: 7,
    phone: PHONE,
    kind: "trial_confirm",
    due_at: 0,
    status: "scheduled",
    airtable_record_id: REC,
    note: null,
    created_at: 0,
  } as Followup;
}

function graphCalls(): { urls: string[] } {
  const log = { urls: [] as string[] };
  (globalThis as { fetch: unknown }).fetch = async (url: unknown) => {
    log.urls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return { messages: [{ id: `wamid.${Math.random()}` }] };
      },
      async text() {
        return "";
      },
    };
  };
  return log;
}

const env = (db: D1Database): Env => ({ DB: db, AIRTABLE_BASE_ID: "appT", AIRTABLE_TRIALS_TABLE: "Trials" }) as unknown as Env;
const record = async (): Promise<BookingRecord> => ({ id: REC, phone: PHONE, trialDateTimeIso: TRIAL_ISO }) as BookingRecord;
const slack = { async postNote() {}, async postAttendanceCheck() {} };

test("race 2 (…9313, 10-17): the brain already confirmed this slot → trial_confirm is cancelled, nothing sent", async () => {
  const w = world({ followups: [trialConfirmRow()], contact: { phone: PHONE, status: "lead", lang: "es", name: "Karina" } });
  const db = memDb(w);
  // 20:45:59 — routeResult's direct send claimed the slot.
  assert.equal(await claimBookingConfirmation(db, PHONE, bookingSlot("2026-10-21", "13:00"), Math.floor(Date.now() / 1000) - 291), true);
  const graph = graphCalls();
  await runDueFollowups(env(db), { slack, getRecord: record });
  assert.deepEqual(w.marks, [{ id: 7, status: "cancelled" }]);
  assert.deepEqual(graph.urls.filter((u) => u.includes("graph.facebook.com")), [], "no WhatsApp send");
});

test("race 2, reverse order: a web-form trial_confirm that went first makes a later chat claim of the slot lose", async () => {
  const w = world({
    followups: [trialConfirmRow()],
    contact: { phone: PHONE, status: "lead", lang: "es", name: "Karina", last_inbound_at: Math.floor(Date.now() / 1000) },
  });
  const db = memDb(w);
  const graph = graphCalls();
  await runDueFollowups(env(db), { slack, getRecord: record });
  assert.deepEqual(w.marks, [{ id: 7, status: "sent" }]);
  assert.ok(graph.urls.some((u) => u.includes("graph.facebook.com")), "the web-form booker DID get the confirmation");
  assert.equal(
    await claimBookingConfirmation(db, PHONE, bookingSlot("2026-10-21", "13:00"), Math.floor(Date.now() / 1000) + 30),
    false,
  );
});
