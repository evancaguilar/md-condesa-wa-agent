// Engagement-driven drip cut (2026-11-09, after two Meta spam flags in a week):
// which extended steps a lead gets depends on whether it answered the bot.
// Pure policy + offsets, then arm / send-time re-check / catch-up on real
// in-memory SQLite (node:sqlite) behind the D1 surface, with a fake CDMX clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  armNudges,
  cancelNudges,
  computeExtendedChain,
  extendedTemplateName,
  maybeArmExtended,
  processExtendedNudge,
} from "../src/cron/nudges.js";
import {
  FULL_CHAIN_POLICY,
  NUDGE_POLICY,
  SILENT,
  nudgeChainFor,
  policyIsUniform,
  policySkipNote,
  remainingAfterSent,
  resolveNudgePolicy,
  stepOffsets,
  type NudgePolicy,
} from "../src/cron/nudge-policy.js";
import { ENGAGEMENT_SQL, OPT_OUT_TAP_BODIES, engagementByPhone } from "../src/db/nudge-engagement.js";
import { runDueFollowups } from "../src/cron/followups.js";
import { CATCHUP_SQL, runNudgeCatchup } from "../src/services/nudge-catchup-db.js";
import { parseCatchupBody } from "../src/services/nudge-catchup.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { cdmxToEpoch, DAY } from "../src/cron/time.js";
import { CLIENT } from "../src/client.gen.js";
import type { Contact, Env } from "../src/types.js";

const H = 3600;
const PHONE = "5215512345678";
/** Tue 2026-11-03 10:00 CDMX — daytime; +8h anchor = 18:00, nothing quiet-shifts. */
const T0 = cdmxToEpoch(2026, 11, 3, 10, 0, 0);
const ANCHOR = T0 + 8 * H;

// ---- helpers ----------------------------------------------------------------

function sqliteDb(opts: { failEngagement?: boolean } = {}): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(":memory:");
  const text = readFileSync("src/db/schema.sql", "utf8")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  for (const stmt of text.split(";").map((s) => s.trim()).filter(Boolean)) {
    try {
      raw.exec(stmt);
    } catch {
      /* ALTERs re-adding a column already in the CREATE */
    }
  }
  for (const sql of INDEX_SQL) raw.exec(sql);
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const guard = () => {
      if (opts.failEngagement && sql.includes("AS first_in")) throw new Error("D1_ERROR: rows read limit");
    };
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        guard();
        return (raw.prepare(sql).get(...(binds as never[])) ?? null) as T | null;
      },
      async run() {
        guard();
        const r = raw.prepare(sql).run(...(binds as never[]));
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        guard();
        return { results: raw.prepare(sql).all(...(binds as never[])) as T[], meta: {} };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return { raw, db: { prepare: make } as unknown as D1Database };
}

function envWith(db: D1Database): Env {
  return { DB: db, AIRTABLE_BASE_ID: "appTest", AIRTABLE_TRIALS_TABLE: "Trials" } as unknown as Env;
}

function insertContact(raw: DatabaseSync, over: Partial<Contact> = {}): void {
  const c = { phone: PHONE, name: "Ana", lang: "es", status: "lead", last_inbound_at: T0, created_at: T0 - 60, ...over };
  raw
    .prepare(`INSERT INTO contacts(phone, name, lang, status, last_inbound_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 0)`)
    .run(c.phone, c.name, c.lang, c.status, c.last_inbound_at, c.created_at);
}

