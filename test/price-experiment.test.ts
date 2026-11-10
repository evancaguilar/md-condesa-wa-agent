// Price-on-first-ask A/B test (2026-11-10): assignment, window, exclusions,
// context delivery, owner read, and the minor-booking age gate shipped with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRICE_VARIANT_B_LINES,
  assignedPriceVariant,
  campaignHasOwnPrice,
  fmix32,
  fnv1a32,
  priceExperimentReport,
  priceTestActive,
  priceVariantForTurn,
} from "../src/services/price-experiment.js";
import { buildContextBlock, PERSONA_AND_POLICIES } from "../src/brain/prompt.js";
import { handleBookTrial, minorBookingWithoutAge } from "../src/brain/claude.js";
import { cdmxDateStr, cdmxToEpoch } from "../src/cron/time.js";
import { CLIENT } from "../src/client.gen.js";
import type { Contact, ConvoContext } from "../src/types.js";
import type { PriceExperimentConfig } from "../src/client-config.js";

const CFG: PriceExperimentConfig = {
  enabled: true,
  start: "2026-11-10",
  end: "2026-11-24",
  salt: "price-first-ask-2026-11",
};

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215512345678",
    name: null,
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: null,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function ctx(phone: string, over: Partial<ConvoContext> = {}): ConvoContext {
  return {
    phone,
    contact: contact({ phone }),
    history: [],
    nowCdmx: "2026-11-12T18:30",
    weekday: "jueves",
    windowOpen: true,
    trainingWheels: true,
    ...over,
  };
}

/** First synthetic phone assigned to `v` under CFG's salt. */
function phoneIn(v: "A" | "B"): string {
  for (let i = 0; i < 1000; i++) {
    const p = `52155${String(10000000 + i)}`;
    if (assignedPriceVariant(p, CFG.salt) === v) return p;
  }
  throw new Error("no phone");
}

// ---- assignment ----

test("fnv1a32 is the standard 32-bit FNV-1a (recomputable offline)", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
  assert.equal(fmix32(0), 0);
  assert.equal(fmix32(1), 0x514e28b7);
});

test("split is ~50/50 over 20,000 phones and stable per phone", () => {
  let b = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const p = `521${String(5500000000 + i * 7919)}`;
    const v = assignedPriceVariant(p, CFG.salt);
    assert.equal(assignedPriceVariant(p, CFG.salt), v, "same phone, same arm");
    if (v === "B") b++;
  }
  const share = b / n;
  assert.ok(share > 0.48 && share < 0.52, `B share ${share}`);
});

test("assignment uses the NORMALIZED phone: 52+10, bare 10 and 521+10 agree", () => {
  for (const local of ["5512345678", "5598765432", "5611112222"]) {
    const v = assignedPriceVariant(`521${local}`, CFG.salt);
    assert.equal(assignedPriceVariant(`52${local}`, CFG.salt), v);
    assert.equal(assignedPriceVariant(local, CFG.salt), v);
    assert.equal(assignedPriceVariant(`+52 1 ${local.slice(0, 2)} ${local.slice(2)}`, CFG.salt), v);
  }
});

test("the salt re-splits (a different salt is a different test)", () => {
  let differ = 0;
  for (let i = 0; i < 400; i++) {
    const p = `52155${String(20000000 + i)}`;
    if (assignedPriceVariant(p, CFG.salt) !== assignedPriceVariant(p, "otro-salt")) differ++;
  }
  assert.ok(differ > 150 && differ < 250, `differ ${differ}`);
});

// ---- window (CDMX, fake clock) ----

