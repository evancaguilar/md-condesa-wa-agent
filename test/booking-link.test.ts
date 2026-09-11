import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adIdFromRef,
  attributionFor,
  decorateBookingLinks,
  withAttribution,
} from "../src/services/booking-link.js";

const BOOKING = "https://mdcondesa.com/clase-prueba-adultos/";
const KIDS = "https://mdcondesa.com/clase-prueba-ninos/";
const SCHEDULE = "https://mdcondesa.com/#horarios";
const AD = "120233445566778899";
const ref = JSON.stringify({ sourceId: AD, headline: "Reto 21 días", body: null });

test("adIdFromRef: parses sourceId, tolerates junk", () => {
  assert.equal(adIdFromRef(ref), AD);
  assert.equal(adIdFromRef(null), null);
  assert.equal(adIdFromRef("{not json"), null);
  assert.equal(adIdFromRef(JSON.stringify({ sourceId: null })), null);
  assert.equal(adIdFromRef(JSON.stringify({ sourceId: "  " })), null);
  assert.equal(adIdFromRef(JSON.stringify({ sourceId: "bad id with spaces" })), null);
});

test("attributionFor: stored ad_ref wins, inbound referral is the fallback", () => {
  assert.deepEqual(attributionFor({ ad_ref: ref }, "Reto", "999"), {
    adId: AD,
    campaignName: "Reto",
  });
  assert.deepEqual(attributionFor({ ad_ref: null }, null, "999"), {
    adId: "999",
    campaignName: null,
  });
  assert.deepEqual(attributionFor(null, "  ", null), { adId: null, campaignName: null });
});

test("withAttribution: appends utm params only when the ad id is known", () => {
  assert.equal(
    withAttribution(BOOKING, { adId: AD, campaignName: "Reto 21 días" }),
    `${BOOKING}?utm_source=whatsapp&utm_content=${AD}&utm_campaign=Reto+21+d%C3%ADas`,
  );
  assert.equal(
    withAttribution(BOOKING, { adId: AD, campaignName: null }),
    `${BOOKING}?utm_source=whatsapp&utm_content=${AD}`,
  );
  assert.equal(withAttribution(BOOKING, { adId: null, campaignName: "Reto" }), BOOKING);
  assert.equal(withAttribution(BOOKING, null), BOOKING);
});

test("withAttribution: keeps existing query and hash; never double-tags", () => {
  const a = { adId: AD, campaignName: null };
  assert.equal(
    withAttribution(SCHEDULE, a),
    `https://mdcondesa.com/?utm_source=whatsapp&utm_content=${AD}#horarios`,
  );
  assert.equal(
    withAttribution("https://mdcondesa.com/x?foo=1", a),
    `https://mdcondesa.com/x?foo=1&utm_source=whatsapp&utm_content=${AD}`,
  );
  const tagged = `${BOOKING}?utm_content=1`;
  assert.equal(withAttribution(tagged, a), tagged);
  assert.equal(withAttribution("not a url", a), "not a url");
  assert.equal(withAttribution("mailto:x@y.z", a), "mailto:x@y.z");
});

test("decorateBookingLinks: rewrites bare known links inside free text", () => {
  const a = { adId: AD, campaignName: "Kids" };
  const text = `Agenda aquí: ${BOOKING} o para niños ${KIDS}\nHorarios: ${SCHEDULE}.`;
  const out = decorateBookingLinks(text, a, [BOOKING, KIDS, SCHEDULE]);
  assert.ok(out.includes(`${BOOKING}?utm_source=whatsapp&utm_content=${AD}&utm_campaign=Kids`));
  assert.ok(out.includes(`${KIDS}?utm_source=whatsapp&utm_content=${AD}&utm_campaign=Kids`));
  assert.ok(
    out.includes(`https://mdcondesa.com/?utm_source=whatsapp&utm_content=${AD}&utm_campaign=Kids#horarios.`),
  );
  // Already-tagged occurrences and unknown links stay untouched.
  const tagged = `Ve a ${BOOKING}?utm_content=1 y a https://mdcondesa.com/otra/`;
  assert.equal(decorateBookingLinks(tagged, a, [BOOKING]), tagged);
  // No ad → text unchanged.
  assert.equal(decorateBookingLinks(text, { adId: null, campaignName: "Kids" }), text);
});
