import { test } from "node:test";
import assert from "node:assert/strict";
import { chainTemplateBody, chainTemplateInputs, SEED_KEY } from "../src/cron/template-seed-chains.js";
import { postTrialTemplateName } from "../src/cron/post-trial.js";

const STEPS2 = ["post_trial_d3", "post_trial_d6", "no_show_hoy", "no_show_d2", "no_show_d7"];

test("chain seeder: exactly 34 templates (d0 kids/baby + 5 steps × 3 programs, × es/en), kv key", () => {
  assert.equal(SEED_KEY, "tpl_seed:chains:2026-10-15");
  const names = chainTemplateInputs().map((t) => t.name).sort();
  const expected: string[] = [];
  for (const l of ["es", "en"]) {
    expected.push(`post_trial_d0_kids_${l}`, `post_trial_d0_baby_${l}`);
    for (const s of STEPS2) for (const v of ["", "_kids", "_baby"]) expected.push(`${s}${v}_${l}`);
  }
  assert.deepEqual(names, expected.sort());
  assert.equal(names.length, 34);
  assert.equal(new Set(names).size, 34);
});

test("chain seeder: names match what the sender asks for per band", () => {
  const names = new Set(chainTemplateInputs().map((t) => t.name));
  for (const band of ["adults", "mini", "kids", "teens", "baby"] as const) {
    for (const kind of ["post_trial_d3", "post_trial_d6", "no_show_hoy", "no_show_d2", "no_show_d7"] as const) {
      assert.ok(names.has(`${postTrialTemplateName(kind, null, band)}_es`), `${kind} ${band}`);
    }
    if (band !== "adults") assert.ok(names.has(`${postTrialTemplateName("post_trial_d0", null, band)}_en`), band);
  }
});

test("chain seeder: placeholder shapes, examples, footer, category; no leftover {braces}", () => {
  for (const t of chainTemplateInputs()) {
    assert.equal(t.category, "MARKETING");
    assert.ok(t.footer && /BAJA/.test(t.footer), t.name);
    assert.ok(t.body.includes("{{1}}"), t.name);
    assert.equal(/\{(who|kid|day|cta|link)\}/.test(t.body), false, t.body);
    assert.equal(t.body.endsWith("}}"), false, t.body); // Meta rejects a trailing variable
    const two = t.body.includes("{{2}}");
    const wantsTwo = /^(post_trial_d3|post_trial_d6|no_show_hoy|no_show_d2)/.test(t.name);
    assert.equal(two, wantsTwo, t.name);
    assert.equal(t.bodyExamples?.length, wantsTwo ? 2 : 1, t.name);
    if (t.name.startsWith("post_trial_d6")) assert.ok(/^https?:\/\//.test(t.bodyExamples![1]!), t.name);
    if (t.name.includes("_baby")) {
      assert.ok(t.body.includes("Baby Fight Club"), t.body);
      assert.equal(/cuerpo|body/i.test(t.body), false, t.body);
    }
    if (t.name.startsWith("no_show_hoy")) assert.ok(/\b(hoy|today)\b/.test(t.body), t.body);
    if (t.name.startsWith("post_trial_d0")) assert.equal(/\b(hoy|ayer|today|yesterday)\b/.test(t.body), false, t.body);
  }
});

test("chainTemplateBody: {cta} → Tenemos {{2}}., {kid} → generic noun, capitalised at a sentence start", () => {
  assert.equal(
    chainTemplateBody("¡Hola{who}! Les guardamos la clase de {kid}. {cta}", "no_show_d2", "baby", "es"),
    "¡Hola {{1}}! Les guardamos la clase de su bebé. Tenemos {{2}}.",
  );
  assert.equal(
    chainTemplateBody("Hi{who}! 👋 {kid}'s trial counts. {cta}", "post_trial_d3", "kids", "en"),
    "Hi {{1}}! 👋 Your little one's trial counts. We have {{2}}.",
  );
  assert.equal(chainTemplateBody("Hola{who}, nos vemos {day}. Horarios: {link}", "post_trial_d6", "adults", "es"),
    "Hola {{1}}, nos vemos. Horarios: {{2}} 🥋");
});