let seq = 0;
function msg(raw: DatabaseSync, direction: string, body: string, ts: number, phone = PHONE): void {
  raw
    .prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES(?, ?, ?, ?, ?)`)
    .run(`w${++seq}`, phone, direction, body, ts);
}

/** Ad prefill, then the bot's welcome: the "silent" shape. */
function seedSilent(raw: DatabaseSync, phone = PHONE, at = T0): void {
  msg(raw, "in", "¡Hola! Quiero información", at - 60, phone);
  msg(raw, "out_bot", "¡Hola Ana! Con gusto 🙂", at, phone);
}

/** …plus a real answer: the "engaged" shape. */
function seedEngaged(raw: DatabaseSync, phone = PHONE, at = T0): void {
  seedSilent(raw, phone, at);
  msg(raw, "in", "Para mi hijo de 7", at + 120, phone);
}

type Row = { id: number; kind: string; status: string; due_at: number };
function rows(raw: DatabaseSync, where = "1 = 1"): Row[] {
  return raw.prepare(`SELECT id, kind, status, due_at FROM followups WHERE ${where} ORDER BY due_at, id`).all() as Row[];
}
const ext = (raw: DatabaseSync, status = "scheduled") =>
  rows(raw, `status = '${status}' AND kind LIKE 'nudge_d%'`);

function addRow(raw: DatabaseSync, kind: string, dueAt: number, status = "scheduled"): void {
  raw
    .prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, created_at) VALUES(?, ?, ?, ?, 'seq:1', 0)`)
    .run(PHONE, kind, dueAt, status);
}

