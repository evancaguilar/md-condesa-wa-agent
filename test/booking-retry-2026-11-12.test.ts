// Promised-but-unbooked retry (2026-11-12): a reply that tells the lead the
// class is booked while book_trial never ran gets ONE corrective brain call
// before the ⚠️ draft stands. Real chat 2026-11-11: «6 pm está perfecto» →
// «¡Va! 🙌 Te apunto el lunes 23 a las 6 pm. Nos vemos 💪», nothing booked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrain, type ApiMessage } from "../src/brain/claude.js";
import {
  BOOKING_RETRY_MIN_MS,
  BOOKING_RETRY_TIMEOUT_MS,
  BOOKING_RETRY_TURN_BUDGET_MS,
  bookingRetryInstruction,
  bookingRetryNote,
  bookingRetryTimeoutMs,
  resolveBookingRetry,
  type BookingRetryEvent,
} from "../src/brain/booking-retry.js";
import { buildContextBlock } from "../src/brain/prompt.js";
import type { AirtablePort, BookTrialInput, BrainResult, Contact, ConvoContext } from "../src/types.js";

// ---- fixtures ------------------------------------------------------------

const PHONE = "5215512345678";
const CLAIM = "¡Va! 🙌 Te apunto el lunes 23 a las 6 pm. Nos vemos 💪";

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: PHONE,
    name: "Andrea",
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

/** The 2026-11-11 chat, written on Wednesday 11 Nov (the 23rd = Monday, 12 days out). */
function chatCtx(over: Partial<ConvoContext> = {}, contactOver: Partial<Contact> = {}): ConvoContext {
  const now = Math.floor(Date.now() / 1000);
  const m = (i: number, direction: "in" | "out", body: string) => ({
    wamid: `w${i}`,
    phone: PHONE,
    direction,
    body,
    ts: now - 600 + i * 60,
    meta: null,
  });
  return {
    phone: PHONE,
    contact: contact(contactOver),
    history: [
      m(1, "in", "Me encanta la idea. El lunes 23 o martes 24"),
      m(2, "in", "De este mes"),
      m(3, "out", "¡Va! 🙌 Te aparto Muay Thai el lunes 23 a las 7:00 am — ¿te queda bien esa hora, o prefieres otra (8am, 10am, 6pm o 7pm)?"),
      m(4, "in", "6 pm está perfecto"),
    ],
    nowCdmx: "2026-11-11T12:00:00-06:00",
    weekday: "miércoles",
    windowOpen: true,
    trainingWheels: true,
    ...over,
  } as ConvoContext;
}

type Body = { system: unknown; tools: unknown; thinking: unknown; messages: ApiMessage[] };

/** Fake Anthropic: each entry is a response payload, or "hang" (rejects only
 *  when the request's AbortSignal fires), or "fail" (HTTP 500). */
function fakeFetch(script: (unknown | "hang" | "fail")[]) {
  let i = 0;
  const bodies: Body[] = [];
  const fn = async (_url: unknown, init?: { body?: string; signal?: AbortSignal }): Promise<Response> => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Body);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step === "hang") {
      return new Promise<Response>((_res, rej) => {
        const sig = init?.signal;
        if (sig?.aborted) return rej(new Error("aborted"));
        (sig as unknown as { addEventListener(t: string, f: () => void): void } | undefined)?.addEventListener(
          "abort",
          () => rej(new Error("aborted")),
        );
      });
    }
    if (step === "fail") {
      return { ok: false, status: 500, json: async () => ({}), text: async () => "overloaded" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => step, text: async () => JSON.stringify(step) } as unknown as Response;
  };
  return { fetchImpl: fn as unknown as typeof fetch, calls: () => i, bodies };
}

function reply(message: string, sureness = 90) {
  return {
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: "tool_use", id: `s${Math.random()}`, name: "send_reply", input: { message, language: "es", sureness, confidence: sureness >= 75 ? "high" : "low", awaiting_reply: true } }],
  };
}

