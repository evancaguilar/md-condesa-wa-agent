import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyBookingCapture,
  auditHumanSend,
  bookingClaimThrottleKey,
  bookingCaptureClaimKey,
  parseCapture,
  parseViewSubmissionTarget,
  skipBookingCapture,
  submitBookingCaptureEdit,
  BOOKING_META_PREFIX,
  BOOKING_MODAL_FIELDS,
  type BookingGuardDeps,
} from "../src/services/booking-guard.js";
import {
  bookingRecordedKey,
  bookingRecordedValue,
} from "../src/services/booking-core.js";
import { validateSlot } from "../src/brain/tools.js";
import { cdmxDateStr, cdmxToEpoch } from "../src/cron/time.js";
import type { BookingCapture } from "../src/services/booking-claims.js";
import type { Contact, Env } from "../src/types.js";

// ---- stateful fake D1 (kv + contacts + followups + messages) ----------------

interface DbState {
  kv: Map<string, string>;
  contact: Partial<Contact> | null;
  /** Backs hasScheduledFollowupOfKind (the dateless path). */
  hasBookingFollowup: boolean;
  /** Backs scheduledFollowupsOfKind (the slot-exact path). */
  followups: { kind: string; due_at: number }[];
  messages: { direction: string; body: string; ts: number }[];
}

function fakeDb(over: Partial<DbState> = {}): {
  db: D1Database;
  state: DbState;
  sqls: string[];
} {
  const state: DbState = {
    kv: new Map(),
    contact: { phone: "5215512345678", name: "Ana", status: "lead" },
    hasBookingFollowup: false,
    followups: [],
    messages: [],
    ...over,
  };
  const sqls: string[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        sqls.push(sql);
        if (sql.includes("SELECT value FROM kv")) {
          const v = state.kv.get(String(binds[0]));
          return v === undefined ? null : ({ value: v } as unknown as T);
        }
        if (sql.includes("FROM contacts")) {
          return (state.contact ?? null) as T | null;
        }
        if (sql.includes("FROM followups")) {
          return (state.hasBookingFollowup ? ({ n: 1 } as unknown as T) : null);
        }
        return null;
      },
      async run() {
        sqls.push(sql);
        const key = String(binds[0]);
        let changes = 0;
        if (sql.includes("INSERT OR IGNORE INTO kv")) {
          if (!state.kv.has(key)) {
            state.kv.set(key, String(binds[1]));
            changes = 1;
          }
        } else if (sql.includes("INSERT INTO kv")) {
          state.kv.set(key, String(binds[1]));
          changes = 1;
        } else if (sql.includes("DELETE FROM kv")) {
          state.kv.delete(key);
          changes = 1;
        } else {
          changes = 1;
        }
        return { results: [], meta: { changes } };
      },
      async all<T>() {
        sqls.push(sql);
        if (sql.includes("FROM messages")) {
          return { results: [...state.messages].reverse() as T[], meta: {} };
        }
        if (sql.includes("FROM followups")) {
          return { results: state.followups as T[], meta: {} };
        }
        return { results: [] as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, state, sqls };
}

function envWith(db: D1Database): Env {
  return { DB: db, ANTHROPIC_API_KEY: "sk-test", SLACK_CHANNEL_ID: "C1" } as unknown as Env;
}

// Monday 2026-08-24 09:00 CDMX.
const NOW = Math.floor(Date.UTC(2026, 7, 24, 15, 0, 0) / 1000);
const PHONE = "5215512345678";

interface GuardLog {
  cards: { key: string; capture: BookingCapture }[];
  updates: { ts: string; headline: string; body: string; buttons: unknown }[];
  notes: string[];
  fyi: unknown[];
  registered: { input: unknown; opts: unknown }[];
  fetches: number;
}

function harness(over: Partial<BookingGuardDeps> = {}): {
  deps: BookingGuardDeps;
  log: GuardLog;
} {
  const log: GuardLog = {
    cards: [],
    updates: [],
    notes: [],
    fyi: [],
    registered: [],
    fetches: 0,
  };
  const deps: BookingGuardDeps = {
    async postCard(_env, key, capture) {
      log.cards.push({ key, capture });
      return "1756.0001";
    },
    async updateCard(_env, ts, headline, body, buttons) {
      log.updates.push({ ts, headline, body, buttons });
    },
    async postNote(_env, text) {
      log.notes.push(text);
    },
    async postBookingFyi(_env, booking) {
      log.fyi.push(booking);
    },
    async registerBooking(_env, _slack, input, opts) {
      log.registered.push({ input, opts });
      return { ok: true, recordId: "recCARD1" };
    },
    validateSlot,
    doFetch: (async () => {
      log.fetches++;
      throw new Error("model call not expected");
    }) as unknown as typeof fetch,
    now: () => NOW,
    ...over,
  };
  return { deps, log };
}

/** A stubbed Anthropic response carrying one propose_booking tool_use. */
function modelFetch(input: Record<string, unknown>, log: GuardLog): typeof fetch {
  return (async () => {
    log.fetches++;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [{ type: "tool_use", id: "tu1", name: "propose_booking", input }],
          stop_reason: "tool_use",
          usage: { input_tokens: 120, output_tokens: 30 },
        };
      },
      async text() {
        return "";
      },
    };
  }) as unknown as typeof fetch;
}