async function withClock(clock: { now: number }, fn: () => Promise<void>): Promise<void> {
  const real = Date.now;
  Date.now = () => clock.now * 1000;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

async function withDay7(on: boolean, fn: () => Promise<void>): Promise<void> {
  const flags = CLIENT.features as { nudgeDay7?: boolean };
  const prev = flags.nudgeDay7;
  flags.nudgeDay7 = on;
  try {
    await fn();
  } finally {
    flags.nudgeDay7 = prev;
  }
}

const extDeps = (sent: string[], policy?: NudgePolicy) => ({
  async sendText(_e: Env, _p: string, body: string) {
    sent.push(body);
    return "wamid";
  },
  async sendTemplate(): Promise<string> {
    throw new Error("no template in this test");
  },
  templateName: (base: string, lang: string) => `${base}_${lang}`,
  isWindowClosed: () => false,
  campaignName: async () => null,
  ...(policy ? { policy } : {}),
});

const kinds = (rs: { kind: string }[]) => rs.map((r) => r.kind);

// ---- config + pure policy ---------------------------------------------------

test("nudgePolicy ships engaged d2,d4,d7 / silent d2,d7 / silentFreshFull off (client.mjs → client.gen.ts)", () => {
  assert.deepEqual(CLIENT.nudgePolicy, {
    engaged: ["d2", "d4", "d7"],
    silent: ["d2", "d7"],
    silentFreshFull: false,
    silentFreshDays: 7,
  });
  assert.deepEqual(NUDGE_POLICY.engaged, ["nudge_d2", "nudge_d4", "nudge_d7"]);
  assert.deepEqual(NUDGE_POLICY.silent, ["nudge_d2", "nudge_d7"]);
  assert.equal(NUDGE_POLICY.silentFreshFull, false);
  assert.equal(policyIsUniform(NUDGE_POLICY), false);
  assert.equal(policyIsUniform(FULL_CHAIN_POLICY), true);
});

test("resolveNudgePolicy: accepts d4 / nudge_d4, dedupes, orders, drops unknown; absent = legacy full chain", () => {
  const p = resolveNudgePolicy({ engaged: ["d7", "nudge_d4", "d2", "d4", "d9"], silent: [] });
  assert.deepEqual(p.engaged, ["nudge_d2", "nudge_d4", "nudge_d7"]);
  assert.deepEqual(p.silent, []);
  assert.equal(p.silentFreshDays, 7);
  assert.deepEqual(FULL_CHAIN_POLICY.engaged, ["nudge_d2", "nudge_d3", "nudge_d4", "nudge_d5", "nudge_d7"]);
  assert.deepEqual(FULL_CHAIN_POLICY.silent, FULL_CHAIN_POLICY.engaged);
});

test("nudgeChainFor: class lists; d7 flag off turns a trailing d7 into the d5 goodbye", () => {
  const eng = { engaged: true, firstMessageAt: T0 };
  assert.deepEqual(nudgeChainFor(NUDGE_POLICY, eng, T0, true), ["nudge_d2", "nudge_d4", "nudge_d7"]);
  assert.deepEqual(nudgeChainFor(NUDGE_POLICY, SILENT, T0, true), ["nudge_d2", "nudge_d7"]);
  assert.deepEqual(nudgeChainFor(NUDGE_POLICY, eng, T0, false), ["nudge_d2", "nudge_d4", "nudge_d5"]);
  assert.deepEqual(nudgeChainFor(NUDGE_POLICY, SILENT, T0, false), ["nudge_d2", "nudge_d5"]);
});

test("silentFreshFull: off → silent list; on → full chain only while the first message is < silentFreshDays old", () => {
  const on = resolveNudgePolicy({ ...CLIENT.nudgePolicy!, silentFreshFull: true });
  const fresh = { engaged: false, firstMessageAt: T0 - 2 * DAY };
  const old = { engaged: false, firstMessageAt: T0 - 8 * DAY };
  const full = ["nudge_d2", "nudge_d3", "nudge_d4", "nudge_d5", "nudge_d7"];
  assert.deepEqual(nudgeChainFor(NUDGE_POLICY, fresh, T0, true), ["nudge_d2", "nudge_d7"], "shipped off");
  assert.deepEqual(nudgeChainFor(on, fresh, T0, true), full);
  assert.deepEqual(nudgeChainFor(on, old, T0, true), ["nudge_d2", "nudge_d7"]);
  assert.deepEqual(nudgeChainFor(on, SILENT, T0, true), ["nudge_d2", "nudge_d7"], "unknown age is never fresh");
  assert.deepEqual(nudgeChainFor(resolveNudgePolicy({ ...on, silentFreshDays: 10 }), old, T0, true), full);
  assert.equal(policyIsUniform(on), false);
});

test("offsets: absolute day numbers from the anchor with gaps; the full chain keeps its old times", () => {
  assert.deepEqual(stepOffsets(["nudge_d2", "nudge_d7"]), [DAY, 6 * DAY]);
  assert.deepEqual(stepOffsets(["nudge_d2", "nudge_d4", "nudge_d7"]), [DAY, 3 * DAY, 6 * DAY]);
  // Resumed: the first remaining step one gap after the new anchor, the rest on their day numbers.
  assert.deepEqual(stepOffsets(["nudge_d4", "nudge_d7"]), [DAY, 4 * DAY]);
  assert.deepEqual(stepOffsets(["nudge_d7"]), [2 * DAY]);
  assert.deepEqual(
    computeExtendedChain(ANCHOR, FULL_CHAIN_POLICY.engaged).map((t) => t.dueAt - ANCHOR),
    [DAY, 2 * DAY, 3 * DAY, 4 * DAY, 6 * DAY],
  );
  // Quiet anchor (07:00): every step shifts to 08:00 of its own day, still ordered.
  const quiet = cdmxToEpoch(2026, 11, 3, 7, 0, 0);
  assert.deepEqual(
    computeExtendedChain(quiet, ["nudge_d2", "nudge_d4", "nudge_d7"]).map((t) => t.dueAt),
    [cdmxToEpoch(2026, 11, 4, 8, 0, 0), cdmxToEpoch(2026, 11, 6, 8, 0, 0), cdmxToEpoch(2026, 11, 9, 8, 0, 0)],
  );
});

test("remainingAfterSent: never back to a step before the latest sent one (the goodbye stays last)", () => {
  const engaged = NUDGE_POLICY.engaged;
  assert.deepEqual(remainingAfterSent(engaged, ["nudge_d2"]), ["nudge_d4", "nudge_d7"]);
  assert.deepEqual(remainingAfterSent(engaged, ["nudge_d2", "nudge_d3"]), ["nudge_d4", "nudge_d7"]);
  assert.deepEqual(remainingAfterSent(engaged, ["nudge_d2", "nudge_d7"]), []);
  assert.deepEqual(remainingAfterSent(engaged, []), engaged);
});

test("template names per step are the already-approved ones (no new Meta template needed)", () => {
  const names = new Set<string>();
  for (const program of ["adults", "kids", "baby"] as const) {
    for (const k of [...NUDGE_POLICY.engaged, ...NUDGE_POLICY.silent]) names.add(extendedTemplateName(k, program, true));
  }
  assert.deepEqual([...names].sort(), [
    "nudge_d2_adults", "nudge_d2_baby", "nudge_d2_kids",
    "nudge_d4_adults", "nudge_d4_baby", "nudge_d4_kids",
    "nudge_d7_adults", "nudge_d7_baby", "nudge_d7_kids",
  ]);
});

test("policySkipNote: one aggregated line, null when nothing was skipped", () => {
  assert.equal(policySkipNote(new Map()), null);
  const t = policySkipNote(new Map([["silent nudge_d3", 4], ["engaged nudge_d5", 1]]));
  assert.match(t!, /5 envío\(s\) omitidos/);
  assert.match(t!, /engaged nudge_d5 1, silent nudge_d3 4/);
});

// ---- engagement lookup (D1) -------------------------------------------------

test("engagement SQL: a reply after our first message counts; prefill-only, reactions, opt-out taps and same-second replies do not", async () => {
  const { raw, db } = sqliteDb();
  for (const p of ["a", "b", "c", "d", "e", "f", "g"]) insertContact(raw, { phone: p, created_at: 50 });
  msg(raw, "in", "Hola, info", 100, "a"); // prefill only
  msg(raw, "out_bot", "¡Hola!", 110, "a");
  msg(raw, "in", "Hola", 100, "b"); // answered
  msg(raw, "out_bot", "¡Hola!", 110, "b");
  msg(raw, "in", "¿cuánto cuesta?", 200, "b");
  msg(raw, "in", "Hola", 100, "c"); // only a reaction afterwards
  msg(raw, "out_bot", "¡Hola!", 110, "c");
  msg(raw, "in", "[reaccionó 👍]", 120, "c");
  msg(raw, "in", "[quitó su reacción]", 130, "c");
  msg(raw, "in", "Hola", 100, "d"); // opt-out quick reply only
  msg(raw, "out_bot", "[template:nudge_d2_adults_es]", 110, "d");
  msg(raw, "in", "No recibir mensajes", 120, "d");
  msg(raw, "in", "Hola", 100, "e"); // same second as our message: not after it
  msg(raw, "out_bot", "¡Hola!", 110, "e");
  msg(raw, "in", "ok", 110, "e");
  msg(raw, "out_human_echo", "Hola de recepción", 90, "f"); // staff first, lead replied
  msg(raw, "in", "gracias", 95, "f");
  // g: contact without any message
  const got = await engagementByPhone(db, ["a", "b", "c", "d", "e", "f", "g", "nobody"]);
  const engaged = [...got].filter(([, v]) => v.engaged).map(([k]) => k).sort();
  assert.deepEqual(engaged, ["b", "f"]);
  assert.equal(got.get("b")!.firstMessageAt, 100);
  assert.equal(got.get("g")!.firstMessageAt, 50, "no inbound → contact.created_at");
  assert.equal(got.has("nobody"), false, "absent ⇒ callers use SILENT");
  assert.ok(OPT_OUT_TAP_BODIES.includes("no recibir más mensajes"));
});

test("engagement SQL is index-pinned: contacts by PK, every messages subquery on idx_messages_phone_ts", () => {
  const { raw } = sqliteDb();
  for (const sql of [ENGAGEMENT_SQL(3), CATCHUP_SQL.replied(3), CATCHUP_SQL.engagement(2)]) {
    const n = (sql.match(/\?\d+/g) ?? []).length;
    const detail = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: n }, (_, i) => `p${i}`)) as {
      detail: string;
    }[])
      .map((r) => r.detail)
      .join(" | ");
    assert.doesNotMatch(detail, /\bSCAN (c|i|o|f|contacts|messages)\b(?! USING)/, detail);
    assert.doesNotMatch(detail, /idx_messages_direction_ts/, detail);
    assert.match(detail, /idx_messages_phone_ts/, detail);
    assert.match(detail, /USING (COVERING )?INDEX sqlite_autoindex_contacts_1|USING PRIMARY KEY|USING INDEX/, detail);
  }
});

