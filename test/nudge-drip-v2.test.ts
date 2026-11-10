// Nudge drip v2 (2026-11): the lead-nudge drip was mostly dead — of 439
// non-booked Meta leads, 35% got 0 follow-ups, 46% got 1 and only 13% the full
// chain (measured 2026-10-28). These pin the fixes: per-inbound day-1 tokens,
// the extended chain armed with every day-1 plan (and resumed, not guarded),
// day-1 sends off the one-per-day claim, deferrals instead of cancels (lost
// claim, pending Aprobar draft) and the optional d7 step. Real in-memory
// SQLite (node:sqlite) behind the D1 surface, fake CDMX clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  armNudges,
  cancelNudges,
  dayOneToken,
  extendedCopy,
  extendedTemplateName,
  nudgeDayClaimKey,
  pendingApprovalRetryAt,
  processExtendedNudge,
  processNudge,
  EXTENDED_NUDGE_KINDS,
  extendedChainKinds,
} from "../src/cron/nudges.js";
import { runDueFollowups } from "../src/cron/followups.js";
import { next8am } from "../src/cron/quiet.js";
import { cdmxToEpoch, DAY } from "../src/cron/time.js";
import { CLIENT } from "../src/client.gen.js";
import { NUDGE_POLICY, SILENT, nudgeChainFor } from "../src/cron/nudge-policy.js";
import type { Contact, Env } from "../src/types.js";

/** The chain armNudges schedules for a SILENT lead (no reply after our first message) under the shipped nudgePolicy (d7 iff nudgeDay7). */
const LIVE_CHAIN: string[] = nudgeChainFor(NUDGE_POLICY, SILENT, 0, CLIENT.features.nudgeDay7 === true);

const H = 3600;
const PHONE = "5215512345678";
/** Tue 2026-11-03 10:00 CDMX — daytime, nothing quiet-shifts. */
const T0 = cdmxToEpoch(2026, 11, 3, 10, 0, 0);

// ---- helpers ----------------------------------------------------------------

function sqliteDb(): { raw: DatabaseSync; db: D1Database } {
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
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (raw.prepare(sql).get(...(binds as never[])) ?? null) as T | null;
      },
      async run() {
        const r = raw.prepare(sql).run(...(binds as never[]));
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(binds as never[])) as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { raw, db: { prepare: make } as unknown as D1Database };
}

function envWith(db: D1Database): Env {
  return { DB: db, AIRTABLE_BASE_ID: "appTest", AIRTABLE_TRIALS_TABLE: "Trials" } as unknown as Env;
}

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: PHONE,
    name: "Ana",
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

