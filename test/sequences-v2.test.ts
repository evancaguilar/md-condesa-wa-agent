import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isQuietHour,
  shiftOutOfQuiet,
  next8am,
  placeNudge3,
} from "../src/cron/quiet.js";
import {
  computeDayOnePlan,
  computeExtendedChain,
  maybeArmExtended,
  classifyProgram,
  extendedCopy,
  EXTENDED_NUDGE_KINDS,
} from "../src/cron/nudges.js";
import { cdmxToEpoch, cdmxParts, DAY } from "../src/cron/time.js";
import type { Contact, Env } from "../src/types.js";

// ---- tiny fake D1 (mirrors nudges.test.ts) ----

type Handler = (sql: string, binds: unknown[]) => {
  first?: unknown;
  all?: unknown[];
  changes?: number;
};

function fakeDb(handler: Handler): {
  db: D1Database;
  calls: { sql: string; binds: unknown[] }[];
} {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        calls.push({ sql, binds });
        return (handler(sql, binds).first ?? null) as T | null;
      },
      async run() {
        calls.push({ sql, binds });
        return { results: [], meta: { changes: handler(sql, binds).changes ?? 1 } };
      },
      async all<T>() {
        calls.push({ sql, binds });
        return { results: (handler(sql, binds).all ?? []) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, calls };
}

