// Nudge-drip catch-up (2026-11): owner one-shot that resumes the extended chain
// for recent leads the broken drip left at 0–1 follow-ups. Pure selection +
// planning with a fake CDMX clock, then the D1 layer on real in-memory SQLite
// (node:sqlite): dryRun writes nothing, apply inserts exactly the planned rows
// under the run token, and every probe query is index-pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  catchupToken,
  classifyCatchupLead,
  defaultCatchupStart,
  normalizeCatchupStart,
  parseCatchupBody,
  parseCatchupCancelBody,
  planCatchup,
  rowSkipReason,
  type CatchupContactRow,
  type CatchupLead,
  type CatchupProbes,
} from "../src/services/nudge-catchup.js";
import { CATCHUP_SQL, cancelNudgeCatchup, runNudgeCatchup } from "../src/services/nudge-catchup-db.js";
import { ALL_EXTENDED_KINDS } from "../src/cron/nudge-copy.js";
import { extendedChainKinds, EXTENDED_NUDGE_KINDS, type ExtendedKind } from "../src/cron/nudges.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { cdmxParts, cdmxToEpoch, DAY } from "../src/cron/time.js";

const H = 3600;
/** Tue 2026-11-03 10:00 CDMX. */
const NOW = cdmxToEpoch(2026, 11, 3, 10, 0, 0);
/** Wed 2026-11-04 09:00 CDMX — the default start from NOW. */
const START = cdmxToEpoch(2026, 11, 4, 9, 0, 0);
const CHAIN = extendedChainKinds(false);

function row(over: Partial<CatchupContactRow> = {}): CatchupContactRow {
  return {
    phone: "5215500000001",
    name: "Ana",
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: NOW - 5 * DAY,
    campaign_id: null,
    created_at: NOW - 5 * DAY,
    ...over,
  };
}

function probes(over: Partial<CatchupProbes> = {}): CatchupProbes {
  return { pendingApproval: false, bookingMarker: null, followups: [], messages: [], ...over };
}

const skipOf = (r: CatchupContactRow, p: CatchupProbes = probes(), chain = CHAIN, ex = new Set<string>()) =>
  classifyCatchupLead(r, p, NOW, chain, ex).skip;

// ---- selection ---------------------------------------------------------------

test("catch-up selection: an eligible lead resumes the whole chain", () => {
  const v = classifyCatchupLead(row(), probes(), NOW, CHAIN);
  assert.equal(v.skip, null);
  assert.deepEqual(v.skip === null ? v.nextKinds : null, [...EXTENDED_NUDGE_KINDS]);
});

test("catch-up selection: every skip reason", () => {
  assert.equal(skipOf(row(), probes(), CHAIN, new Set(["5215500000001"])), "excluded");
  assert.equal(skipOf(row({ phone: "ig:1784" })), "notWa");
  assert.equal(skipOf(row({ status: "opted_out" })), "optedOut");
  assert.equal(skipOf(row({ status: "student" })), "student");
  assert.equal(skipOf(row({ last_inbound_at: null })), "noInbound");
  assert.equal(skipOf(row({ lang: "en" })), "english");
  assert.equal(skipOf(row({ human_override_until: NOW + H })), "override");
  assert.equal(skipOf(row({ human_override_until: NOW - H })), null, "expired override is fine");
  // booked: marker < 60d, a past booking-kind row < 60d, or a live reminder
  assert.equal(skipOf(row(), probes({ bookingMarker: String(NOW - 10 * DAY) })), "booked");
  assert.equal(skipOf(row(), probes({ bookingMarker: String(NOW - 70 * DAY) })), null);
  assert.equal(
    skipOf(row(), probes({ followups: [{ kind: "no_show_hoy", status: "sent", due_at: NOW - 3 * DAY }] })),
    "booked",
  );
  assert.equal(
    skipOf(row(), probes({ followups: [{ kind: "same_day", status: "cancelled", due_at: NOW - 90 * DAY }] })),
    null,
  );
  assert.equal(skipOf(row(), probes({ pendingApproval: true })), "pendingApproval");
  assert.equal(
    skipOf(row(), probes({ followups: [{ kind: "nudge_d3", status: "scheduled", due_at: NOW + DAY }] })),
    "inChain",
  );
  assert.equal(
    skipOf(
      row(),
      probes({ followups: EXTENDED_NUDGE_KINDS.map((k) => ({ kind: k, status: "sent", due_at: NOW - 2 * DAY })) }),
    ),
    "chainDone",
  );
  assert.equal(
    skipOf(row(), probes({ messages: [{ direction: "out_bot", body: null, ts: NOW - 47 * H }] })),
    "recentOutbound",
  );
  assert.equal(
    skipOf(row(), probes({ messages: [{ direction: "out_bot", body: null, ts: NOW - 49 * H }] })),
    null,
    "a 49h-old outbound is fine",
  );
  assert.equal(
    skipOf(row(), probes({ messages: [{ direction: "in", body: "¿cómo pago la mensualidad?", ts: NOW - 3 * DAY }] })),
    "buyIntent",
  );
  assert.equal(rowSkipReason(row(), NOW, new Set()), null);
});

