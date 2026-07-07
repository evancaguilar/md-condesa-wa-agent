import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCampaign, normalizeText } from "../src/pipeline/campaigns.js";
import type { Campaign } from "../src/types.js";

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 1,
    name: "Promo",
    trigger_phrase: "Curso de defensa",
    trigger_norm: "curso de defensa",
    info: "info",
    status: "active",
    ends_at: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

// ---- normalizeText -------------------------------------------------------

test("normalizeText strips diacritics", () => {
  assert.equal(normalizeText("Anúncio de Defénsa"), "anuncio de defensa");
});

test("normalizeText lowercases", () => {
  assert.equal(normalizeText("HOLA Mundo"), "hola mundo");
});

test("normalizeText strips punctuation to spaces and collapses", () => {
  assert.equal(normalizeText("¡Curso!! de... defensa??"), "curso de defensa");
});

test("normalizeText collapses whitespace and trims", () => {
  assert.equal(normalizeText("  curso   de\tdefensa \n"), "curso de defensa");
});

test("normalizeText keeps numbers", () => {
  assert.equal(normalizeText("Promo 2x1!"), "promo 2x1");
});

// ---- matchCampaign -------------------------------------------------------

test("match on exact equality", () => {
  const id = matchCampaign("curso de defensa", [campaign()]);
  assert.equal(id, 1);
});

test("match on startsWith (body longer than trigger)", () => {
  const id = matchCampaign("curso de defensa me interesa mucho", [campaign()]);
  assert.equal(id, 1);
});

test("no match when body does not start with trigger", () => {
  const id = matchCampaign("hola quiero informacion", [campaign()]);
  assert.equal(id, null);
});

test("no match when trigger is a prefix of a different word run", () => {
  // Body "cursos..." does NOT start with "curso de defensa".
  const id = matchCampaign("cursos varios", [campaign()]);
  assert.equal(id, null);
});

test("empty campaign list → null", () => {
  assert.equal(matchCampaign("curso de defensa", []), null);
});

test("returns the first matching campaign id", () => {
  const id = matchCampaign("promo verano", [
    campaign({ id: 5, trigger_norm: "otra cosa" }),
    campaign({ id: 7, trigger_norm: "promo verano" }),
    campaign({ id: 9, trigger_norm: "promo" }),
  ]);
  assert.equal(id, 7);
});

test("ignores campaigns with empty trigger_norm", () => {
  const id = matchCampaign("cualquier cosa", [campaign({ id: 3, trigger_norm: "" })]);
  assert.equal(id, null);
});
