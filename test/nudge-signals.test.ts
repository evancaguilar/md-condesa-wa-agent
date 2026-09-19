import { test } from "node:test";
import assert from "node:assert/strict";
import { statedAges, ageConflictsWithProgram, hasBuyIntent, isDuplicateSend } from "../src/cron/nudge-signals.js";

test("statedAges reads years and months", () => {
  assert.deepEqual(statedAges(["Mi hijo tiene 3 años", "y la bebé de 10 meses"]), [
    { value: 3, unit: "years" },
    { value: 10, unit: "months" },
  ]);
  assert.deepEqual(statedAges(["hola, info por favor"]), []);
});

test("ageConflictsWithProgram: Kids campaign vs a 3-year-old / baby / teen; BFC vs a 4-year-old", () => {
  assert.equal(ageConflictsWithProgram("kids", ["tiene 3 años"]), true);
  assert.equal(ageConflictsWithProgram("kids", ["tiene 10 meses"]), true);
  assert.equal(ageConflictsWithProgram("kids", ["tiene 14 años"]), true);
  assert.equal(ageConflictsWithProgram("kids", ["tiene 8 años"]), false);
  assert.equal(ageConflictsWithProgram("kids", ["hola"]), false);
  assert.equal(ageConflictsWithProgram("baby", ["ya tiene 4 años"]), true);
  assert.equal(ageConflictsWithProgram("baby", ["tiene 18 meses"]), false);
  assert.equal(ageConflictsWithProgram("adults", ["tengo 35 años"]), false);
});

test("hasBuyIntent catches pay/enrol phrasing, not casual price questions", () => {
  assert.equal(hasBuyIntent(["Ya pagué la promo, cuándo puedo ir?"]), true);
  assert.equal(hasBuyIntent(["quiero inscribirme en línea"]), true);
  assert.equal(hasBuyIntent(["me mandas el link de pago?"]), true);
  assert.equal(hasBuyIntent(["cuánto cuesta la mensualidad?"]), false);
  assert.equal(hasBuyIntent(["me interesa el reto"]), false);
});

test("isDuplicateSend: same text within 24h only", () => {
  const now = 1_000_000;
  assert.equal(isDuplicateSend("Hola  🥋\nvengan", [{ body: "Hola 🥋 vengan", ts: now - 60 }], now), true);
  assert.equal(isDuplicateSend("Hola", [{ body: "Hola", ts: now - 2 * 86400 }], now), false);
  assert.equal(isDuplicateSend("Hola", [{ body: "Otra cosa", ts: now - 60 }], now), false);
});
