import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrain, computeCost, type ApiMessage } from "../src/brain/claude.js";
import type {
  AirtablePort,
  BookingFailureEvent,
  Contact,
  ConvoContext,
} from "../src/types.js";

// ---- fixtures ------------------------------------------------------------

function contact(overrides: Partial<Contact> = {}): Contact {
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
    ...overrides,
  };
}

function ctx(body: string): ConvoContext {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    phone: "5215512345678",
    contact: contact(),
    history: [
      {
        wamid: "w1",
        phone: "5215512345678",
        direction: "in",
        body,
        ts: nowS,
        meta: null,
      },
    ],
    nowCdmx: "2026-07-06T18:30:00-06:00",
    weekday: "lunes",
    windowOpen: true,
    trainingWheels: true,
  };
}

const okAirtable: AirtablePort = {
  async bookTrial() {
    return "recXYZ";
  },
};

/** Build a fake fetch that returns each queued Anthropic response in order.
 *  `bodies()` exposes the request payloads so tests can inspect the tool_results
 *  the brain fed back to the model. */
function mockFetch(responses: unknown[]): {
  fetchImpl: typeof fetch;
  calls: () => number;
  bodies: () => { messages: ApiMessage[] }[];
} {
  let i = 0;
  const sent: { messages: ApiMessage[] }[] = [];
  const fn = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    sent.push(JSON.parse(init?.body ?? "{}") as { messages: ApiMessage[] });
    const payload = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  };
  return {
    fetchImpl: fn as unknown as typeof fetch,
    calls: () => i,
    bodies: () => sent,
  };
}

/** The tool_result string the brain handed back for tool_use id `id`. */
function toolResultText(
  bodies: { messages: ApiMessage[] }[],
  id: string,
): string | null {
  for (const body of bodies) {
    for (const m of body.messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const block of m.content as { type: string; tool_use_id?: string; content?: string }[]) {
        if (block.type === "tool_result" && block.tool_use_id === id) {
          return block.content ?? "";
        }
      }
    }
  }
  return null;
}

function usage(over: Record<string, number> = {}) {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  };
}

function sendReplyResp(confidence: "high" | "low", message = "¡Va!") {
  return {
    stop_reason: "tool_use",
    usage: usage(),
    content: [
      {
        type: "tool_use",
        id: "tu1",
        name: "send_reply",
        input: { message, language: "es", confidence },
      },
    ],
  };
}

// ---- tests ---------------------------------------------------------------

test("send_reply high → action:send", async () => {
  let accrued = 0;
  const { fetchImpl } = mockFetch([sendReplyResp("high", "¡Hola! 🙌")]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {
      accrued++;
    },
    fetchImpl,
  });
  const r = await brain.respond(ctx("hola"));
  assert.equal(r.action, "send");
  if (r.action === "send") {
    assert.equal(r.confidence, "high");
    assert.equal(r.message, "¡Hola! 🙌");
    assert.equal(r.language, "es");
  }
  assert.equal(accrued, 1, "usage flushed once");
});

test("text-only response → ONE corrective retry recovers send_reply", async () => {
  // Adaptive-thinking failure mode (2026-08-28): the model writes the reply as
  // prose and skips the tool. The retry nudge must recover the normal path so
  // the reply keeps its sureness (auto-send / best-bet stay alive).
  const textOnly = {
    stop_reason: "end_turn",
    usage: usage(),
    content: [{ type: "text", text: "¡Va! Sábado 2 pm entonces 🙌" }],
  };
  const recovered = {
    stop_reason: "tool_use",
    usage: usage(),
    content: [
      {
        type: "tool_use",
        id: "tu9",
        name: "send_reply",
        input: {
          message: "¡Va! Sábado 2 pm entonces 🙌",
          language: "es",
          confidence: "high",
          sureness: 85,
        },
      },
    ],
  };
  const { fetchImpl, calls, bodies } = mockFetch([textOnly, recovered]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("sábado"));
  assert.equal(calls(), 2, "exactly one retry");
  assert.equal(r.action, "send");
  if (r.action === "send") assert.equal(r.sureness, 85);
  // The nudge rode in as a plain user message on the second call.
  const second = bodies()[1]!;
  const last = second.messages[second.messages.length - 1]!;
  assert.equal(last.role, "user");
  assert.ok(String(last.content).includes("send_reply"), String(last.content));
});

