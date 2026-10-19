import { test } from "node:test";
import assert from "node:assert/strict";
import { nivel0TemplateInputs, SEED_KEY } from "../src/cron/template-seed-nivel0.js";
import { buildCreateTemplatePayload } from "../src/services/blast-templates.js";

test("Nivel 0 announcement templates: es + en, Marketing, 2 variables with samples, BAJA footer, quick replies", () => {
  const inputs = nivel0TemplateInputs();
  assert.deepEqual(inputs.map((i) => i.name), ["bfc_nivel0_viernes_es", "bfc_nivel0_viernes_en"]);
  for (const i of inputs) {
    assert.equal(i.category, "MARKETING");
    const vars = i.body.match(/\{\{\d\}\}/g) ?? [];
    assert.deepEqual(vars, ["{{1}}", "{{2}}"]);
    assert.equal(i.bodyExamples?.length, 2);
    assert.match(i.footer ?? "", /BAJA/);
    assert.equal(i.buttons?.length, 2);
    assert.match(i.body, /12 pm/);
    assert.doesNotMatch(i.body, /\{nombre\}|https?:/);
    const payload = buildCreateTemplatePayload(i) as { components: { type: string }[] };
    assert.deepEqual(payload.components.map((c) => c.type), ["BODY", "FOOTER", "BUTTONS"]);
  }
  assert.match(SEED_KEY, /^tpl_seed:bfc_nivel0:/);
});