test("catch-up selection: resume computes nextKinds from the steps already sent (30d window)", () => {
  const v = classifyCatchupLead(
    row(),
    probes({
      followups: [
        { kind: "nudge_d2", status: "sent", due_at: NOW - 6 * DAY },
        { kind: "nudge_d3", status: "cancelled", due_at: NOW - 5 * DAY },
        { kind: "nudge_d4", status: "sent", due_at: NOW - 40 * DAY }, // too old: counts as not sent
      ],
    }),
    NOW,
    CHAIN,
  );
  assert.equal(v.skip, null);
  if (v.skip === null) {
    assert.deepEqual(v.sentKinds, ["nudge_d2"]);
    assert.deepEqual(v.nextKinds, ["nudge_d3", "nudge_d4", "nudge_d5"]);
  }
});

test("catch-up selection: d7 is part of the chain only with the flag", () => {
  const sentD2toD5 = EXTENDED_NUDGE_KINDS.map((k) => ({ kind: k, status: "sent", due_at: NOW - 3 * DAY }));
  assert.equal(skipOf(row(), probes({ followups: sentD2toD5 }), extendedChainKinds(false)), "chainDone");
  const v = classifyCatchupLead(row(), probes({ followups: sentD2toD5 }), NOW, extendedChainKinds(true));
  assert.deepEqual(v.skip === null ? v.nextKinds : null, ["nudge_d7"]);
});

// ---- start + body ------------------------------------------------------------

test("catch-up start: next 09:00 CDMX ≥ now+10min; explicit starts clamp into 09:00–19:00", () => {
  assert.equal(defaultCatchupStart(NOW), START);
  assert.equal(defaultCatchupStart(cdmxToEpoch(2026, 11, 3, 8, 30)), cdmxToEpoch(2026, 11, 3, 9, 0));
  assert.equal(defaultCatchupStart(cdmxToEpoch(2026, 11, 3, 8, 55)), START, "08:55 + 10 min is past 09:00");
  assert.equal(normalizeCatchupStart(cdmxToEpoch(2026, 11, 4, 6, 0)), START);
  assert.equal(normalizeCatchupStart(cdmxToEpoch(2026, 11, 3, 19, 0)), START);
  const mid = cdmxToEpoch(2026, 11, 4, 14, 0);
  assert.equal(normalizeCatchupStart(mid), mid);
});

test("catch-up body: defaults, clamps, past startAt rejected", () => {
  const ok = parseCatchupBody({}, NOW);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.opts.dryRun, true);
    assert.equal(ok.opts.sinceDays, 21);
    assert.equal(ok.opts.perDay, 150);
    assert.equal(ok.opts.limit, 2000);
    assert.equal(ok.opts.startAt, START);
  }
  const c = parseCatchupBody({ dryRun: false, sinceDays: 400, perDay: 9999, excludePhones: ["+52 1 55 0000 0001"] }, NOW);
  assert.ok(c.ok);
  if (c.ok) {
    assert.equal(c.opts.dryRun, false);
    assert.equal(c.opts.sinceDays, 45);
    assert.equal(c.opts.perDay, 400);
    assert.ok(c.opts.excludePhones.has("5215500000001"));
  }
  assert.equal(parseCatchupBody({ startAt: new Date((NOW - H) * 1000).toISOString() }, NOW).ok, false);
  assert.equal(parseCatchupBody({ startAt: "mañana" }, NOW).ok, false);
});

// ---- planning ----------------------------------------------------------------