// ---- arm time ---------------------------------------------------------------

test("arm: a silent lead gets only d2 (+1 day) and d7 (+6 days) off the +8h anchor", async () => {
  const { raw, db } = sqliteDb();
  await withDay7(true, () =>
    withClock({ now: T0 }, async () => {
      insertContact(raw);
      seedSilent(raw);
      await armNudges(envWith(db), PHONE);
    }),
  );
  assert.deepEqual(
    ext(raw).map((r) => [r.kind, r.due_at - ANCHOR]),
    [
      ["nudge_d2", DAY],
      ["nudge_d7", 6 * DAY],
    ],
  );
  // Day-1 unchanged.
  assert.deepEqual(kinds(rows(raw, "kind IN ('nudge_1h','nudge_8h')")), ["nudge_1h", "nudge_8h"]);
});

test("arm: a silent lead whose +8h lands in quiet hours: steps at 08:00 of day 2 and day 7", async () => {
  const { raw, db } = sqliteDb();
  const base = cdmxToEpoch(2026, 11, 3, 15, 0, 0); // +8h = 23:00 → anchor 08:00 Wed
  await withDay7(true, () =>
    withClock({ now: base }, async () => {
      insertContact(raw, { last_inbound_at: base });
      seedSilent(raw, PHONE, base);
      await armNudges(envWith(db), PHONE);
    }),
  );
  assert.deepEqual(ext(raw).map((r) => r.due_at), [
    cdmxToEpoch(2026, 11, 5, 8, 0, 0),
    cdmxToEpoch(2026, 11, 10, 8, 0, 0),
  ]);
});

