import { test } from "node:test";
import assert from "node:assert/strict";
import { greetingName } from "../src/cron/display-name.js";
import { nudgeCopy } from "../src/cron/nudge-copy.js";
import type { Contact } from "../src/types.js";

// ---- accepted: real first names (decoration stripped, casing normalized) ----

test("plain first name passes through", () => {
  assert.equal(greetingName("Pam"), "Pam");
});

test("first token of a full name", () => {
  assert.equal(greetingName("raul ramirez"), "Raul");
});

test("trailing symbol garnish is stripped", () => {
  assert.equal(greetingName("jesse♡"), "Jesse");
});

test("emoji garnish on both sides is stripped", () => {
  assert.equal(greetingName("🌌 Zaira Covian 🌷"), "Zaira");
});

test("repeated emoji suffix is stripped", () => {
  assert.equal(greetingName("Zuley😘😘😘"), "Zuley");
});

test("accented names survive", () => {
  assert.equal(greetingName("Ángel"), "Ángel");
});

test("hyphenated and apostrophe names survive", () => {
  assert.equal(greetingName("D'Angelo"), "D'angelo");
  assert.equal(greetingName("Ana-María López"), "Ana-maría");
});

// ---- rejected: not a person's first name -----------------------------------

test("email address → no name (the live orco_publicidad@yahoo.com case)", () => {
  assert.equal(greetingName("orco_publicidad@yahoo.com"), "");
});

test("handle with underscore → no name", () => {
  assert.equal(greetingName("md_condesa"), "");
});

test("name containing digits → no name", () => {
  assert.equal(greetingName("opala120812"), "");
});

test("fancy unicode font → no name (math letters are not Latin script)", () => {
  assert.equal(greetingName("𝙂𝙧𝙞𝙢𝙢𝙟𝙤̄𝙬"), "");
});

test("url-ish profile name → no name", () => {
  assert.equal(greetingName("mdcondesa.com"), "");
  assert.equal(greetingName("www.gimnasio"), "");
});

test("vowel-less initials → no name", () => {
  assert.equal(greetingName("HM"), "");
});

test("single letter → no name", () => {
  assert.equal(greetingName("A"), "");
});

test("article-led nickname → no name (never '¡Hola El!')", () => {
  assert.equal(greetingName("El Shadow"), "");
});

test("business-inbox words → no name", () => {
  assert.equal(greetingName("Ventas"), "");
  assert.equal(greetingName("info"), "");
  assert.equal(greetingName("Publicidad"), "");
});

test("empty / null / whitespace → no name", () => {
  assert.equal(greetingName(""), "");
  assert.equal(greetingName(null), "");
  assert.equal(greetingName(undefined), "");
  assert.equal(greetingName("   "), "");
});

test("emoji-only profile name → no name", () => {
  assert.equal(greetingName("🔥🔥"), "");
});

// ---- integration: the exact live message that triggered this ---------------

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215573757239",
    name: null,
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: 0,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as Contact;
}

test("nudge never greets a junk push name", () => {
  const body = nudgeCopy(contact({ name: "orco_publicidad@yahoo.com" }), "nudge_1h");
  assert.ok(!body.includes("orco"), "junk name must not appear in the message");
  assert.ok(body.startsWith("¡Hola!"), `expected bare greeting, got: ${body}`);
});

test("nudge still greets a good push name", () => {
  const body = nudgeCopy(contact({ name: "Pam" }), "nudge_1h");
  assert.ok(body.startsWith("¡Hola Pam!"), body);
});

test("baby-campaign lead gets BABY day-1 copy, not the adults pitch", () => {
  // The live bug: campaign-only lead (no qualification) received the adults
  // copy — "bajar de peso ... defenderse" + the adults booking link.
  const body = nudgeCopy(contact(), "nudge_6h", "baby fight club");
  assert.ok(body.includes("Baby Fight Club"), body);
  assert.ok(!body.includes("bajar de peso"), "must not send the adults pitch");
  assert.ok(!body.includes("clase-prueba-adultos"), "must not send the adults link");
});

test("baby-campaign lead gets the baby step-1 copy", () => {
  const body = nudgeCopy(contact(), "nudge_1h", "baby fight club");
  assert.ok(body.includes("tu bebé"), body);
});

test("no campaign name → adults copy (unchanged fallback)", () => {
  const body = nudgeCopy(contact(), "nudge_6h");
  assert.ok(body.includes("bajar de peso"), body);
});