function lead(i: number, nextKinds: ExtendedKind[] = [...EXTENDED_NUDGE_KINDS]): CatchupLead {
  return {
    row: row({ phone: `52155000000${String(i).padStart(2, "0")}`, created_at: NOW - i * H }),
    sentKinds: [],
    nextKinds,
  };
}

const cdmxHourMin = (t: number): number => {
  const p = cdmxParts(t);
  return p.hour * 60 + p.minute;
};

test("catch-up plan: N leads over ceil(N/perDay) days, first steps 09:00–19:00 CDMX, freshest first", () => {
  const leads = Array.from({ length: 7 }, (_, i) => lead(6 - i)); // shuffled order in
  const plan = planCatchup(leads, 3, START);
  assert.equal(plan.length, 7);
  assert.deepEqual([...new Set(plan.map((p) => p.day))], [0, 1, 2]); // ceil(7/3)
  // Freshest (smallest i → newest created_at) first.
  assert.equal(plan[0]!.row.phone, "5215500000000");
  assert.equal(plan[6]!.row.phone, "5215500000006");
  for (const p of plan) {
    const first = p.rows[0]!.dueAt;
    assert.ok(cdmxHourMin(first) >= 9 * 60 && cdmxHourMin(first) < 19 * 60, `first step at ${cdmxHourMin(first)}`);
    assert.equal(Math.floor((first - START) / DAY), p.day);
  }
  // Day 0: 3 leads spread evenly over 10h → 09:00, 12:20, 15:40.
  assert.deepEqual(
    plan.filter((p) => p.day === 0).map((p) => p.rows[0]!.dueAt - START),
    [0, 12000, 24000],
  );
  // Day 2 holds the single leftover at 09:00.
  assert.equal(plan[6]!.rows[0]!.dueAt, START + 2 * DAY);
});

test("catch-up plan: the rest of the chain follows +24h (d7 +48h)", () => {
  const [p] = planCatchup([lead(1, ["nudge_d4", "nudge_d5", "nudge_d7"])], 150, START);
  assert.deepEqual(
    p!.rows.map((r) => [r.kind, r.dueAt - START]),
    [
      ["nudge_d4", 0],
      ["nudge_d5", DAY],
      ["nudge_d7", 3 * DAY],
    ],
  );
  // A chain whose first remaining step is d7 still lands on the slot.
  const [q] = planCatchup([lead(1, ["nudge_d7"])], 150, START);
  assert.equal(q!.rows[0]!.dueAt, START);
});

test("catch-up plan: a mid-day start gets only its share of day 0 (send rate stays ≤ perDay/10h)", () => {
  const start = cdmxToEpoch(2026, 11, 4, 14, 0); // 5h of 10h left
  const plan = planCatchup(Array.from({ length: 12 }, (_, i) => lead(i)), 10, start);
  assert.equal(plan.filter((p) => p.day === 0).length, 5);
  assert.equal(plan.filter((p) => p.day === 1).length, 7);
  for (const p of plan.filter((p) => p.day === 0)) assert.ok(p.rows[0]!.dueAt >= start);
});

// ---- D1 layer on real SQLite --------------------------------------------------