test("arm: an engaged lead gets d2, d4, d7 at +1, +3, +6 days", async () => {
  const { raw, db } = sqliteDb();
  await withDay7(true, () =>
    withClock({ now: T0 + 5 * 60 }, async () => {
      insertContact(raw, { last_inbound_at: T0 });
      seedEngaged(raw);
      await armNudges(envWith(db), PHONE);
    }),
  );
  assert.deepEqual(
    ext(raw).map((r) => [r.kind, r.due_at - ANCHOR]),
    [
      ["nudge_d2", DAY],
      ["nudge_d4", 3 * DAY],
      ["nudge_d7", 6 * DAY],
    ],
  );
});

test("arm: a lead who becomes engaged mid-chain resumes on the engaged list after d2, d7 still last", async () => {
  const { raw, db } = sqliteDb();
  const clock = { now: T0 };
  await withDay7(true, () =>
    withClock(clock, async () => {
      insertContact(raw);
      seedSilent(raw);
      await armNudges(envWith(db), PHONE);
      assert.deepEqual(kinds(ext(raw)), ["nudge_d2", "nudge_d7"]);
      // d2 goes out on day 2; the lead answers it; the bot replies.
      const d2 = ext(raw).find((r) => r.kind === "nudge_d2")!;
      raw.prepare(`UPDATE followups SET status = 'sent' WHERE id = ?`).run(d2.id);
      clock.now = d2.due_at + 2 * H;
      msg(raw, "in", "¿Tienen clase el sábado?", clock.now);
      await cancelNudges(envWith(db), PHONE);
      raw.prepare(`UPDATE contacts SET last_inbound_at = ?`).run(clock.now);
      clock.now += 60;
      msg(raw, "out_bot", "¡Sí! Sábado 10 am 🙂", clock.now);
      await armNudges(envWith(db), PHONE);
    }),
  );
  const anchor = clock.now - 60 + 8 * H; // reply 20:00 + 8h = 04:00 quiet → 08:00
  const live = ext(raw);
  assert.deepEqual(kinds(live), ["nudge_d4", "nudge_d7"]);
  assert.ok(live[0]!.due_at > anchor && live[1]!.due_at - live[0]!.due_at === 3 * DAY, JSON.stringify(live));
  assert.deepEqual(kinds(ext(raw, "sent")), ["nudge_d2"]);
});