test("text-only twice → falls back to a reviewable no_tool_call draft", async () => {
  const textOnly = {
    stop_reason: "end_turn",
    usage: usage(),
    content: [{ type: "text", text: "Solo texto otra vez" }],
  };
  const { fetchImpl, calls } = mockFetch([textOnly, textOnly]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("hola"));
  assert.equal(calls(), 2);
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.equal(r.reason, "no_tool_call");
    assert.equal(r.message, "Solo texto otra vez");
    assert.equal(r.sureness, undefined);
  }
});

test("send_reply with literal \\n sequences → real newlines in the draft", async () => {
  const { fetchImpl } = mockFetch([
    sendReplyResp("low", "¡Hola! 👋 Bienvenido/a 🥋 \\n\\n¿La clase sería para ti?"),
  ]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("hola"));
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.equal(r.message, "¡Hola! 👋 Bienvenido/a 🥋 \n\n¿La clase sería para ti?");
    assert.ok(!r.message.includes("\\n"), "no literal backslash-n survives");
  }
});

test("send_reply low → action:draft with reason", async () => {
  const resp = {
    stop_reason: "tool_use",
    usage: usage(),
    content: [
      {
        type: "tool_use",
        id: "tu1",
        name: "send_reply",
        input: {
          message: "déjame confirmar el precio",
          language: "es",
          confidence: "low",
          escalation_reason: "price not in KB",
        },
      },
    ],
  };
  const { fetchImpl } = mockFetch([resp]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("cuánto cuesta niños"));
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.equal(r.confidence, "low");
    assert.equal(r.reason, "price not in KB");
  }
});

test("escalate_to_human → action:escalate", async () => {
  const resp = {
    stop_reason: "tool_use",
    usage: usage(),
    content: [
      {
        type: "tool_use",
        id: "tu1",
        name: "escalate_to_human",
        input: { reason: "price negotiation", summary: "lead haggling" },
      },
    ],
  };
  const { fetchImpl } = mockFetch([resp]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("me haces descuento?"));
  assert.equal(r.action, "escalate");
  if (r.action === "escalate") {
    assert.equal(r.reason, "price negotiation");
    assert.equal(r.summary, "lead haggling");
  }
});

test("book_trial (valid slot) then send_reply → action:book", async () => {
  // 2026-07-06 is Monday. Book jiu adult 18:00 — a valid generated slot.
  const bookResp = {
    stop_reason: "tool_use",
    usage: usage(),
    content: [
      {
        type: "tool_use",
        id: "b1",
        name: "book_trial",
        input: {
          name: "Ana",
          discipline: "jiu",
          audience: "adult",
          trial_date: "2026-07-06",
          trial_time: "18:00",
          followup_message: "Listo Ana, te esperamos el lunes 6pm 🙌",
        },
      },
    ],
  };
  const { fetchImpl } = mockFetch([bookResp, sendReplyResp("high")]);
  let booked: unknown = null;
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: {
      async bookTrial(input) {
        booked = input;
        return "recABC";
      },
    },
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("quiero probar jiu el lunes a las 6"));
  assert.equal(r.action, "book");
  if (r.action === "book") {
    assert.equal(r.trialDate, "2026-07-06");
    assert.equal(r.trialTime, "18:00");
    assert.equal(r.discipline, "jiu");
    assert.equal(r.followupMessage, "Listo Ana, te esperamos el lunes 6pm 🙌");
  }
  assert.ok(booked, "airtable.bookTrial was called");
});