function sqliteDb(): { raw: DatabaseSync; db: D1Database; sqls: string[] } {
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
  const sqls: string[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        sqls.push(sql);
        return (raw.prepare(sql).get(...(binds as never[])) ?? null) as T | null;
      },
      async run() {
        sqls.push(sql);
        const r = raw.prepare(sql).run(...(binds as never[]));
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        sqls.push(sql);
        return { results: raw.prepare(sql).all(...(binds as never[])) as T[], meta: {} };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: make,
    async batch(stmts: D1PreparedStatement[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
  return { raw, db, sqls };
}

function seed(raw: DatabaseSync): void {
  const ins = raw.prepare(
    `INSERT INTO contacts(phone, name, lang, status, last_inbound_at, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
  );
  // 3 eligible leads (one resumes from d4), plus one per skip reason.
  ins.run("5215500000001", "Ana", "es", "lead", NOW - 2 * DAY, NOW - 3 * DAY, NOW);
  ins.run("5215500000002", "Beto", "es", "lead", NOW - 6 * DAY, NOW - 6 * DAY, NOW);
  ins.run("5215500000003", "Caro", "es", "lead", NOW - 10 * DAY, NOW - 12 * DAY, NOW);
  ins.run("5215500000004", "Dani", "es", "student", NOW - 2 * DAY, NOW - 4 * DAY, NOW);
  ins.run("5215500000005", "Eli", "en", "lead", NOW - 2 * DAY, NOW - 4 * DAY, NOW);
  ins.run("5215500000006", "Fer", "es", "lead", NOW - 3 * DAY, NOW - 5 * DAY, NOW); // booked
  ins.run("5215500000007", "Gabi", "es", "lead", NOW - 3 * DAY, NOW - 5 * DAY, NOW); // blast 1 day ago
  ins.run("5215500000008", "Hugo", "es", "lead", NOW - 3 * DAY, NOW - 40 * DAY, NOW); // outside window
  ins.run("ig:17841", "Ines", "es", "lead", NOW - 3 * DAY, NOW - 5 * DAY, NOW);
  raw
    .prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, created_at) VALUES(?, ?, ?, ?, ?, ?)`)
    .run("5215500000003", "nudge_d2", NOW - 8 * DAY, "sent", "seq:1", NOW);
  raw
    .prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, created_at) VALUES(?, ?, ?, ?, ?, ?)`)
    .run("5215500000003", "nudge_d3", NOW - 7 * DAY, "sent", "seq:1", NOW);
  raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run("booking_recorded:5215500000006", String(NOW - 4 * DAY));
  raw
    .prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES(?, ?, ?, ?, ?)`)
    .run("w1", "5215500000007", "out_bot", "[template:promo]", NOW - DAY);
  raw
    .prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES(?, ?, ?, ?, ?)`)
    .run("w2", "5215500000001", "in", "hola, info", NOW - 2 * DAY);
}

const optsFor = (dryRun: boolean) => {
  const p = parseCatchupBody({ dryRun }, NOW);
  assert.ok(p.ok);
  return p.ok ? p.opts : (null as never);
};

test("catch-up D1: dryRun reports counts + sample and inserts nothing", async () => {
  const { raw, db, sqls } = sqliteDb();
  seed(raw);
  const notes: string[] = [];
  const res = await runNudgeCatchup(db, optsFor(true), NOW, { postNote: async (t) => void notes.push(t) });
  assert.equal(res.dryRun, true);
  assert.equal(res.candidates, 3);
  assert.equal(res.scheduled, 0);
  assert.equal(res.rows, 4 + 4 + 2); // Caro resumes at d4
  assert.equal(res.estTemplateSends, res.rows);
  assert.deepEqual(res.byNextStep, { nudge_d2: 2, nudge_d4: 1 });
  assert.equal(res.skipped.student, 1);
  assert.equal(res.skipped.english, 1);
  assert.equal(res.skipped.booked, 1);
  assert.equal(res.skipped.recentOutbound, 1);
  assert.equal(res.skipped.notWa, 1);
  assert.equal(res.scanned, 8, "Hugo (40d) is outside the 21-day window");
  assert.deepEqual(res.byAge, { "0-7d": 2, "7-14d": 1, "14-21d": 0, "21+": 0 });
  assert.equal(res.days, 1);
  assert.equal(res.sample[0]!.phone, "5215500000001", "freshest first");
  assert.deepEqual(res.sample[2]!.nextKinds, ["nudge_d4", "nudge_d5"]);
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM followups`).get()!.n, 2, "nothing inserted");
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'nudge_catchup:%'`).get()!.n, 0);
  assert.equal(notes.length, 0);
  assert.ok(sqls.every((s) => /^\s*SELECT/i.test(s)), "dry run only reads");
});

test("catch-up D1: apply inserts exactly the planned rows with the run token; a rerun adds none", async () => {
  const { raw, db } = sqliteDb();
  seed(raw);
  const notes: string[] = [];
  const res = await runNudgeCatchup(db, optsFor(false), NOW, { postNote: async (t) => void notes.push(t) });
  const token = catchupToken(START);
  assert.equal(res.token, token);
  assert.equal(res.runId, START);
  assert.equal(res.scheduled, 3);
  const rows = raw
    .prepare(`SELECT phone, kind, due_at, status FROM followups WHERE airtable_record_id = ? ORDER BY due_at, phone`)
    .all(token) as { phone: string; kind: string; due_at: number; status: string }[];
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.status === "scheduled"));
  // Ana (freshest) first at 09:00, Caro third at 09:00 + 2·(10h/3).
  assert.deepEqual(
    rows.filter((r) => r.phone === "5215500000001").map((r) => [r.kind, r.due_at - START]),
    [
      ["nudge_d2", 0],
      ["nudge_d3", DAY],
      ["nudge_d4", 2 * DAY],
      ["nudge_d5", 3 * DAY],
    ],
  );
  assert.deepEqual(
    rows.filter((r) => r.phone === "5215500000003").map((r) => [r.kind, r.due_at - START]),
    [
      ["nudge_d4", 24000],
      ["nudge_d5", DAY + 24000],
    ],
  );
  const kv = raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(`nudge_catchup:${START}`) as { value: string };
  assert.equal(JSON.parse(kv.value).scheduled, 3);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /seq:catchup:/);

  // Second apply with the same start: everyone already holds a live chain.
  const again = await runNudgeCatchup(db, optsFor(false), NOW, {});
  assert.equal(again.candidates, 0);
  assert.equal(again.skipped.inChain, 3);
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM followups WHERE airtable_record_id = ?`).get(token)!.n, 10);
});