test("arm resume after partial sends under the OLD daily chain: d2+d3 sent → engaged gets d4,d7; silent gets d7", async () => {
  for (const [shape, want] of [["engaged", ["nudge_d4", "nudge_d7"]], ["silent", ["nudge_d7"]]] as const) {
    const { raw, db } = sqliteDb();
    await withDay7(true, () =>
      withClock({ now: T0 }, async () => {
        insertContact(raw);
        if (shape === "engaged") seedEngaged(raw, PHONE, T0 - 4 * DAY);
        else seedSilent(raw, PHONE, T0 - 4 * DAY);
        addRow(raw, "nudge_d2", T0 - 3 * DAY, "sent");
        addRow(raw, "nudge_d3", T0 - 2 * DAY, "sent");
        await maybeArmExtended(envWith(db), PHONE, ANCHOR, true);
      }),
    );
    assert.deepEqual(kinds(ext(raw)), want, shape);
    // First remaining step one gap after the anchor: 24h, or 48h when it is d7.
    assert.equal(ext(raw)[0]!.due_at, ANCHOR + (want[0] === "nudge_d7" ? 2 : 1) * DAY, shape);
  }
});

test("arm: a silent lead that already got the goodbye (d2+d7) and then writes gets nothing more", async () => {
  const { raw, db } = sqliteDb();
  await withClock({ now: T0 }, async () => {
    insertContact(raw);
    seedEngaged(raw, PHONE, T0 - 8 * DAY);
    addRow(raw, "nudge_d2", T0 - 7 * DAY, "sent");
    addRow(raw, "nudge_d7", T0 - 2 * DAY, "sent");
    await maybeArmExtended(envWith(db), PHONE, ANCHOR, true);
  });
  assert.deepEqual(ext(raw), []);
});

test("arm with silentFreshFull on: a fresh silent lead gets the full chain, an old one the silent list", async () => {
  const on = resolveNudgePolicy({ ...CLIENT.nudgePolicy!, silentFreshFull: true });
  for (const [age, want] of [
    [2 * DAY, ["nudge_d2", "nudge_d3", "nudge_d4", "nudge_d5", "nudge_d7"]],
    [9 * DAY, ["nudge_d2", "nudge_d7"]],
  ] as const) {
    const { raw, db } = sqliteDb();
    await withClock({ now: T0 }, async () => {
      insertContact(raw);
      seedSilent(raw, PHONE, T0 - age);
      await maybeArmExtended(envWith(db), PHONE, ANCHOR, true, on);
    });
    assert.deepEqual(kinds(ext(raw)), want, `age ${age / DAY}d`);
  }
});

test("arm: engagement lookup failure → treated as silent (d2 + d7), the drip still arms", async () => {
  const { raw, db } = sqliteDb({ failEngagement: true });
  await withDay7(true, () =>
    withClock({ now: T0 + 5 * 60 }, async () => {
      insertContact(raw);
      seedEngaged(raw);
      await armNudges(envWith(db), PHONE);
    }),
  );
  assert.deepEqual(kinds(ext(raw)), ["nudge_d2", "nudge_d7"]);
});

// ---- send time --------------------------------------------------------------

