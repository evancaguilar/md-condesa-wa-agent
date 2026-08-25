import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_SEND_DAILY_CAP,
  AUTO_SEND_KV,
  autoSendCountKey,
  decideAutoSend,
  evaluateAutoSendLane,
  getAutoSendCount,
  isAutoSendEnabled,
  releaseAutoSendSlot,
  setAutoSendEnabled,
  SURENESS_SEND_MIN,
  surenessOf,
  tryClaimAutoSendSlot,
  type AutoSendGateInput,
} from "../src/services/auto-send.js";
import { cdmxDateStr, cdmxToEpoch } from "../src/cron/time.js";

// A reply with nothing to review: no money, no promised class, no booking claim.
const SAFE = "Sí, la clase de jiu jitsu para adultos dura una hora.";

/** Everything passing; each test flips exactly one field. */
function input(over: Partial<AutoSendGateInput> = {}): AutoSendGateInput {
  return {
    action: "send",
    confidence: "high",
    sureness: 90,
    message: SAFE,
    dailyCount: 0,
    enabled: true,
    ...over,
  };
}

// ---- pure gate stack -------------------------------------------------------

test("decideAutoSend: happy path auto-sends", () => {
  assert.deepEqual(decideAutoSend(input()), { auto: true });
});

test("decideAutoSend: kv switch off blocks (blockedBy switch)", () => {
  assert.deepEqual(decideAutoSend(input({ enabled: false })), {
    auto: false,
    blockedBy: "switch",
  });
});

test("decideAutoSend: only the plain 'send' action qualifies", () => {
  for (const action of ["draft", "escalate", "book", ""]) {
    assert.deepEqual(
      decideAutoSend(input({ action })),
      { auto: false, blockedBy: "action" },
      action,
    );
  }
});

test("decideAutoSend: the 75% threshold — 74 blocks, 75 passes", () => {
  assert.equal(SURENESS_SEND_MIN, 75);
  assert.deepEqual(decideAutoSend(input({ sureness: 74 })), {
    auto: false,
    blockedBy: "sureness",
  });
  assert.deepEqual(decideAutoSend(input({ sureness: 75 })), { auto: true });
  assert.deepEqual(decideAutoSend(input({ sureness: 0 })), {
    auto: false,
    blockedBy: "sureness",
  });
  assert.deepEqual(decideAutoSend(input({ sureness: 100 })), { auto: true });
});

test("decideAutoSend: no sureness ⇒ the legacy enum decides (high 85 / low 50)", () => {
  assert.equal(surenessOf(undefined, "high"), 85);
  assert.equal(surenessOf(undefined, "low"), 50);
  assert.equal(surenessOf(10, "high"), 10, "an explicit number always wins");
  assert.deepEqual(
    decideAutoSend(input({ sureness: undefined, confidence: "high" })),
    { auto: true },
  );
  for (const confidence of ["low", "medium", ""]) {
    assert.deepEqual(
      decideAutoSend(input({ sureness: undefined, confidence })),
      { auto: false, blockedBy: "sureness" },
      confidence,
    );
  }
});

test("decideAutoSend: a booking claim always goes to a human", () => {
  for (const message of [
    "Listo, ya quedó agendado tu lugar 🙌",
    "Tu clase está reservada.",
    "Te esperamos mañana a las 7 pm.",
  ]) {
    assert.deepEqual(
      decideAutoSend(input({ message })),
      { auto: false, blockedBy: "booking_claim" },
      message,
    );
  }
});

test("decideAutoSend: offering to book is NOT a booking claim (still auto-sends)", () => {
  // The shared regex deliberately spares offers/questions — the lane inherits it.
  assert.deepEqual(
    decideAutoSend(input({ message: "¿Quieres que te agende una clase de prueba?" })),
    { auto: true },
  );
});

test("decideAutoSend: price copy AUTO-SENDS now (gate removed 2026-08-25)", () => {
  // The price/promo gate and the first-contact gate are gone: sureness owns
  // that caution (persona.md checklist box 3 sends an unapproved figure to
  // 25-50, well under the threshold). A price the model is 90% sure of — one of
  // the approved figures — goes straight out.
  for (const message of [
    "Son $999 al mes.",
    "El precio depende del plan.",
    "Tenemos una promo esta semana.",
    "La inscripción es aparte.",
    "La membresía es flexible.",
  ]) {
    assert.deepEqual(decideAutoSend(input({ message })), { auto: true }, message);
  }
  // …and the same copy at 60% still waits for a human.
  assert.deepEqual(decideAutoSend(input({ message: "Son $999 al mes.", sureness: 60 })), {
    auto: false,
    blockedBy: "sureness",
  });
});