test("window: CDMX dates, start inclusive, end exclusive", () => {
  // 2026-11-10 00:05 CDMX is still 2026-11-10 06:05 UTC; 2026-11-09 23:59 CDMX
  // is already 2026-11-10 in UTC — CDMX wins.
  const before = cdmxToEpoch(2026, 11, 9, 23, 59, 0);
  const first = cdmxToEpoch(2026, 11, 10, 0, 5, 0);
  const last = cdmxToEpoch(2026, 11, 23, 23, 59, 0);
  const after = cdmxToEpoch(2026, 11, 24, 0, 0, 0);
  assert.equal(new Date(before * 1000).toISOString().slice(0, 10), "2026-11-10", "UTC already the 10th");
  assert.equal(priceTestActive(CFG, cdmxDateStr(before)), false);
  assert.equal(priceTestActive(CFG, cdmxDateStr(first)), true);
  assert.equal(priceTestActive(CFG, cdmxDateStr(last)), true);
  assert.equal(priceTestActive(CFG, cdmxDateStr(after)), false);
  assert.equal(priceTestActive({ ...CFG, enabled: false }, "2026-11-12"), false);
  assert.equal(priceTestActive(null, "2026-11-12"), false);
  assert.equal(priceTestActive(CFG, "2026-11-12T18:30"), true, "accepts nowCdmx ISO");
});

test("outside the window or disabled, a B phone is A", () => {
  const p = phoneIn("B");
  assert.equal(priceVariantForTurn({ cfg: CFG, phone: p, cdmxDate: "2026-11-12" }).variant, "B");
  assert.deepEqual(priceVariantForTurn({ cfg: CFG, phone: p, cdmxDate: "2026-11-24" }), {
    variant: "A",
    assigned: null,
    excluded: "inactive",
  });
  assert.equal(priceVariantForTurn({ cfg: { ...CFG, enabled: false }, phone: p, cdmxDate: "2026-11-12" }).variant, "A");
});

// ---- exclusions ----

test("campaign with its own price/promo keeps its rules; 'gratis' alone does not count", () => {
  assert.equal(campaignHasOwnPrice("Promo matutino: $999 al mes en clases de la mañana"), true);
  assert.equal(campaignHasOwnPrice("Inscripción gratis esta semana"), true);
  assert.equal(campaignHasOwnPrice("10% de descuento familiar"), true);
  assert.equal(campaignHasOwnPrice("Clase de prueba GRATIS para niños de 6 a 12"), false);
  assert.equal(campaignHasOwnPrice(""), false);
  assert.equal(campaignHasOwnPrice(null), false);
  const p = phoneIn("B");
  const r = priceVariantForTurn({ cfg: CFG, phone: p, cdmxDate: "2026-11-12", campaignInfo: "Reto: $1,499 por 6 semanas" });
  assert.deepEqual(r, { variant: "A", assigned: "B", excluded: "campaign_price" });
  assert.equal(priceVariantForTurn({ cfg: CFG, phone: p, cdmxDate: "2026-11-12", status: "student" }).variant, "A");
});

// ---- delivery through the per-turn <context> ----

test("context: B gets the override block, A gets nothing new", () => {
  const b = buildContextBlock(ctx(phoneIn("B")), { priceExperiment: CFG });
  const a = buildContextBlock(ctx(phoneIn("A")), { priceExperiment: CFG });
  assert.ok(b.includes("<experimento_precio>"));
  assert.ok(b.includes("REEMPLAZA el reencuadre"));
  assert.ok(!a.includes("experimento_precio"));
  // A is byte-identical to a turn with the test off.
  assert.equal(a, buildContextBlock(ctx(phoneIn("A")), { priceExperiment: null }));
  // The <quiere_inscribirse> block (when present) stays last.
  assert.ok(b.lastIndexOf("</experimento_precio>") > b.lastIndexOf("</context>"));
});

test("context: a B lead from a priced campaign gets campaign rules only", () => {
  const c = ctx(phoneIn("B"), { campaign: { name: "Mañanas", info: "Promo mañanas $999" } });
  assert.ok(!buildContextBlock(c, { priceExperiment: CFG }).includes("experimento_precio"));
});

test("variant B copy uses ONLY figures the persona/KB already approves", () => {
  const text = PRICE_VARIANT_B_LINES.join("\n");
  const figures = [...new Set(text.match(/\$[\d,]+/g) ?? [])].sort();
  assert.deepEqual(figures, ["$1,500", "$1,996", "$2,996"]);
  // Each quoted figure string appears verbatim in the persona.
  assert.ok(PERSONA_AND_POLICIES.includes("$1,996 a $2,996 cada 4 semanas"));
  assert.ok(PERSONA_AND_POLICIES.includes("$1,500 cada 4 semanas con 1 clase por semana, o $1,996 con las 3 clases"));
  assert.ok(text.includes("$1,996 a $2,996 cada 4 semanas"));
  assert.ok(text.includes("$1,500 cada 4 semanas con 1 clase por semana, o $1,996 con las 3 clases"));
  assert.ok(text.includes("casilla 3"));
  assert.ok(!/\$(?:999|2,500|3,996|499|625|749)\b/.test(text), "no plan-table numbers");
});