function insertContact(raw: DatabaseSync, c: Contact): void {
  raw
    .prepare(
      `INSERT INTO contacts(phone, name, lang, status, qualification, human_override_until, last_inbound_at, campaign_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(c.phone, c.name, c.lang, c.status, c.qualification, c.human_override_until, c.last_inbound_at, c.campaign_id);
}

function setLastInbound(raw: DatabaseSync, ts: number): void {
  raw.prepare(`UPDATE contacts SET last_inbound_at = ? WHERE phone = ?`).run(ts, PHONE);
}

type Row = { id: number; kind: string; status: string; airtable_record_id: string; due_at: number };

function rows(raw: DatabaseSync, where = "1 = 1"): Row[] {
  return raw
    .prepare(`SELECT id, kind, status, airtable_record_id, due_at FROM followups WHERE ${where} ORDER BY due_at, id`)
    .all() as Row[];
}

function scheduled(raw: DatabaseSync): Row[] {
  return rows(raw, "status = 'scheduled'");
}

/** Run `fn` with Date.now pinned to `clock.now` (epoch seconds, mutable). */
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

const textDeps = (sent: string[]) => ({
  async sendText(_e: Env, _p: string, body: string) {
    sent.push(body);
    return "wamid";
  },
  isWindowClosed: () => false,
});

const extDeps = (sent: string[]) => ({
  ...textDeps(sent),
  async sendTemplate(): Promise<string> {
    throw new Error("no template in this test");
  },
  templateName: (base: string, lang: string) => `${base}_${lang}`,
  campaignName: async () => null,
});

const slackDeps = { slack: { async postNote() {}, async postAttendanceCheck() {} } } as never;

// ---- 1. day-1 re-arm ---------------------------------------------------------

test("armNudges: a reply before +1h cancels the day-1 rows and the re-arm schedules FRESH ones", async () => {
  const { raw, db } = sqliteDb();
  const clock = { now: T0 };
  await withClock(clock, async () => {
    insertContact(raw, contact({ last_inbound_at: T0 }));
    await armNudges(envWith(db), PHONE);
    assert.deepEqual(
      scheduled(raw).filter((r) => r.kind === "nudge_1h").map((r) => r.airtable_record_id),
      [dayOneToken(T0)],
    );

    // Lead writes back at +30 min (inbound cancels), the bot answers (re-arm).
    clock.now = T0 + 30 * 60;
    await cancelNudges(envWith(db), PHONE);
    setLastInbound(raw, clock.now);
    await armNudges(envWith(db), PHONE);

    const one = scheduled(raw).filter((r) => r.kind === "nudge_1h");
    assert.equal(one.length, 1); // the '' token used to leave ZERO here
    assert.equal(one[0]!.airtable_record_id, dayOneToken(clock.now));
    assert.equal(one[0]!.due_at, clock.now + H);
    assert.equal(scheduled(raw).filter((r) => r.kind === "nudge_8h").length, 1);
  });
});

test("armNudges: two arms off the SAME inbound revive the cancelled rows; a sent one is never re-sent", async () => {
  const { raw, db } = sqliteDb();
  await withClock({ now: T0 }, async () => {
    insertContact(raw, contact({ last_inbound_at: T0 }));
    await armNudges(envWith(db), PHONE);
    await armNudges(envWith(db), PHONE); // second bot reply to the same message
    assert.deepEqual(
      scheduled(raw).filter((r) => r.kind.endsWith("h")).map((r) => r.kind),
      ["nudge_1h", "nudge_8h"],
    );
    // nudge_1h went out; a third arm off the same inbound keeps it sent.
    raw.prepare(`UPDATE followups SET status = 'sent' WHERE kind = 'nudge_1h'`).run();
    await armNudges(envWith(db), PHONE);
    const all1h = rows(raw, "kind = 'nudge_1h'");
    assert.deepEqual(all1h.map((r) => r.status), ["sent"]);
  });
});

// ---- 2. extended chain armed with every plan --------------------------------

test("armNudges: a silent lead gets the policy's silent steps off the +8h anchor (d7 only with nudgeDay7, else the goodbye is d5)", async () => {
  for (const day7 of [false, true]) {
    const { raw, db } = sqliteDb();
    await withDay7(day7, () =>
      withClock({ now: T0 }, async () => {
        insertContact(raw, contact({ last_inbound_at: T0 }));
        await armNudges(envWith(db), PHONE);
      }),
    );
    const ext = scheduled(raw).filter((r) => r.kind.startsWith("nudge_d"));
    const want = day7 ? ["nudge_d2", "nudge_d7"] : ["nudge_d2", "nudge_d5"];
    assert.deepEqual(ext.map((r) => r.kind), want, `day7=${day7}`);
    const anchor = T0 + 8 * H; // 18:00, not quiet
    assert.ok(ext.every((r) => r.airtable_record_id === `seq:${anchor}`));
    assert.equal(ext[0]!.due_at, anchor + DAY); // d2 = Wed 18:00
    // Absolute day numbers from the anchor: d5 = +4 days, d7 = +6 days (unchanged times).
    assert.equal(ext[1]!.due_at, anchor + (day7 ? 6 : 4) * DAY);
  }
});

test("armNudges: over the day-1 cap the extended chain still arms (only day-1 is capped)", async () => {
  const { raw, db } = sqliteDb();
  await withClock({ now: T0 }, async () => {
    insertContact(raw, contact({ last_inbound_at: T0 }));
    raw
      .prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`)
      .run(`nudge_count:${PHONE}`, JSON.stringify({ sends: [T0 - 3 * H, T0 - 2 * H, T0 - H] }));
    await armNudges(envWith(db), PHONE);
  });
  assert.deepEqual(scheduled(raw).map((r) => r.kind), LIVE_CHAIN);
});

