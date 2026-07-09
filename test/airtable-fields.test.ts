import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPatchFields,
  buildLeadFields,
  schemaSummary,
  leadsMap,
  phoneMatchFormula,
  classifyResult,
  DEFAULT_LEADS_MAP,
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
// Engine mechanics are asserted against the English DEFAULT_LEADS_MAP; the
// active client map (Spanish CRM columns) is covered separately below.

test("buildLeadFields fills Name when current has none", () => {
  const f = buildLeadFields(
    null,
    { phone: "5215500000000", name: "Ana" },
    DEFAULT_LEADS_MAP,
  );
  assert.equal(f["Name"], "Ana");
  assert.equal(f["Phone E164"], "+5215500000000");
  assert.equal(f["Source"], "WhatsApp");
});

test("buildLeadFields does NOT clobber an existing Name", () => {
  const f = buildLeadFields(
    { Name: "Manual Edit", Source: "Web" },
    { phone: "5215500000000", name: "Ana" },
    DEFAULT_LEADS_MAP,
  );
  assert.equal("Name" in f, false);
  assert.equal("Source" in f, false); // Source already set → not clobbered
});

test("buildLeadFields sets Campaña whenever provided (not fill-if-empty)", () => {
  const f = buildLeadFields(
    { Campaña: "Old" },
    { phone: "521", campaignName: "Promo matutino" },
    DEFAULT_LEADS_MAP,
  );
  assert.equal(f["Campaña"], "Promo matutino");
});

test("buildLeadFields Ad is fill-if-empty", () => {
  const filled = buildLeadFields(
    null,
    { phone: "521", ad: "Headline (123)" },
    DEFAULT_LEADS_MAP,
  );
  assert.equal(filled["Ad"], "Headline (123)");
  const kept = buildLeadFields(
    { Ad: "Existing" },
    { phone: "521", ad: "New" },
    DEFAULT_LEADS_MAP,
  );
  assert.equal("Ad" in kept, false);
});

// ---- md-condesa client map (real Spanish CRM columns) --------------------

test("leadsMap resolves md-condesa's Spanish column names", () => {
  const m = leadsMap();
  assert.equal(m.phone, "# de Teléfono");
  assert.equal(m.name, "Nombre de Lead");
  assert.equal(m.trialDateTime, "Fecha Clase Prueba");
  assert.equal(m.source, "Canal");
  assert.equal(m.sourceValue, "WA");
  assert.equal(m.result, "Resultado Clase Prueba");
  assert.equal(m.disciplineIsMulti, true);
  assert.equal(m.disciplineValues["jiu"], "BJJ");
  assert.equal(m.disciplineValues["jiu:kid"], "BJJ Kids");
  assert.equal(m.audienceValues["adult"], "Adultos");
});

test("buildLeadFields writes the active client's Spanish columns by default", () => {
  const f = buildLeadFields(null, { phone: "5215500000000", name: "Ana" });
  assert.equal(f["# de Teléfono"], "+5215500000000");
  assert.equal(f["Nombre de Lead"], "Ana");
  assert.equal(f["Canal"], "WA");
});

test("phoneMatchFormula matches on last-10 digits of a cleaned column", () => {
  const fml = phoneMatchFormula("# de Teléfono", "5534260813");
  assert.ok(fml.includes('RIGHT('));
  assert.ok(fml.includes('{# de Teléfono}&""'));
  assert.ok(fml.endsWith('"5534260813"'));
  // strips every separator seen in the real CRM data
  for (const sep of ['" "', '"-"', '"("', '")"', '"+"']) {
    assert.ok(fml.includes(sep), `missing separator ${sep}`);
  }
});

test("classifyResult: enrollment wins over no-show in a multi-select join", () => {
  assert.equal(classifyResult("No asistió, Se inscribió"), "enrolled");
  assert.equal(classifyResult("No asistió"), "no_show");
  assert.equal(classifyResult("Reprogramó"), null);
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
