// Pure blast planning: audience split, pacing, payload round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_PER_TICK,
  blastComponents,
  blastDueAt,
  decodeBlastNote,
  encodeBlastNote,
  planBlastAudience,
} from "../src/services/blast.js";
import { cdmxParts, cdmxToEpoch } from "../src/cron/time.js";
import type { Contact } from "../src/types.js";

function contact(over: Partial<Contact> & { campaign_name?: string | null } = {}): Contact & {
  campaign_name?: string | null;
} {
  return {
    phone: "5215500000000",
    name: null,
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: 1_787_000_000,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 1_787_000_000,
    updated_at: 1_787_000_000,
    campaign_name: null,
    ...over,
  };
}

const NOW = 1_787_900_000;

test("planBlastAudience: splits by program and excludes booked / active / non-leads", () => {
  const contacts = [
    contact({ phone: "5215500000001", campaign_name: "Reto Gladiador" }),
    contact({ phone: "5215500000002", campaign_name: "Kids" }),
    contact({ phone: "5215500000003", campaign_name: "baby fight club" }),
    contact({ phone: "5215500000004", campaign_name: "Reto Gladiador" }), // booked
    contact({ phone: "5215500000005", last_inbound_at: NOW - 3600 }), // in-window
    contact({ phone: "5215500000006", status: "student" }),
    contact({ phone: "5215500000007", status: "opted_out" }),
  ];
  const a = planBlastAudience(contacts, new Set(["5215500000004"]), NOW);
  assert.deepEqual(a.adults.map((c) => c.phone), ["5215500000001"]);
  assert.deepEqual(a.kids.map((c) => c.phone), ["5215500000002"]);
  assert.deepEqual(a.baby.map((c) => c.phone), ["5215500000003"]);
  assert.deepEqual(a.excluded, { booked: 1, inWindow: 1, notLead: 2 });
  // The open-window lead is NOT lost: it lands in the freeform bucket.
  assert.deepEqual(a.inWindow.adults.map((c) => c.phone), ["5215500000005"]);
});

test("blast note: freeform txt survives the round-trip", () => {
  const p = { t: "", l: "", p2: "", txt: "¡Hola! Mañana sábado hay clase 🙌" };
  assert.deepEqual(decodeBlastNote(encodeBlastNote(p)), p);
});

test("planBlastAudience: qualification audience=kid routes to kids without a campaign", () => {
  const a = planBlastAudience(
    [contact({ phone: "5215500000008", qualification: JSON.stringify({ audience: "kid" }) })],
    new Set(),
    NOW,
  );
  assert.equal(a.kids.length, 1);
  assert.equal(a.adults.length, 0);
});

test("blastDueAt: paces 50 per 5-min tick and never leaves 09:00-21:00", () => {
  const start = cdmxToEpoch(2026, 8, 29, 9, 30, 0);
  assert.equal(blastDueAt(0, start), start);
  assert.equal(blastDueAt(BATCH_PER_TICK - 1, start), start);
  assert.equal(blastDueAt(BATCH_PER_TICK, start), start + 300);
  // Recipient #250 (cap 250) rolls to the NEXT day at 09:00.
  const nextDay = blastDueAt(250, start, 250);
  const p = cdmxParts(nextDay);
  assert.equal(p.day, 30);
  assert.equal(p.hour, 9);
});

test("blastDueAt: a late-evening start clamps into the next morning", () => {
  const start = cdmxToEpoch(2026, 8, 29, 21, 30, 0);
  const p = cdmxParts(blastDueAt(0, start));
  assert.equal(p.day, 30);
  assert.equal(p.hour, 9);
});

test("blast note round-trips; garbage decodes to null", () => {
  const p = { t: "adult_follow_up", l: "es_MX", p2: "sábado 9:00 am" };
  assert.deepEqual(decodeBlastNote(encodeBlastNote(p)), p);
  const zero = { t: "bebe", l: "es_MX", p2: "", n: 0 as const };
  assert.deepEqual(decodeBlastNote(encodeBlastNote(zero)), zero);
  assert.equal(decodeBlastNote("not json"), null);
  assert.equal(decodeBlastNote(null), null);
  assert.equal(decodeBlastNote(JSON.stringify({ t: "x" })), null);
});

test("blastComponents: body with {{1}} greeting and {{2}} class text", () => {
  const c = blastComponents("Ana", "sábado 2 pm") as {
    type: string;
    parameters: { type: string; text: string }[];
  }[];
  assert.equal(c.length, 1);
  assert.equal(c[0]!.type, "body");
  assert.deepEqual(
    c[0]!.parameters.map((x) => x.text),
    ["Ana", "sábado 2 pm"],
  );
});