test("book_trial (invalid slot) is rejected, model retries and drafts", async () => {
  // Ask for a Sunday jiu adult 07:00 (no such class) → executor returns an
  // is_error tool_result; the next mocked turn falls back to a low send_reply.
  const badBook = {
    stop_reason: "tool_use",
    usage: usage(),
    content: [
      {
        type: "tool_use",
        id: "b1",
        name: "book_trial",
        input: {
          name: "Ana",
          discipline: "jiu",
          audience: "adult",
          trial_date: "2026-07-12", // Sunday
          trial_time: "07:00",
          followup_message: "ok",
        },
      },
    ],
  };
  let bookCalled = false;
  const { fetchImpl } = mockFetch([badBook, sendReplyResp("low", "ese horario no existe, ¿te va otro?")]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: {
      async bookTrial() {
        bookCalled = true;
        return "nope";
      },
    },
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("domingo 7am jiu"));
  assert.equal(bookCalled, false, "invalid slot never reaches airtable");
  assert.equal(r.action, "draft");
});

// ---- booking-failure notifications (slice 3) -----------------------------

/** book_trial tool_use with overridable input. */
function bookResp(input: Record<string, unknown>, id = "b1") {
  return {
    stop_reason: "tool_use",
    usage: usage(),
    content: [{ type: "tool_use", id, name: "book_trial", input }],
  };
}

test("invalid slot → notifier fires once; tool_result text is unchanged", async () => {
  // A malformed date keeps the reason deterministic (no dependence on the
  // generated schedule), so the exact tool_result string can be asserted.
  const { fetchImpl, bodies } = mockFetch([
    bookResp({
      name: "Ana",
      child_name: "Emilia",
      discipline: "jiu",
      audience: "kid",
      trial_date: "mañana",
      trial_time: "17:00",
      followup_message: "ok",
    }),
    sendReplyResp("low", "¿te va otro horario?"),
  ]);
  const events: BookingFailureEvent[] = [];
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    onBookingFailure: async (ev) => {
      events.push(ev);
    },
    fetchImpl,
  });

  const r = await brain.respond(ctx("mañana a las 5 para mi hija"));
  assert.equal(r.action, "draft");

  assert.equal(events.length, 1, "notifier called exactly once");
  const ev = events[0]!;
  assert.equal(ev.kind, "invalid_slot");
  assert.equal(ev.phone, "5215512345678");
  assert.equal(ev.requested.name, "Ana");
  assert.equal(ev.requested.childName, "Emilia");
  assert.equal(ev.requested.discipline, "jiu");
  assert.equal(ev.requested.audience, "kid");
  assert.equal(ev.requested.trialDate, "mañana");
  assert.equal(ev.requested.trialTime, "17:00");
  assert.equal(ev.requested.phone, "5215512345678");
  assert.equal(ev.reason, "Invalid trial_date 'mañana' (expected YYYY-MM-DD).");
  assert.equal(ev.alternatives, undefined, "no same-day options for a bad date");

  // CONTRACT: the string the model sees must not change because we now alert.
  assert.equal(
    toolResultText(bodies(), "b1"),
    "error: Invalid trial_date 'mañana' (expected YYYY-MM-DD). Do not book; propose a valid slot to the lead and end with send_reply.",
  );
});

test("invalid slot with same-day options → alternatives ride on the event", async () => {
  // 2026-07-06 is Monday; jiu/adult runs that day but never at 06:00.
  const { fetchImpl } = mockFetch([
    bookResp({
      name: "Ana",
      discipline: "jiu",
      audience: "adult",
      trial_date: "2026-07-06",
      trial_time: "06:00",
      followup_message: "ok",
    }),
    sendReplyResp("low", "¿te va otro horario?"),
  ]);
  const events: BookingFailureEvent[] = [];
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    onBookingFailure: async (ev) => {
      events.push(ev);
    },
    fetchImpl,
  });

  await brain.respond(ctx("lunes 6am jiu"));
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.kind, "invalid_slot");
  assert.ok(ev.reason.includes("Same-day options"), ev.reason);
  assert.ok(Array.isArray(ev.alternatives) && ev.alternatives.length > 0);
  assert.ok(ev.alternatives!.includes("18:00"), ev.alternatives!.join(","));
});