function book(input: Record<string, unknown>) {
  return {
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: "tool_use", id: `b${Math.random()}`, name: "book_trial", input }],
  };
}

const MON23 = {
  name: "Andrea",
  discipline: "muay",
  audience: "adult",
  trial_date: "2026-11-23",
  trial_weekday: "lun",
  trial_time: "18:00",
  followup_message: "¡Listo, Andrea! 🙌 Quedaste agendada a Muay Thai el lunes 23 a las 6 pm.",
};

function harness(script: (unknown | "hang" | "fail")[], capMs?: number) {
  const f = fakeFetch(script);
  const booked: BookTrialInput[] = [];
  const events: BookingRetryEvent[] = [];
  const airtable: AirtablePort = {
    async bookTrial(i) {
      booked.push(i);
      return "recRETRY";
    },
  };
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable,
    accrueUsage: async () => {},
    fetchImpl: f.fetchImpl,
    onBookingRetry: async (ev) => {
      events.push(ev);
    },
    ...(capMs !== undefined ? { bookingRetryCapMs: capMs } : {}),
  });
  return { brain, booked, events, ...f };
}

function lastUserText(b: Body): string {
  const last = b.messages[b.messages.length - 1]!;
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

// ---- end to end through createBrain ----------------------------------------

test("the 2026-11-11 chat: the retry books Mon 23 18:00 and the turn is a normal 'book'", async () => {
  const h = harness([reply(CLAIM), book(MON23), reply("¡Listo, Andrea! 🙌 Quedaste agendada el lunes 23 a las 6 pm.")]);
  const r = await h.brain.respond(chatCtx());
  assert.equal(h.calls(), 3);
  assert.equal(r.action, "book");
  if (r.action !== "book") return;
  assert.equal(r.trialDate, "2026-11-23");
  assert.equal(r.trialTime, "18:00");
  assert.equal(r.recordId, "recRETRY");
  assert.equal(r.replySureness, 90);
  assert.equal(h.booked.length, 1);
  assert.deepEqual(h.events.map((e) => e.ending), ["booked"]);

  // Cache prefix untouched: system, tools and thinking byte-identical.
  const [b0, b1] = h.bodies;
  assert.equal(JSON.stringify(b1!.system), JSON.stringify(b0!.system));
  assert.equal(JSON.stringify(b1!.tools), JSON.stringify(b0!.tools));
  assert.equal(JSON.stringify(b1!.thinking), JSON.stringify(b0!.thinking));
  // The instruction rides on the per-turn context, quoting the claim.
  const ctxText = lastUserText(b1!);
  assert.match(ctxText, /<reintento_agendado>/);
  assert.ok(ctxText.includes("Te apunto el lunes 23 a las 6 pm"));
  assert.ok(ctxText.indexOf("</context>") < ctxText.indexOf("<reintento_agendado>"));
  assert.doesNotMatch(lastUserText(b0!), /reintento_agendado/);
});

test("retry asks for the missing name instead → that reply replaces the draft", async () => {
  const ask = "¡Va! 🙌 ¿Me confirmas tu nombre para dejarte apartada la clase?";
  const h = harness([reply(CLAIM), reply(ask, 85)]);
  const r = await h.brain.respond(chatCtx({}, { name: null }));
  assert.equal(h.calls(), 2);
  assert.equal(r.action, "send");
  if (r.action !== "send") return;
  assert.equal(r.message, ask);
  assert.equal(h.booked.length, 0);
  assert.deepEqual(h.events.map((e) => e.ending), ["asked"]);
});

test("retry repeats the claim without booking → the first ⚠️ draft, no second retry", async () => {
  const h = harness([reply(CLAIM), reply("Listo, te apunto el lunes 23 a las 6 pm 💪")]);
  const r = await h.brain.respond(chatCtx());
  assert.equal(h.calls(), 2);
  assert.equal(r.action, "draft");
  if (r.action !== "draft") return;
  assert.equal(r.message, CLAIM);
  assert.match(r.reason ?? "", /NO se creó ningún booking/);
  assert.equal(r.sureness, undefined);
  assert.deepEqual(h.events.map((e) => e.ending), ["claimed_again"]);
});

test("retry times out → the first ⚠️ draft", async () => {
  const h = harness([reply(CLAIM), "hang"], 50);
  const r = await h.brain.respond(chatCtx());
  assert.equal(r.action, "draft");
  if (r.action !== "draft") return;
  assert.equal(r.message, CLAIM);
  assert.match(r.reason ?? "", /NO se creó ningún booking/);
  assert.deepEqual(h.events.map((e) => e.ending), ["timeout"]);
});

test("retry API error → the first ⚠️ draft (never the apology)", async () => {
  const h = harness([reply(CLAIM), "fail"]);
  const r = await h.brain.respond(chatCtx());
  assert.equal(r.action, "draft");
  if (r.action !== "draft") return;
  assert.equal(r.message, CLAIM);
  assert.deepEqual(h.events.map((e) => e.ending), ["error"]);
});

test("retry booked, then the deadline hit before send_reply → still a 'book' (record never dropped)", async () => {
  const h = harness([reply(CLAIM), book(MON23), "hang"], 200);
  const r = await h.brain.respond(chatCtx());
  assert.equal(r.action, "book");
  if (r.action !== "book") return;
  assert.equal(r.replyMissing, true);
  assert.equal(h.booked.length, 1);
  assert.deepEqual(h.events.map((e) => e.ending), ["booked"]);
});

test("date guards still apply in the retry: the nearest Monday (16th) is refused, claim again → draft", async () => {
  const wrong = { ...MON23, trial_date: "2026-11-16" };
  const h = harness([reply(CLAIM), book(wrong), reply(CLAIM)]);
  const r = await h.brain.respond(chatCtx());
  assert.equal(h.booked.length, 0);
  assert.equal(r.action, "draft");
  const refused = JSON.stringify(h.bodies[2]!.messages);
  assert.match(refused, /accepted our offer of[^"]*\(2026-11-23\), but trial_date is 2026-11-16/);
  assert.deepEqual(h.events.map((e) => e.ending), ["claimed_again"]);
});

test("a reply about an EXISTING recorded booking is untouched: no retry", async () => {
  const h = harness([reply("¡Perfecto! Nos vemos el lunes 23 a las 6 pm 💪")]);
  const r = await h.brain.respond(
    chatCtx({ recordedBooking: { ts: 1, trialDate: "2026-11-23", trialTime: "18:00" } }),
  );
  assert.equal(h.calls(), 1);
  assert.equal(r.action, "send");
  assert.equal(h.events.length, 0);
});

test("stale redrive turn (its prompt forbids booking) → no retry, plain draft", async () => {
  const h = harness([reply(CLAIM)]);
  const r = await h.brain.respond(chatCtx({ staleReply: { waitedHours: 3, lastInboundCdmx: "2026-11-11 09:00" } }));
  assert.equal(h.calls(), 1);
  assert.equal(r.action, "draft");
  assert.equal(h.events.length, 0);
});

test("a reply that claims nothing never retries", async () => {
  const h = harness([reply("¿Te queda bien el lunes 23 a las 6 pm?")]);
  await h.brain.respond(chatCtx());
  assert.equal(h.calls(), 1);
  assert.equal(h.events.length, 0);
});

// ---- pure gate / instruction / resolution ----------------------------------

const gate = {
  reply: CLAIM,
  escalationReason: null,
  bookedThisTurn: false,
  recordedBooking: false,
  staleReply: false,
  bookingEnabled: true,
  elapsedMs: 4000,
};

test("bookingRetryTimeoutMs: fires on an unbacked claim, with the 20 s deadline", () => {
  assert.equal(bookingRetryTimeoutMs(gate), BOOKING_RETRY_TIMEOUT_MS);
});

test("bookingRetryTimeoutMs: every exemption", () => {
  assert.equal(bookingRetryTimeoutMs({ ...gate, bookedThisTurn: true }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, recordedBooking: true }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, staleReply: true }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, bookingEnabled: false }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, reply: "¿Te aparto el lunes 23 a las 6 pm?" }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, reply: "¿Me confirmas tu nombre para dejarlo agendado?" }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, escalationReason: "complaint: molesto" }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, escalationReason: "opt_out" }), null);
  assert.equal(bookingRetryTimeoutMs({ ...gate, escalationReason: "clase_privada" }), null);
});