const CONFIRMED = "¡Listo! Ya quedó agendado tu Jiu-Jitsu mañana a las 7 pm 🙌";

// ---- gate 1: not a booking claim -------------------------------------------

test("auditHumanSend: a non-claim send is a complete no-op", async () => {
  const { db, state } = fakeDb();
  const { deps, log } = harness();

  await auditHumanSend(
    envWith(db),
    PHONE,
    "¿Te late mañana a las 7 pm para tu clase de prueba?",
    "staff",
    "fer",
    deps,
  );

  assert.equal(log.cards.length, 0);
  assert.equal(state.kv.size, 0);
});

// ---- gate 2: the claim is already backed -----------------------------------

test("auditHumanSend: a LEGACY bare-epoch marker is still recognized as backing", async () => {
  const { db, state } = fakeDb();
  // Rows written before the marker carried its slot: no slot to compare, so
  // they back any claim (the pre-slice behavior) for their 72h lifetime.
  state.kv.set(bookingRecordedKey(PHONE), String(NOW - 3600));
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);

  assert.equal(log.cards.length, 0);
  assert.equal(state.kv.has(bookingClaimThrottleKey(PHONE, cdmxDateStr(NOW))), false);
});

test("auditHumanSend: a fresh marker for the SAME slot backs the claim", async () => {
  const { db, state } = fakeDb();
  state.kv.set(
    bookingRecordedKey(PHONE),
    bookingRecordedValue(NOW - 3600, "2026-08-25", "19:00"),
  );
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);

  assert.equal(log.cards.length, 0);
});

test("auditHumanSend: a fresh marker for ANOTHER slot cards, with the mismatch note", async () => {
  const { db, state } = fakeDb();
  state.kv.set(
    bookingRecordedKey(PHONE),
    bookingRecordedValue(NOW - 3600, "2026-08-25", "19:00"),
  );
  const { deps, log } = harness();

  // Saturday 11:00 — a DIFFERENT class from the Tuesday 19:00 on file.
  await auditHumanSend(
    envWith(db),
    PHONE,
    "¡Listo! Ya quedó agendado tu Jiu-Jitsu el sábado a las 11 am 🙌",
    "approved",
    undefined,
    deps,
  );

  assert.equal(log.cards.length, 1);
  const capture = log.cards[0]!.capture;
  assert.equal(capture.trialDate, "2026-08-29");
  assert.equal(
    capture.conflictNote,
    "Ya hay un registro para 2026-08-25 19:00 — esto parece OTRA clase",
  );
});

test("auditHumanSend: a DATELESS claim + a fresh marker stays backed (no false card)", async () => {
  const { db, state } = fakeDb();
  state.kv.set(
    bookingRecordedKey(PHONE),
    bookingRecordedValue(NOW - 3600, "2026-08-25", "19:00"),
  );
  const { deps, log } = harness();

  await auditHumanSend(
    envWith(db),
    PHONE,
    "¡Perfecto! Ya quedó agendado, cualquier cosa me avisas 🙌",
    "approved",
    undefined,
    deps,
  );

  assert.equal(log.cards.length, 0);
  assert.equal(log.fetches, 0); // backed ⇒ it never even parses
});