test("send time: pre-existing d3/d4/d5 rows of a silent lead close quietly, ONE ops note per tick, d7 still goes", async () => {
  const { raw, db } = sqliteDb();
  const notes: { text: string; opts: unknown }[] = [];
  const slack = {
    slack: {
      async postNote(text: string, opts: unknown) {
        notes.push({ text, opts });
      },
      async postAttendanceCheck() {},
    },
  } as never;
  const now = T0 + 4 * DAY; // Sat 10:00
  await withDay7(true, () =>
    withClock({ now }, async () => {
      insertContact(raw);
      seedSilent(raw, PHONE, T0);
      // The old daily chain, armed before this deploy: d2 sent, d3–d5 due (a
      // backlog), d7 two days out.
      addRow(raw, "nudge_d2", T0 + DAY, "sent");
      addRow(raw, "nudge_d3", now - 2 * DAY);
      addRow(raw, "nudge_d4", now - DAY);
      addRow(raw, "nudge_d5", now - 60);
      addRow(raw, "nudge_d7", now + 2 * DAY);
      await runDueFollowups(envWith(db), slack);
    }),
  );
  assert.deepEqual(
    rows(raw).map((r) => [r.kind, r.status]),
    [
      ["nudge_d2", "sent"],
      ["nudge_d3", "cancelled"],
      ["nudge_d4", "cancelled"],
      ["nudge_d5", "cancelled"],
      ["nudge_d7", "scheduled"],
    ],
  );
  assert.equal(notes.length, 1, "one aggregated note, not one per row");
  assert.match(notes[0]!.text, /3 envío\(s\) omitidos/);
  assert.match(notes[0]!.text, /silent nudge_d3 1, silent nudge_d4 1, silent nudge_d5 1/);

  // Two days later d7 is still allowed for a silent lead and goes out.
  const sent: string[] = [];
  await withDay7(true, () =>
    withClock({ now: now + 2 * DAY }, async () => {
      assert.deepEqual(await processExtendedNudge(envWith(db), PHONE, "nudge_d7", extDeps(sent)), { outcome: "sent" });
    }),
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /último mensaje/i);
});

test("send time: an engaged lead's old d3/d5 rows are skipped, d4 is not", async () => {
  const { raw, db } = sqliteDb();
  const sent: string[] = [];
  await withDay7(true, () =>
    withClock({ now: T0 + 3 * DAY }, async () => {
      insertContact(raw);
      seedEngaged(raw);
      for (const k of ["nudge_d3", "nudge_d5"] as const) {
        assert.deepEqual(await processExtendedNudge(envWith(db), PHONE, k, extDeps(sent)), {
          outcome: "policy_skip",
          engagement: "engaged",
        });
      }
      assert.deepEqual(await processExtendedNudge(envWith(db), PHONE, "nudge_d4", extDeps(sent)), { outcome: "sent" });
    }),
  );
  assert.equal(sent.length, 1);
});

test("send time: engagement lookup failure → silent: d4 is skipped, d2 still sends", async () => {
  const { raw, db } = sqliteDb({ failEngagement: true });
  const sent: string[] = [];
  await withDay7(true, () =>
    withClock({ now: T0 + 3 * DAY }, async () => {
      insertContact(raw);
      seedEngaged(raw);
      assert.deepEqual(await processExtendedNudge(envWith(db), PHONE, "nudge_d4", extDeps(sent)), {
        outcome: "policy_skip",
        engagement: "silent",
      });
      assert.deepEqual(await processExtendedNudge(envWith(db), PHONE, "nudge_d2", extDeps(sent)), { outcome: "sent" });
    }),
  );
  assert.equal(sent.length, 1);
});

test("send time through the cron: a failed per-tick engagement batch closes non-silent steps, never throws", async () => {
  const { raw, db } = sqliteDb({ failEngagement: true });
  const notes: string[] = [];
  const slack = { slack: { async postNote(t: string) { notes.push(t); }, async postAttendanceCheck() {} } } as never;
  await withDay7(true, () =>
    withClock({ now: T0 + 3 * DAY }, async () => {
      insertContact(raw);
      seedEngaged(raw);
      addRow(raw, "nudge_d4", T0 + 3 * DAY - 60);
      await runDueFollowups(envWith(db), slack);
    }),
  );
  assert.deepEqual(rows(raw).map((r) => r.status), ["cancelled"]);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /silent nudge_d4 1/);
});

