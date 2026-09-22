// nextTrialSlot (B1): the concrete class a nudge proposes. Every expectation
// below is derived from the COMPILED schedule (src/brain/slots.gen.ts) — never
// from a hand-written table. Anchor week (CDMX): Mon 2026-08-24 … Sun 2026-08-30.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  nextTrialSlot,
  upcomingTrialSlots,
  inPreferredBlock,
  formatSlotLabel,
  disciplineLabel,
  time12h,
  SLOT_LEAD_SECONDS,
  TODAY_BUFFER_SECONDS,
} from "../src/cron/next-slot.js";
import { cdmxParts, cdmxToEpoch } from "../src/cron/time.js";
import { SLOTS } from "../src/brain/slots.gen.js";
import { weekdayIndex } from "../src/brain/tools.js";

const MON = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 24, h, m, 0);
const THU = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 27, h, m, 0);
const FRI = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 28, h, m, 0);
const SUN = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 30, h, m, 0);

test("nextTrialSlot: Monday morning, kid Muay Thai → today's 16:00 Kids", () => {
  // 15:15 exists on the grid but is Mini Muay Thai (3–5, parent-participation,
  // pp: true) — a generic kid pick must land on the Kids class, not Mini.
  const slot = nextTrialSlot("muay", "kid", MON(10));
  assert.equal(slot?.date, "2026-08-24");
  assert.equal(slot?.weekday, 0);
  assert.equal(slot?.time, "16:00");
  assert.equal(slot?.discipline, "muay");
  assert.equal(slot?.label, "hoy a las 4:00 pm");
});

test("nextTrialSlot: 2h lead time skips classes that are too close", () => {
  // 14:30 → 15:15 (45 min away) and 16:00 (90 min away) are both inside the
  // 2h lead, so the proposal rolls to the next day's kid Muay Thai.
  const slot = nextTrialSlot("muay", "kid", MON(14, 30));
  assert.equal(slot?.date, "2026-08-25");
  assert.equal(slot?.time, "16:00");
  assert.equal(slot?.label, "mañana martes 4:00 pm");
});

test("nextTrialSlot: Thursday evening adult Muay Thai proposes the sparring hour", () => {
  // Owner policy 2026-08-25: jue 18:00 + 19:00 muay take trials again (the
  // professor gives first-timers a mini-lesson). 18:00 is inside the 2h lead
  // from 17:00, so the proposal is the same evening at 19:00.
  const slot = nextTrialSlot("Muay Thai", "adult", THU(17));
  assert.equal(slot?.date, "2026-08-27");
  assert.equal(slot?.time, "19:00");
  assert.equal(slot?.label, "hoy a las 7:00 pm");
});

test("nextTrialSlot: Sunday kid lead never gets a Sunday slot", () => {
  const slot = nextTrialSlot(null, "kid", SUN(10));
  assert.ok(slot);
  assert.notEqual(slot?.weekday, 6); // 6 = Sunday
  assert.equal(slot?.date, "2026-08-31"); // the following Monday
  assert.equal(slot?.time, "16:00"); // Kids Muay Thai, never the pp Mini class
  assert.equal(slot?.label, "mañana lunes 4:00 pm");
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
  // 15:15 (Mini MT, pp) is skipped: the fallback lands on a REAL adult class.
  assert.equal(slot?.time, "18:00");
  assert.equal(slot?.discipline, "jiu");
});

// Regression pin for the 2026-08-26 incident: Wednesday-morning adult nudges
// proposed "Baby Fight Club hoy a las 11:00 am" because the dual-audience
// (pp) baby mirror looked like the soonest adult slot.
test("nextTrialSlot: generic picks never propose a parent-participation slot", () => {
  const WED = (h: number, m = 0): number => cdmxToEpoch(2026, 8, 26, h, m, 0);
  for (const audience of ["adult", "kid"] as const) {
    const slot = nextTrialSlot(null, audience, WED(8, 15));
    assert.ok(slot);
    assert.notEqual(slot?.discipline, "baby", JSON.stringify(slot));
    assert.notEqual(slot?.time, "15:15", JSON.stringify(slot));
    assert.notEqual(slot?.time, "13:15", JSON.stringify(slot));
  }
  // An EXPLICIT baby pick still lands on the baby grid (Wed 13:00).
  const baby = nextTrialSlot("baby", "kid", WED(8, 15));
  assert.equal(baby?.discipline, "baby");
  assert.equal(baby?.time, "13:00");
});

test("nextTrialSlot: empty schedule → null (copy falls back to generic)", () => {
  assert.equal(nextTrialSlot("muay", "adult", MON(10), []), null);
});

// The compiled grid no longer flags anything `trial: false`; this hand-authored
// grid keeps the skip logic covered.
test("nextTrialSlot: a trial:false-only grid yields nothing", () => {
  const closedOnly = [
    { weekday: 0, time: "18:00", discipline: "muay", audience: "adult" as const, trial: false },
  ];
  assert.equal(nextTrialSlot("muay", "adult", MON(10), closedOnly), null);
});

