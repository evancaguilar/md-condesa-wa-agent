import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystem,
  buildContextBlock,
  systemText,
  PERSONA_AND_POLICIES,
} from "../src/brain/prompt.js";
import type { Contact, ConvoContext } from "../src/types.js";

const KB_A = "## KB\n- horario: lunes 6pm jiu\n- precio: $499";

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

function ctx(overrides: Partial<ConvoContext> = {}): ConvoContext {
  return {
    phone: "5215512345678",
    contact: contact(),
    history: [],
    nowCdmx: "2026-07-06T18:30:00-06:00",
    weekday: "lunes",
    windowOpen: true,
    trainingWheels: true,
    ...overrides,
  };
}

test("buildSystem returns one static block with 1h ephemeral cache_control", () => {
  const sys = buildSystem(KB_A);
  assert.equal(sys.length, 1);
  assert.equal(sys[0]!.type, "text");
  assert.deepEqual(sys[0]!.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.ok(sys[0]!.text.includes(PERSONA_AND_POLICIES));
  assert.ok(sys[0]!.text.includes(KB_A));
});

test("system block is stable across calls (no volatile content)", () => {
  // Same KB → byte-identical system text on repeated calls: the cache key holds.
  const a = buildSystem(KB_A)[0]!.text;
  const b = buildSystem(KB_A)[0]!.text;
  assert.equal(a, b);
  assert.equal(a, systemText(KB_A));
  // No date/time/name leaked into the frozen prefix.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(PERSONA_AND_POLICIES), "no ISO date in persona");
  assert.ok(!PERSONA_AND_POLICIES.includes("5215512345678"), "no phone in persona");
});

test("context block carries CDMX datetime, weekday, and window status", () => {
  const block = buildContextBlock(ctx());
  assert.ok(block.startsWith("<context>"));
  assert.ok(block.includes("now (America/Mexico_City): 2026-07-06T18:30:00-06:00"));
  assert.ok(block.includes("weekday: lunes"));
  assert.ok(block.includes("24h window OPEN"));
  assert.ok(block.includes("phone: 5215512345678"));
});

test("context block renders qualification and closed-window status", () => {
  const block = buildContextBlock(
    ctx({
      windowOpen: false,
      contact: contact({
        name: "Ana",
        qualification: JSON.stringify({
          discipline: "jiu",
          audience: "adult",
          goal: "defensa personal",
        }),
      }),
    }),
  );
  assert.ok(block.includes("name: Ana"));
  assert.ok(block.includes("qual.discipline: jiu"));
  assert.ok(block.includes("qual.audience: adult"));
  assert.ok(block.includes("qual.goal: defensa personal"));
  assert.ok(block.includes("24h window CLOSED"));
});

test("context block survives malformed qualification JSON", () => {
  const block = buildContextBlock(ctx({ contact: contact({ qualification: "{bad" }) }));
  assert.ok(block.includes("<context>"));
  assert.ok(!block.includes("qual.discipline"));
});

// ---- two-block system (overlay) ------------------------------------------

test("buildSystem with empty/omitted overlay stays a single block (unchanged)", () => {
  const one = buildSystem(KB_A);
  const alsoOne = buildSystem(KB_A, "");
  assert.equal(one.length, 1);
  assert.equal(alsoOne.length, 1);
  assert.equal(one[0]!.text, alsoOne[0]!.text);
  assert.equal(one[0]!.text, systemText(KB_A));
});

test("buildSystem with a non-empty overlay appends a second cached block", () => {
  const overlay = "# ACTUALIZACIONES\n## Precios\nniños $450";
  const sys = buildSystem(KB_A, overlay);
  assert.equal(sys.length, 2);
  // Block 1 is byte-identical to the single-arg form (cache key preserved).
  assert.equal(sys[0]!.text, systemText(KB_A));
  assert.deepEqual(sys[0]!.cache_control, { type: "ephemeral", ttl: "1h" });
  // Block 2 carries the overlay with its own 1h ephemeral cache.
  assert.equal(sys[1]!.type, "text");
  assert.equal(sys[1]!.text, overlay);
  assert.deepEqual(sys[1]!.cache_control, { type: "ephemeral", ttl: "1h" });
});

// ---- campaign context block ----------------------------------------------

test("no campaign → no <campaign_info> block", () => {
  const block = buildContextBlock(ctx());
  assert.ok(!block.includes("<campaign_info>"));
});

test("campaign present → <campaign_info> with name and info", () => {
  const block = buildContextBlock(
    ctx({ campaign: { name: "Promo verano", info: "2x1 en clases de niños" } }),
  );
  assert.ok(block.includes("<campaign_info>"));
  assert.ok(block.includes("campaña: Promo verano"));
  assert.ok(block.includes("2x1 en clases de niños"));
  assert.ok(block.includes("El lead llegó por esta campaña; úsala para responder."));
  assert.ok(block.includes("</campaign_info>"));
  // The campaign block comes after the closed context block.
  assert.ok(block.indexOf("</context>") < block.indexOf("<campaign_info>"));
});
