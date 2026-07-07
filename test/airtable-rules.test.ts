import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRule,
  ruleMatches,
  ruleSummaryEs,
} from "../src/services/airtable-rules.js";
import type { RuleAction, RuleTrigger } from "../src/types.js";

// ---- parseRule ----------------------------------------------------------

test("parseRule returns null on malformed trigger JSON", () => {
  assert.equal(parseRule("{not json", "[]"), null);
});

test("parseRule returns null on malformed actions JSON", () => {
  assert.equal(parseRule(JSON.stringify({ type: "always" }), "nope"), null);
});

test("parseRule returns null on unknown trigger type", () => {
  assert.equal(
    parseRule(JSON.stringify({ type: "weekday" }), JSON.stringify([{ op: "clear", field: "X" }])),
    null,
  );
});

test("parseRule returns null on empty actions", () => {
  assert.equal(parseRule(JSON.stringify({ type: "always" }), "[]"), null);
});

test("parseRule returns null on invalid action (missing value)", () => {
  const bad = JSON.stringify([{ op: "set", field: "Tags" }]);
  assert.equal(parseRule(JSON.stringify({ type: "always" }), bad), null);
});

test("parseRule returns null when campaign trigger lacks numeric id", () => {
  assert.equal(
    parseRule(JSON.stringify({ type: "campaign", campaignId: "5" }), JSON.stringify([{ op: "clear", field: "X" }])),
    null,
  );
});

test("parseRule parses a valid campaign rule", () => {
  const r = parseRule(
    JSON.stringify({ type: "campaign", campaignId: 7 }),
    JSON.stringify([{ op: "add", field: "Tags", value: "#promo" }]),
  );
  assert.ok(r);
  assert.deepEqual(r!.trigger, { type: "campaign", campaignId: 7 });
  assert.deepEqual(r!.actions, [{ op: "add", field: "Tags", value: "#promo" }]);
});

// ---- ruleMatches --------------------------------------------------------

test("ruleMatches always fires", () => {
  assert.equal(ruleMatches({ type: "always" }, { campaignId: null, program: "adults" }), true);
});

test("ruleMatches campaign fires on matching id", () => {
  const t: RuleTrigger = { type: "campaign", campaignId: 3 };
  assert.equal(ruleMatches(t, { campaignId: 3, program: "adults" }), true);
});

test("ruleMatches campaign does not fire on other id / null", () => {
  const t: RuleTrigger = { type: "campaign", campaignId: 3 };
  assert.equal(ruleMatches(t, { campaignId: 4, program: "adults" }), false);
  assert.equal(ruleMatches(t, { campaignId: null, program: "adults" }), false);
});

test("ruleMatches program fires on matching program only", () => {
  const t: RuleTrigger = { type: "program", program: "baby" };
  assert.equal(ruleMatches(t, { campaignId: null, program: "baby" }), true);
  assert.equal(ruleMatches(t, { campaignId: null, program: "kids" }), false);
});

// ---- ruleSummaryEs ------------------------------------------------------

test("ruleSummaryEs renders campaign + add + set (spec shape)", () => {
  const actions: RuleAction[] = [
    { op: "add", field: "Tags", value: "#promomatutino" },
    { op: "set", field: "Actividad", value: "Baby Fight Club" },
  ];
  const s = ruleSummaryEs({ type: "campaign", campaignId: 1 }, actions, "Promo matutino");
  assert.equal(
    s,
    "SI campaña «Promo matutino» ENTONCES Tags += #promomatutino · Actividad = Baby Fight Club",
  );
});

test("ruleSummaryEs falls back to #id when campaign name unknown", () => {
  const s = ruleSummaryEs({ type: "campaign", campaignId: 42 }, [{ op: "clear", field: "Tags" }]);
  assert.equal(s, "SI campaña «#42» ENTONCES Tags = (vacío)");
});

test("ruleSummaryEs renders program in Spanish", () => {
  const s = ruleSummaryEs({ type: "program", program: "kids" }, [{ op: "set", field: "Actividad", value: "Kids" }]);
  assert.equal(s, "SI programa niños ENTONCES Actividad = Kids");
});

test("ruleSummaryEs renders always", () => {
  const s = ruleSummaryEs({ type: "always" }, [{ op: "add", field: "Tags", value: "#lead" }]);
  assert.equal(s, "SI siempre ENTONCES Tags += #lead");
});
