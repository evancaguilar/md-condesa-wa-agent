import { test } from "node:test";
import assert from "node:assert/strict";
import { adultSelfSignal, programSignalUpdate } from "../src/services/program-signal.js";
import { shouldSkipCannedWelcome } from "../src/pipeline/campaigns.js";
import { detectLanguage } from "../src/services/lang-detect.js";
import { classifyProgram } from "../src/cron/nudge-copy.js";
import type { Campaign, Contact } from "../src/types.js";

function campaign(p: Partial<Campaign>): Campaign {
  return {
    id: 13,
    name: "X",
    trigger_phrase: "",
    trigger_norm: "",
    info: "",
    status: "active",
    ends_at: null,
    ad_id: null,
    first_reply: null,
    ad_keywords: null,
    created_at: 0,
    updated_at: 0,
    ...p,
  };
}

// Live config 2026-10-24: the "Jiu-Jitsu Kids" ad also prefills an adult line.
const JIU_KIDS = campaign({
  name: "fw jiu-jitsu kids (anuncios generales)",
  trigger_phrase: "Quiero info de las clases de Jiu-Jitsu para niños",
  first_reply:
    "Hola 🙌 Gracias por tu interés en nuestras clases de Jiu-Jitsu para niños. El primer día es GRATIS. ¿Qué edad tiene tu peque? 😄",
});
const MMA = campaign({
  name: "fw mma (anuncios generales)",
  trigger_phrase: "Quiero info de MMA",
  first_reply: "Hola 🙌 Gracias por escribir a MD Condesa. MMA es lo que ves en la UFC…",
});

test("adultSelfSignal: adults about themselves, never a parent", () => {
  assert.equal(adultSelfSignal("Hola! Quiero info de las clases de Jiu-Jitsu para adulto 🥋"), true); // ANG, 2026-10-24
  assert.equal(adultSelfSignal("Quiero para mi"), true);
  assert.equal(adultSelfSignal("Soy adulto tengo 29"), true);
  assert.equal(adultSelfSignal("es para mí, tengo 30"), true);
  assert.equal(adultSelfSignal("¿Tienen clases para adultos?"), true);
  assert.equal(adultSelfSignal("It's for me"), true);
  assert.equal(adultSelfSignal("Quiero info para mi hijo"), false);
  assert.equal(adultSelfSignal("para mi hija de 5 años"), false);
  assert.equal(adultSelfSignal("Quiero info de las clases de Jiu-Jitsu para niños"), false);
});

test("shouldSkipCannedWelcome: an adult on the kids welcome gets the brain, not the kids pitch", () => {
  assert.equal(shouldSkipCannedWelcome("Hola! Quiero info de las clases de Jiu-Jitsu para adulto 🥋", JIU_KIDS), true);
  // The bare kids prefill keeps the instant welcome.
  assert.equal(shouldSkipCannedWelcome("Hola! Quiero info de las clases de Jiu-Jitsu para niños", JIU_KIDS), false);
  // An adult welcome is already right for an adult.
  assert.equal(shouldSkipCannedWelcome("Quiero info de MMA para mí", MMA), false);
});

test("programSignalUpdate: 'para adulto' / 'soy adulto' files the lead as adults, even on a kids campaign", () => {
  const base: Contact = {
    phone: "5215535306909", name: "ANG", lang: "es", status: "lead", qualification: null,
    human_override_until: null, last_inbound_at: null, campaign_id: 13, ad_ref: null,
    airtable_lead_id: null, created_at: 0, updated_at: 0,
  };
  assert.equal(classifyProgram(base, JIU_KIDS.name), "kids");
  const q = programSignalUpdate({ discipline: "jiu" }, { body: "Soy adulto tengo 29" })!;
  assert.deepEqual(q, { discipline: "jiu", audience: "adult", program: "adults" });
  assert.equal(classifyProgram({ ...base, qualification: JSON.stringify(q) }, JIU_KIDS.name), "adults");
  // A parent stays a parent; a stated child's age is never overridden.
  assert.equal(programSignalUpdate({}, { body: "Quiero para mi hijo" })?.audience, "kid");
  assert.equal(programSignalUpdate({ audience: "kid", child_age_months: 60, program: "kids" }, { body: "para mí también" }), null);
});

test("detectLanguage: Thilo's messages are English; Spanish stays Spanish; unclear is null", () => {
  assert.equal(detectLanguage("Hey team"), "en"); // Thilo, 2026-10-24
  assert.equal(detectLanguage("Thilo here, visiting cdmx this week. Is there any no-go bjj today?"), "en");
  assert.equal(detectLanguage("Unfortunately I'm already gone tomorrow"), "en");
  assert.equal(detectLanguage("But thanks for the info!"), "en");
  assert.equal(detectLanguage("Hi, how much are the classes?"), "en");
  assert.equal(detectLanguage("Hola! Quiero info de las clases de Jiu-Jitsu para adulto 🥋"), "es");
  assert.equal(detectLanguage("Gracias"), "es");
  assert.equal(detectLanguage("Mañana no creo, pero el lunes si se puede estaría mejor"), "es");
  assert.equal(detectLanguage("Soy adulto tengo 29"), "es");
  assert.equal(detectLanguage("ok"), null);
  assert.equal(detectLanguage("👍"), null);
  assert.equal(detectLanguage("Hi, quiero info"), null);
  assert.equal(detectLanguage("9 meses"), null);
});