// ---- soonest-first (2026-09-21) ----
//
// Same-day trials show 54% (115/214) vs ~29% (126/431) for trials booked a day
// or more out, and Saturday — 37% of all bookings — shows worst of the busy
// days at 33%. The proposal must therefore always be the chronologically
// nearest valid class, never whatever row sits first in SLOTS.

/**
 * Independent brute force: expand the WHOLE grid over the next two weeks, then
 * take the minimum by epoch. Deliberately structured differently from the
 * production walk so an ordering bug there can't hide here.
 */
function bruteSoonest(
  audience: "adult" | "kid",
  now: number,
): { date: string; time: string } | undefined {
  const p = cdmxParts(now);
  const all: { date: string; time: string; at: number }[] = [];
  for (let off = 0; off < 14; off++) {
    const dp = cdmxParts(cdmxToEpoch(p.year, p.month, p.day + off, 0, 0, 0));
    const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
    const date = `${dp.year}-${pad(dp.month)}-${pad(dp.day)}`;
    const wd = weekdayIndex(date);
    for (const s of SLOTS) {
      // pp slots are never proposed to a generic (no-discipline) lead.
      if (s.weekday !== wd || s.audience !== audience || s.trial === false || s.pp) continue;
      const hh = Number(s.time.slice(0, 2));
      const mm = Number(s.time.slice(3, 5));
      const at = cdmxToEpoch(dp.year, dp.month, dp.day, hh, mm, 0);
      if (at >= now + SLOT_LEAD_SECONDS) all.push({ date, time: s.time, at });
    }
  }
  all.sort((a, b) => a.at - b.at);
  return all[0];
}

test("nextTrialSlot: always the chronologically soonest slot, every hour of the week", () => {
  for (let day = 24; day <= 30; day++) {
    for (const h of [0, 6, 10, 14, 17, 20, 23]) {
      const now = cdmxToEpoch(2026, 8, day, h, 0, 0);
      for (const audience of ["adult", "kid"] as const) {
        const got = nextTrialSlot(null, audience, now, undefined, []);
        const want = bruteSoonest(audience, now);
        assert.ok(got && want, `no slot for ${audience} at 2026-08-${day} ${h}:00`);
        assert.equal(`${got!.date} ${got!.time}`, `${want!.date} ${want!.time}`);
      }
    }
  }
});

test("nextTrialSlot: no Saturday default — a weekday lead gets the weekday class", () => {
  // Thursday 06:00: the 08:00 class is the answer, not the busy Saturday grid.
  const slot = nextTrialSlot(null, "adult", THU(6), undefined, []);
  assert.equal(slot?.date, "2026-08-27");
  assert.equal(slot?.time, "08:00");
  assert.equal(slot?.label, "hoy a las 8:00 am");
});

// ---- preferred blocks (config-driven tie-breaker, EMPTY by default) ----

const SAT_EARLY = [{ dow: 5, from: "09:00", to: "13:00" }] as const;

test("inPreferredBlock: from/to are inclusive class start times, dow is 0=Mon", () => {
  const at = (weekday: number, time: string) => ({ weekday, time });
  assert.equal(inPreferredBlock(at(5, "09:00"), SAT_EARLY), true); // lower edge
  assert.equal(inPreferredBlock(at(5, "13:00"), SAT_EARLY), true); // upper edge
  assert.equal(inPreferredBlock(at(5, "08:59"), SAT_EARLY), false);
  assert.equal(inPreferredBlock(at(5, "14:00"), SAT_EARLY), false);
  assert.equal(inPreferredBlock(at(4, "10:00"), SAT_EARLY), false); // Friday
  assert.equal(inPreferredBlock(at(5, "10:00"), []), false); // no blocks ⇒ never
});

test("nextTrialSlot: the EMPTY default leaves behavior at pure soonest-first", () => {
  // Friday 07:00 → today's 09:00, which is also what the live CLIENT config gives.
  const plain = nextTrialSlot(null, "adult", FRI(7), undefined, [], []);
  assert.equal(plain?.date, "2026-08-28");
  assert.equal(plain?.time, "09:00");
  assert.deepEqual(nextTrialSlot(null, "adult", FRI(7), undefined, []), plain);
});

test("nextTrialSlot: a preferred block wins INSIDE the 24h horizon", () => {
  // Soonest is Fri 09:00; Sat 09:00 is exactly 24h later and sits in the block.
  const slot = nextTrialSlot(null, "adult", FRI(7), undefined, [], SAT_EARLY);
  assert.equal(slot?.date, "2026-08-29");
  assert.equal(slot?.time, "09:00");
  assert.equal(slot?.label, "mañana sábado 9:00 am");
});