test("catch-up D1: every probe is index-pinned (no full scans of hot tables)", () => {
  const { raw } = sqliteDb();
  const plans: [string, unknown[]][] = [
    [CATCHUP_SQL.contacts, [0, 2000]],
    [CATCHUP_SQL.pending, []],
    [CATCHUP_SQL.followups(2, 2), ["a", "b", "nudge_d2", "same_day"]],
    [CATCHUP_SQL.kv(2), ["a", "b"]],
    [CATCHUP_SQL.messages(2), ["a", "b", 0]],
  ];
  for (const [sql, binds] of plans) {
    const detail = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");
    assert.doesNotMatch(detail, /^SCAN \w+$|\bSCAN (contacts|followups|messages|kv|pending_approvals)\b(?! USING)/, detail);
    assert.match(detail, /USING (COVERING )?INDEX|USING PRIMARY KEY/, detail);
  }
  const contacts = (raw.prepare(`EXPLAIN QUERY PLAN ${CATCHUP_SQL.contacts}`).all(0, 1) as { detail: string }[])
    .map((r) => r.detail)
    .join(" ");
  assert.match(contacts, /idx_contacts_created/);
});

// ---- requireReplyToBot + cancel (2026-11-05, Meta spam flag) ---------------------

test("catch-up body: requireReplyToBot defaults to false, true only when sent as true", () => {
  const d = parseCatchupBody({}, NOW);
  assert.ok(d.ok && d.opts.requireReplyToBot === false);
  const t = parseCatchupBody({ requireReplyToBot: true }, NOW);
  assert.ok(t.ok && t.opts.requireReplyToBot === true);
  const s = parseCatchupBody({ requireReplyToBot: "yes" }, NOW);
  assert.ok(s.ok && s.opts.requireReplyToBot === false);
});

test("catch-up selection: a paused extended row counts as a live chain", () => {
  assert.equal(
    skipOf(row(), probes({ followups: [{ kind: "nudge_d2", status: "paused", due_at: NOW + DAY }] })),
    "inChain",
  );
  assert.equal(
    skipOf(row(), probes({ followups: [{ kind: "nudge_d2", status: "cancelled", due_at: NOW - DAY }] })),
    null,
  );
});

