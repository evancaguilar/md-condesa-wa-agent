import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffButtonTemplate, isOptOutButton } from "../src/pipeline/promo-button.js";

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