test("decideAutoSend: daily cap boundary — 99 passes, 100 blocks", () => {
  assert.equal(AUTO_SEND_DAILY_CAP, 100);
  assert.deepEqual(decideAutoSend(input({ dailyCount: 99 })), { auto: true });
  assert.deepEqual(decideAutoSend(input({ dailyCount: 100 })), {
    auto: false,
    blockedBy: "cap",
  });
  assert.deepEqual(decideAutoSend(input({ dailyCount: 999 })), {
    auto: false,
    blockedBy: "cap",
  });
});

test("decideAutoSend: gate order — the earliest failure is the one reported", () => {
  // switch beats everything…
  assert.equal(
    decideAutoSend(input({ enabled: false, sureness: 10, dailyCount: 999 })).blockedBy,
    "switch",
  );
  // …action beats sureness…
  assert.equal(
    decideAutoSend(input({ action: "draft", sureness: 10 })).blockedBy,
    "action",
  );
  // …sureness beats the booking-claim lock…
  assert.equal(
    decideAutoSend(input({ message: "Ya quedó agendado.", sureness: 10 })).blockedBy,
    "sureness",
  );
  // …and the booking claim beats the cap.
  assert.equal(
    decideAutoSend(input({ message: "Ya quedó agendado.", dailyCount: 999 })).blockedBy,
    "booking_claim",
  );
});

test("decideAutoSend: a 100%-sure booking claim STILL blocks (correctness lock)", () => {
  assert.deepEqual(
    decideAutoSend(input({ message: "Listo, ya quedó agendado tu lugar 🙌", sureness: 100 })),
    { auto: false, blockedBy: "booking_claim" },
  );
});

// ---- fake D1 (kv rows) ------------------------------------------------------

interface FakeDb {
  db: D1Database;
  store: Map<string, string>;
  calls: { sql: string; binds: unknown[] }[];
}

