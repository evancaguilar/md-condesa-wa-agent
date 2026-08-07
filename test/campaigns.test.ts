import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adIdToLearn,
  adTextForMatch,
  firstReplyDecision,
  firstReplyFor,
  firstReplyKey,
  matchCampaign,
  matchCampaignByAdId,
  matchCampaignByAdText,
  matchCampaignTiered,
  normalizeText,
  parseAdKeywords,
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
    ad_keywords: null,
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

// Greeting drift: Meta ships the same prefill with and without "¡Hola!".
test("body without hola matches a trigger stored WITH hola", () => {
  const c = campaign({
    trigger_norm:
      "hola si quiero inscribirme en linea y asegurar mi lugar antes de que se acaben",
  });
  const id = matchCampaign(
    "si quiero inscribirme en linea y asegurar mi lugar antes de que se acaben",
    [c],
  );
  assert.equal(id, 1);
});

test("body WITH hola matches a trigger stored without it", () => {
  const c = campaign({ trigger_norm: "quiero el curso de defensa" });
  const id = matchCampaign("hola quiero el curso de defensa", [c]);
  assert.equal(id, 1);
});

test("greeting stripping does not create false positives mid-body", () => {
  // "hola" only strips at the START — a body about something else stays unmatched.
  const c = campaign({ trigger_norm: "curso de defensa" });
  assert.equal(matchCampaign("quiero decir hola al curso de defensa", [c]), null);
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

test("firstReplyDecision: new lead → first, regardless of referral", () => {
  assert.equal(
    firstReplyDecision({ hasPriorOutbound: false, hasReferral: false, hasActiveBooking: false }),
    "first",
  );
  assert.equal(
    firstReplyDecision({ hasPriorOutbound: false, hasReferral: true, hasActiveBooking: false }),
    "first",
  );
});

test("firstReplyDecision: returning ad click (referral) → resend, unless booked", () => {
  assert.equal(
    firstReplyDecision({ hasPriorOutbound: true, hasReferral: true, hasActiveBooking: false }),
    "resend",
  );
  assert.equal(
    firstReplyDecision({ hasPriorOutbound: true, hasReferral: true, hasActiveBooking: true }),
    "none",
  );
});

test("firstReplyDecision: trigger typed mid-chat without referral → none", () => {
  assert.equal(
    firstReplyDecision({ hasPriorOutbound: true, hasReferral: false, hasActiveBooking: false }),
    "none",
  );
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

// ---- parseAdKeywords ------------------------------------------------------

test("parseAdKeywords splits on commas preserving multi-word phrases", () => {
  assert.deepEqual(parseAdKeywords("reto gladiador, reto 30 días"), [
    "reto gladiador",
    "reto 30 dias",
  ]);
});

test("parseAdKeywords normalizes diacritics/case/punctuation", () => {
  assert.deepEqual(parseAdKeywords("¡RETO Gladiadór!"), ["reto gladiador"]);
});

test("parseAdKeywords drops empty entries", () => {
  assert.deepEqual(parseAdKeywords("a,, b ,"), ["a", "b"]);
});

test("parseAdKeywords tolerates null/undefined (pre-migration rows)", () => {
  assert.deepEqual(parseAdKeywords(null), []);
  assert.deepEqual(parseAdKeywords(undefined), []);
});

// ---- adTextForMatch -------------------------------------------------------

test("adTextForMatch joins headline and body normalized", () => {
  assert.equal(
    adTextForMatch({ headline: "¡Agenda tu Día Gratis!", body: "Así funciona el Reto Gladiador" }),
    "agenda tu dia gratis asi funciona el reto gladiador",
  );
});

test("adTextForMatch handles headline-only and body-only", () => {
  assert.equal(adTextForMatch({ headline: "Solo Titular", body: null }), "solo titular");
  assert.equal(adTextForMatch({ headline: null, body: "solo cuerpo" }), "solo cuerpo");
});

test("adTextForMatch: no referral or no text → empty string", () => {
  assert.equal(adTextForMatch(null), "");
  assert.equal(adTextForMatch(undefined), "");
  assert.equal(adTextForMatch({ headline: null, body: null }), "");
});

// ---- matchCampaignByAdText ------------------------------------------------

test("keyword phrase matches inside longer creative text", () => {
  const c = campaign({ ad_keywords: "reto gladiador" });
  const norm = adTextForMatch({ headline: "¡Agenda tu Día Gratis!", body: "Así funciona el Reto Gladiador: tú eliges" });
  assert.equal(matchCampaignByAdText(norm, [c]), 1);
});

test("whole-phrase guard: 'reto' does not match 'retorno'", () => {
  const c = campaign({ ad_keywords: "reto" });
  assert.equal(matchCampaignByAdText("retorno seguro garantizado", [c]), null);
  assert.equal(matchCampaignByAdText("unete al reto hoy", [c]), 1);
});

test("ANY-of across the keyword list", () => {
  const c = campaign({ ad_keywords: "muay thai kids, jiu jitsu kids" });
  assert.equal(matchCampaignByAdText("clases de jiu jitsu kids en condesa", [c]), 1);
});

test("campaign with null/absent ad_keywords is skipped", () => {
  const noCol = campaign();
  delete (noCol as Partial<Campaign>).ad_keywords; // pre-migration SELECT * shape
  assert.equal(matchCampaignByAdText("reto gladiador", [campaign(), noCol]), null);
});

test("empty ad text never matches", () => {
  assert.equal(matchCampaignByAdText("", [campaign({ ad_keywords: "reto" })]), null);
});

test("first campaign in list order wins a shared keyword (id DESC = newest)", () => {
  const newer = campaign({ id: 9, ad_keywords: "reto" });
  const older = campaign({ id: 2, ad_keywords: "reto" });
  assert.equal(matchCampaignByAdText("el reto empieza", [newer, older]), 9);
});

// ---- matchCampaignTiered --------------------------------------------------

test("tiered: trigger phrase beats ad_id and keywords (ice-breaker routing)", () => {
  // One ad (id 111) registered to campaign 3, but the lead sent campaign 5's
  // designed prefill — the phrase must win so several prefills on the SAME ad
  // can route to different campaigns.
  const byId = campaign({ id: 3, ad_id: "111", trigger_norm: "quiero probar primero" });
  const byTrigger = campaign({ id: 5, trigger_norm: "quiero inscribirme ya" });
  const m = matchCampaignTiered({
    sourceId: "111",
    adTextNorm: "el reto gladiador",
    bodyNorm: "quiero inscribirme ya por favor",
    campaigns: [byId, byTrigger],
  });
  assert.deepEqual(m, { id: 5, kind: "trigger" });
});

test("tiered: exact ad_id beats keywords when no trigger matches", () => {
  const byId = campaign({ id: 3, ad_id: "111", trigger_norm: "frase a" });
  const byKw = campaign({ id: 4, ad_keywords: "reto", trigger_norm: "frase b" });
  const m = matchCampaignTiered({
    sourceId: "111",
    adTextNorm: "el reto gladiador",
    bodyNorm: "hola quiero informacion",
    campaigns: [byKw, byId],
  });
  assert.deepEqual(m, { id: 3, kind: "ad_id" });
});

test("tiered: keywords match when neither trigger nor ad_id do", () => {
  const byKw = campaign({ id: 4, ad_keywords: "reto", trigger_norm: "frase b" });
  const m = matchCampaignTiered({
    sourceId: "999",
    adTextNorm: "unete al reto",
    bodyNorm: "hola quiero informacion",
    campaigns: [byKw],
  });
  assert.deepEqual(m, { id: 4, kind: "ad_text" });
});

test("tiered: falls through to trigger when no referral data matches", () => {
  const m = matchCampaignTiered({
    sourceId: null,
    adTextNorm: "",
    bodyNorm: "curso de defensa me interesa",
    campaigns: [campaign()],
  });
  assert.deepEqual(m, { id: 1, kind: "trigger" });
});

test("tiered: nothing matches → null", () => {
  const m = matchCampaignTiered({
    sourceId: "42",
    adTextNorm: "otro anuncio",
    bodyNorm: "hola",
    campaigns: [campaign()],
  });
  assert.equal(m, null);
});

// ---- adIdToLearn ----------------------------------------------------------

test("adIdToLearn: keyword/trigger matches learn the source id", () => {
  assert.equal(adIdToLearn({ id: 1, kind: "ad_text" }, "120249684011870518"), "120249684011870518");
  assert.equal(adIdToLearn({ id: 1, kind: "trigger" }, "123"), "123");
});

test("adIdToLearn: ad_id-tier match learns nothing (already registered)", () => {
  assert.equal(adIdToLearn({ id: 1, kind: "ad_id" }, "123"), null);
});

test("adIdToLearn: no match / no source id → null", () => {
  assert.equal(adIdToLearn(null, "123"), null);
  assert.equal(adIdToLearn({ id: 1, kind: "ad_text" }, null), null);
  assert.equal(adIdToLearn({ id: 1, kind: "ad_text" }, ""), null);
});

test("adIdToLearn: malformed source ids are rejected (SQL LIKE safety)", () => {
  assert.equal(adIdToLearn({ id: 1, kind: "ad_text" }, "12%3"), null);
  assert.equal(adIdToLearn({ id: 1, kind: "ad_text" }, "12 3"), null);
  assert.equal(adIdToLearn({ id: 1, kind: "ad_text" }, "a".repeat(200)), null);
});