test("bookingRetryTimeoutMs: respects the turn budget", () => {
  assert.equal(bookingRetryTimeoutMs({ ...gate, elapsedMs: BOOKING_RETRY_TURN_BUDGET_MS - 8000 }), 8000);
  assert.equal(bookingRetryTimeoutMs({ ...gate, elapsedMs: BOOKING_RETRY_TURN_BUDGET_MS - BOOKING_RETRY_MIN_MS + 1 }), null);
});

test("bookingRetryInstruction: ES/EN, quotes the reply on one line, can't break the block", () => {
  const es = bookingRetryInstruction("es", "Te apunto <b>el lunes</b>\n«23»");
  assert.match(es, /^<reintento_agendado>\nTu respuesta anterior/);
  assert.ok(es.includes("«Te apunto bel lunes/b 23»"));
  assert.match(es, /llama book_trial AHORA/);
  assert.match(es, /NO digas que quedó apuntado/);
  assert.match(es, /<\/reintento_agendado>$/);
  const en = bookingRetryInstruction("en", "You're booked for Monday 23 at 6 pm");
  assert.match(en, /call book_trial NOW/);
  assert.match(en, /do NOT say they are booked/);
});

test("buildContextBlock: the retry block rides after </context>, absent by default", () => {
  const ctx = chatCtx();
  assert.doesNotMatch(buildContextBlock(ctx), /reintento_agendado/);
  const withRetry = buildContextBlock({ ...ctx, bookingRetryInstruction: bookingRetryInstruction("es", CLAIM) });
  assert.ok(withRetry.trimEnd().endsWith("</reintento_agendado>"));
  assert.ok(withRetry.indexOf("</context>") < withRetry.indexOf("<reintento_agendado>"));
});

