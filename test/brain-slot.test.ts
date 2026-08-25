import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSlot,
  weekdayIndex,
  normalizeDiscipline,
  isKnownDiscipline,
  type ValidateResult,
} from "../src/brain/tools.js";
import type { Slot } from "../src/brain/slots.gen.js";

// A tiny hand-authored schedule so the test doesn't depend on the generated one.
// Mon(0) 18:00 jiu adult; Sat(5) 09:00 jiu adult; Sat(5) 11:00 jiu kid.
const SCHED: Slot[] = [
  { weekday: 0, time: "18:00", discipline: "jiu", audience: "adult" },
  { weekday: 0, time: "19:00", discipline: "jiu", audience: "adult" },
  { weekday: 5, time: "09:00", discipline: "jiu", audience: "adult" },
  { weekday: 5, time: "11:00", discipline: "jiu", audience: "kid" },
];

// `trial: false`: real classes that exist on the grid but never take a trial.
// The compiled grid no longer sets the flag (the Muay Thai sparring hours
// reopened to trials — owner, 2026-08-25), so these hand-authored fixtures are
// what keeps the mechanism covered end to end.
// Thu(3) 18:00 muay is closed, 19:00 muay is a normal class, and jiu runs at
// the same 18:00 hour. Sat(5) 11:00 muay is closed with nothing else that day.
const SPAR: Slot[] = [
  { weekday: 3, time: "18:00", discipline: "muay", audience: "adult", trial: false },
  { weekday: 3, time: "19:00", discipline: "muay", audience: "adult" },
  { weekday: 3, time: "18:00", discipline: "jiu", audience: "adult" },
  { weekday: 5, time: "11:00", discipline: "muay", audience: "adult", trial: false },
];

test("weekdayIndex maps YYYY-MM-DD to 0=Mon..6=Sun", () => {
  // 2026-07-06 is a Monday.
  assert.equal(weekdayIndex("2026-07-06"), 0);
  // 2026-07-11 is a Saturday.
  assert.equal(weekdayIndex("2026-07-11"), 5);
  // 2026-07-12 is a Sunday.
  assert.equal(weekdayIndex("2026-07-12"), 6);
  assert.equal(weekdayIndex("not-a-date"), null);
});

test("normalizeDiscipline maps common labels to compact keys", () => {
  assert.equal(normalizeDiscipline("Jiu-Jitsu"), "jiu");
  assert.equal(normalizeDiscipline("BJJ"), "jiu");
  assert.equal(normalizeDiscipline("Muay Thai"), "muay");
  assert.equal(normalizeDiscipline("boxing"), "box");
  assert.equal(normalizeDiscipline("MMA"), "mma");
});

test("validateSlot accepts a real slot (Monday 18:00 jiu adult)", () => {
  const r: ValidateResult = validateSlot("2026-07-06", "18:00", "adult", "jiu", SCHED);
  assert.equal(r.ok, true);
});

test("validateSlot accepts via a display discipline name", () => {
  const r = validateSlot("2026-07-06", "18:00", "adult", "Jiu-Jitsu", SCHED);
  assert.equal(r.ok, true);
});

test("validateSlot rejects the wrong day", () => {
  // 2026-07-07 is a Tuesday — no jiu adult in SCHED.
  const r = validateSlot("2026-07-07", "18:00", "adult", "jiu", SCHED);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test("validateSlot rejects the wrong time but returns same-day alternatives", () => {
  const r = validateSlot("2026-07-06", "07:00", "adult", "jiu", SCHED);
  assert.equal(r.ok, false);
  assert.deepEqual(r.alternatives, ["18:00", "19:00"]);
});

test("validateSlot distinguishes audience (kid vs adult)", () => {
  // Sat 11:00 is a kid slot; asking for adult should fail.
  assert.equal(validateSlot("2026-07-11", "11:00", "adult", "jiu", SCHED).ok, false);
  assert.equal(validateSlot("2026-07-11", "11:00", "kid", "jiu", SCHED).ok, true);
});

test("validateSlot rejects a malformed date", () => {
  const r = validateSlot("07/06/2026", "18:00", "adult", "jiu", SCHED);
  assert.equal(r.ok, false);
});

// ---- slots closed to trials (trial: false) --------------------------------

test("validateSlot never books a trial:false slot, and says why", () => {
  // 2026-08-27 is a Thursday.
  const r = validateSlot("2026-08-27", "18:00", "adult", "muay", SPAR);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /SPARRING/);
});

test("validateSlot's alternatives exclude trial:false slots", () => {
  const r = validateSlot("2026-08-27", "18:00", "adult", "muay", SPAR);
  // 19:00 is bookable; the requested 18:00 closed hour must not be offered back.
  assert.deepEqual(r.alternatives, ["19:00"]);
});

test("a trial:false slot with nothing else that day offers another day/discipline", () => {
  // 2026-08-29 is a Saturday — 11:00 muay is closed and nothing else runs.
  const r = validateSlot("2026-08-29", "11:00", "adult", "muay", SPAR);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /SPARRING/);
  assert.match(r.reason ?? "", /different day or discipline/);
  assert.equal(r.alternatives, undefined);
});

test("a co-timed class in another discipline still validates", () => {
  // Thu 18:00 muay is closed, but Thu 18:00 jiu is a normal class.
  assert.equal(validateSlot("2026-08-27", "18:00", "adult", "jiu", SPAR).ok, true);
});

test("slots without a trial flag stay bookable (back-compat)", () => {
  // SCHED has no `trial` field at all — every entry must remain bookable.
  assert.equal(validateSlot("2026-07-06", "18:00", "adult", "jiu", SCHED).ok, true);
  assert.equal(validateSlot("2026-08-27", "19:00", "adult", "muay", SPAR).ok, true);
});

// ---- unknown disciplines --------------------------------------------------

test("validateSlot rejects an unknown discipline with a corrective", () => {
  const r = validateSlot("2026-07-06", "18:00", "adult", "defensa personal", SCHED);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not a bookable discipline/);
  // Self-defense routes to all four disciplines (owner policy, 2026-08-25).
  assert.match(r.reason ?? "", /foundations of MMA/);
  assert.match(r.reason ?? "", /jiu, muay, mma or box/);
});

test("isKnownDiscipline tracks the client's service keys", () => {
  assert.equal(isKnownDiscipline("jiu"), true);
  assert.equal(isKnownDiscipline("baby"), true);
  assert.equal(isKnownDiscipline("defensa personal"), false);
  assert.equal(isKnownDiscipline("Jiu-Jitsu"), false); // keys only, not labels
});