test("auditHumanSend: a scheduled same_day followup on the claimed date backs it", async () => {
  // computeTrialSequence puts same_day at class−4h (clamped into 09:00–21:00),
  // so its CDMX due date IS the trial date.
  const { db } = fakeDb({
    followups: [{ kind: "same_day", due_at: cdmxToEpoch(2026, 8, 25, 15, 0, 0) }],
  });
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);

  assert.equal(log.cards.length, 0);
});

test("auditHumanSend: a day_before followup backs the NEXT day's claim", async () => {
  // day_before fires at 18:00 CDMX the day before the class.
  const { db } = fakeDb({
    followups: [{ kind: "day_before", due_at: cdmxToEpoch(2026, 8, 24, 18, 0, 0) }],
  });
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);

  assert.equal(log.cards.length, 0);
});

test("auditHumanSend: a sequence armed for ANOTHER date does not back the claim", async () => {
  const { db } = fakeDb({
    followups: [{ kind: "same_day", due_at: cdmxToEpoch(2026, 8, 27, 15, 0, 0) }],
  });
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);

  assert.equal(log.cards.length, 1);
  // No fresh marker ⇒ nothing concrete to point at, so no mismatch note.
  assert.equal(log.cards[0]!.capture.conflictNote, undefined);
});

test("auditHumanSend: a dateless claim is backed by ANY scheduled booking followup", async () => {
  const { db } = fakeDb({ hasBookingFollowup: true });
  const { deps, log } = harness();

  await auditHumanSend(
    envWith(db),
    PHONE,
    "¡Perfecto! Ya quedó agendado 🙌",
    "approved",
    undefined,
    deps,
  );

  assert.equal(log.cards.length, 0);
});

test("auditHumanSend: a STALE marker (>72h) no longer backs the claim", async () => {
  const { db, state } = fakeDb();
  state.kv.set(bookingRecordedKey(PHONE), String(NOW - 80 * 3600));
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);

  assert.equal(log.cards.length, 1);
});

// ---- the capture itself -----------------------------------------------------

test("auditHumanSend: unbacked claim ⇒ capture persisted + card posted with a valid verdict", async () => {
  const { db, state } = fakeDb();
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "edited", undefined, deps);

  assert.equal(log.cards.length, 1);
  const { key, capture } = log.cards[0]!;
  assert.ok(key.startsWith(`booking_capture:${NOW}:`));
  assert.equal(capture.phone, PHONE);
  assert.equal(capture.name, "Ana"); // from the contact row
  assert.equal(capture.discipline, "jiu");
  assert.equal(capture.trialDate, "2026-08-25");
  assert.equal(capture.trialTime, "19:00");
  assert.equal(capture.verdict.ok, true); // Tuesday 19:00 adult jiu is real
  assert.equal(capture.status, "open");
  assert.equal(capture.sentText, CONFIRMED);

  // Persisted, and re-persisted with the card ts so apply/skip can swap it.
  const stored = parseCapture(state.kv.get(key) ?? null);
  assert.equal(stored?.slackTs, "1756.0001");
  assert.equal(log.fetches, 0); // full regex parse ⇒ no model call
});

test("auditHumanSend: the source (and who sent it) rides on the capture", async () => {
  const { db } = fakeDb();
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "staff_later", "vale", deps);

  assert.equal(log.cards[0]!.capture.source, "staff_later");
  assert.equal(log.cards[0]!.capture.by, "vale");
});

test("auditHumanSend: an invalid slot still cards, with the corrective verdict", async () => {
  const { db } = fakeDb();
  const { deps, log } = harness();

  // Tuesday has no 05:00 class.
  await auditHumanSend(
    envWith(db),
    PHONE,
    "Ya quedó agendado tu Jiu-Jitsu mañana a las 5:00.",
    "approved",
    undefined,
    deps,
  );

  const verdict = log.cards[0]!.capture.verdict;
  assert.equal(verdict.ok, false);
  assert.ok((verdict.alternatives ?? []).length > 0);
});

// ---- gate 3: daily throttle -------------------------------------------------

test("auditHumanSend: at most one capture per lead per CDMX day", async () => {
  const { db, state } = fakeDb();
  const { deps, log } = harness();

  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);
  await auditHumanSend(envWith(db), PHONE, CONFIRMED, "approved", undefined, deps);

  assert.equal(log.cards.length, 1);
  assert.equal(state.kv.has(bookingClaimThrottleKey(PHONE, cdmxDateStr(NOW))), true);
});

