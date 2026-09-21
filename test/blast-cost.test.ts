// What a blast costs (src/services/blast-cost.ts): category → rate, per-run
// totals, day counters, and the month-to-date fold across CDMX month
// boundaries (fake clock — never Date.now()).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDayCost,
  cdmxMonthPrefix,
  dayCostTotal,
  emptyDayCost,
  encodeDayCost,
  foldMonthCounters,
  monthCost,
  parseDayCost,
  prefixRange,
  priceCategory,
  rateFor,
  round2,
  runCost,
  KV_COST_DAY_PREFIX,
  KV_SENT_DAY_PREFIX,
} from "../src/services/blast-cost.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { WhatsAppPricing } from "../src/client-config.js";

/** Meta's USD rate card for Mexico, effective 2026-07-01. */
const MX: WhatsAppPricing = {
  currency: "USD",
  marketing: 0.0305,
  utility: 0.0085,
  asOf: "2026-07",
  source: "https://developers.facebook.com/docs/whatsapp/pricing/",
};

test("priceCategory: known categories, unknown falls back to marketing", () => {
  assert.deepEqual(priceCategory("MARKETING"), { category: "marketing", known: true });
  assert.deepEqual(priceCategory("utility"), { category: "utility", known: true });
  // Unknown/absent/authentication ⇒ the dearer rate, flagged.
  for (const raw of ["", null, undefined, "AUTHENTICATION", "weird"]) {
    assert.deepEqual(priceCategory(raw), { category: "marketing", known: false }, String(raw));
  }
});

test("rateFor: reads the client rate card, 0 without one", () => {
  assert.equal(rateFor(MX, "marketing"), 0.0305);
  assert.equal(rateFor(MX, "utility"), 0.0085);
  assert.equal(rateFor(null, "marketing"), 0);
  assert.equal(rateFor({ ...MX, marketing: 0 }, "marketing"), 0);
});

test("round2 rounds to whole cents", () => {
  assert.equal(round2(0.2135), 0.21);
  assert.equal(round2(7.625), 7.63);
  assert.equal(round2(0), 0);
});

test("runCost: sent × rate for the run's category", () => {
  const marketing = runCost(250, "MARKETING", MX);
  assert.equal(marketing.sent, 250);
  assert.equal(marketing.rate, 0.0305);
  assert.equal(marketing.estCostUsd, 7.63); // 7.625
  assert.equal(marketing.knownCategory, true);
  assert.equal(marketing.currency, "USD");

  const utility = runCost(100, "UTILITY", MX);
  assert.equal(utility.estCostUsd, 0.85);
  assert.equal(utility.category, "utility");
});

test("runCost: a run with no category is priced as marketing and flagged", () => {
  const c = runCost(10, "", MX);
  assert.equal(c.category, "marketing");
  assert.equal(c.knownCategory, false);
  assert.equal(c.estCostUsd, 0.31); // 0.305
});

test("runCost: only SENT rows count; no rate card ⇒ zero money", () => {
  assert.equal(runCost(0, "MARKETING", MX).estCostUsd, 0);
  assert.equal(runCost(-5, "MARKETING", MX).sent, 0);
  const noRates = runCost(100, "MARKETING", null);
  assert.equal(noRates.sent, 100);
  assert.equal(noRates.estCostUsd, 0);
});

test("day counters: add, encode, decode, garbage-proof", () => {
  let d = emptyDayCost();
  d = addDayCost(d, "MARKETING");
  d = addDayCost(d, "MARKETING", 4);
  d = addDayCost(d, "UTILITY", 2);
  d = addDayCost(d, null, 3);
  assert.deepEqual(d, { marketing: 5, utility: 2, unknown: 3 });
  assert.equal(dayCostTotal(d), 10);
  assert.deepEqual(parseDayCost(encodeDayCost(d)), d);
  assert.deepEqual(parseDayCost("{oops"), emptyDayCost());
  assert.deepEqual(parseDayCost(null), emptyDayCost());
  assert.deepEqual(parseDayCost('{"marketing":-3,"utility":"x"}'), emptyDayCost());
});

test("cdmxMonthPrefix uses CDMX month boundaries, not UTC", () => {
  // 2026-09-30 23:30 CDMX is already October 1 in UTC.
  assert.equal(cdmxMonthPrefix(cdmxToEpoch(2026, 9, 30, 23, 30, 0)), "2026-09-");
  assert.equal(cdmxMonthPrefix(cdmxToEpoch(2026, 10, 1, 0, 30, 0)), "2026-10-");
  assert.equal(cdmxMonthPrefix(cdmxToEpoch(2026, 1, 1, 0, 0, 0)), "2026-01-");
});

test("prefixRange is a half-open key range for an index scan", () => {
  const r = prefixRange("blast_cost:2026-09-");
  assert.equal(r.from, "blast_cost:2026-09-");
  assert.equal(r.to, "blast_cost:2026-09.");
  assert.ok("blast_cost:2026-09-30" >= r.from && "blast_cost:2026-09-30" < r.to);
  assert.ok(!("blast_cost:2026-10-01" >= r.from && "blast_cost:2026-10-01" < r.to));
});

test("foldMonthCounters: breakdown wins, plain totals fill the gap", () => {
  const rows = [
    { key: KV_COST_DAY_PREFIX + "2026-09-18", value: '{"marketing":10,"utility":5,"unknown":0}' },
    { key: KV_SENT_DAY_PREFIX + "2026-09-18", value: "15" }, // same day, fully covered
    { key: KV_SENT_DAY_PREFIX + "2026-09-17", value: "7" }, // day before the breakdown shipped
    { key: KV_COST_DAY_PREFIX + "2026-09-19", value: '{"marketing":4,"utility":0,"unknown":0}' },
    { key: KV_SENT_DAY_PREFIX + "2026-09-19", value: "6" }, // 2 sent before the drain wrote a breakdown
    { key: KV_SENT_DAY_PREFIX + "2026-08-31", value: "99" }, // other month → ignored
    { key: "blast_run:b2609", value: "{}" }, // unrelated kv row → ignored
  ];
  const d = foldMonthCounters(rows, "2026-09-");
  assert.deepEqual(d, { marketing: 14, utility: 5, unknown: 9 }); // 7 + 2 unattributed
  assert.equal(dayCostTotal(d), 28);
});

test("monthCost: unknown messages ride the marketing rate", () => {
  const m = monthCost({ marketing: 100, utility: 200, unknown: 50 }, MX);
  assert.equal(m.sent, 350);
  // 150 × 0.0305 + 200 × 0.0085 = 4.575 + 1.70 = 6.275
  assert.equal(m.estCostUsd, 6.28);
  assert.equal(m.unknown, 50);
  assert.equal(m.currency, "USD");
});

test("monthCost: empty month and no rate card", () => {
  assert.equal(monthCost(emptyDayCost(), MX).estCostUsd, 0);
  const none = monthCost({ marketing: 10, utility: 0, unknown: 0 }, null);
  assert.equal(none.sent, 10);
  assert.equal(none.estCostUsd, 0);
});
