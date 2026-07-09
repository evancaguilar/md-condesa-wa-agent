import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrain, computeCost } from "../src/brain/claude.js";
import type { AirtablePort, Contact, ConvoContext } from "../src/types.js";

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

/** Build a fake fetch that returns each queued Anthropic response in order. */
function mockFetch(responses: unknown[]): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let i = 0;
  const fn = async (): Promise<Response> => {
    const payload = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  };
  return { fetchImpl: fn as unknown as typeof fetch, calls: () => i };
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
