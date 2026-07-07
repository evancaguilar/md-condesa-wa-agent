import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleOverlay,
  estimateTokens,
  OVERLAY_HEADER,
} from "../src/brain/overlay.js";
import type { KbSection } from "../src/types.js";

function section(over: Partial<KbSection> = {}): KbSection {
  return {
    id: 1,
    title: "T",
    content: "C",
    sort: 100,
    enabled: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

test("empty sections → empty overlay", () => {
  assert.equal(assembleOverlay([]), "");
});

test("all-disabled sections → empty overlay", () => {
  const out = assembleOverlay([
    section({ id: 1, enabled: 0 }),
    section({ id: 2, enabled: 0 }),
  ]);
  assert.equal(out, "");
});

test("overlay starts with the override header", () => {
  const out = assembleOverlay([section({ title: "Precios", content: "niños $450" })]);
  assert.ok(out.startsWith(OVERLAY_HEADER));
  assert.ok(out.includes("ESTO manda"));
});

test("enabled section renders as ## title + content", () => {
  const out = assembleOverlay([section({ title: "Horario", content: "sábado 10am" })]);
  assert.ok(out.includes("## Horario\nsábado 10am"));
});

test("disabled sections are excluded, enabled kept", () => {
  const out = assembleOverlay([
    section({ id: 1, title: "Activa", content: "sí", enabled: 1 }),
    section({ id: 2, title: "Inactiva", content: "no", enabled: 0 }),
  ]);
  assert.ok(out.includes("## Activa"));
  assert.ok(!out.includes("## Inactiva"));
});

test("sections sort by (sort ASC, id ASC)", () => {
  const out = assembleOverlay([
    section({ id: 3, title: "C", content: "c", sort: 200 }),
    section({ id: 1, title: "A", content: "a", sort: 100 }),
    section({ id: 2, title: "B", content: "b", sort: 100 }),
  ]);
  const iA = out.indexOf("## A");
  const iB = out.indexOf("## B");
  const iC = out.indexOf("## C");
  // sort 100 (A id1, B id2) before sort 200 (C); within sort 100, id ASC.
  assert.ok(iA < iB, "A before B (same sort, lower id)");
  assert.ok(iB < iC, "B before C (lower sort)");
});

test("estimateTokens = ceil(chars / 3.5)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1); // 3/3.5 = 0.857 → 1
  assert.equal(estimateTokens("a".repeat(7)), 2); // 7/3.5 = 2
  assert.equal(estimateTokens("a".repeat(8)), 3); // 8/3.5 = 2.28 → 3
});
