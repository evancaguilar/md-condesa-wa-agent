import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandFromAgeMonths,
  bandFromQualification,
  childAgeMonthsFromText,
  isNivel0,
  slotFitsAge,
  slotMatchesBand,
} from "../src/services/age-band.js";
import { SLOTS } from "../src/brain/slots.gen.js";

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

test("slotFitsAge: Nivel 0 Friday 12 pm is [6,12) months, Wed/Sat are [12,36); unknown age fits all", () => {
  const nivel0 = { weekday: 4, time: "12:00", discipline: "baby", audience: "adult" as const, group: "baby" as const, months: [6, 12] as [number, number] };
  const regular = { weekday: 2, time: "13:00", discipline: "baby", audience: "adult" as const, group: "baby" as const, months: [12, 36] as [number, number] };
  assert.equal(slotFitsAge(nivel0, 7), true);
  assert.equal(slotFitsAge(nivel0, 12), false);
  assert.equal(slotFitsAge(nivel0, 5), false);
  assert.equal(slotFitsAge(regular, 7), false);
  assert.equal(slotFitsAge(regular, 12), true);
  assert.equal(slotFitsAge(regular, 35), true);
  assert.equal(slotFitsAge(regular, null), true);
  assert.equal(slotFitsAge(regular, undefined), true);
  assert.equal(slotMatchesBand(nivel0, "baby", 7), true);
  assert.equal(slotMatchesBand(nivel0, "baby", 24), false);
  assert.equal(slotMatchesBand(regular, "baby", 24), true);
  assert.equal(slotMatchesBand(regular, "baby"), true); // age unknown → band only
  assert.equal(isNivel0(6), true);
  assert.equal(isNivel0(11), true);
  assert.equal(isNivel0(12), false);
  assert.equal(isNivel0(null), false);
});

test("generated schedule carries the Nivel 0 Friday 12 pm row and age windows on every BFC trial", () => {
  const baby = SLOTS.filter((s) => s.discipline === "baby" && s.trial !== false);
  assert.ok(baby.some((s) => s.weekday === 4 && s.time === "12:00" && s.months?.[0] === 6 && s.months?.[1] === 12));
  assert.ok(baby.every((s) => Array.isArray(s.months)));
  // A 7-month-old sees only Friday; a 2-year-old never sees Friday.
  assert.deepEqual([...new Set(baby.filter((s) => slotMatchesBand(s, "baby", 7)).map((s) => s.weekday))], [4]);
  assert.ok(!baby.filter((s) => slotMatchesBand(s, "baby", 24)).some((s) => s.weekday === 4));
});
