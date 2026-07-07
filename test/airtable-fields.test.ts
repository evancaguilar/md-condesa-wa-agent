import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPatchFields,
  buildLeadFields,
  schemaSummary,
  type BaseSchema,
} from "../src/services/airtable.js";
import type { RuleAction } from "../src/types.js";

// ---- buildPatchFields ---------------------------------------------------

test("buildPatchFields set overwrites", () => {
  const p = buildPatchFields({ Actividad: "Old" }, [
    { op: "set", field: "Actividad", value: "Baby Fight Club" },
  ]);
  assert.deepEqual(p, { Actividad: "Baby Fight Club" });
});

test("buildPatchFields add unions into existing multi-select", () => {
  const p = buildPatchFields({ Tags: ["#a", "#b"] }, [
    { op: "add", field: "Tags", value: "#c" },
  ]);
  assert.deepEqual(p, { Tags: ["#a", "#b", "#c"] });
});

test("buildPatchFields add dedupes an already-present value", () => {
  const p = buildPatchFields({ Tags: ["#a", "#b"] }, [
    { op: "add", field: "Tags", value: "#a" },
  ]);
  assert.deepEqual(p, { Tags: ["#a", "#b"] });
});

test("buildPatchFields add coerces a scalar string current value to an array", () => {
  const p = buildPatchFields({ Tags: "#a" }, [
    { op: "add", field: "Tags", value: "#b" },
  ]);
  assert.deepEqual(p, { Tags: ["#a", "#b"] });
});

test("buildPatchFields add on empty/missing field starts a fresh array", () => {
  const p = buildPatchFields({}, [{ op: "add", field: "Tags", value: "#x" }]);
  assert.deepEqual(p, { Tags: ["#x"] });
});

test("buildPatchFields clear sets null", () => {
  const p = buildPatchFields({ Tags: ["#a"] }, [{ op: "clear", field: "Tags" }]);
  assert.deepEqual(p, { Tags: null });
});

test("buildPatchFields unions multiple adds to the same field in one batch", () => {
  const actions: RuleAction[] = [
    { op: "add", field: "Tags", value: "#a" },
    { op: "add", field: "Tags", value: "#b" },
    { op: "add", field: "Tags", value: "#a" },
  ];
  const p = buildPatchFields({}, actions);
  assert.deepEqual(p, { Tags: ["#a", "#b"] });
});

// ---- buildLeadFields (fill-if-empty) ------------------------------------

test("buildLeadFields fills Name when current has none", () => {
  const f = buildLeadFields(null, { phone: "5215500000000", name: "Ana" });
  assert.equal(f["Name"], "Ana");
  assert.equal(f["Phone E164"], "5215500000000");
  assert.equal(f["Source"], "WhatsApp");
});

test("buildLeadFields does NOT clobber an existing Name", () => {
  const f = buildLeadFields({ Name: "Manual Edit", Source: "Web" }, {
    phone: "5215500000000",
    name: "Ana",
  });
  assert.equal("Name" in f, false);
  assert.equal("Source" in f, false); // Source already set → not clobbered
});

test("buildLeadFields sets Campaña whenever provided (not fill-if-empty)", () => {
  const f = buildLeadFields({ Campaña: "Old" }, {
    phone: "521",
    campaignName: "Promo matutino",
  });
  assert.equal(f["Campaña"], "Promo matutino");
});

test("buildLeadFields Ad is fill-if-empty", () => {
  const filled = buildLeadFields(null, { phone: "521", ad: "Headline (123)" });
  assert.equal(filled["Ad"], "Headline (123)");
  const kept = buildLeadFields({ Ad: "Existing" }, { phone: "521", ad: "New" });
  assert.equal("Ad" in kept, false);
});

// ---- schemaSummary ------------------------------------------------------

test("schemaSummary truncates a field's options to first 12 + (+N más)", () => {
  const choices = Array.from({ length: 15 }, (_, i) => `opt${i + 1}`);
  const schema: BaseSchema = {
    table: "Leads",
    fields: [{ name: "Actividad", type: "singleSelect", choices }],
  };
  const out = schemaSummary(schema);
  assert.ok(out.includes("opt1"));
  assert.ok(out.includes("opt12"));
  assert.equal(out.includes("opt13"), false);
  assert.ok(out.includes("(+3 más)"));
});

test("schemaSummary respects the token cap by dropping trailing fields", () => {
  const fields = Array.from({ length: 200 }, (_, i) => ({
    name: `Field_${i}_with_a_fairly_long_name`,
    type: "singleLineText",
  }));
  const schema: BaseSchema = { table: "Leads", fields };
  const capped = schemaSummary(schema, 50);
  const lineCount = capped.split("\n").length;
  assert.ok(lineCount < 200, "should drop fields past the cap");
  assert.ok(lineCount >= 1, "should keep at least one field");
});
