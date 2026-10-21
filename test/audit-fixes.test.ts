// Fixes for the recurring defects the nightly Opus audits (2026-10-07 … 10-21)
// kept reporting. One file so the regression pins for that review live
// together; each block names the audit finding it pins.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bandSlot, copyInputsForBand } from "../src/cron/nudges.js";
import {
  classifyProgram,
  disciplineFromCampaign,
  isKidsCampaign,
  nudgeCopy,
} from "../src/cron/nudge-copy.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { Contact } from "../src/types.js";

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