test("airtable throw → notifier fires with kind airtable_error, text unchanged", async () => {
  const { fetchImpl, bodies } = mockFetch([
    bookResp({
      name: "Ana",
      discipline: "jiu",
      audience: "adult",
      trial_date: "2026-07-06",
      trial_time: "18:00",
      followup_message: "ok",
    }),
    sendReplyResp("low", "perdón, hubo un problema"),
  ]);
  const events: BookingFailureEvent[] = [];
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: {
      async bookTrial() {
        throw new Error("airtable 422 UNKNOWN_FIELD_NAME");
      },
    },
    accrueUsage: async () => {},
    onBookingFailure: async (ev) => {
      events.push(ev);
    },
    fetchImpl,
  });

  const r = await brain.respond(ctx("lunes 6pm jiu"));
  assert.equal(r.action, "draft");
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.kind, "airtable_error");
  assert.equal(ev.reason, "airtable 422 UNKNOWN_FIELD_NAME");
  assert.equal(ev.requested.trialDate, "2026-07-06");
  assert.equal(ev.requested.trialTime, "18:00");

  assert.equal(
    toolResultText(bodies(), "b1"),
    "error: booking failed (airtable 422 UNKNOWN_FIELD_NAME). Apologize and offer the booking link; end with send_reply confidence low.",
  );
});

test("a notifier that throws never breaks the turn", async () => {
  const { fetchImpl } = mockFetch([
    bookResp({
      name: "Ana",
      discipline: "jiu",
      audience: "adult",
      trial_date: "2026-07-12", // Sunday: no class
      trial_time: "07:00",
      followup_message: "ok",
    }),
    sendReplyResp("low", "ese horario no existe, ¿te va otro?"),
  ]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    onBookingFailure: async () => {
      throw new Error("slack down");
    },
    fetchImpl,
  });
  const r = await brain.respond(ctx("domingo 7am jiu"));
  assert.equal(r.action, "draft");
  if (r.action === "draft") assert.equal(r.message, "ese horario no existe, ¿te va otro?");
});

test("no notifier wired (sandbox) → failures still handled normally", async () => {
  const { fetchImpl, bodies } = mockFetch([
    bookResp({
      name: "Ana",
      discipline: "jiu",
      audience: "adult",
      trial_date: "2026-07-12",
      trial_time: "07:00",
      followup_message: "ok",
    }),
    sendReplyResp("low", "otro horario?"),
  ]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl,
  });
  const r = await brain.respond(ctx("domingo 7am jiu"));
  assert.equal(r.action, "draft");
  assert.ok((toolResultText(bodies(), "b1") ?? "").startsWith("error: "));
});

// ---- multi-person bookings (slice 5) -------------------------------------

/** One assistant turn carrying several book_trial calls. */
function multiBookResp(inputs: Record<string, unknown>[]) {
  return {
    stop_reason: "tool_use",
    usage: usage(),
    content: inputs.map((input, i) => ({
      type: "tool_use",
      id: `b${i + 1}`,
      name: "book_trial",
      input,
    })),
  };
}

test("two book_trial calls in one turn → both survive in bookings[]", async () => {
  // Mamá + hijo, same Monday: 19:00 adult jiu and 17:00 kid jiu are real slots.
  const { fetchImpl } = mockFetch([
    multiBookResp([
      {
        name: "Ana",
        discipline: "jiu",
        audience: "adult",
        trial_date: "2026-07-06",
        trial_time: "19:00",
        followup_message: "Listo Ana 🙌",
      },
      {
        name: "Ana",
        child_name: "Leo",
        discipline: "jiu",
        audience: "kid",
        trial_date: "2026-07-06",
        trial_time: "17:00",
        followup_message: "Listos los dos: Leo a las 5 y tú a las 7 🙌",
      },
    ]),
    sendReplyResp("high"),
  ]);
  const booked: unknown[] = [];
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: {
      async bookTrial(input) {
        booked.push(input);
        return "recABC"; // upsert by phone ⇒ same row for the whole family
      },
    },
    accrueUsage: async () => {},
    fetchImpl,
  });

  const r = await brain.respond(ctx("vamos mi hijo y yo el lunes"));
  assert.equal(booked.length, 2, "both bookings reached Airtable");
  assert.equal(r.action, "book");
  if (r.action !== "book") return;
  assert.equal(r.bookings.length, 2);
  // Flat fields mirror the FIRST booking (deterministic, back-compat).
  assert.equal(r.name, r.bookings[0]!.name);
  assert.equal(r.trialTime, "19:00");
  assert.equal(r.audience, "adult");
  assert.equal(r.recordId, r.bookings[0]!.recordId);
  // …the closing text is the LAST call's (it covers everyone).
  assert.equal(r.followupMessage, "Listos los dos: Leo a las 5 y tú a las 7 🙌");
  assert.equal(r.bookings[1]!.audience, "kid");
  assert.equal(r.bookings[1]!.childName, "Leo");
  assert.equal(r.bookings[1]!.trialTime, "17:00");
});

