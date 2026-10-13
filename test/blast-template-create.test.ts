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

test("buildCreateTemplatePayload: IMAGE header handle comes first, URL button carries its example", () => {
  const p = buildCreateTemplatePayload({
    name: "student_x",
    language: "es",
    category: "UTILITY",
    header: { type: "IMAGE", handle: "4::aW1hZ2U=" },
    body: "Tu QR.",
    buttons: [
      {
        type: "URL",
        text: "Firmar responsiva",
        url: "https://responsiva.mdcondesa.com/?rid={{1}}",
        example: ["https://responsiva.mdcondesa.com/?rid=recJGBLgxBbsGqrf0"],
      },
    ],
  });
  assert.deepEqual(p.components, [
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1hZ2U="] } },
    { type: "BODY", text: "Tu QR." },
    {
      type: "BUTTONS",
      buttons: [
        {
          type: "URL",
          text: "Firmar responsiva",
          url: "https://responsiva.mdcondesa.com/?rid={{1}}",
          example: ["https://responsiva.mdcondesa.com/?rid=recJGBLgxBbsGqrf0"],
        },
      ],
    },
  ]);
});

test("buildCreateTemplatePayload: an empty URL example is omitted (static URLs unchanged)", () => {
  const p = buildCreateTemplatePayload({
    name: "a",
    language: "es",
    category: "MARKETING",
    body: "Hola.",
    buttons: [{ type: "URL", text: "Ver", url: "https://x.test/", example: [] }],
  });
  assert.deepEqual((p.components as Record<string, unknown>[])[1], {
    type: "BUTTONS",
    buttons: [{ type: "URL", text: "Ver", url: "https://x.test/" }],
  });
});