// ---- 3. day-1 sends stay off the one-per-day claim --------------------------

test("processNudge: a day-1 send does not take nudge_day — an extended step the same day still sends", async () => {
  const { raw, db } = sqliteDb();
  const sent: string[] = [];
  await withClock({ now: T0 + H }, async () => {
    insertContact(raw, contact({ last_inbound_at: T0 }));
    assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", textDeps(sent)), "sent");
    const claim = raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(nudgeDayClaimKey(PHONE, T0 + H));
    assert.equal(claim, undefined);
    const res = await processExtendedNudge(envWith(db), PHONE, "nudge_d2", extDeps(sent));
    assert.deepEqual(res, { outcome: "sent" });
  });
  assert.equal(sent.length, 2);
});

test("processNudge: nudge_8h after nudge_1h the same day sends (the old day claim cancelled it)", async () => {
  const { raw, db } = sqliteDb();
  const sent: string[] = [];
  const clock = { now: T0 + H };
  await withClock(clock, async () => {
    insertContact(raw, contact({ last_inbound_at: T0 }));
    assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", textDeps(sent)), "sent");
    clock.now = T0 + 8 * H;
    assert.equal(await processNudge(envWith(db), PHONE, "nudge_8h", textDeps(sent)), "sent");
  });
  assert.equal(sent.length, 2);
});

// ---- 4. extended lost claim → deferred to the next 08:00 --------------------

test("extended step that loses the day claim is DEFERRED to next 08:00, not cancelled (end to end)", async () => {
  const { raw, db } = sqliteDb();
  const now = T0 + 2 * H; // 12:00
  const realFetch = globalThis.fetch;
  let fetched = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    fetched++;
    throw new Error("no network in this test");
  };
  try {
    await withClock({ now }, async () => {
      insertContact(raw, contact({ last_inbound_at: T0 - DAY }));
      raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run(nudgeDayClaimKey(PHONE, now), String(now - H));
      raw
        // d2: in every class's list (a d3 row would now close on the policy).
        .prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, created_at) VALUES(?, 'nudge_d2', ?, 'scheduled', 'seq:1', 0)`)
        .run(PHONE, now - 60);
      await runDueFollowups(envWith(db), slackDeps);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const [row] = rows(raw);
  assert.equal(row!.status, "scheduled");
  assert.equal(row!.due_at, next8am(now));
  assert.equal(row!.due_at, cdmxToEpoch(2026, 11, 4, 8, 0, 0));
  assert.equal(fetched, 0);
});

// ---- 5. resume instead of seq_done ------------------------------------------

test("resume: d2 sent, the lead replies (now engaged), the re-arm schedules the engaged steps after d2 only (no 30-day block)", async () => {
  const { raw, db } = sqliteDb();
  const clock = { now: T0 };
  const msg = raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES(?, ?, ?, ?, ?)`);
  await withClock(clock, async () => {
    msg.run("p1", PHONE, "in", "Hola, quiero info", T0 - 60); // ad prefill
    msg.run("p2", PHONE, "out_bot", "¡Hola Ana! …", T0);
    insertContact(raw, contact({ last_inbound_at: T0 }));
    await armNudges(envWith(db), PHONE);
    // Day 2: d2 goes out.
    const d2 = scheduled(raw).find((r) => r.kind === "nudge_d2")!;
    clock.now = d2.due_at;
    raw.prepare(`UPDATE followups SET status = 'sent' WHERE id = ?`).run(d2.id);
    raw.prepare(`UPDATE followups SET status = 'sent' WHERE kind IN ('nudge_1h', 'nudge_8h')`).run();
    // The lead answers d2 an hour later; the bot replies.
    clock.now = d2.due_at + H;
    msg.run("p3", PHONE, "in", "¿Qué horarios hay el sábado?", clock.now);
    await cancelNudges(envWith(db), PHONE);
    setLastInbound(raw, clock.now);
    await armNudges(envWith(db), PHONE);
  });
  const ext = scheduled(raw).filter((r) => r.kind.startsWith("nudge_d"));
  const engagedChain = nudgeChainFor(NUDGE_POLICY, { engaged: true, firstMessageAt: T0 }, T0, CLIENT.features.nudgeDay7 === true);
  assert.deepEqual(ext.map((r) => r.kind), engagedChain.filter((k) => k !== "nudge_d2"));
  // Fresh token off the new anchor (+8h after the reply, quiet-shifted).
  assert.ok(ext.every((r) => r.airtable_record_id !== `seq:${T0 + 8 * H}`));
  assert.ok(ext[0]!.due_at > clock.now + DAY - 1);
  // d2 is sent exactly once.
  assert.deepEqual(rows(raw, "kind = 'nudge_d2'").map((r) => r.status).sort(), ["sent"]);
});

