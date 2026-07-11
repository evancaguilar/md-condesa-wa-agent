import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstReplyFor,
  firstReplyKey,
  matchCampaign,
  matchCampaignByAdId,
  normalizeText,
} from "../src/pipeline/campaigns.js";
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
    ad_id: null,
    first_reply: null,
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

// ---- matchCampaignByAdId -------------------------------------------------

test("ad-id match returns the campaign whose ad_id equals the source id", () => {
  const id = matchCampaignByAdId("120210000000012345", [
    campaign({ id: 4, ad_id: "999" }),
    campaign({ id: 8, ad_id: "120210000000012345" }),
  ]);
  assert.equal(id, 8);
});

test("ad-id match returns null when nothing matches", () => {
  const id = matchCampaignByAdId("nope", [campaign({ id: 8, ad_id: "120210000000012345" })]);
  assert.equal(id, null);
});

test("ad-id match returns null on empty/undefined source id", () => {
  assert.equal(matchCampaignByAdId(null, [campaign({ ad_id: "1" })]), null);
  assert.equal(matchCampaignByAdId(undefined, [campaign({ ad_id: "1" })]), null);
  assert.equal(matchCampaignByAdId("", [campaign({ ad_id: "1" })]), null);
});

test("ad-id match ignores campaigns with null ad_id", () => {
  const id = matchCampaignByAdId("123", [campaign({ id: 3, ad_id: null })]);
  assert.equal(id, null);
});

test("ad-id match supports a comma/whitespace-separated id list", () => {
  const c = campaign({ id: 5, ad_id: "111, 222,333\n444" });
  assert.equal(matchCampaignByAdId("222", [c]), 5);
  assert.equal(matchCampaignByAdId("444", [c]), 5);
  assert.equal(matchCampaignByAdId("22", [c]), null); // no partial-id match
});

// ---- firstReplyFor --------------------------------------------------------

test("firstReplyFor returns the trimmed welcome for a fresh lead", () => {
  const c = campaign({ first_reply: "  Hola, gracias por escribirnos!  " });
  assert.equal(firstReplyFor(c, false), "Hola, gracias por escribirnos!");
});

test("firstReplyFor returns null when the phone already has an outbound message", () => {
  const c = campaign({ first_reply: "Hola!" });
  assert.equal(firstReplyFor(c, true), null);
});

test("firstReplyFor returns null when first_reply is null", () => {
  const c = campaign({ first_reply: null });
  assert.equal(firstReplyFor(c, false), null);
});

test("firstReplyFor returns null when first_reply is empty string", () => {
  const c = campaign({ first_reply: "" });
  assert.equal(firstReplyFor(c, false), null);
});

test("firstReplyFor returns null when first_reply is whitespace-only", () => {
  const c = campaign({ first_reply: "   \n\t  " });
  assert.equal(firstReplyFor(c, false), null);
});

test("firstReplyFor returns null when the property is absent (pre-migration row shape)", () => {
  // SELECT * on a pre-migration DB simply lacks the column; simulate via a cast.
  const { first_reply, ...rest } = campaign();
  const preMigration = rest as Campaign;
  assert.equal(firstReplyFor(preMigration, false), null);
});

test("firstReplyFor returns null for a null campaign", () => {
  assert.equal(firstReplyFor(null, false), null);
});

test("firstReplyFor returns null for an undefined campaign", () => {
  assert.equal(firstReplyFor(undefined, false), null);
});

// ---- firstReplyKey ---------------------------------------------------------

test("firstReplyKey shape", () => {
  assert.equal(firstReplyKey("5215512345678"), "first_reply_sent:5215512345678");
});