// ---- model fallback for a partial parse -------------------------------------

test("auditHumanSend: a bare claim falls back to ONE propose_booking model call", async () => {
  const { db } = fakeDb({
    messages: [
      { direction: "in", body: "¿Tienen clase el martes en la tarde?", ts: NOW - 600 },
      { direction: "out_bot", body: "Sí, a las 7 pm 🙌", ts: NOW - 300 },
    ],
  });
  const { deps, log } = harness();
  const withModel: BookingGuardDeps = {
    ...deps,
    doFetch: modelFetch(
      {
        discipline: "muay",
        audience: "adult",
        trial_date: "2026-08-25",
        trial_time: "19:00",
      },
      log,
    ),
  };

  await auditHumanSend(
    envWith(db),
    PHONE,
    "¡Perfecto! Ya quedó agendado 🙌",
    "approved",
    undefined,
    withModel,
  );

  assert.equal(log.fetches, 1);
  const c = log.cards[0]!.capture;
  assert.equal(c.discipline, "muay");
  assert.equal(c.trialDate, "2026-08-25");
  assert.equal(c.trialTime, "19:00");
  assert.equal(c.verdict.ok, true);
});

test("auditHumanSend: a model-call failure degrades to the partial parse, no throw", async () => {
  const { db } = fakeDb();
  const { deps, log } = harness();

  await auditHumanSend(
    envWith(db),
    PHONE,
    "¡Perfecto! Ya quedó agendado 🙌",
    "approved",
    undefined,
    deps, // doFetch throws
  );

  assert.equal(log.fetches, 2); // callAnthropic's own single retry
  assert.equal(log.cards.length, 1);
  assert.equal(log.cards[0]!.capture.verdict.ok, false);
  assert.match(log.cards[0]!.capture.verdict.reason ?? "", /faltan datos/);
});

// ---- the Registrar button ---------------------------------------------------

async function seedCapture(
  state: DbState,
  over: Partial<BookingCapture> = {},
): Promise<string> {
  const key = `booking_capture:${NOW}:${PHONE}`;
  const capture: BookingCapture = {
    phone: PHONE,
    name: "Ana",
    discipline: "jiu",
    audience: "adult",
    trialDate: "2026-08-25",
    trialTime: "19:00",
    sentText: CONFIRMED,
    source: "approved",
    verdict: { ok: true },
    status: "open",
    slackTs: "1756.0001",
    createdAt: NOW,
    ...over,
  };
  state.kv.set(key, JSON.stringify(capture));
  return key;
}

test("applyBookingCapture: registers once — a second click books nothing more", async () => {
  const { db, state } = fakeDb();
  const key = await seedCapture(state);
  const { deps, log } = harness();

  await applyBookingCapture(envWith(db), key, undefined, deps);
  await applyBookingCapture(envWith(db), key, undefined, deps);

  assert.equal(log.registered.length, 1);
  assert.equal(state.kv.has(bookingCaptureClaimKey(key)), true);
  const stored = parseCapture(state.kv.get(key) ?? null);
  assert.equal(stored?.status, "registered");
  assert.equal(stored?.recordId, "recCARD1");
  assert.ok(log.updates.some((u) => u.headline.includes("recCARD1")));
});

test("applyBookingCapture: a failed register releases the claim and keeps the buttons", async () => {
  const { db, state } = fakeDb();
  const key = await seedCapture(state);
  const { deps, log } = harness({
    async registerBooking(_env, _slack, input, opts) {
      log.registered.push({ input, opts });
      return {
        ok: false,
        reason: "airtable_error",
        detail: "airtable create failed",
      };
    },
  });

  await applyBookingCapture(envWith(db), key, undefined, deps);

  assert.equal(state.kv.has(bookingCaptureClaimKey(key)), false); // released
  assert.equal(parseCapture(state.kv.get(key) ?? null)?.status, "open");
  const last = log.updates[log.updates.length - 1]!;
  assert.match(last.headline, /No se pudo registrar/);
  assert.deepEqual(last.buttons, { key, verdictOk: false });
});