function fakeDb(initial: Record<string, string> = {}): FakeDb {
  const store = new Map<string, string>(Object.entries(initial));
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
        if (sql.includes("FROM kv")) {
          const v = store.get(String(binds[0]));
          return (v === undefined ? null : ({ value: v } as unknown as T)) as T | null;
        }
        return null;
      },
      async run() {
        calls.push({ sql, binds });
        const key = String(binds[0]);
        // CAST('muchas' AS INTEGER) is 0 in SQLite — mirror that here.
        const asInt = (v: string | undefined): number => {
          const n = Number.parseInt(v ?? "", 10);
          return Number.isFinite(n) ? n : 0;
        };
        if (sql.includes("INSERT OR IGNORE INTO kv")) {
          if (store.has(key)) return { results: [], meta: { changes: 0 } };
          store.set(key, String(binds[1]));
          return { results: [], meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO kv")) {
          store.set(key, String(binds[1]));
          return { results: [], meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE kv SET value = CAST(value AS INTEGER) + 1")) {
          const cur = asInt(store.get(key));
          if (cur >= Number(binds[1])) return { results: [], meta: { changes: 0 } };
          store.set(key, String(cur + 1));
          return { results: [], meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE kv SET value = CAST(value AS INTEGER) - 1")) {
          const cur = asInt(store.get(key));
          if (cur <= 0) return { results: [], meta: { changes: 0 } };
          store.set(key, String(cur - 1));
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 1 } };
      },
      async all<T>() {
        calls.push({ sql, binds });
        return { results: [] as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, store, calls };
}

/** 2026-08-25 10:00 CDMX. */
const NOW = cdmxToEpoch(2026, 8, 25, 10, 0, 0);
const DAY_STR = "2026-08-25";

// ---- runtime helpers -------------------------------------------------------

test("isAutoSendEnabled: only the exact '1' arms the lane", async () => {
  assert.equal(await isAutoSendEnabled(fakeDb({ [AUTO_SEND_KV]: "1" }).db), true);
  assert.equal(await isAutoSendEnabled(fakeDb({ [AUTO_SEND_KV]: "0" }).db), false);
  assert.equal(await isAutoSendEnabled(fakeDb({ [AUTO_SEND_KV]: "true" }).db), false);
});

test("isAutoSendEnabled: a MISSING kv key means disabled (ships inert)", async () => {
  assert.equal(await isAutoSendEnabled(fakeDb().db), false);
});

test("setAutoSendEnabled writes 1/0 to the master switch", async () => {
  const f = fakeDb();
  await setAutoSendEnabled(f.db, true);
  assert.equal(f.store.get(AUTO_SEND_KV), "1");
  await setAutoSendEnabled(f.db, false);
  assert.equal(f.store.get(AUTO_SEND_KV), "0");
});

test("tryClaimAutoSendSlot: absent key starts at 1, then increments", async () => {
  const f = fakeDb();
  assert.equal(await tryClaimAutoSendSlot(f.db, DAY_STR), true);
  assert.equal(await tryClaimAutoSendSlot(f.db, DAY_STR), true);
  assert.equal(f.store.get(autoSendCountKey(DAY_STR)), "2");
});

test("tryClaimAutoSendSlot: builds on an existing count and ignores garbage", async () => {
  const f = fakeDb({ [autoSendCountKey(DAY_STR)]: "7" });
  assert.equal(await tryClaimAutoSendSlot(f.db, DAY_STR), true);
  assert.equal(await getAutoSendCount(f.db, DAY_STR), 8);
  const g = fakeDb({ [autoSendCountKey(DAY_STR)]: "muchas" });
  assert.equal(await tryClaimAutoSendSlot(g.db, DAY_STR), true);
  assert.equal(await getAutoSendCount(g.db, DAY_STR), 1);
});

test("tryClaimAutoSendSlot: the counter rolls over with the CDMX day", async () => {
  const f = fakeDb();
  await tryClaimAutoSendSlot(f.db, "2026-08-25");
  await tryClaimAutoSendSlot(f.db, "2026-08-25");
  assert.equal(await tryClaimAutoSendSlot(f.db, "2026-08-26"), true);
  assert.equal(await getAutoSendCount(f.db, "2026-08-25"), 2);
  assert.equal(await getAutoSendCount(f.db, "2026-08-26"), 1);
});

test("tryClaimAutoSendSlot: one below the cap wins, AT the cap loses", async () => {
  const below = fakeDb({ [autoSendCountKey(DAY_STR)]: String(AUTO_SEND_DAILY_CAP - 1) });
  assert.equal(await tryClaimAutoSendSlot(below.db, DAY_STR, AUTO_SEND_DAILY_CAP), true);
  assert.equal(await getAutoSendCount(below.db, DAY_STR), AUTO_SEND_DAILY_CAP);
  // …and the very next claim, now AT the cap, is refused without bumping.
  assert.equal(await tryClaimAutoSendSlot(below.db, DAY_STR, AUTO_SEND_DAILY_CAP), false);
  assert.equal(await getAutoSendCount(below.db, DAY_STR), AUTO_SEND_DAILY_CAP);
});

test("tryClaimAutoSendSlot: two concurrent-ish claims for the LAST slot — only one wins", async () => {
  // The whole point of the atomic claim: the old read-modify-write bump let
  // both of these read cap-1 and both send.
  const f = fakeDb({ [autoSendCountKey(DAY_STR)]: String(AUTO_SEND_DAILY_CAP - 1) });
  const [a, b] = await Promise.all([
    tryClaimAutoSendSlot(f.db, DAY_STR, AUTO_SEND_DAILY_CAP),
    tryClaimAutoSendSlot(f.db, DAY_STR, AUTO_SEND_DAILY_CAP),
  ]);
  assert.deepEqual([a, b].filter(Boolean).length, 1);
  assert.equal(await getAutoSendCount(f.db, DAY_STR), AUTO_SEND_DAILY_CAP);
});

test("releaseAutoSendSlot: gives a claim back, and never goes below zero", async () => {
  const f = fakeDb();
  await tryClaimAutoSendSlot(f.db, DAY_STR);
  await releaseAutoSendSlot(f.db, DAY_STR);
  assert.equal(await getAutoSendCount(f.db, DAY_STR), 0);
  await releaseAutoSendSlot(f.db, DAY_STR);
  assert.equal(await getAutoSendCount(f.db, DAY_STR), 0);
});

test("getAutoSendCount: unknown day reads as 0", async () => {
  assert.equal(await getAutoSendCount(fakeDb().db, "2026-01-01"), 0);
});

// ---- lane evaluation (what the inbound pipeline calls) ----------------------

const lane = (
  over: Partial<{
    action: string;
    confidence: string;
    sureness: number;
    message: string;
  }> = {},
) => ({
  phone: "5215500000000",
  action: "send",
  confidence: "high",
  sureness: 90,
  message: SAFE,
  now: NOW,
  ...over,
});

test("evaluateAutoSendLane: switch off ⇒ blocked, and no counter read runs", async () => {
  const f = fakeDb();
  const r = await evaluateAutoSendLane(f.db, lane());
  assert.deepEqual(
    { auto: r.auto, blockedBy: r.blockedBy, day: r.day, cap: r.cap },
    { auto: false, blockedBy: "switch", day: DAY_STR, cap: AUTO_SEND_DAILY_CAP },
  );
  assert.equal(f.calls.length, 1); // just the switch read
});

test("evaluateAutoSendLane: an ineligible message costs one kv read", async () => {
  const f = fakeDb({ [AUTO_SEND_KV]: "1" });
  const r = await evaluateAutoSendLane(f.db, lane({ sureness: 40 }));
  assert.equal(r.blockedBy, "sureness");
  assert.equal(f.calls.length, 1);
});

test("evaluateAutoSendLane: a price answer the model is sure of goes out", async () => {
  // Regression for the removed `price` gate — this used to be blocked outright.
  const f = fakeDb({ [AUTO_SEND_KV]: "1" });
  const r = await evaluateAutoSendLane(f.db, lane({ message: "Son $999 al mes." }));
  assert.deepEqual({ auto: r.auto, blockedBy: r.blockedBy }, {
    auto: true,
    blockedBy: undefined,
  });
});

test("evaluateAutoSendLane: never queries pending_approvals (no first-contact gate)", async () => {
  const f = fakeDb({ [AUTO_SEND_KV]: "1", [autoSendCountKey(DAY_STR)]: "3" });
  const r = await evaluateAutoSendLane(f.db, lane());
  assert.equal(r.auto, true);
  assert.equal(
    f.calls.some((c) => c.sql.includes("pending_approvals")),
    false,
    "a lead with zero approval history still auto-sends",
  );
});

test("evaluateAutoSendLane: all gates pass ⇒ auto, with today's count and day", async () => {
  const f = fakeDb({ [AUTO_SEND_KV]: "1", [autoSendCountKey(DAY_STR)]: "4" });
  const r = await evaluateAutoSendLane(f.db, lane());
  assert.deepEqual(
    { auto: r.auto, blockedBy: r.blockedBy, dailyCount: r.dailyCount, day: r.day },
    { auto: true, blockedBy: undefined, dailyCount: 4, day: DAY_STR },
  );
});

test("evaluateAutoSendLane: at the cap ⇒ blocked; one below ⇒ auto", async () => {
  const at = fakeDb({
    [AUTO_SEND_KV]: "1",
    [autoSendCountKey(DAY_STR)]: String(AUTO_SEND_DAILY_CAP),
  });
  const blocked = await evaluateAutoSendLane(at.db, lane());
  assert.deepEqual({ auto: blocked.auto, blockedBy: blocked.blockedBy }, {
    auto: false,
    blockedBy: "cap",
  });

  const below = fakeDb({
    [AUTO_SEND_KV]: "1",
    [autoSendCountKey(DAY_STR)]: String(AUTO_SEND_DAILY_CAP - 1),
  });
  assert.equal((await evaluateAutoSendLane(below.db, lane())).auto, true);
});

test("evaluateAutoSendLane: the day is CDMX, not UTC (23:00 CDMX is still today)", async () => {
  // 23:00 CDMX on the 25th is already the 26th in UTC — the counter must not
  // roll over an hour before midnight local.
  const f = fakeDb({ [AUTO_SEND_KV]: "1" });
  const late = cdmxToEpoch(2026, 8, 25, 23, 0, 0);
  const r = await evaluateAutoSendLane(f.db, { ...lane(), now: late });
  assert.equal(r.day, DAY_STR);
  assert.equal(cdmxDateStr(late), DAY_STR);
});

test("evaluateAutoSendLane: a draft never auto-sends even with everything armed", async () => {
  const f = fakeDb({ [AUTO_SEND_KV]: "1", [autoSendCountKey(DAY_STR)]: "0" });
  const r = await evaluateAutoSendLane(f.db, lane({ action: "draft" }));
  assert.deepEqual({ auto: r.auto, blockedBy: r.blockedBy }, {
    auto: false,
    blockedBy: "action",
  });
});
