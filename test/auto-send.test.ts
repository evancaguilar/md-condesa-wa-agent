import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_SEND_DAILY_CAP,
  AUTO_SEND_KV,
  autoSendCountKey,
  bumpAutoSendCount,
  decideAutoSend,
  evaluateAutoSendLane,
  getAutoSendCount,
  hasPriorResolvedApproval,
  isAutoSendEnabled,
  setAutoSendEnabled,
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
    message: SAFE,
    hasPriorResolvedApproval: true,
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

test("decideAutoSend: low (or unknown) confidence blocks", () => {
  for (const confidence of ["low", "medium", ""]) {
    assert.deepEqual(
      decideAutoSend(input({ confidence })),
      { auto: false, blockedBy: "confidence" },
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

test("decideAutoSend: every price/promo token blocks", () => {
  for (const message of [
    "Son $999 al mes.",
    "El precio depende del plan.",
    "El costo de la clase es bajo.",
    "Tenemos una promo esta semana.",
    "Hay descuento por pago anual.",
    "Son 1200 MXN mensuales.",
    "La inscripción es aparte.",
    "La mensualidad incluye dos disciplinas.",
    "La membresía es flexible.",
  ]) {
    assert.deepEqual(
      decideAutoSend(input({ message })),
      { auto: false, blockedBy: "price" },
      message,
    );
  }
});

test("decideAutoSend: first contact (no approved/edited history) blocks", () => {
  assert.deepEqual(decideAutoSend(input({ hasPriorResolvedApproval: false })), {
    auto: false,
    blockedBy: "first_contact",
  });
});

test("decideAutoSend: daily cap boundary — 19 passes, 20 blocks", () => {
  assert.equal(AUTO_SEND_DAILY_CAP, 20);
  assert.deepEqual(decideAutoSend(input({ dailyCount: 19 })), { auto: true });
  assert.deepEqual(decideAutoSend(input({ dailyCount: 20 })), {
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
    decideAutoSend(input({ enabled: false, confidence: "low", dailyCount: 99 }))
      .blockedBy,
    "switch",
  );
  // …booking claim beats price…
  assert.equal(
    decideAutoSend(input({ message: "Ya quedó agendado, son $999." })).blockedBy,
    "booking_claim",
  );
  // …and price beats the per-lead gates.
  assert.equal(
    decideAutoSend(
      input({ message: "El precio es ese.", hasPriorResolvedApproval: false, dailyCount: 99 }),
    ).blockedBy,
    "price",
  );
});

// ---- fake D1 (kv rows + the prior-approval probe) ---------------------------

interface FakeDb {
  db: D1Database;
  store: Map<string, string>;
  calls: { sql: string; binds: unknown[] }[];
}

function fakeDb(
  initial: Record<string, string> = {},
  opts: { priorApproval?: boolean } = {},
): FakeDb {
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
        if (sql.includes("FROM pending_approvals")) {
          return (opts.priorApproval ? ({ n: 1 } as unknown as T) : null) as T | null;
        }
        return null;
      },
      async run() {
        calls.push({ sql, binds });
        if (sql.includes("INSERT INTO kv")) {
          store.set(String(binds[0]), String(binds[1]));
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

test("bumpAutoSendCount: absent key starts at 1, then increments", async () => {
  const f = fakeDb();
  assert.equal(await bumpAutoSendCount(f.db, DAY_STR), 1);
  assert.equal(await bumpAutoSendCount(f.db, DAY_STR), 2);
  assert.equal(f.store.get(autoSendCountKey(DAY_STR)), "2");
});

test("bumpAutoSendCount: builds on an existing count and ignores garbage", async () => {
  const f = fakeDb({ [autoSendCountKey(DAY_STR)]: "7" });
  assert.equal(await bumpAutoSendCount(f.db, DAY_STR), 8);
  const g = fakeDb({ [autoSendCountKey(DAY_STR)]: "muchas" });
  assert.equal(await bumpAutoSendCount(g.db, DAY_STR), 1);
});

test("bumpAutoSendCount: the counter rolls over with the CDMX day", async () => {
  const f = fakeDb();
  await bumpAutoSendCount(f.db, "2026-08-25");
  await bumpAutoSendCount(f.db, "2026-08-25");
  assert.equal(await bumpAutoSendCount(f.db, "2026-08-26"), 1);
  assert.equal(await getAutoSendCount(f.db, "2026-08-25"), 2);
  assert.equal(await getAutoSendCount(f.db, "2026-08-26"), 1);
});

test("getAutoSendCount: unknown day reads as 0", async () => {
  assert.equal(await getAutoSendCount(fakeDb().db, "2026-01-01"), 0);
});

test("hasPriorResolvedApproval: true only when an approved/edited row exists", async () => {
  const yes = fakeDb({}, { priorApproval: true });
  assert.equal(await hasPriorResolvedApproval(yes.db, "5215500000000"), true);
  const no = fakeDb({}, { priorApproval: false });
  assert.equal(await hasPriorResolvedApproval(no.db, "5215500000000"), false);
  // The query must scope to sent-by-a-human statuses and to this phone.
  const sql = no.calls[0]!.sql;
  assert.match(sql, /status IN \('approved', 'edited'\)/);
  assert.deepEqual(no.calls[0]!.binds, ["5215500000000"]);
});

// ---- lane evaluation (what the inbound pipeline calls) ----------------------

const lane = (over: Partial<{ action: string; confidence: string; message: string }> = {}) => ({
  phone: "5215500000000",
  action: "send",
  confidence: "high",
  message: SAFE,
  now: NOW,
  ...over,
});

test("evaluateAutoSendLane: switch off ⇒ blocked, and no per-lead queries run", async () => {
  const f = fakeDb({}, { priorApproval: true });
  const r = await evaluateAutoSendLane(f.db, lane());
  assert.deepEqual(
    { auto: r.auto, blockedBy: r.blockedBy, day: r.day, cap: r.cap },
    { auto: false, blockedBy: "switch", day: DAY_STR, cap: AUTO_SEND_DAILY_CAP },
  );
  assert.equal(f.calls.length, 1); // just the switch read
});

test("evaluateAutoSendLane: an ineligible message costs one kv read", async () => {
  const f = fakeDb({ [AUTO_SEND_KV]: "1" }, { priorApproval: true });
  const r = await evaluateAutoSendLane(f.db, lane({ message: "Son $999 al mes." }));
  assert.equal(r.blockedBy, "price");
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.calls.some((c) => c.sql.includes("pending_approvals")),
    false,
  );
});

test("evaluateAutoSendLane: all gates pass ⇒ auto, with today's count and day", async () => {
  const f = fakeDb(
    { [AUTO_SEND_KV]: "1", [autoSendCountKey(DAY_STR)]: "4" },
    { priorApproval: true },
  );
  const r = await evaluateAutoSendLane(f.db, lane());
  assert.deepEqual(
    { auto: r.auto, blockedBy: r.blockedBy, dailyCount: r.dailyCount, day: r.day },
    { auto: true, blockedBy: undefined, dailyCount: 4, day: DAY_STR },
  );
});

test("evaluateAutoSendLane: no approved/edited history ⇒ first_contact", async () => {
  const f = fakeDb({ [AUTO_SEND_KV]: "1" }, { priorApproval: false });
  const r = await evaluateAutoSendLane(f.db, lane());
  assert.deepEqual({ auto: r.auto, blockedBy: r.blockedBy }, {
    auto: false,
    blockedBy: "first_contact",
  });
});

test("evaluateAutoSendLane: at the cap ⇒ blocked; one below ⇒ auto", async () => {
  const at = fakeDb(
    { [AUTO_SEND_KV]: "1", [autoSendCountKey(DAY_STR)]: String(AUTO_SEND_DAILY_CAP) },
    { priorApproval: true },
  );
  const blocked = await evaluateAutoSendLane(at.db, lane());
  assert.deepEqual({ auto: blocked.auto, blockedBy: blocked.blockedBy }, {
    auto: false,
    blockedBy: "cap",
  });

  const below = fakeDb(
    { [AUTO_SEND_KV]: "1", [autoSendCountKey(DAY_STR)]: String(AUTO_SEND_DAILY_CAP - 1) },
    { priorApproval: true },
  );
  assert.equal((await evaluateAutoSendLane(below.db, lane())).auto, true);
});

test("evaluateAutoSendLane: the day is CDMX, not UTC (23:00 CDMX is still today)", async () => {
  // 23:00 CDMX on the 25th is already the 26th in UTC — the counter must not
  // roll over an hour before midnight local.
  const f = fakeDb({ [AUTO_SEND_KV]: "1" }, { priorApproval: true });
  const late = cdmxToEpoch(2026, 8, 25, 23, 0, 0);
  const r = await evaluateAutoSendLane(f.db, { ...lane(), now: late });
  assert.equal(r.day, DAY_STR);
  assert.equal(cdmxDateStr(late), DAY_STR);
});

test("evaluateAutoSendLane: a draft never auto-sends even with everything armed", async () => {
  const f = fakeDb(
    { [AUTO_SEND_KV]: "1", [autoSendCountKey(DAY_STR)]: "0" },
    { priorApproval: true },
  );
  const r = await evaluateAutoSendLane(f.db, lane({ action: "draft" }));
  assert.deepEqual({ auto: r.auto, blockedBy: r.blockedBy }, {
    auto: false,
    blockedBy: "action",
  });
});