test("resolveBookingRetry: each ending", () => {
  const first: BrainResult = { action: "draft", message: CLAIM, language: "es", confidence: "low", reason: "⚠️" };
  const bookR = { action: "book" } as unknown as BrainResult;
  assert.deepEqual(resolveBookingRetry(first, { kind: "booked", result: bookR }), { result: bookR, ending: "booked" });
  const ask: BrainResult = { action: "send", message: "¿Me confirmas tu nombre?", language: "es", confidence: "high" };
  assert.deepEqual(resolveBookingRetry(first, { kind: "reply", result: ask }), { result: ask, ending: "asked" });
  const again: BrainResult = { action: "draft", message: "Te apunto el lunes 23. Nos vemos 💪", language: "es", confidence: "low" };
  assert.equal(resolveBookingRetry(first, { kind: "reply", result: again }).ending, "claimed_again");
  assert.equal(resolveBookingRetry(first, { kind: "reply", result: again }).result, first);
  assert.equal(resolveBookingRetry(first, { kind: "timeout" }).result, first);
  assert.equal(resolveBookingRetry(first, { kind: "error", detail: "x" }).ending, "error");
  assert.equal(resolveBookingRetry(first, { kind: "no_reply", detail: "escalate" }).result, first);
});

test("bookingRetryNote: one line with phone, ending and time", () => {
  const n = bookingRetryNote({ phone: PHONE, ending: "booked", ms: 6400 });
  assert.match(n, /^🔁 Reintento de agendado 5215512345678/);
  assert.match(n, /agendó con book_trial/);
  assert.match(n, /6\.4 s/);
  assert.doesNotMatch(n, /\n/);
});