function seedReplies(raw: DatabaseSync): void {
  const msg = raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES(?, ?, ?, ?, ?)`);
  // Ana: bot wrote first (blast) 3 days ago, she answered 2 days ago (seed's w2) → replied.
  msg.run("r1", "5215500000001", "out_bot", "[template:promo]", NOW - 3 * DAY);
  // Beto: ad prefill, bot answered, silence since → no reply to the bot.
  msg.run("r2", "5215500000002", "in", "Hola, quiero info", NOW - 6 * DAY);
  msg.run("r3", "5215500000002", "out_bot", "¡Hola Beto! …", NOW - 6 * DAY + 30);
  // Caro: prefill, bot answer, her reply 19 days ago (outside the 7-day probe) → replied.
  msg.run("r4", "5215500000003", "in", "Hola", NOW - 20 * DAY);
  msg.run("r5", "5215500000003", "out_bot", "¡Hola Caro!", NOW - 20 * DAY + 30);
  msg.run("r6", "5215500000003", "in", "¿Qué horarios tienen?", NOW - 19 * DAY);
}

test("catch-up D1: requireReplyToBot keeps only leads who wrote after our first outbound", async () => {
  const { raw, db } = sqliteDb();
  seed(raw);
  seedReplies(raw);
  // Old behavior unchanged: all three eligible leads.
  const off = await runNudgeCatchup(db, optsFor(true), NOW, {});
  assert.equal(off.requireReplyToBot, false);
  assert.equal(off.candidates, 3);
  assert.equal(off.skipped.noReplyToBot, 0);

  const p = parseCatchupBody({ dryRun: true, requireReplyToBot: true }, NOW);
  assert.ok(p.ok);
  const on = await runNudgeCatchup(db, p.ok ? p.opts : (null as never), NOW, {});
  assert.equal(on.requireReplyToBot, true);
  assert.equal(on.candidates, 2);
  assert.equal(on.skipped.noReplyToBot, 1);
  assert.deepEqual(on.sample.map((s) => s.phone).sort(), ["5215500000001", "5215500000003"]);
  // The other skip counts are the same as without the filter.
  assert.equal(on.skipped.booked, off.skipped.booked);
  assert.equal(on.skipped.recentOutbound, off.skipped.recentOutbound);
});

test("catch-up D1: replied probe semantics (inbound strictly after the first outbound; no outbound = no reply)", async () => {
  const { raw } = sqliteDb();
  const msg = raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES(?, ?, ?, ?, ?)`);
  const contact = raw.prepare(`INSERT INTO contacts(phone, status, created_at, updated_at) VALUES(?, 'lead', ?, ?)`);
  for (const p of ["a", "b", "c", "d", "e"]) contact.run(p, NOW - DAY, NOW);
  msg.run("a1", "a", "in", "hola", 100); // only inbound, never answered
  msg.run("a2", "a", "in", "¿hola?", 200);
  msg.run("b1", "b", "in", "hola", 100); // answered, then silence
  msg.run("b2", "b", "out_bot", "¡Hola!", 110);
  msg.run("b3", "b", "out_bot", "[template:nudge_d2_adults_es]", 900);
  msg.run("c1", "c", "in", "hola", 100); // answered, wrote back
  msg.run("c2", "c", "out_bot", "¡Hola!", 110);
  msg.run("c3", "c", "in", "va, el sábado", 120);
  msg.run("d1", "d", "out_human_echo", "Hola de recepción", 50); // staff first, lead replied
  msg.run("d2", "d", "in", "gracias", 60);
  msg.run("e1", "e", "in", "hola", 100); // reply in the same second as our message: not after it
  msg.run("e2", "e", "out_bot", "¡Hola!", 110);
  msg.run("e3", "e", "in", "ok", 110);
  const got = (raw.prepare(CATCHUP_SQL.replied(5)).all("a", "b", "c", "d", "e") as { phone: string }[])
    .map((r) => r.phone)
    .sort();
  assert.deepEqual(got, ["c", "d"]);
});

function seedCatchupRows(raw: DatabaseSync): void {
  const fu = raw.prepare(
    `INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, created_at) VALUES(?, ?, ?, ?, ?, ?)`,
  );
  const A = catchupToken(START);
  const B = catchupToken(START + DAY);
  fu.run("5215500000001", "nudge_d2", START, "paused", A, NOW);
  fu.run("5215500000001", "nudge_d3", START + DAY, "scheduled", A, NOW);
  fu.run("5215500000002", "nudge_d2", START + 60, "scheduled", A, NOW);
  fu.run("5215500000009", "nudge_d2", NOW - DAY, "sent", A, NOW); // already sent: untouched
  fu.run("5215500000003", "nudge_d2", START + DAY, "scheduled", B, NOW);
  fu.run("5215500000004", "nudge_d2", NOW + DAY, "scheduled", "seq:1", NOW); // regular drip: untouched
  fu.run("5215500000005", "same_day", NOW + DAY, "scheduled", A, NOW); // not an extended kind: untouched
}

