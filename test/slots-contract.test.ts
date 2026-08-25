// Contract tests for the COMPILED schedule (src/brain/slots.gen.ts), not the
// hand-authored fixtures in brain-slot.test.ts. These pin the slots the ads and
// intake.md actually promise, so a site-schedule recompile can't silently drop
// one. `npm test` runs `pretest` (CLIENT=md-condesa node tools/compile-kb.mjs)
// first, so SLOTS is always freshly generated here; running the compiled tests
// by hand needs `npm run build` first.
//
// Dates below are real 2026 calendar days:
//   2026-08-31 Mon · 2026-09-02 Wed · 2026-09-03 Thu · 2026-09-05 Sat
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSlot } from "../src/brain/tools.js";
import { SLOTS } from "../src/brain/slots.gen.js";
import { CLIENT } from "../src/client.gen.js";

const MON = "2026-08-31";
const WED = "2026-09-02";
const THU = "2026-09-03";
const SAT = "2026-09-05";
const AUDIENCES = ["adult", "kid"];

// ---- Baby Fight Club: trial times, both audiences ------------------------
// intake.md: trials are mié 11:00 and sáb 14:00 ONLY; the member classes
// (mié 12:00, sáb 15:00) must never accept a trial booking. Parents train
// alongside the toddler, so the model labels the booking 'adult' about as often
// as 'kid' — both must validate (live incident 2026-08-18: every advertised
// baby slot was rejected and leads were told "ya quedó agendado" anyway).

test("SLOTS: baby trials bookable mié 11:00 + sáb 14:00, both audiences", () => {
  for (const aud of AUDIENCES) {
    assert.equal(validateSlot(WED, "11:00", aud, "baby", SLOTS).ok, true);
    assert.equal(validateSlot(SAT, "14:00", aud, "baby", SLOTS).ok, true);
  }
});

test("SLOTS: baby member classes are NOT bookable as trials, either audience", () => {
  for (const aud of AUDIENCES) {
    assert.equal(validateSlot(WED, "12:00", aud, "baby", SLOTS).ok, false);
    assert.equal(validateSlot(SAT, "15:00", aud, "baby", SLOTS).ok, false);
  }
});

// ---- Mini Muay Thai (3-5): same parent-participation trap ----------------

test("SLOTS: mini Muay Thai bookable under BOTH audiences", () => {
  for (const aud of AUDIENCES) {
    assert.equal(validateSlot(MON, "15:15", aud, "muay", SLOTS).ok, true);
    assert.equal(validateSlot(WED, "15:15", aud, "muay", SLOTS).ok, true);
    assert.equal(validateSlot(SAT, "13:15", aud, "muay", SLOTS).ok, true);
  }
});

// ---- Sparring: carried, never bookable ------------------------------------

test("SLOTS: Muay Thai sparring (jue 18/19, sáb 11) is rejected as SPARRING", () => {
  for (const [date, time] of [
    [THU, "18:00"],
    [THU, "19:00"],
    [SAT, "11:00"],
  ]) {
    const r = validateSlot(date, time, "adult", "muay", SLOTS);
    assert.equal(r.ok, false, `${date} ${time} should not be bookable`);
    assert.match(r.reason ?? "", /SPARRING/);
    assert.ok((r.alternatives ?? []).length > 0, `${date} ${time} needs alternatives`);
    assert.ok(!(r.alternatives ?? []).includes(time), "sparring time offered back");
  }
});

test("SLOTS: sparring is Muay-Thai-only — Thu 18:00 Jiu-Jitsu still books", () => {
  assert.equal(validateSlot(THU, "18:00", "adult", "jiu", SLOTS).ok, true);
});

// ---- regression net: ordinary slots keep working -------------------------

test("SLOTS: everyday bookings still validate", () => {
  assert.equal(validateSlot(SAT, "09:00", "adult", "jiu", SLOTS).ok, true); // Fundamentos
  assert.equal(validateSlot(MON, "16:00", "kid", "muay", SLOTS).ok, true); // Muay Thai Kids
  assert.equal(validateSlot(MON, "07:00", "adult", "muay", SLOTS).ok, true);
  assert.equal(validateSlot(THU, "21:00", "adult", "box", SLOTS).ok, true);
});

// ---- shape ---------------------------------------------------------------

test("SLOTS: every entry is well-formed and uses a real service key", () => {
  const keys = new Set(CLIENT.services.map((s) => s.key));
  assert.ok(SLOTS.length > 0);
  for (const s of SLOTS) {
    assert.ok(keys.has(s.discipline), `unknown discipline '${s.discipline}'`);
    assert.ok(s.audience === "adult" || s.audience === "kid", `bad audience '${s.audience}'`);
    assert.match(s.time, /^\d{2}:\d{2}$/);
    assert.ok(s.weekday >= 0 && s.weekday <= 6, `bad weekday ${s.weekday}`);
  }
});

test("SLOTS: unknown discipline gets the self-defense corrective", () => {
  const r = validateSlot(SAT, "09:00", "adult", "defensa personal (mujeres)", SLOTS);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not a bookable discipline/);
  assert.match(r.reason ?? "", /jiu/);
  assert.match(r.reason ?? "", /muay/);
});