function envWith(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

function contact(over: Partial<Contact>): Contact {
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

// Fixed CDMX moments.
const D15 = (h: number, m = 0) => cdmxToEpoch(2026, 7, 15, h, m, 0);
const D16 = (h: number, m = 0) => cdmxToEpoch(2026, 7, 16, h, m, 0);

// ---- R1: isQuietHour / shiftOutOfQuiet ----

test("isQuietHour: 21:30 allowed, after it quiet, mornings quiet, daytime clear", () => {
  assert.equal(isQuietHour(D15(1)), true); // 1am
  assert.equal(isQuietHour(D15(7, 59)), true); // 7:59am
  assert.equal(isQuietHour(D15(8)), false); // 8:00 exactly allowed
  assert.equal(isQuietHour(D15(12)), false); // noon
  assert.equal(isQuietHour(D15(21, 30)), false); // 21:30 exactly allowed (pull target)
  assert.equal(isQuietHour(D15(21, 31)), true); // 21:31 quiet
  assert.equal(isQuietHour(D15(23)), true); // 11pm
});

test("shiftOutOfQuiet: 1am → 8am same day", () => {
  assert.equal(shiftOutOfQuiet(D15(1)), D15(8));
});

test("shiftOutOfQuiet: evening quiet → 8am next day; daytime unchanged", () => {
  assert.equal(shiftOutOfQuiet(D15(22)), D16(8));
  assert.equal(shiftOutOfQuiet(D15(23, 45)), D16(8));
  assert.equal(shiftOutOfQuiet(D15(14)), D15(14)); // in the clear
});

test("next8am is strictly after the input", () => {
  assert.equal(next8am(D15(7)), D15(8));
  assert.equal(next8am(D15(8)), D16(8)); // 8:00 → next day's 8:00
  assert.equal(next8am(D15(22)), D16(8));
});

// ---- R2: nudge-3 placement rule ----

test("placeNudge3: natural time is fine → keep", () => {
  const natural = D15(17); // 5pm
  const nudge2 = D15(15); // 3pm (earliest 5pm)
  const p = placeNudge3(natural, nudge2, D16(9), D15(9));
  assert.deepEqual(p, { dueAt: natural });
});

test("placeNudge3: 22:00 quiet + ≥2h satisfied → pull to 21:30", () => {
  const natural = D15(22);
  const nudge2 = D15(19); // earliest 21:00
  const p = placeNudge3(natural, nudge2, D16(12), D15(14));
  assert.deepEqual(p, { dueAt: D15(21, 30) });
});

test("placeNudge3: ≥2h guard fails → defer to next 08:00", () => {
  const natural = D15(22);
  const nudge2 = D15(20); // earliest 22:00 → 21:30 < 22:00, no pull
  const p = placeNudge3(natural, nudge2, D16(12), D15(14));
  assert.deepEqual(p, { dueAt: D16(8) });
});

test("placeNudge3: pull + defer both beyond window → drop", () => {
  const natural = D15(22);
  const nudge2 = D15(19); // earliest 21:00
  const p = placeNudge3(natural, nudge2, D15(21), D15(14)); // window closes 21:00
  assert.deepEqual(p, { dropped: true });
});

// ---- computeDayOnePlan ----

test("computeDayOnePlan: daytime base → 3 nudges, none dropped", () => {
  const base = D15(9); // 09:00
  const plan = computeDayOnePlan(base, base);
  assert.equal(plan.nudge3Dropped, false);
  assert.deepEqual(
    plan.scheduled.map((s) => [s.kind, s.dueAt]),
    [
      ["nudge_1h", D15(10)],
      ["nudge_6h", D15(15)],
      ["nudge_8h", D15(17)],
    ],
  );
});

test("computeDayOnePlan: evening base defers nudges 1–2 out of quiet with ≥2h gap", () => {
  const base = D15(21); // 9pm → +1h=22:00 (quiet), +6h=03:00 (quiet)
  const plan = computeDayOnePlan(base, base);
  const one = plan.scheduled.find((s) => s.kind === "nudge_1h");
  const six = plan.scheduled.find((s) => s.kind === "nudge_6h");
  // nudge_1h (22:00) → next 08:00; nudge_6h (03:00) → 08:00 collides → +2h = 10:00
  assert.equal(one?.dueAt, D16(8));
  assert.equal(six?.dueAt, D16(10));
  // ≥2h between consecutive placed nudges
  assert.ok((six?.dueAt ?? 0) - (one?.dueAt ?? 0) >= 2 * 3600);
});

// ---- R3: extended chain timing ----

test("computeExtendedChain: 4 steps, each +24h off the previous, quiet-shifted", () => {
  const anchor = D15(10);
  const chain = computeExtendedChain(anchor);
  assert.deepEqual(chain.map((c) => c.kind), [...EXTENDED_NUDGE_KINDS]);
  // 10:00 + 24h stays 10:00 each day (never quiet)
  assert.deepEqual(
    chain.map((c) => c.dueAt),
    [D16(10), cdmxToEpoch(2026, 7, 17, 10, 0, 0), cdmxToEpoch(2026, 7, 18, 10, 0, 0), cdmxToEpoch(2026, 7, 19, 10, 0, 0)],
  );
});

test("computeExtendedChain: quiet anchor shifts d2 to 08:00, chain continues", () => {
  const anchor = D15(7); // 7am (quiet) — +24h = 7am D16 → 08:00 D16
  const chain = computeExtendedChain(anchor);
  assert.equal(chain[0]?.dueAt, D16(8));
  assert.equal(chain[1]?.dueAt, cdmxToEpoch(2026, 7, 17, 8, 0, 0));
});

// ---- classifyProgram ----

test("classifyProgram: baby by discipline, baby by campaign, kids by audience, else adults", () => {
  assert.equal(
    classifyProgram(contact({ qualification: JSON.stringify({ discipline: "Baby Fight Club" }) })),
    "baby",
  );
  assert.equal(classifyProgram(contact({}), "Promo Baby CDMX"), "baby");
  assert.equal(
    classifyProgram(contact({ qualification: JSON.stringify({ audience: "kid" }) })),
    "kids",
  );
  assert.equal(
    classifyProgram(contact({ qualification: JSON.stringify({ audience: "adult", discipline: "BJJ" }) })),
    "adults",
  );
  assert.equal(classifyProgram(null), "adults");
});

// ---- extended copy ----

test("extendedCopy: program links + CTA present, last step is a warm goodbye", () => {
  const adultsD2 = extendedCopy(contact({ name: "Ana" }), "nudge_d2", "adults");
  assert.ok(adultsD2.includes("https://mdcondesa.com/clase-prueba-adultos/"));
  assert.ok(adultsD2.includes("Ana"));

  const kidsD3 = extendedCopy(contact({}), "nudge_d3", "kids");
  assert.ok(kidsD3.includes("https://mdcondesa.com/clase-prueba-ninos/"));

  const babyD5 = extendedCopy(contact({}), "nudge_d5", "baby");
  assert.ok(babyD5.includes("https://mdcondesa.com/clase-prueba-ninos/"));
  assert.ok(/último mensaje/i.test(babyD5));
});

// ---- 30d guard (maybeArmExtended) ----

test("maybeArmExtended: first run schedules d2–d5 + sets seq_done", async () => {
  const inserted: unknown[] = [];
  let seqDoneSet = false;
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT value FROM kv")) return { first: null }; // not done yet
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      inserted.push(binds[1]);
      return {};
    }
    if (sql.startsWith("INSERT INTO kv") && String(binds[0]).startsWith("seq_done:")) {
      seqDoneSet = true;
      return {};
    }
    return {};
  });
  await maybeArmExtended(envWith(db), "5215512345678", D15(10));
  assert.deepEqual(inserted, [...EXTENDED_NUDGE_KINDS]);
  assert.equal(seqDoneSet, true);
});

test("maybeArmExtended: within 30d → no re-schedule", async () => {
  const inserted: unknown[] = [];
  const recent = Math.floor(Date.now() / 1000) - 5 * DAY; // 5 days ago
  const { db } = fakeDb((sql) => {
    if (sql.includes("SELECT value FROM kv")) return { first: { value: String(recent) } };
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      inserted.push(1);
      return {};
    }
    return {};
  });
  await maybeArmExtended(envWith(db), "5215512345678", D15(10));
  assert.equal(inserted.length, 0);
});