test("send time: the legacy full-chain policy (no nudgePolicy) skips nothing", async () => {
  const { raw, db } = sqliteDb();
  const sent: string[] = [];
  await withDay7(true, () =>
    withClock({ now: T0 + 2 * DAY }, async () => {
      insertContact(raw);
      seedSilent(raw);
      assert.deepEqual(
        await processExtendedNudge(envWith(db), PHONE, "nudge_d3", extDeps(sent, FULL_CHAIN_POLICY)),
        { outcome: "sent" },
      );
    }),
  );
});

// ---- catch-up ---------------------------------------------------------------

test("catch-up honours the policy: silent → d2 + d7, engaged → d2,d4,d7, engaged with d2+d3 sent → d4,d7", async () => {
  const NOW = cdmxToEpoch(2026, 11, 9, 10, 0, 0);
  const { raw, db } = sqliteDb();
  const lead = (phone: string, ageDays: number) =>
    insertContact(raw, { phone, last_inbound_at: NOW - ageDays * DAY, created_at: NOW - ageDays * DAY });
  lead("5215500000001", 5); // silent
  seedSilent(raw, "5215500000001", NOW - 5 * DAY);
  lead("5215500000002", 6); // engaged
  seedEngaged(raw, "5215500000002", NOW - 6 * DAY);
  lead("5215500000003", 9); // engaged, resumes
  seedEngaged(raw, "5215500000003", NOW - 9 * DAY);
  const fu = raw.prepare(
    `INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, created_at) VALUES(?, ?, ?, 'sent', 'seq:1', 0)`,
  );
  fu.run("5215500000003", "nudge_d2", NOW - 8 * DAY);
  fu.run("5215500000003", "nudge_d3", NOW - 7 * DAY);
  lead("5215500000004", 9); // silent, d2 + d7 already sent → nothing left
  seedSilent(raw, "5215500000004", NOW - 9 * DAY);
  fu.run("5215500000004", "nudge_d2", NOW - 8 * DAY);
  fu.run("5215500000004", "nudge_d7", NOW - 3 * DAY);

  const p = parseCatchupBody({ dryRun: true }, NOW);
  assert.ok(p.ok);
  const res = await runNudgeCatchup(db, p.ok ? p.opts : (null as never), NOW, { day7: true });
  const byPhone = Object.fromEntries(res.sample.map((s) => [s.phone, s.nextKinds]));
  assert.deepEqual(byPhone, {
    "5215500000001": ["nudge_d2", "nudge_d7"],
    "5215500000002": ["nudge_d2", "nudge_d4", "nudge_d7"],
    "5215500000003": ["nudge_d4", "nudge_d7"],
  });
  assert.equal(res.rows, 2 + 3 + 2);
  assert.equal(res.skipped.chainDone, 1);
  // The legacy policy would have planned the full chain: 5 + 5 + 3 rows (+ d3–d5 for the 4th).
  const legacy = await runNudgeCatchup(db, p.ok ? p.opts : (null as never), NOW, { day7: true, policy: FULL_CHAIN_POLICY });
  assert.ok(legacy.rows > res.rows);
});

test("catch-up: engagement probe failure → every lead silent (and requireReplyToBot keeps none)", async () => {
  const NOW = cdmxToEpoch(2026, 11, 9, 10, 0, 0);
  const { raw, db } = sqliteDb({ failEngagement: true });
  insertContact(raw, { phone: "5215500000002", last_inbound_at: NOW - 6 * DAY, created_at: NOW - 6 * DAY });
  seedEngaged(raw, "5215500000002", NOW - 6 * DAY);
  const p = parseCatchupBody({ dryRun: true }, NOW);
  assert.ok(p.ok);
  const res = await runNudgeCatchup(db, p.ok ? p.opts : (null as never), NOW, { day7: true });
  assert.deepEqual(res.sample.map((s) => s.nextKinds), [["nudge_d2", "nudge_d7"]]);
  const r2 = parseCatchupBody({ dryRun: true, requireReplyToBot: true }, NOW);
  const strict = await runNudgeCatchup(db, r2.ok ? r2.opts : (null as never), NOW, { day7: true });
  assert.equal(strict.candidates, 0);
  assert.equal(strict.skipped.noReplyToBot, 1);
});
