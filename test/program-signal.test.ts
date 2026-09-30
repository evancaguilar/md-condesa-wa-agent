import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeProgramSignal, programSignalFromText } from "../src/services/program-signal.js";
import { classifyProgram } from "../src/cron/nudge-copy.js";
import type { Contact } from "../src/types.js";

test("baby: bare ages 1–2, months, baby words (real messages)", () => {
  assert.equal(programSignalFromText("2 años"), "baby"); // 2026-09-23, the Leo Meza case
  assert.equal(programSignalFromText("Mi bebé tiene 8 meses"), "baby");
  assert.equal(programSignalFromText("tiene 18 meses"), "baby");
  assert.equal(programSignalFromText("es para mi bebé"), "baby");
  assert.equal(programSignalFromText("info de baby fight club"), "baby");
  assert.equal(programSignalFromText("tiene 1 año"), "baby");
  assert.equal(programSignalFromText("20 meses"), "baby");
});

test("kids: ages 3–12 about a third person, child words", () => {
  assert.equal(programSignalFromText("Diego tiene 10 años"), "kids");
  assert.equal(programSignalFromText("Hola buenas noches\nMi hija cumplió cinco años"), "kids");
  assert.equal(programSignalFromText("Mi hija cumplió 5"), "kids");
  assert.equal(programSignalFromText("5 añitos"), "kids");
  assert.equal(programSignalFromText("Entre semana no puedo llevar a mi nieto"), "kids");
  assert.equal(programSignalFromText("es para mi hijo"), "kids");
});

test("no signal: adult talking about themselves, time spans, unrelated numbers", () => {
  assert.equal(programSignalFromText("Tengo 25 años"), null);
  assert.equal(programSignalFromText("entreno hace 2 años"), null);
  assert.equal(programSignalFromText("después de 2 años sin entrenar"), null);
  assert.equal(programSignalFromText("6 pm"), null);
  assert.equal(programSignalFromText("llevo 6 meses entrenando"), null);
  assert.equal(programSignalFromText("hace 3 meses dejé el gym"), null);
  assert.equal(programSignalFromText("Sí, por favor"), null);
  assert.equal(programSignalFromText("tiene 30 años mi esposo"), null);
  assert.equal(programSignalFromText(""), null);
  assert.equal(programSignalFromText(null), null);
});

test("merge: fills the gap, never overrides a booking's audience", () => {
  assert.deepEqual(mergeProgramSignal({}, "baby"), { audience: "kid", discipline: "baby" });
  assert.deepEqual(mergeProgramSignal({ goal: "x" }, "kids"), { goal: "x", audience: "kid" });
  assert.equal(mergeProgramSignal({ audience: "adult", discipline: "jiu" }, "baby"), null);
  assert.equal(mergeProgramSignal({ audience: "kid", discipline: "baby" }, "kids"), null);
  assert.deepEqual(mergeProgramSignal({ audience: "kid" }, "baby"), { audience: "kid", discipline: "baby" });
  assert.equal(mergeProgramSignal({ audience: "kid", discipline: "jiu" }, "baby"), null);
  assert.equal(mergeProgramSignal({}, null), null);
});

test("end to end: a 'Sitio web' parent who said '2 años' now classifies as baby, not adults", () => {
  const base: Contact = {
    phone: "5217292658534", name: "x", lang: "es", status: "lead", qualification: null,
    human_override_until: null, last_inbound_at: null, campaign_id: null, ad_ref: null,
    airtable_lead_id: null, created_at: 0, updated_at: 0,
  };
  assert.equal(classifyProgram(base, "Sitio web"), "adults");
  const q = mergeProgramSignal({}, programSignalFromText("2 años"))!;
  assert.equal(classifyProgram({ ...base, qualification: JSON.stringify(q) }, "Sitio web"), "baby");
});