test("nextTrialSlot: a preferred block NEVER wins beyond the 24h horizon", () => {
  // Same Friday, but the block now starts at 10:00 — Sat 10:00 is 25h out, so
  // sooner wins and the lead keeps today's class.
  const blocks = [{ dow: 5, from: "10:00", to: "13:00" }];
  const slot = nextTrialSlot(null, "adult", FRI(7), undefined, [], blocks);
  assert.equal(slot?.date, "2026-08-28");
  assert.equal(slot?.time, "09:00");
});

test("nextTrialSlot: a preferred block never conjures a slot the grid lacks", () => {
  // Sunday has no kid classes at all; a Sunday block changes nothing.
  const blocks = [{ dow: 6, from: "09:00", to: "13:00" }];
  const slot = nextTrialSlot(null, "kid", SUN(6), undefined, [], blocks);
  assert.notEqual(slot?.weekday, 6);
  assert.deepEqual(slot, nextTrialSlot(null, "kid", SUN(6), undefined, [], []));
});

// ---- upcomingTrialSlots (the brain's per-turn list) ----

test("upcomingTrialSlots: N soonest hours, deduped per (date,time)", () => {
  const slots = upcomingTrialSlots(null, "adult", MON(10), 3, undefined, []);
  assert.equal(slots.length, 3);
  // Monday 18:00/19:00 each hold TWO adult classes (jiu + muay) — one entry each.
  assert.deepEqual(
    slots.map((s) => `${s.date} ${s.time}`),
    ["2026-08-24 18:00", "2026-08-24 19:00", "2026-08-24 20:00"],
  );
  assert.equal(slots[0]?.label, "hoy a las 6:00 pm");
});

test("upcomingTrialSlots: the persona's 1h buffer (shorter than the 2h default) admits the nearer hour", () => {
  // 17:00 + 2h default skips the 18:00 class; the persona's 1h rule
  // (TODAY_BUFFER_SECONDS) lets the model offer it.
  const two = upcomingTrialSlots(null, "adult", MON(17), 1, undefined, []);
  assert.equal(two[0]?.time, "19:00");
  const one = upcomingTrialSlots(
    null,
    "adult",
    MON(17),
    1,
    undefined,
    [],
    TODAY_BUFFER_SECONDS,
  );
  assert.equal(one[0]?.time, "18:00");
  assert.equal(TODAY_BUFFER_SECONDS, 3600);
});

test("upcomingTrialSlots: soonest first, strictly ascending, never a past hour", () => {
  const slots = upcomingTrialSlots(null, "adult", FRI(20), 3, undefined, []);
  assert.equal(slots.length, 3);
  for (let i = 1; i < slots.length; i++) {
    const prev = `${slots[i - 1]!.date} ${slots[i - 1]!.time}`;
    assert.ok(`${slots[i]!.date} ${slots[i]!.time}` > prev, `${prev} → not ascending`);
  }
  // Friday night has nothing left: the list opens on Saturday, not next week.
  assert.equal(slots[0]?.date, "2026-08-29");
});

test("upcomingTrialSlots: honors closed dates and an empty grid", () => {
  const closed = [{ date: "2026-08-24" }, { date: "2026-08-25" }];
  const slots = upcomingTrialSlots(null, "adult", MON(6), 2, undefined, closed);
  assert.ok(slots.every((s) => !["2026-08-24", "2026-08-25"].includes(s.date)));
  assert.equal(slots[0]?.date, "2026-08-26");
  assert.deepEqual(upcomingTrialSlots(null, "adult", MON(6), 3, []), []);
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

// ---- closed dates (holidays) ----

test("nextTrialSlot: a closed date is skipped for every audience; validateSlot rejects it", async () => {
  const { validateSlot, closedDateInfo } = await import("../src/brain/tools.js");
  const now = cdmxToEpoch(2026, 9, 16, 8, 0, 0); // Wed 2026-09-16 08:00 (Independence Day)
  const closed = [{ date: "2026-09-16", reason: "Día de la Independencia" }];
  // No closures ⇒ today's class is still proposed (CLIENT itself lists 09-16).
  const open = nextTrialSlot("muay", "adult", now, undefined, []);
  assert.equal(open?.date, "2026-09-16");
  const shifted = nextTrialSlot("muay", "adult", now, undefined, closed);
  assert.ok(shifted);
  assert.notEqual(shifted!.date, "2026-09-16");
  assert.ok(shifted!.date > "2026-09-16");
  const kid = nextTrialSlot(null, "kid", now, undefined, closed);
  assert.notEqual(kid?.date, "2026-09-16");
  const v = validateSlot("2026-09-16", "19:00", "adult", "muay", undefined, closed);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /CLOSED on 2026-09-16 \(Día de la Independencia\)/);
  assert.equal(validateSlot("2026-09-17", "07:00", "adult", "jiu", undefined, closed).ok, true);
  assert.equal(closedDateInfo("2026-09-16", closed)?.reason, "Día de la Independencia");
  assert.equal(closedDateInfo("2026-09-17", closed), null);
});
