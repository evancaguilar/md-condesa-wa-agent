// nextTrialSlot (B1): the concrete class a nudge proposes. Every expectation
// below is derived from the COMPILED schedule (src/brain/slots.gen.ts) — never
// from a hand-written table. Anchor week (CDMX): Mon 2026-08-24 … Sun 2026-08-30.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  nextTrialSlot,
  formatSlotLabel,
  disciplineLabel,
  time12h,
} from "../src/cron/next-slot.js";
import { cdmxToEpoch } from "../src/cron/time.js";

const MON = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 24, h, m, 0);
const THU = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 27, h, m, 0);
const SUN = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 30, h, m, 0);

test("nextTrialSlot: Monday morning, kid Muay Thai → today's 15:15", () => {
  const slot = nextTrialSlot("muay", "kid", MON(10));
  assert.equal(slot?.date, "2026-08-24");
  assert.equal(slot?.weekday, 0);
  assert.equal(slot?.time, "15:15");
  assert.equal(slot?.discipline, "muay");
  assert.equal(slot?.label, "hoy a las 3:15 pm");
});

test("nextTrialSlot: 2h lead time skips classes that are too close", () => {
  // 14:30 → 15:15 (45 min away) and 16:00 (90 min away) are both inside the
  // 2h lead, so the proposal rolls to the next day's kid Muay Thai.
  const slot = nextTrialSlot("muay", "kid", MON(14, 30));
  assert.equal(slot?.date, "2026-08-25");
  assert.equal(slot?.time, "16:00");
  assert.equal(slot?.label, "mañana martes 4:00 pm");
});

test("nextTrialSlot: Thursday evening adult Muay Thai never lands on sparring", () => {
  // Thu 18:00 + 19:00 muay are trial:false (sparring) → jump to Friday 07:00.
  const slot = nextTrialSlot("Muay Thai", "adult", THU(17));
  assert.equal(slot?.date, "2026-08-28");
  assert.equal(slot?.time, "07:00");
  assert.equal(slot?.label, "mañana viernes 7:00 am");
});

test("nextTrialSlot: Sunday kid lead never gets a Sunday slot", () => {
  const slot = nextTrialSlot(null, "kid", SUN(10));
  assert.ok(slot);
  assert.notEqual(slot?.weekday, 6); // 6 = Sunday
  assert.equal(slot?.date, "2026-08-31"); // the following Monday
  assert.equal(slot?.time, "15:15");
  assert.equal(slot?.label, "mañana lunes 3:15 pm");
});

test("nextTrialSlot: kid audience never returns an adult class", () => {
  for (const now of [MON(6), THU(12), SUN(19)]) {
    const slot = nextTrialSlot(null, "kid", now);
    assert.ok(slot, "expected some kid slot within two weeks");
  }
  // Sunday has adult-only classes on the grid; a kid lead skips the whole day.
  const sunday = nextTrialSlot(null, "kid", SUN(6));
  assert.notEqual(sunday?.date, "2026-08-30");
});

test("nextTrialSlot: baby leads get the Wed/Sat baby slots only", () => {
  const slot = nextTrialSlot("baby", "kid", THU(12));
  assert.equal(slot?.discipline, "baby");
  assert.equal(slot?.date, "2026-08-29"); // Saturday
  assert.equal(slot?.time, "14:00");
  assert.equal(slot?.label, "el sábado 2:00 pm");
});

test("nextTrialSlot: unbookable discipline text falls back to any class", () => {
  const slot = nextTrialSlot("defensa personal", "adult", MON(10));
  assert.ok(slot, "should still propose something");
  assert.equal(slot?.date, "2026-08-24");
  assert.equal(slot?.time, "15:15");
});

test("nextTrialSlot: empty schedule → null (copy falls back to generic)", () => {
  assert.equal(nextTrialSlot("muay", "adult", MON(10), []), null);
});

test("nextTrialSlot: a trial:false-only grid yields nothing", () => {
  const sparringOnly = [
    { weekday: 0, time: "18:00", discipline: "muay", audience: "adult" as const, trial: false },
  ];
  assert.equal(nextTrialSlot("muay", "adult", MON(10), sparringOnly), null);
});

test("formatSlotLabel: hoy / mañana / el <día>, es + en", () => {
  const slot = { weekday: 2, date: "2026-08-26", time: "11:00" };
  assert.equal(formatSlotLabel(slot, cdmxToEpoch(2026, 8, 26, 8), "es"), "hoy a las 11:00 am");
  assert.equal(
    formatSlotLabel(slot, cdmxToEpoch(2026, 8, 25, 8), "es"),
    "mañana miércoles 11:00 am",
  );
  assert.equal(formatSlotLabel(slot, cdmxToEpoch(2026, 8, 24, 8), "es"), "el miércoles 11:00 am");
  assert.equal(formatSlotLabel(slot, cdmxToEpoch(2026, 8, 26, 8), "en"), "today at 11:00 am");
  assert.equal(
    formatSlotLabel(slot, cdmxToEpoch(2026, 8, 24, 8), "en"),
    "on Wednesday at 11:00 am",
  );
});

test("time12h: 24h → Mexican 12h clock", () => {
  assert.equal(time12h("07:00"), "7:00 am");
  assert.equal(time12h("12:00"), "12:00 pm");
  assert.equal(time12h("00:30"), "12:30 am");
  assert.equal(time12h("15:15"), "3:15 pm");
  assert.equal(time12h("21:00"), "9:00 pm");
});

test("disciplineLabel: service key → client-facing name", () => {
  assert.equal(disciplineLabel("muay"), "Muay Thai");
  assert.equal(disciplineLabel("jiu"), "Jiu-Jitsu");
  assert.equal(disciplineLabel("baby"), "Baby Fight Club");
  assert.equal(disciplineLabel("unknown"), "unknown");
});
