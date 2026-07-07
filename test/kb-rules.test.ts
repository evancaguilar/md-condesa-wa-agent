// Pure-logic tests for the Airtable-rule proposal validation helper factored out
// of kb-editor.ts (WS-2). validateRuleActions is deps-free — it takes the parsed
// actions + a fresh BaseSchema and returns {ok, reason?, createdOptions}. The
// trigger/create side of applyAirtableRule needs D1 + Airtable and is exercised
// manually per docs/airtable-rules-plan.md §Verification.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRuleActions } from "../src/services/rule-actions.js";
import type { BaseSchema } from "../src/services/airtable.js";
import type { RuleAction } from "../src/types.js";

const SCHEMA: BaseSchema = {
  table: "Leads",
  fields: [
    { name: "Name", type: "singleLineText" },
    { name: "Actividad", type: "singleSelect", choices: ["Box", "Baby Fight Club"] },
    { name: "Tags", type: "multipleSelects", choices: ["#a", "#b"] },
    { name: "Notas", type: "multilineText" },
    { name: "Nivel", type: "singleSelect" }, // select with no options yet
  ],
};

test("set on an existing text field is ok, no created options", () => {
  const actions: RuleAction[] = [{ op: "set", field: "Name", value: "Ana" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, []);
});

test("set an existing select option is ok, no created options", () => {
  const actions: RuleAction[] = [{ op: "set", field: "Actividad", value: "Box" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, []);
});

test("set a NEW single-select option is allowed and reported as createdOption", () => {
  const actions: RuleAction[] = [
    { op: "set", field: "Actividad", value: "Kickboxing" },
  ];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, ["Kickboxing"]);
});

test("add a NEW multi-select option is allowed and reported as createdOption", () => {
  const actions: RuleAction[] = [{ op: "add", field: "Tags", value: "#promo" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, ["#promo"]);
});

test("add an already-present multi-select option creates nothing", () => {
  const actions: RuleAction[] = [{ op: "add", field: "Tags", value: "#a" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, []);
});

test("a select with no options yet treats any value as a created option", () => {
  const actions: RuleAction[] = [{ op: "set", field: "Nivel", value: "Principiante" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, ["Principiante"]);
});

test("createdOptions dedupes repeated new values across actions", () => {
  const actions: RuleAction[] = [
    { op: "add", field: "Tags", value: "#promo" },
    { op: "add", field: "Tags", value: "#promo" },
  ];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, ["#promo"]);
});

test("unknown field fails with unknown_field", () => {
  const actions: RuleAction[] = [{ op: "set", field: "Inexistente", value: "x" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_field");
});

test("add on a non-multiselect field fails with bad_action", () => {
  const actions: RuleAction[] = [{ op: "add", field: "Actividad", value: "Box" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_action");
});

test("add on a single-line text field fails with bad_action", () => {
  const actions: RuleAction[] = [{ op: "add", field: "Name", value: "x" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_action");
});

test("set with an empty value fails with bad_action", () => {
  const actions: RuleAction[] = [{ op: "set", field: "Name", value: "" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_action");
});

test("clear needs no value and is ok on any existing field", () => {
  const actions: RuleAction[] = [{ op: "clear", field: "Tags" }];
  const r = validateRuleActions(actions, SCHEMA);
  assert.ok(r.ok);
  assert.deepEqual(r.createdOptions, []);
});

test("empty actions list fails with bad_action", () => {
  const r = validateRuleActions([], SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_action");
});

test("the first failing action short-circuits and reports no created options", () => {
  const actions: RuleAction[] = [
    { op: "add", field: "Tags", value: "#new" }, // would-be createdOption
    { op: "set", field: "Inexistente", value: "x" }, // unknown_field
  ];
  const r = validateRuleActions(actions, SCHEMA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_field");
  assert.deepEqual(r.createdOptions, []);
});
