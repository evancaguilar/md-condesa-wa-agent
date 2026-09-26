import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCreateTemplatePayload } from "../src/services/blast-templates.js";
import { BLAST_PER_TICK_MAX } from "../src/services/blast.js";

test("buildCreateTemplatePayload: body vars get examples, footer + URL button", () => {
  const p = buildCreateTemplatePayload({
    name: "promo_x",
    language: "es",
    category: "MARKETING",
    body: "¡Hola {{1}}! Promo hasta mañana.",
    footer: "Responde BAJA para dejar de recibir mensajes.",
    buttons: [{ type: "URL", text: "Ver promos", url: "https://mdcondesa.com/promos-independencia/" }],
  });
  const comps = p.components as Record<string, unknown>[];
  assert.equal(p.name, "promo_x");
  assert.equal(p.category, "MARKETING");
  assert.deepEqual(comps[0], {
    type: "BODY",
    text: "¡Hola {{1}}! Promo hasta mañana.",
    example: { body_text: [["Ana"]] },
  });
  assert.deepEqual(comps[1], { type: "FOOTER", text: "Responde BAJA para dejar de recibir mensajes." });
  assert.deepEqual(comps[2], {
    type: "BUTTONS",
    buttons: [{ type: "URL", text: "Ver promos", url: "https://mdcondesa.com/promos-independencia/" }],
  });
});

test("buildCreateTemplatePayload: no vars → no example block", () => {
  const p = buildCreateTemplatePayload({ name: "a", language: "es", category: "MARKETING", body: "Hola." });
  assert.deepEqual(p.components, [{ type: "BODY", text: "Hola." }]);
});

test("per-tick cap raised for Workers Paid", () => {
  assert.equal(BLAST_PER_TICK_MAX, 75);
});