test("one valid + one rejected slot → only the valid one is in bookings[]", async () => {
  const events: BookingFailureEvent[] = [];
  const { fetchImpl } = mockFetch([
    multiBookResp([
      {
        name: "Ana",
        discipline: "jiu",
        audience: "adult",
        trial_date: "2026-07-12", // Sunday: no class
        trial_time: "07:00",
        followup_message: "no",
      },
      {
        name: "Luis",
        discipline: "jiu",
        audience: "adult",
        trial_date: "2026-07-06",
        trial_time: "19:00",
        followup_message: "Listo Luis 🙌",
      },
    ]),
    sendReplyResp("high"),
  ]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    onBookingFailure: async (ev) => {
      events.push(ev);
    },
    fetchImpl,
  });

  const r = await brain.respond(ctx("Ana el domingo y Luis el lunes"));
  assert.equal(events.length, 1, "the rejected slot still notifies");
  assert.equal(events[0]!.kind, "invalid_slot");
  assert.equal(r.action, "book");
  if (r.action !== "book") return;
  assert.equal(r.bookings.length, 1);
  assert.equal(r.bookings[0]!.name, "Luis");
  assert.equal(r.name, "Luis"); // flat fields = the only surviving booking
  assert.equal(r.trialDate, "2026-07-06");
});

test("single booking → bookings[] holds exactly the flat fields (regression)", async () => {
  const { fetchImpl } = mockFetch([
    multiBookResp([
      {
        name: "Ana",
        discipline: "jiu",
        audience: "adult",
        trial_date: "2026-07-06",
        trial_time: "18:00",
        followup_message: "Listo Ana 🙌",
      },
    ]),
    sendReplyResp("high"),
  ]);
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl,
  });

  const r = await brain.respond(ctx("lunes 6pm jiu"));
  assert.equal(r.action, "book");
  if (r.action !== "book") return;
  assert.deepEqual(r.bookings, [
    {
      name: "Ana",
      discipline: "jiu",
      audience: "adult",
      trialDate: "2026-07-06",
      trialTime: "18:00",
      phone: "5215512345678",
      recordId: "recXYZ",
    },
  ]);
  assert.equal(r.recordId, "recXYZ");
  assert.equal(r.followupMessage, "Listo Ana 🙌");
});

test("API error → draft apology with reason api_error", async () => {
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const brain = createBrain({
    apiKey: "k",
    kb: "KB",
    airtable: okAirtable,
    accrueUsage: async () => {},
    fetchImpl: failing,
  });
  const r = await brain.respond(ctx("hola"));
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.equal(r.reason, "api_error");
    assert.ok(r.message.length > 0);
  }
});

