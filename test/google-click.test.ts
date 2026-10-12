import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clickTimeIso,
  gclidColumnValue,
  googleClickKey,
  parseGoogleClickRef,
  parseStoredGoogleClick,
} from "../src/services/google-click.js";
import { buildLeadFields, DEFAULT_LEADS_MAP } from "../src/services/airtable.js";
import { matchCampaign, normalizeText } from "../src/pipeline/campaigns.js";
import type { AirtableLeadsMap } from "../src/client-config.js";
import type { Campaign } from "../src/types.js";

// The exact text the site's js/attribution.js prefills after a click on
// /jiu-jitsu/?gclid=TEST123 (md-condesa-site tools/test-attribution.js).
const SITE_TEXT = "Hola, vi su anuncio en Google [ref gclid:TEST123:1790251200]";
const SITE_TEXT_KW = "Hola, vi su anuncio en Google (kw: clases de box condesa) [ref gclid:TEST123:1790251200]";

test("parseGoogleClickRef: site prefill → click + body without the ref", () => {
  assert.deepEqual(parseGoogleClickRef(SITE_TEXT), {
    click: { kind: "gclid", id: "TEST123", ts: 1790251200 },
    body: "Hola, vi su anuncio en Google",
  });
  assert.deepEqual(parseGoogleClickRef(SITE_TEXT_KW).body, "Hola, vi su anuncio en Google (kw: clases de box condesa)");
});

test("parseGoogleClickRef: gbraid / wbraid / real-looking gclid", () => {
  const g = parseGoogleClickRef("Hola [ref gbraid:0AAAAAo-abc_XYZ:1790251200]").click;
  assert.deepEqual(g, { kind: "gbraid", id: "0AAAAAo-abc_XYZ", ts: 1790251200 });
  const w = parseGoogleClickRef("Hola\n[ref wbraid:CjkKCQjw:1790251200] y otra cosa");
  assert.equal(w.click?.kind, "wbraid");
  assert.equal(w.body, "Hola y otra cosa");
  const real = "Cj0KCQjw8a2b3c4d5e6f7g8h9EAIaIQobChMI_x-Y";
  assert.equal(parseGoogleClickRef(`Hola [ref gclid:${real}:1790251200]`).click?.id, real);
});

test("parseGoogleClickRef: no ref / malformed ref → body untouched", () => {
  for (const b of [
    "Hola, vi su anuncio en Google",
    "Hola [ref gclid:TEST123]", // no time
    "Hola [ref fbclid:TEST123:1790251200]", // not a Google id
    "Hola [ref gclid:bad]id:1790251200]",
    "Hola [ref gclid:abc:1790251200]", // id too short
    "",
  ]) {
    assert.deepEqual(parseGoogleClickRef(b), { click: null, body: b }, b);
  }
});

test("campaign trigger still matches once the ref is stripped (and even if it were not)", () => {
  const google: Campaign = {
    id: 9,
    name: "Google Search (anuncios Google)",
    trigger_phrase: "Hola, vi su anuncio en Google",
    trigger_norm: normalizeText("Hola, vi su anuncio en Google"),
    first_reply: null,
    status: "active",
  } as unknown as Campaign;
  assert.equal(matchCampaign(normalizeText(parseGoogleClickRef(SITE_TEXT_KW).body), [google]), 9);
  assert.equal(matchCampaign(normalizeText(SITE_TEXT_KW), [google]), 9);
});

test("gclidColumnValue / clickTimeIso: the shapes the site's form prefill uses", () => {
  assert.equal(gclidColumnValue({ kind: "gclid", id: "TEST123", ts: 0 }), "TEST123");
  assert.equal(gclidColumnValue({ kind: "gbraid", id: "0AAA", ts: 0 }), "gbraid:0AAA");
  assert.equal(gclidColumnValue({ kind: "wbraid", id: "CjkK", ts: 0 }), "wbraid:CjkK");
  // 2026-09-24T12:00:00Z — same instant as the site test → same string.
  assert.equal(clickTimeIso(1790251200), "2026-09-24T06:00:00-06:00");
  assert.equal(clickTimeIso(Date.parse("2026-10-13T03:00:00Z") / 1000), "2026-10-12T21:00:00-06:00");
});

test("parseStoredGoogleClick: round-trip, junk → null", () => {
  const c = { kind: "gclid" as const, id: "TEST123", ts: 1790251200 };
  assert.deepEqual(parseStoredGoogleClick(JSON.stringify(c)), c);
  assert.equal(parseStoredGoogleClick(null), null);
  assert.equal(parseStoredGoogleClick("{nope"), null);
  assert.equal(parseStoredGoogleClick(JSON.stringify({ ...c, kind: "fbclid" })), null);
  assert.equal(parseStoredGoogleClick(JSON.stringify({ ...c, ts: "x" })), null);
  assert.equal(googleClickKey("5215512345678"), "gclick:5215512345678");
});

// ---- buildLeadFields: Leads.gclid / gclid_time --------------------------

const MAP: AirtableLeadsMap = { ...DEFAULT_LEADS_MAP, gclid: "gclid", gclidTime: "gclid_time" };
const CLICK = { kind: "gclid" as const, id: "TEST123", ts: 1790251200 };

test("buildLeadFields writes gclid + gclid_time on a new lead", () => {
  const f = buildLeadFields(null, { phone: "5215500000000", googleClick: CLICK }, MAP);
  assert.equal(f["gclid"], "TEST123");
  assert.equal(f["gclid_time"], "2026-09-24T06:00:00-06:00");
});

test("buildLeadFields never overwrites a gclid (form-submitted or earlier), nor pairs its time", () => {
  const f = buildLeadFields({ gclid: "FROMFORM" }, { phone: "521", googleClick: CLICK }, MAP);
  assert.equal("gclid" in f, false);
  assert.equal("gclid_time" in f, false);
});

test("buildLeadFields: no click, or the map names no column → nothing written", () => {
  assert.equal("gclid" in buildLeadFields(null, { phone: "521" }, MAP), false);
  const f = buildLeadFields(null, { phone: "521", googleClick: CLICK }, DEFAULT_LEADS_MAP);
  assert.equal(Object.keys(f).some((k) => k.startsWith("gclid")), false);
});
