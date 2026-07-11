import { test } from "node:test";
import assert from "node:assert/strict";
import { isOptOut } from "../src/pipeline/opt-out.js";

// ---- positives ------------------------------------------------------------

test("isOptOut: baja", () => {
  assert.equal(isOptOut("baja"), true);
});

test("isOptOut: Baja. (trailing punctuation)", () => {
  assert.equal(isOptOut("Baja."), true);
});

test("isOptOut:  BAJA  (case + surrounding whitespace)", () => {
  assert.equal(isOptOut(" BAJA "), true);
});

test("isOptOut: stop", () => {
  assert.equal(isOptOut("stop"), true);
});

test("isOptOut: Alto!", () => {
  assert.equal(isOptOut("Alto!"), true);
});

test("isOptOut: unsubscribe", () => {
  assert.equal(isOptOut("unsubscribe"), true);
});

test("isOptOut: Ya no me envíen mensajes (accents)", () => {
  assert.equal(isOptOut("Ya no me envíen mensajes"), true);
});

test("isOptOut: no me envien más mensajes. (accent + trailing period)", () => {
  assert.equal(isOptOut("no me envien más mensajes."), true);
});

test("isOptOut: Quiero darme de baja", () => {
  assert.equal(isOptOut("Quiero darme de baja"), true);
});

test("isOptOut: ya no me manden mensajes", () => {
  assert.equal(isOptOut("ya no me manden mensajes"), true);
});

// ---- negatives (no substring matching) -------------------------------------

test("isOptOut: false for hola quiero info", () => {
  assert.equal(isOptOut("hola quiero info"), false);
});

test("isOptOut: false for baja de peso (contains baja, not exact)", () => {
  assert.equal(isOptOut("baja de peso"), false);
});

test("isOptOut: false for alto rendimiento (contains alto, not exact)", () => {
  assert.equal(isOptOut("alto rendimiento"), false);
});

test("isOptOut: false for no me envien el video (not the exact phrase)", () => {
  assert.equal(isOptOut("no me envien el video"), false);
});

test("isOptOut: false for quiero darme de baja del curso (extra words)", () => {
  assert.equal(isOptOut("quiero darme de baja del curso"), false);
});

test("isOptOut: false for stop, mejor mándame la info (extra words)", () => {
  assert.equal(isOptOut("stop, mejor mándame la info"), false);
});