test("computeCost applies intro pricing across token classes", () => {
  const cost = computeCost({
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  // $2 input + $10 output + $0.20 cache read + $4 1h cache write = $16.20
  assert.ok(Math.abs(cost - 16.2) < 1e-9, `cost was ${cost}`);
});

// ---- awaiting_reply mapping (read-the-room holding-line guard) ----

import { sendResult } from "../src/brain/claude.js";

const sendReplyUse = (input: Record<string, unknown>) => ({
  type: "tool_use" as const,
  id: "tu_1",
  name: "send_reply",
  input,
});

test("sendResult: awaiting_reply=false maps to awaitingReply false", () => {
  const r = sendResult(
    sendReplyUse({
      message: "¡Con gusto!",
      language: "es",
      confidence: "low",
      awaiting_reply: false,
    }),
  );
  assert.equal(r.action, "draft");
  if (r.action === "draft") assert.equal(r.awaitingReply, false);
});

test("sendResult: awaiting_reply omitted defaults to true (safe hold)", () => {
  const r = sendResult(
    sendReplyUse({ message: "Hola", language: "es", confidence: "low" }),
  );
  if (r.action === "draft") assert.equal(r.awaitingReply, true);
});

test("sendResult: high confidence send carries awaitingReply too", () => {
  const r = sendResult(
    sendReplyUse({
      message: "Va",
      language: "es",
      confidence: "high",
      awaiting_reply: false,
    }),
  );
  assert.equal(r.action, "send");
  if (r.action === "send") assert.equal(r.awaitingReply, false);
});

// ---- sureness → confidence mapping (owner directive 2026-08-25) ----

test("sendResult: sureness >=75 sends, <75 drafts (the 75% threshold)", () => {
  for (const [sureness, action] of [
    [100, "send"],
    [75, "send"],
    [74, "draft"],
    [25, "draft"],
    [0, "draft"],
  ] as const) {
    const r = sendResult(
      sendReplyUse({ message: "Hola", language: "es", sureness, confidence: "low" }),
    );
    assert.equal(r.action, action, `sureness ${sureness}`);
    if (r.action === "send" || r.action === "draft") {
      assert.equal(r.sureness, sureness);
      assert.equal(r.confidence, action === "send" ? "high" : "low");
    }
  }
});

test("sendResult: sureness OVERRIDES a contradictory confidence enum", () => {
  // The model set the legacy field wrong; the number is the source of truth.
  const low = sendResult(
    sendReplyUse({ message: "Hola", language: "es", sureness: 10, confidence: "high" }),
  );
  assert.equal(low.action, "draft");
  const high = sendResult(
    sendReplyUse({ message: "Hola", language: "es", sureness: 99, confidence: "low" }),
  );
  assert.equal(high.action, "send");
});

test("sendResult: out-of-range sureness is clamped and rounded", () => {
  const over = sendResult(
    sendReplyUse({ message: "Hola", language: "es", sureness: 140, confidence: "low" }),
  );
  assert.equal(over.action, "send", "140 must clamp to 100 and send");
  if (over.action === "send") assert.equal(over.sureness, 100);

  const under = sendResult(
    sendReplyUse({ message: "Hola", language: "es", sureness: -20, confidence: "high" }),
  );
  assert.equal(under.action, "draft", "-20 must clamp to 0 and draft");
  if (under.action === "draft") assert.equal(under.sureness, 0);

  const fractional = sendResult(
    sendReplyUse({ message: "Hola", language: "es", sureness: 74.6, confidence: "low" }),
  );
  // 74.6 rounds to 75 — at the threshold, so it sends.
  assert.equal(fractional.action, "send");
  if (fractional.action === "send") assert.equal(fractional.sureness, 75);
});

test("sendResult: a numeric STRING sureness still parses", () => {
  const r = sendResult(
    sendReplyUse({ message: "Hola", language: "es", sureness: "80", confidence: "low" }),
  );
  assert.equal(r.action, "send");
  if (r.action === "send") assert.equal(r.sureness, 80);
});

test("sendResult: missing/garbage sureness falls back to the enum, with no number", () => {
  for (const input of [
    { message: "Hola", language: "es", confidence: "high" },
    { message: "Hola", language: "es", sureness: "muy seguro", confidence: "high" },
    { message: "Hola", language: "es", sureness: null, confidence: "high" },
  ]) {
    const r = sendResult(sendReplyUse(input));
    assert.equal(r.action, "send", JSON.stringify(input));
    if (r.action === "send") {
      assert.equal(r.confidence, "high");
      assert.equal(r.sureness, undefined, "no invented number");
    }
  }
  const low = sendResult(sendReplyUse({ message: "Hola", language: "es" }));
  assert.equal(low.action, "draft");
  if (low.action === "draft") assert.equal(low.sureness, undefined);
});

test("sendResult: a low-sureness draft keeps its escalation reason", () => {
  const r = sendResult(
    sendReplyUse({
      message: "Hola",
      language: "es",
      sureness: 30,
      confidence: "low",
      escalation_reason: "precio no aprobado",
    }),
  );
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.equal(r.reason, "precio no aprobado");
    assert.equal(r.sureness, 30);
  }
});

// ---- guardUnbackedBookingClaim -------------------------------------------
import { guardUnbackedBookingClaim } from "../src/brain/claude.js";
import type { BrainResult } from "../src/types.js";

function sendRes(message: string): BrainResult {
  return {
    action: "send",
    message,
    language: "es",
    confidence: "high",
    sureness: 95,
    awaitingReply: true,
  };
}

test("guard downgrades an 'agendado' claim with no booking to a low draft", () => {
  const r = guardUnbackedBookingClaim(sendRes("¡Perfecto! Ya quedó agendado 🙌 Nos vemos el sábado a las 2 pm."));
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.equal(r.confidence, "low");
    assert.ok(/booking/i.test(r.reason ?? ""));
    // The model's 95 is discarded: a guarded draft must never best-bet itself
    // out an hour later (services/slack-timeouts.ts).
    assert.equal(r.sureness, undefined);
    assert.ok(r.reason!.startsWith("⚠️"), "the guard marker the pipeline keys on");
  }
});