test("applyBookingCapture: an incomplete capture asks for a correction, books nothing", async () => {
  const { db, state } = fakeDb();
  const key = await seedCapture(state, { trialTime: undefined, verdict: { ok: false } });
  const { deps, log } = harness();

  await applyBookingCapture(envWith(db), key, undefined, deps);

  assert.equal(log.registered.length, 0);
  assert.match(log.updates[0]!.headline, /No se pudo registrar/);
});

test("skipBookingCapture: closes the capture without touching Airtable", async () => {
  const { db, state } = fakeDb();
  const key = await seedCapture(state);
  const { deps, log } = harness();

  await skipBookingCapture(envWith(db), key, deps);
  await skipBookingCapture(envWith(db), key, deps); // second click is inert

  assert.equal(log.registered.length, 0);
  assert.equal(parseCapture(state.kv.get(key) ?? null)?.status, "skipped");
  assert.equal(log.updates.length, 1);
});

// ---- the correction modal ---------------------------------------------------

test("parseViewSubmissionTarget: booking prefix vs. the legacy bare approval id", () => {
  assert.deepEqual(parseViewSubmissionTarget(`${BOOKING_META_PREFIX}booking_capture:1:52`), {
    kind: "booking",
    key: "booking_capture:1:52",
  });
  assert.deepEqual(parseViewSubmissionTarget("816"), { kind: "approval", id: 816 });
  assert.deepEqual(parseViewSubmissionTarget(null), { kind: "none" });
  assert.deepEqual(parseViewSubmissionTarget(""), { kind: "none" });
  assert.deepEqual(parseViewSubmissionTarget(BOOKING_META_PREFIX), { kind: "none" });
});

test("submitBookingCaptureEdit: merged fields re-validate and register WITHOUT force", async () => {
  const { db, state } = fakeDb();
  const key = await seedCapture(state, {
    discipline: undefined,
    trialTime: undefined,
    verdict: { ok: false, reason: "faltan datos (disciplina, fecha u hora)" },
  });
  const { deps, log } = harness();

  await submitBookingCaptureEdit(
    envWith(db),
    key,
    {
      [BOOKING_MODAL_FIELDS.name]: "Ana Ruiz",
      [BOOKING_MODAL_FIELDS.discipline]: "muay",
      [BOOKING_MODAL_FIELDS.trialDate]: "2026-08-25",
      [BOOKING_MODAL_FIELDS.trialTime]: "19:00",
    },
    "fer",
    deps,
  );

  assert.equal(log.registered.length, 1);
  const opts = log.registered[0]!.opts as { force: boolean; by?: string };
  assert.equal(opts.force, false);
  assert.equal(opts.by, "fer");
  const input = log.registered[0]!.input as { name: string; discipline: string };
  assert.equal(input.name, "Ana Ruiz");
  assert.equal(input.discipline, "muay");
});

test("submitBookingCaptureEdit: still-invalid AFTER an already-invalid verdict ⇒ force", async () => {
  const { db, state } = fakeDb();
  const key = await seedCapture(state, {
    trialTime: "05:00",
    verdict: { ok: false, reason: "No jiu (adult) class at 05:00" },
  });
  const { deps, log } = harness();

  await submitBookingCaptureEdit(
    envWith(db),
    key,
    {
      [BOOKING_MODAL_FIELDS.discipline]: "jiu",
      [BOOKING_MODAL_FIELDS.trialDate]: "2026-08-25",
      [BOOKING_MODAL_FIELDS.trialTime]: "05:30", // still not on the grid
    },
    undefined,
    deps,
  );

  assert.equal(log.registered.length, 1);
  assert.equal((log.registered[0]!.opts as { force: boolean }).force, true);
});

test("submitBookingCaptureEdit: a child name flips the audience to kid", async () => {
  const { db, state } = fakeDb();
  const key = await seedCapture(state);
  const { deps, log } = harness();

  await submitBookingCaptureEdit(
    envWith(db),
    key,
    {
      [BOOKING_MODAL_FIELDS.childName]: "Sofía",
      [BOOKING_MODAL_FIELDS.discipline]: "jiu",
      [BOOKING_MODAL_FIELDS.trialDate]: "2026-08-25",
      [BOOKING_MODAL_FIELDS.trialTime]: "17:00", // Tuesday kids jiu
    },
    undefined,
    deps,
  );

  const input = log.registered[0]!.input as { audience: string; childName?: string };
  assert.equal(input.audience, "kid");
  assert.equal(input.childName, "Sofía");
});