// ---- 6. a draft waiting in Aprobar holds every nudge back --------------------

test("pending approval: day-1 and extended nudges defer +60 min instead of sending or cancelling", async () => {
  const { raw, db } = sqliteDb();
  const sent: string[] = [];
  const now = T0 + H;
  await withClock({ now }, async () => {
    insertContact(raw, contact({ last_inbound_at: T0 }));
    raw
      .prepare(`INSERT INTO pending_approvals(phone, draft, status, created_at) VALUES(?, 'borrador', 'pending', ?)`)
      .run(PHONE, now - 5 * 60);
    assert.deepEqual(await processNudge(envWith(db), PHONE, "nudge_1h", textDeps(sent)), {
      outcome: "deferred",
      retryAt: now + H,
    });
    assert.deepEqual(await processExtendedNudge(envWith(db), PHONE, "nudge_d2", extDeps(sent)), {
      outcome: "deferred",
      retryAt: now + H,
    });

    // Through the cron: the row stays scheduled, one hour later.
    raw
      .prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, created_at) VALUES(?, 'nudge_1h', ?, 'scheduled', 'd1:1', 0)`)
      .run(PHONE, now - 60);
    await runDueFollowups(envWith(db), slackDeps);
  });
  assert.equal(sent.length, 0);
  const [row] = rows(raw);
  assert.equal(row!.status, "scheduled");
  assert.equal(row!.due_at, now + H);
});

test("pendingApprovalRetryAt: +60 min, quiet-shifted to 08:00", () => {
  assert.equal(pendingApprovalRetryAt(T0), T0 + H);
  assert.equal(pendingApprovalRetryAt(cdmxToEpoch(2026, 11, 3, 20, 30, 0)), cdmxToEpoch(2026, 11, 4, 8, 0, 0));
});

// ---- 7. d7 copy + flag -----------------------------------------------------------

test("extendedCopy: with day7 the goodbye moves to d7 (link-only) and d5 becomes a value touch", () => {
  for (const program of ["adults", "kids", "baby"] as const) {
    for (const lang of ["es", "en"] as const) {
      const c = contact({ lang });
      const d7 = extendedCopy(c, "nudge_d7", program, T0, undefined, null, true);
      const d5On = extendedCopy(c, "nudge_d5", program, T0, undefined, null, true);
      const d5Off = extendedCopy(c, "nudge_d5", program, T0, undefined, null, false);
      const last = lang === "es" ? /último mensaje/i : /last (message|follow-up)/i;
      assert.match(d7, last, `${program}/${lang} d7`);
      assert.doesNotMatch(d5On, last, `${program}/${lang} d5 with d7`);
      assert.match(d5Off, last, `${program}/${lang} d5 without d7 (unchanged)`);
      assert.ok(d7.includes("https://mdcondesa.com/clase-prueba-"), `${program}/${lang} d7 link`);
      assert.ok(d5On.includes("https://mdcondesa.com/clase-prueba-"), `${program}/${lang} d5 link`);
    }
  }
});

test("extendedCopy: d5-with-d7 and d7 are generic (no name) and close with the link + 'o escríbenos aquí'", () => {
  for (const program of ["adults", "kids", "baby"] as const) {
    const link = program === "adults"
      ? "https://mdcondesa.com/clase-prueba-adultos/"
      : "https://mdcondesa.com/clase-prueba-ninos/";
    const c = contact({ name: "Ana" });
    const d7 = extendedCopy(c, "nudge_d7", program, T0, undefined, null, true);
    const d5On = extendedCopy(c, "nudge_d5", program, T0, undefined, null, true);
    for (const [label, text] of [["d7", d7], ["d5 on", d5On]] as const) {
      assert.ok(text.startsWith("¡Hola! "), `${program} ${label} generic opener: ${text}`);
      assert.doesNotMatch(text, /Ana/, `${program} ${label} has no name`);
      assert.ok(text.includes(link), `${program} ${label} link`);
      assert.match(text, /o escríbenos aquí 🙂$/, `${program} ${label} write-us close`);
    }
    // d7 keeps the link-only close; d5 keeps the concrete slot CTA of d2–d4.
    assert.doesNotMatch(d7, /apartar lugar en|¿te late\?|¿les late\?/, `${program} d7 no slot`);
    assert.match(d5On, /(Te|Les) puedo apartar lugar en .* — ¿(te|les) late\?/, `${program} d5 slot CTA`);
    const en7 = extendedCopy(contact({ name: "Ana", lang: "en" }), "nudge_d7", program, T0, undefined, null, true);
    assert.ok(en7.startsWith("Hi! ") && !en7.includes("Ana") && en7.endsWith("or message us here 🙂"), en7);
  }
});

test("extendedCopy: d2–d4 and the flag-off d5 still greet by name and have no 'escríbenos'", () => {
  for (const program of ["adults", "kids", "baby"] as const) {
    for (const kind of ["nudge_d2", "nudge_d3", "nudge_d4"] as const) {
      for (const day7 of [false, true]) {
        const t = extendedCopy(contact({ name: "Ana" }), kind, program, T0, undefined, null, day7);
        assert.match(t, /Ana/, `${program} ${kind} day7=${day7}`);
        assert.doesNotMatch(t, /escríbenos/, `${program} ${kind} day7=${day7}`);
      }
    }
    const d5Off = extendedCopy(contact({ name: "Ana" }), "nudge_d5", program, T0, undefined, null, false);
    assert.match(d5Off, /¡Hola Ana!/);
    assert.doesNotMatch(d5Off, /escríbenos/);
  }
});

test("extendedTemplateName: d5 → nudge_d5v2_* only with the flag on; d7 and d2–d4 unchanged", () => {
  assert.equal(extendedTemplateName("nudge_d5", "adults"), "nudge_d5_adults");
  assert.equal(extendedTemplateName("nudge_d5", "kids", false), "nudge_d5_kids");
  assert.equal(extendedTemplateName("nudge_d5", "adults", true), "nudge_d5v2_adults");
  assert.equal(extendedTemplateName("nudge_d5", "kids", true), "nudge_d5v2_kids");
  assert.equal(extendedTemplateName("nudge_d5", "baby", true), "nudge_d5v2_baby");
  assert.equal(extendedTemplateName("nudge_d7", "baby", true), "nudge_d7_baby");
  assert.equal(extendedTemplateName("nudge_d2", "adults", true), "nudge_d2_adults");
});

test("processExtendedNudge: a d7 row left over after the flag is switched off is cancelled, not sent", async () => {
  const { raw, db } = sqliteDb();
  const sent: string[] = [];
  await withDay7(false, () =>
    withClock({ now: T0 }, async () => {
      insertContact(raw, contact({ last_inbound_at: T0 - DAY }));
      assert.deepEqual(await processExtendedNudge(envWith(db), PHONE, "nudge_d7", extDeps(sent)), {
        outcome: "cancelled",
      });
    }),
  );
  assert.equal(sent.length, 0);
});

test("features.nudgeDay7 ships ON (Evan OK + nudge_d7/d5v2 templates APPROVED 2026-11-05)", () => {
  assert.equal((CLIENT.features as { nudgeDay7?: boolean }).nudgeDay7, true);
});