test("compiled client carries the experiment config (compile-kb whitelist)", () => {
  const p = CLIENT.experiments?.priceFirstAsk;
  assert.ok(p, "experiments.priceFirstAsk reached client.gen.ts");
  assert.match(p!.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(p!.end, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(p!.start < p!.end);
  assert.ok(p!.salt.length > 0);
});

// ---- owner read ----

test("owner read: config, activeToday and the assigned arm per (deduped) phone", () => {
  const pa = phoneIn("A");
  const pb = phoneIn("B");
  const r = priceExperimentReport(CFG, `${pa}, ${pb} ${pa}`, "2026-11-12");
  assert.equal(r.activeToday, true);
  assert.deepEqual(r.assignments.map((x) => x.variant), ["A", "B"]);
  assert.equal(r.assignments[0]!.normalized, pa);
  assert.equal(priceExperimentReport(CFG, "", "2026-11-30").activeToday, false);
  assert.deepEqual(priceExperimentReport(null, pa, "2026-11-12").assignments, []);
});

// ---- Change 1: a minor's first trial confirms directly on a KNOWN age ----

test("minorBookingWithoutAge: only a child's booking with no stated age", () => {
  const none = { contact: contact() };
  const withAge = { contact: contact({ qualification: JSON.stringify({ child_age_months: 84 }) }) };
  const kid = { band: null, audience: "kid" as const, childName: "Emilia", childAgeMonths: null };
  assert.equal(minorBookingWithoutAge(none, kid), true);
  assert.equal(minorBookingWithoutAge(none, { ...kid, childAgeMonths: 84 }), false);
  assert.equal(minorBookingWithoutAge(withAge, kid), false);
  // campaign-guessed band without an age is not an age
  assert.equal(
    minorBookingWithoutAge({ contact: contact({ qualification: JSON.stringify({ audience: "kid" }) }) }, { ...kid, band: "kids" }),
    true,
  );
  // a parent booking their own adult class
  assert.equal(minorBookingWithoutAge(none, { band: null, audience: "adult", childName: "", childAgeMonths: null }), false);
});

test("handleBookTrial: Kids booking with age books directly; without age it asks first", async () => {
  let booked = 0;
  const airtable = { bookTrial: async () => { booked++; return "recK"; } };
  const tu = (input: Record<string, unknown>) => ({ type: "tool_use" as const, id: "t1", name: "book_trial", input });
  // Monday 2026-11-16 16:00 = Kids (6–12) arrival row.
  const base = { name: "Ana", child_name: "Emilia", discipline: "muay", audience: "kid", trial_date: "2026-11-16", trial_time: "16:00", followup_message: "ok" };
  const c = ctx("5215512345678");

  const noAge = await handleBookTrial(airtable, c, tu(base));
  assert.equal(booked, 0);
  assert.equal(noAge.result.is_error, true);
  assert.match(noAge.result.content, /age is unknown/);

  const ok = await handleBookTrial(airtable, c, tu({ ...base, child_age: 8 }));
  assert.equal(ok.result.is_error, undefined, ok.result.content);
  assert.equal(booked, 1);
  assert.equal(ok.booking!.input.program, "kids");

  // an age that does not fit the class is still refused (Mini child into Kids)
  const wrong = await handleBookTrial(airtable, c, tu({ ...base, child_age: 4 }));
  assert.equal(wrong.result.is_error, true);
  assert.equal(booked, 1);
});

test("persona: checklist box 8 no longer sends a minor's first booking to a human", () => {
  assert.ok(!PERSONA_AND_POLICIES.includes("ni la primera reserva de un menor"));
  assert.ok(PERSONA_AND_POLICIES.includes("se agenda y confirma igual que la de un adulto"));
  assert.ok(PERSONA_AND_POLICIES.includes("las OCHO casillas"));
});
