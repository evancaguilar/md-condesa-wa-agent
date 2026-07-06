import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSlot,
  weekdayIndex,
  normalizeDiscipline,
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