test("guard lets a claim through when a recent REAL booking backs it", () => {
  // 2026-08-26 incident: after the brain booked a trial, every later
  // "nos vemos mañana" ack was demoted to a low draft because the guard had
  // no memory of the booking. A recordedBooking marker (read from kv by the
  // pipeline, <72h) backs the claim.
  const r = guardUnbackedBookingClaim(
    sendRes("¡Perfecto! Ya quedó agendado 🙌 Nos vemos el sábado a las 2 pm."),
    { ts: 1_787_700_000, trialDate: "2026-08-29", trialTime: "14:00" },
  );
  assert.equal(r.action, "send");
  if (r.action === "send") assert.equal(r.sureness, 95);
});

test("guard leaves offers to book (infinitive) untouched", () => {
  const r = guardUnbackedBookingClaim(sendRes("¿Te gustaría agendar tu clase muestra? Puedo agendarte el sábado."));
  assert.equal(r.action, "send");
});

test("guard leaves normal replies untouched", () => {
  const r = guardUnbackedBookingClaim(sendRes("La clase es sábado a las 2 pm, ¡te esperamos!"));
  assert.equal(r.action, "send");
});

// ---- guardUnverifiedSlotClaim --------------------------------------------
// Audit backstop: a reply that NAMES a day+hour+discipline the grid doesn't
// have, without ever calling book_trial. Fixed clock: Monday 2026-08-24.
import { guardUnverifiedSlotClaim } from "../src/brain/claude.js";

const MON = { nowCdmx: "2026-08-24T10:00" };

function draftRes(message: string, reason?: string): BrainResult {
  return reason
    ? { action: "draft", message, language: "es", confidence: "low", reason, awaitingReply: true }
    : { action: "draft", message, language: "es", confidence: "low", awaitingReply: true };
}

test("slot guard leaves a real adult slot on send", () => {
  // Sábado 9 am Jiu-Jitsu (adultos) is on the generated grid.
  const r = guardUnverifiedSlotClaim(
    sendRes("Nos vemos el sábado a las 9 am para Jiu-Jitsu 🙌"),
    MON,
  );
  assert.equal(r.action, "send");
});

test("slot guard downgrades an invented Friday-evening Muay Thai claim", () => {
  const r = guardUnverifiedSlotClaim(
    sendRes("¿Te late el viernes a las 7 pm para Muay Thai? 💪"),
    MON,
  );
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.equal(r.confidence, "low");
    assert.match(r.reason ?? "", /viernes 19:00/);
    assert.match(r.reason ?? "", /no existe en el calendario/);
  }
});

test("slot guard ignores a message without a full date+time+discipline parse", () => {
  const r = guardUnverifiedSlotClaim(sendRes("Te esperamos mañana a las 7 pm 🙌"), MON);
  assert.equal(r.action, "send");
});

