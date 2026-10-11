import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandFromAgeMonths,
  bandFromQualification,
  childAgeMonthsFromText,
  slotMatchesBand,
} from "../src/services/age-band.js";

test("bandFromAgeMonths follows persona.md routing", () => {
  assert.equal(bandFromAgeMonths(8), "baby"); // Nivel 0 → baby copy, brain escalates
  assert.equal(bandFromAgeMonths(12), "baby");
  assert.equal(bandFromAgeMonths(35), "baby");
  assert.equal(bandFromAgeMonths(36), "mini");
  assert.equal(bandFromAgeMonths(4 * 12 + 11), "mini"); // "casi 5"
  assert.equal(bandFromAgeMonths(6 * 12), "kids");
  assert.equal(bandFromAgeMonths(12 * 12 + 11), "kids");
  assert.equal(bandFromAgeMonths(13 * 12), "teens");
  assert.equal(bandFromAgeMonths(17 * 12 + 11), "teens");
  assert.equal(bandFromAgeMonths(18 * 12), "adults");
});

test("childAgeMonthsFromText: the real phrasings from the audit", () => {
  const cases: [string, number | null][] = [
    ["Info para alguna disciplina de una niña de 4 años", 48], // Joss, 09-07
    ["Sábado 2 PM pero es una niña de casi 5 años", 60],
    ["Mi hijo tiene 3 años y medio", 42],
    ["tiene 18 meses", 18],
    ["1 año 10 meses", 22],
    ["cumplió 2 años", 24],
    ["va a cumplir 3", null], // no unit → not trusted
    ["Tengo 25 años y quiero bajar de peso", null],
    ["llevo 6 meses entrenando", null],
    ["entreno hace 2 años", null],
    ["Para mi hija de 7 años y para mí", 84],
    ["Son dos: uno de 3 y otra de 2 años", 24], // picks the explicit unit; the brain asks the rest
  ];
  for (const [text, months] of cases) {
    assert.equal(childAgeMonthsFromText(text), months, text);
  }
  // Bare number only when the bot just asked for the age (Jose, 10-11: "5").
  assert.equal(childAgeMonthsFromText("5"), null);
  assert.equal(childAgeMonthsFromText("5", { expectingAge: true }), 60);
});

test("bandFromQualification prefers stored age over legacy signals", () => {
  assert.equal(bandFromQualification(null), null);
  assert.equal(bandFromQualification({ discipline: "baby", audience: "kid" }), "baby");
  assert.equal(
    bandFromQualification({ discipline: "baby", audience: "kid", child_age_months: 58 }),
    "mini",
  );
  assert.equal(bandFromQualification({ program: "teens", audience: "kid" }), "teens");
  assert.equal(bandFromQualification({ audience: "adult" }), "adults");
  assert.equal(bandFromQualification({ audience: "kid" }), "kids");
});

test("slotMatchesBand uses the generated group, with a legacy fallback", () => {
  const mini = { weekday: 0, time: "15:15", discipline: "muay", audience: "kid" as const, pp: true, group: "mini" as const };
  const kids = { weekday: 0, time: "16:00", discipline: "muay", audience: "kid" as const, group: "kids" as const };
  const baby = { weekday: 2, time: "13:00", discipline: "baby", audience: "kid" as const, pp: true, group: "baby" as const };
  const adult = { weekday: 5, time: "14:00", discipline: "box", audience: "adult" as const, group: "adult" as const };
  assert.equal(slotMatchesBand(mini, "mini"), true);
  assert.equal(slotMatchesBand(mini, "kids"), false);
  assert.equal(slotMatchesBand(kids, "mini"), false);
  assert.equal(slotMatchesBand(baby, "baby"), true);
  assert.equal(slotMatchesBand(baby, "mini"), false);
  assert.equal(slotMatchesBand(adult, "adults"), true);
  assert.equal(slotMatchesBand(kids, "adults"), false);
  // legacy grid without group: pp + non-baby → mini, kid audience → kids
  assert.equal(slotMatchesBand({ ...mini, group: undefined }, "mini"), true);
  assert.equal(slotMatchesBand({ ...kids, group: undefined }, "kids"), true);
});
