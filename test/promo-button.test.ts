import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handoffButtonTemplate,
  isOptOutButton,
  isOptOutButtonLabel,
  OPT_OUT_BUTTON_EN,
  OPT_OUT_BUTTON_ES,
  OPT_OUT_BUTTON_LABELS,
} from "../src/pipeline/promo-button.js";
import { normalizeText } from "../src/pipeline/campaigns.js";
import { isOptOut } from "../src/pipeline/opt-out.js";

const T = "halloween_promo_prueba_oct26";
const sent = { direction: "out_bot", ts: 100, body: `[template:${T}]` };

test("handoffButtonTemplate: the Sí tap on the Halloween template hands off", () => {
  assert.equal(handoffButtonTemplate("button", "Sí, quiero saber", [sent]), T);
});

test("handoffButtonTemplate: everything else keeps the normal flow", () => {
  assert.equal(handoffButtonTemplate("button", "No me interesa", [sent]), null);
  assert.equal(handoffButtonTemplate("text", "Sí, quiero saber", [sent]), null);
  assert.equal(handoffButtonTemplate("button", "Sí, quiero saber", []), null);
  // A newer template wins: this tap answers that one.
  assert.equal(
    handoffButtonTemplate("button", "Sí, quiero saber", [sent, { direction: "out_bot", ts: 200, body: "[template:otra]" }]),
    null,
  );
  // Free-form messages after the template don't change which template it answers.
  assert.equal(
    handoffButtonTemplate("button", "Sí, quiero saber", [sent, { direction: "in", ts: 150, body: "hola" }, { direction: "out_bot", ts: 160, body: "Hola!" }]),
    T,
  );
});

test("isOptOutButton: only the promo's No me interesa button is a baja", () => {
  assert.equal(isOptOutButton("button", "No me interesa", [sent]), true);
  assert.equal(isOptOutButton("button", "Sí, quiero saber", [sent]), false);
  assert.equal(isOptOutButton("text", "No me interesa", [sent]), false);
  assert.equal(isOptOutButton("button", "No me interesa", [{ direction: "out_bot", ts: 100, body: "[template:otra]" }]), false);
});

// --- One-tap opt-out quick reply on any template (2026-11-05) ---

const nudge = { direction: "out_bot", ts: 100, body: "[template:nudge_d2_adults_es]" };

test("opt-out label: canonical labels normalize into the label set", () => {
  assert.equal(OPT_OUT_BUTTON_ES, "No recibir mensajes");
  assert.equal(OPT_OUT_BUTTON_EN, "Stop messages");
  assert.ok(OPT_OUT_BUTTON_LABELS.has(normalizeText(OPT_OUT_BUTTON_ES)));
  assert.ok(OPT_OUT_BUTTON_LABELS.has(normalizeText(OPT_OUT_BUTTON_EN)));
  // Meta caps quick-reply text at 25 chars.
  assert.ok(OPT_OUT_BUTTON_ES.length <= 25 && OPT_OUT_BUTTON_EN.length <= 25);
});

test("opt-out label: every label on a button tap is a baja, case/accents/punctuation ignored", () => {
  for (const label of [
    "No recibir mensajes",
    "No recibir más mensajes",
    "Dejar de recibir mensajes",
    "Stop promotions",
    "Stop messages",
    "  STOP MESSAGES. ",
    "no recibir mensajes 🙏",
  ]) {
    assert.equal(isOptOutButtonLabel("button", label), true, label);
  }
});

test("opt-out label: typed text and other buttons are not this path", () => {
  assert.equal(isOptOutButtonLabel("text", "No recibir mensajes"), false);
  assert.equal(isOptOutButtonLabel("interactive", "Stop messages"), false);
  assert.equal(isOptOutButtonLabel(undefined, "Stop messages"), false);
  assert.equal(isOptOutButtonLabel("button", "Sí, quiero agendar"), false);
  assert.equal(isOptOutButtonLabel("button", "No recibir mensajes de otros"), false);
  // The typed-text detector is unchanged: these words typed by hand were not an
  // opt-out before and are still not one (only the button tap counts).
  assert.equal(isOptOut("No recibir mensajes"), false);
  assert.equal(isOptOut("Dejar de recibir mensajes"), false);
});

test("isOptOutButton: the generic label counts on any template, even with no history", () => {
  assert.equal(isOptOutButton("button", "No recibir mensajes", [nudge]), true);
  assert.equal(isOptOutButton("button", "Stop messages", []), true);
  assert.equal(isOptOutButton("button", "No recibir mensajes", [sent]), true);
  assert.equal(isOptOutButton("text", "No recibir mensajes", [nudge]), false);
  // Existing promo behavior still holds.
  assert.equal(isOptOutButton("button", "No me interesa", [sent]), true);
  assert.equal(isOptOutButton("button", "No me interesa", [nudge]), false);
});