test("slot guard passes a kid-only slot (sábado 12 pm Muay Thai niños)", () => {
  // Invalid for the adult grid, valid for the kid grid — must not trigger.
  const r = guardUnverifiedSlotClaim(
    sendRes("Nos vemos el sábado a las 12 pm para Muay Thai niños 🙌"),
    MON,
  );
  assert.equal(r.action, "send");
});

test("slot guard keeps a draft a draft and appends its reason", () => {
  const r = guardUnverifiedSlotClaim(
    draftRes("¿Te late el viernes a las 7 pm para Muay Thai?", "motivo previo"),
    MON,
  );
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.match(r.reason ?? "", /motivo previo/);
    assert.match(r.reason ?? "", /no existe en el calendario/);
  }
});

test("slot guard is idempotent (no duplicate reason)", () => {
  const once = guardUnverifiedSlotClaim(
    sendRes("¿Te late el viernes a las 7 pm para Muay Thai?"),
    MON,
  );
  const twice = guardUnverifiedSlotClaim(once, MON);
  if (twice.action === "draft" && once.action === "draft") {
    assert.equal(twice.reason, once.reason);
  }
});

test("slot guard leaves escalations alone", () => {
  const esc: BrainResult = { action: "escalate", reason: "queja", summary: "queja" };
  assert.equal(guardUnverifiedSlotClaim(esc, MON).action, "escalate");
});

// ---- impossible-hour tier (multi-offer copy) ------------------------------
// Live 2026-08-25: a Box lead was offered "hoy Box a las 9 pm, o mañana
// miércoles a las 7 u 8 am". Box runs Tue 9 pm / Thu 9 pm / Sat 2 pm only.

const BOX_MORNING =
  "Claro, sin bronca 🙌 Si te late, hoy mismo tenemos Box a las 9 pm, o si prefieres, mañana miércoles a las 7 u 8 am.";

test("guard flags an hour the named discipline never runs, on any day", () => {
  const r = guardUnverifiedSlotClaim(sendRes(BOX_MORNING), MON);
  assert.equal(r.action, "draft");
  assert.match(String((r as { reason?: string }).reason), /Boxing a las 07:00, 08:00/);
  assert.match(String((r as { reason?: string }).reason), /NUNCA se imparte a esa hora/);
  // Sureness dropped ⇒ the 1h best-bet timeout can't deliver it unreviewed.
  assert.equal((r as { sureness?: number }).sureness, undefined);
});

test("guard names the discipline's real hours so the approver can fix it", () => {
  const r = guardUnverifiedSlotClaim(sendRes(BOX_MORNING), MON);
  assert.match(String((r as { reason?: string }).reason), /14:00, 21:00/);
});

test("guard leaves a three-slot offer of REAL hours alone", () => {
  // The persona allows up to three slots, spanning two days.
  const r = guardUnverifiedSlotClaim(
    sendRes("¿Te queda bien hoy a las 6 pm, 7 pm, o mañana a las 7 am? A esa hora toca Muay Thai 🙌"),
    MON,
  );
  assert.equal(r.action, "send");
});

test("guard does not cross-pair two offers naming DIFFERENT disciplines", () => {
  // Box 9 pm and Muay Thai 7 am are both real; only a crossed pairing
  // ("miércoles 21:00 Box") would look wrong, and that slot was never offered.
  const r = guardUnverifiedSlotClaim(
    sendRes("Hoy tenemos Box a las 9 pm, o Muay Thai mañana a las 7 am 🙌"),
    MON,
  );
  assert.equal(r.action, "send");
});

test("guard still catches a single invented slot (pairing tier intact)", () => {
  const r = guardUnverifiedSlotClaim(
    sendRes("Te esperamos el domingo a las 5 pm para Jiu-Jitsu."),
    MON,
  );
  assert.equal(r.action, "draft");
});

test("a draft already carrying a reason keeps it and appends the new one", () => {
  const r = guardUnverifiedSlotClaim(draftRes(BOX_MORNING, "motivo previo"), MON);
  assert.equal(r.action, "draft");
  assert.match(String((r as { reason?: string }).reason), /motivo previo/);
  assert.match(String((r as { reason?: string }).reason), /NUNCA se imparte/);
});