test("catch-up cancel body: runId or all, status only cancelled, dryRun default", () => {
  const a = parseCatchupCancelBody({ runId: START });
  assert.ok(a.ok);
  if (a.ok) assert.deepEqual(a.opts, { dryRun: true, token: catchupToken(START) });
  const b = parseCatchupCancelBody({ runId: catchupToken(START), dryRun: false, status: "cancelled" });
  assert.ok(b.ok);
  if (b.ok) assert.deepEqual(b.opts, { dryRun: false, token: catchupToken(START) });
  const c = parseCatchupCancelBody({ all: true });
  assert.ok(c.ok);
  if (c.ok) assert.deepEqual(c.opts, { dryRun: true, token: null });
  assert.equal(parseCatchupCancelBody({}).ok, false);
  assert.equal(parseCatchupCancelBody({ runId: START, all: true }).ok, false);
  assert.equal(parseCatchupCancelBody({ all: "true" }).ok, false);
  assert.equal(parseCatchupCancelBody({ runId: "seq:1" }).ok, false);
  assert.equal(parseCatchupCancelBody({ runId: "seq:catchup:%" }).ok, false);
  assert.equal(parseCatchupCancelBody({ all: true, status: "sent" }).ok, false);
});

test("catch-up D1 cancel: dry run counts, apply cancels scheduled + paused rows of one run, then all", async () => {
  const { raw, db, sqls } = sqliteDb();
  seedCatchupRows(raw);
  const A = catchupToken(START);
  const B = catchupToken(START + DAY);
  const statusOf = () =>
    (raw.prepare(`SELECT phone, kind, status, airtable_record_id AS t FROM followups ORDER BY id`).all() as {
      status: string;
    }[]).map((r) => r.status);
  const before = statusOf();

  const notes: string[] = [];
  const dry = await cancelNudgeCatchup(db, { dryRun: true, token: A }, { postNote: async (t) => void notes.push(t) });
  assert.deepEqual(dry.matched, { scheduled: 2, paused: 1 });
  assert.deepEqual(dry.byRun, { [A]: 3 });
  assert.equal(dry.cancelled, 0);
  assert.equal(dry.target, A);
  assert.deepEqual(statusOf(), before, "dry run writes nothing");
  assert.ok(sqls.every((s) => /^\s*SELECT/i.test(s)));
  assert.equal(notes.length, 0);

  const allDry = await cancelNudgeCatchup(db, { dryRun: true, token: null });
  assert.deepEqual(allDry.byRun, { [A]: 3, [B]: 1 });
  assert.equal(allDry.target, "all");

  const one = await cancelNudgeCatchup(db, { dryRun: false, token: A }, { postNote: async (t) => void notes.push(t) });
  assert.equal(one.cancelled, 3);
  assert.deepEqual(statusOf(), ["cancelled", "cancelled", "cancelled", "sent", "scheduled", "scheduled", "scheduled"]);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /seq:catchup:/);

  const rest = await cancelNudgeCatchup(db, { dryRun: false, token: null });
  assert.equal(rest.cancelled, 1);
  assert.deepEqual(statusOf(), ["cancelled", "cancelled", "cancelled", "sent", "cancelled", "scheduled", "scheduled"]);

  // Nothing left: apply is a no-op (no UPDATE issued).
  const n = sqls.length;
  const none = await cancelNudgeCatchup(db, { dryRun: false, token: null });
  assert.equal(none.cancelled, 0);
  assert.equal(sqls.length, n + 1);
});

test("catch-up D1: replied + cancel queries are index-pinned", () => {
  const { raw } = sqliteDb();
  const kinds = [...ALL_EXTENDED_KINDS];
  const plans: [string, unknown[]][] = [
    [CATCHUP_SQL.replied(2), ["a", "b"]],
    [CATCHUP_SQL.cancelCount(kinds.length, true), [...kinds, "seq:catchup:1"]],
    [CATCHUP_SQL.cancelCount(kinds.length, false), kinds],
    [CATCHUP_SQL.cancel(kinds.length, true), [...kinds, "seq:catchup:1"]],
    [CATCHUP_SQL.cancel(kinds.length, false), kinds],
  ];
  for (const [sql, binds] of plans) {
    const detail = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");
    assert.doesNotMatch(detail, /\bSCAN (c|i|o|contacts|followups|messages)\b(?! USING)/, detail);
    assert.match(detail, /USING (COVERING )?INDEX|USING PRIMARY KEY/, detail);
    if (sql.includes("FROM messages")) assert.match(detail, /idx_messages_phone_ts/, detail);
    if (sql.includes("followups")) assert.match(detail, /idx_followups_kind_status_due/, detail);
  }
});
