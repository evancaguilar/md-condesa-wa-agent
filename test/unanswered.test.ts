// «💬 Esperando respuesta» (services/unanswered.ts + unanswered-db.ts).
// Pure rules with fake clocks, then the D1 half against a REAL SQLite loaded
// from schema.sql + the worker-applied indexes (INDEXED BY needs them), incl.
// the three live cases from 2026-11-11 and query-plan checks (no scans).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  classifyInbound,
  dueForReminder,
  holdingTexts,
  inReminderWindow,
  isInOwedList,
  judgeTail,
  parseCache,
  reasonsFor,
  reminderText,
  selectUnanswered,
  unansweredDoneKey,
  unansweredPingKey,
  waitedLabel,
  UNANSWERED_CACHE_KEY,
  UNANSWERED_MIN_WAIT_SEC,
  type CandidateFacts,
  type TailMsg,
  type UnansweredItem,
} from "../src/services/unanswered.js";
import {
  computeUnanswered,
  getUnansweredForPanel,
  markUnansweredDone,
  runUnansweredReminder,
} from "../src/services/unanswered-db.js";
import { HOLDING_LINE } from "../src/services/slack-timeouts.js";
import { owedDoneKey } from "../src/services/owed-approvals.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { Env } from "../src/types.js";

// Thursday 2026-11-12 12:00 CDMX.
const NOW = cdmxToEpoch(2026, 11, 12, 12, 0, 0);
const MIN = 60;
const H = 3600;
const HOLD = holdingTexts();

let seq = 0;
const msg = (direction: string, ts: number, body: string, meta: string | null = null): TailMsg => ({
  wamid: `w${++seq}`,
  direction,
  body,
  ts,
  meta,
});
/** Chronological list → newest first (what judgeTail takes). */
const tail = (...m: TailMsg[]): TailMsg[] => [...m].sort((a, b) => b.ts - a.ts);

// ---- classifyInbound --------------------------------------------------------

test("classifyInbound: closers / thanks never need an answer", () => {
  for (const t of ["Gracias", "muchas gracias!!", "Mil gracias 🙏", "nos vemos", "Ahí estaré", "gracias, nos vemos mañana", "Thank you", "Hasta luego"]) {
    assert.equal(classifyInbound({ body: t, meta: null }), "thanks", t);
  }
});

test("classifyInbound: acknowledgements are 'ack' (context decides)", () => {
  for (const t of ["ok", "Ok gracias", "Va", "Perfecto!", "sale", "Sí", "de acuerdo", "👍", "👍🏽", "❤️", "listo gracias"]) {
    assert.equal(classifyInbound({ body: t, meta: null }), "ack", t);
  }
});

test("classifyInbound: conservative — anything else needs an answer", () => {
  for (const t of [
    "Si por favor",
    "Hoy a la misma hora vdd?",
    "Buena noche. Una pregunta",
    "ok?",
    "¿Ok",
    "Buenos días",
    "Hola",
    "gracias, y cuánto cuesta",
    "🤔",
    "[imagen]",
    "ok pero mañana no puedo",
  ]) {
    assert.equal(classifyInbound({ body: t, meta: null }), "needs", t);
  }
});

test("classifyInbound: reactions and bare stickers are ignored; baja is optout", () => {
  assert.equal(classifyInbound({ body: "[reaccionó ❤️]", meta: null }), "ignore");
  assert.equal(classifyInbound({ body: "[quitó su reacción]", meta: null }), "ignore");
  assert.equal(classifyInbound({ body: "[sticker]", meta: '{"type":"sticker","mimeType":"image/webp"}' }), "ignore");
  assert.equal(classifyInbound({ body: "baja", meta: null }), "optout");
  assert.equal(classifyInbound({ body: "Ya no me manden mensajes", meta: null }), "optout");
});

// ---- judgeTail ---------------------------------------------------------------

test("judgeTail: our reply after the question → answered", () => {
  const v = judgeTail(tail(msg("in", NOW - 2 * H, "¿Cuánto cuesta?"), msg("out_bot", NOW - 2 * H + 30, "Son $900")), HOLD);
  assert.equal(v.kind, "answered");
});

test("judgeTail: holding line is not an answer (meta tag or exact text)", () => {
  const q = msg("in", NOW - 2 * H, "Si por favor");
  const v1 = judgeTail(tail(q, msg("out_bot", NOW - 2 * H + 600, HOLDING_LINE)), HOLD);
  assert.equal(v1.kind, "waiting");
  const v2 = judgeTail(tail(q, msg("out_bot", NOW - 2 * H + 600, "otro texto", '{"holding":1}')), HOLD);
  assert.equal(v2.kind, "waiting");
  if (v1.kind === "waiting") assert.equal(v1.last.wamid, q.wamid);
});

test("judgeTail: student ack copy passed as extra holding text is not an answer", () => {
  const ack = "¡Hola! 🙌 Recibimos tu mensaje y alguien del equipo te contesta por aquí.";
  const v = judgeTail(tail(msg("in", NOW - H, "Una pregunta"), msg("out_bot", NOW - H + 2, ack)), holdingTexts([ack]));
  assert.equal(v.kind, "waiting");
});

test("judgeTail: a closer after our answer is not a question", () => {
  const v = judgeTail(
    tail(msg("in", NOW - 3 * H, "¿horario?"), msg("out_bot", NOW - 3 * H + 20, "A las 7 pm."), msg("in", NOW - 2 * H, "Gracias!")),
    HOLD,
  );
  assert.equal(v.kind, "answered");
});

test("judgeTail: 'Va' right after OUR question needs action", () => {
  const va = msg("in", NOW - H, "Va");
  const v = judgeTail(tail(msg("out_bot", NOW - H - 60, "¿Te aparto lugar el jueves a las 5 pm?"), va), HOLD);
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") {
    assert.equal(v.last.wamid, va.wamid);
    assert.equal(v.since, va.ts);
  }
  // …but "ok" after a statement is a closer.
  const v2 = judgeTail(tail(msg("out_bot", NOW - H - 60, "Te esperamos el jueves."), msg("in", NOW - H, "ok")), HOLD);
  assert.equal(v2.kind, "answered");
});

test("judgeTail: since = oldest unanswered inbound of the streak; reactions/closers after it don't hide it", () => {
  const q1 = msg("in", NOW - 3 * H, "Hola, info de kids");
  const q2 = msg("in", NOW - 2 * H, "?");
  const v = judgeTail(
    tail(msg("out_bot", NOW - 4 * H, "¡Hola!"), q1, q2, msg("in", NOW - H, "[reaccionó 👍]"), msg("in", NOW - 30 * MIN, "gracias")),
    HOLD,
  );
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") {
    assert.equal(v.since, q1.ts);
    assert.equal(v.last.wamid, q2.wamid);
  }
});

test("judgeTail: a baja ends the walk; only-closers and empty tails are quiet", () => {
  assert.equal(judgeTail(tail(msg("in", NOW - H, "baja")), HOLD).kind, "quiet");
  assert.equal(judgeTail(tail(msg("in", NOW - H, "gracias")), HOLD).kind, "quiet");
  assert.equal(judgeTail([], HOLD).kind, "quiet");
  // A new question AFTER a baja still counts (newest first: question, then baja).
  assert.equal(judgeTail(tail(msg("in", NOW - 2 * H, "baja"), msg("in", NOW - H, "¿Siguen abiertos?")), HOLD).kind, "waiting");
});

test("judgeTail: staff panel send and WA Business echo both answer", () => {
  for (const d of ["out_human", "out_human_echo"]) {
    assert.equal(judgeTail(tail(msg("in", NOW - H, "¿Hoy hay clase?"), msg(d, NOW - H + 300, "Sí, 7 pm")), HOLD).kind, "answered", d);
  }
});

// ---- reasons / selection -----------------------------------------------------

test("reasonsFor: override, student, bot off, discarded approval for THIS silence", () => {
  const r = reasonsFor({
    now: NOW,
    botEnabled: false,
    status: "student",
    overrideUntil: NOW + 999 * H,
    latestApproval: { id: 7, status: "discarded", createdAt: NOW - H },
    since: NOW - H - 10,
  });
  assert.deepEqual(r.map((x) => x.code), ["human_override", "student", "bot_off", "approval_discarded"]);
  // An old discarded approval (before the silence) is not the reason; expired override isn't either.
  const r2 = reasonsFor({
    now: NOW,
    botEnabled: true,
    status: "lead",
    overrideUntil: NOW - 1,
    latestApproval: { id: 3, status: "discarded", createdAt: NOW - 5 * 86400 },
    since: NOW - H,
  });
  assert.deepEqual(r2, []);
});

test("isInOwedList: newest approval for this silence expired within 7 d", () => {
  assert.equal(isInOwedList({ status: "expired", createdAt: NOW - 13 * H }, NOW - 13 * H - 20, NOW), true);
  assert.equal(isInOwedList({ status: "discarded", createdAt: NOW - 13 * H }, NOW - 13 * H - 20, NOW), false);
  assert.equal(isInOwedList({ status: "expired", createdAt: NOW - 8 * 86400 }, NOW - 8 * 86400, NOW), false);
  assert.equal(isInOwedList({ status: "expired", createdAt: NOW - 3 * 86400 }, NOW - H, NOW), false); // older silence
  assert.equal(isInOwedList(null, NOW, NOW), false);
});

const facts = (over: Partial<CandidateFacts> & { since?: number; lastTs?: number } = {}): CandidateFacts => {
  const lastTs = over.lastTs ?? NOW - H;
  const since = over.since ?? lastTs;
  return {
    phone: "5215512345678",
    name: "Ana",
    status: "lead",
    overrideUntil: null,
    verdict: { kind: "waiting", last: { wamid: "wX", direction: "in", body: "¿info?", ts: lastTs, meta: null }, since },
    latestApproval: null,
    hasPending: false,
    handled: false,
    ...over,
  };
};

test("selectUnanswered: 20-min wait, 7-day age, pending/handled/opted-out hidden, newest first, cap", () => {
  const o = { now: NOW, botEnabled: true };
  assert.equal(selectUnanswered([facts({ lastTs: NOW - UNANSWERED_MIN_WAIT_SEC + 60 })], o).length, 0);
  assert.equal(selectUnanswered([facts({ lastTs: NOW - UNANSWERED_MIN_WAIT_SEC })], o).length, 1);
  // streak started 30 min ago, newest message 5 min ago → shown (waiting counts from the first)
  assert.equal(selectUnanswered([facts({ lastTs: NOW - 5 * MIN, since: NOW - 30 * MIN })], o).length, 1);
  assert.equal(selectUnanswered([facts({ lastTs: NOW - 8 * 86400 })], o).length, 0);
  assert.equal(selectUnanswered([facts({ hasPending: true })], o).length, 0);
  assert.equal(selectUnanswered([facts({ handled: true })], o).length, 0);
  assert.equal(selectUnanswered([facts({ status: "opted_out" })], o).length, 0);
  assert.equal(selectUnanswered([facts({ verdict: { kind: "answered" } })], o).length, 0);
  const many = Array.from({ length: 70 }, (_, i) => facts({ phone: `52155000000${String(i).padStart(2, "0")}`, lastTs: NOW - H - i }));
  const out = selectUnanswered(many, o);
  assert.equal(out.length, 60);
  assert.ok(out[0]!.lastTs >= out[1]!.lastTs);
});

// ---- time / cache / Slack text ----------------------------------------------

test("inReminderWindow: 08:00–21:30 CDMX, end exclusive", () => {
  assert.equal(inReminderWindow(cdmxToEpoch(2026, 11, 12, 7, 59)), false);
  assert.equal(inReminderWindow(cdmxToEpoch(2026, 11, 12, 8, 0)), true);
  assert.equal(inReminderWindow(cdmxToEpoch(2026, 11, 12, 21, 29)), true);
  assert.equal(inReminderWindow(cdmxToEpoch(2026, 11, 12, 21, 30)), false);
});

const item = (over: Partial<UnansweredItem> = {}): UnansweredItem => ({
  phone: "5215512345678",
  name: "Ana",
  status: "lead",
  wamid: "wA",
  lastBody: "Hoy a la misma hora vdd?",
  lastTs: NOW - 70 * MIN,
  since: NOW - 70 * MIN,
  reasons: [{ code: "human_override", until: NOW + H }],
  ...over,
});

test("dueForReminder: ≥ 60 min waiting and inbound within 24 h", () => {
  assert.equal(dueForReminder([item({ since: NOW - 59 * MIN })], NOW).length, 0);
  assert.equal(dueForReminder([item()], NOW).length, 1);
  assert.equal(dueForReminder([item({ lastTs: NOW - 25 * H, since: NOW - 25 * H })], NOW).length, 0);
});

test("reminderText: one message, no @here, reasons + links, '+N más' past 15", () => {
  const t = reminderText([item()], NOW, { panel: "https://x/admin#aprobaciones", chat: (p) => `https://x/admin#chats/${p}` });
  assert.match(t, /1 chat espera respuesta/);
  assert.match(t, /Ana/);
  assert.match(t, /1 h 10 min/);
  assert.match(t, /control humano/);
  assert.ok(!/@here|<!here>|<!channel>/.test(t));
  const many = Array.from({ length: 18 }, (_, i) => item({ phone: `5215500000${i}`, wamid: `w${i}` }));
  assert.match(reminderText(many, NOW, { panel: "p", chat: () => null }), /…y 3 más/);
  assert.equal(waitedLabel(2 * 86400 + 3 * H), "2 d 3 h");
});

test("parseCache: TTL, garbled, and look-back coverage", () => {
  const raw = JSON.stringify({ at: NOW - 60, maxAgeSec: 7 * 86400, items: [] });
  assert.ok(parseCache(raw, NOW, 110, 7 * 86400));
  assert.equal(parseCache(raw, NOW + 100, 110, 7 * 86400), null);
  assert.equal(parseCache("{nope", NOW, 110, 0), null);
  const small = JSON.stringify({ at: NOW, maxAgeSec: 86400, items: [] });
  assert.equal(parseCache(small, NOW, 110, 7 * 86400), null); // the cron's 24 h list never feeds the panel
  assert.ok(parseCache(small, NOW, 300, 86400));
});

// ---- D1 half against real SQLite -------------------------------------------

function schemaStatements(): string[] {
  const text = readFileSync("src/db/schema.sql", "utf8")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function openDb(): { raw: DatabaseSync; db: D1Database; env: Env; sqls: string[] } {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of schemaStatements()) raw.exec(stmt);
  for (const sql of INDEX_SQL) raw.exec(sql);
  const sqls: string[] = [];
  const make = (sql: string): D1PreparedStatement => {
    sqls.push(sql);
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
  const db = { prepare: make } as unknown as D1Database;
  return { raw, db, env: { DB: db } as Env, sqls };
}

function seed(
  raw: DatabaseSync,
  phone: string,
  msgs: Array<[direction: string, ts: number, body: string, meta?: string]>,
  c: { status?: string; override?: number | null; name?: string } = {},
): string[] {
  const lastIn = Math.max(0, ...msgs.filter((m) => m[0] === "in" && !m[2].startsWith("[reacc")).map((m) => m[1]));
  raw
    .prepare(
      `INSERT INTO contacts(phone, name, status, human_override_until, last_inbound_at, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(phone, c.name ?? "n" + phone, c.status ?? "lead", c.override ?? null, lastIn || null, 1, lastIn || 1);
  const ins = raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts, meta) VALUES(?, ?, ?, ?, ?, ?)`);
  const ids: string[] = [];
  for (const [d, ts, body, meta] of msgs) {
    const id = `m${++seq}`;
    ids.push(id);
    ins.run(id, phone, d, body, ts, meta ?? null);
  }
  return ids;
}

function approval(raw: DatabaseSync, phone: string, status: string, createdAt: number): number {
  const r = raw
    .prepare(`INSERT INTO pending_approvals(phone, draft, status, created_at) VALUES(?, 'd', ?, ?)`)
    .run(phone, status, createdAt);
  return Number(r.lastInsertRowid);
}

test("computeUnanswered: the three 2026-11-11 cases surface with their reason", async () => {
  const { raw, db } = openDb();
  // 1. «Tomar control» (no expiry), lead asks later, nobody answers.
  seed(
    raw,
    "5215511111111",
    [
      ["in", NOW - 6 * H, "¿Tienen clase hoy?"],
      ["out_human", NOW - 5 * H, "Sí, a las 7"],
      ["in", NOW - 2 * H, "Hoy a la misma hora vdd?"],
    ],
    { override: NOW + 365 * 86400, name: "Caso 1" },
  );
  // 2. «Si por favor» → holding line only, approval discarded.
  seed(
    raw,
    "5215522222222",
    [
      ["out_bot", NOW - 5 * H, "[template:post_trial_d0]"],
      ["in", NOW - 3 * H, "Si por favor"],
      ["out_bot", NOW - 3 * H + 600, HOLDING_LINE, '{"holding":1}'],
    ],
    { name: "Caso 2" },
  );
  const disc = approval(raw, "5215522222222", "discarded", NOW - 3 * H + 10);
  // 3. Student on the leads line, no reply.
  seed(raw, "5215533333333", [["in", NOW - 90 * MIN, "Buena noche. Una pregunta"]], { status: "student", name: "Caso 3" });
  // Controls: answered, closer, pending approval, opted out, too fresh.
  seed(raw, "5215544444444", [
    ["in", NOW - 2 * H, "¿Precio?"],
    ["out_bot", NOW - 2 * H + 20, "Son $900"],
  ]);
  seed(raw, "5215555555555", [
    ["in", NOW - 3 * H, "¿Precio?"],
    ["out_bot", NOW - 3 * H + 20, "Son $900."],
    ["in", NOW - 2 * H, "Muchas gracias 👍"],
  ]);
  seed(raw, "5215566666666", [["in", NOW - 2 * H, "¿Hay estacionamiento?"]]);
  approval(raw, "5215566666666", "pending", NOW - 2 * H + 10);
  seed(raw, "5215577777777", [["in", NOW - 2 * H, "¿Hola?"]], { status: "opted_out" });
  seed(raw, "5215588888888", [["in", NOW - 5 * MIN, "¿Hola?"]]);

  const items = await computeUnanswered(db, NOW);
  assert.deepEqual(
    items.map((i) => i.phone),
    ["5215533333333", "5215511111111", "5215522222222"], // newest last message first
  );
  const byPhone = new Map(items.map((i) => [i.phone, i]));
  assert.deepEqual(byPhone.get("5215511111111")!.reasons.map((r) => r.code), ["human_override"]);
  assert.equal(byPhone.get("5215511111111")!.lastBody, "Hoy a la misma hora vdd?");
  assert.deepEqual(byPhone.get("5215522222222")!.reasons, [{ code: "approval_discarded", approvalId: disc }]);
  assert.deepEqual(byPhone.get("5215533333333")!.reasons.map((r) => r.code), ["student"]);
});

test("computeUnanswered: an expired approval for this silence is left to «Sin responder»", async () => {
  const { raw, db } = openDb();
  seed(raw, "5215511111111", [["in", NOW - 13 * H, "¿Cuánto cuesta?"]]);
  const id = approval(raw, "5215511111111", "expired", NOW - 13 * H + 10);
  assert.equal((await computeUnanswered(db, NOW)).length, 0);
  // owed «Ya lo atendí» keeps it hidden here too.
  raw.prepare(`INSERT INTO kv(key, value) VALUES(?, '1')`).run(owedDoneKey(id));
  assert.equal((await computeUnanswered(db, NOW)).length, 0);
});

test("«Ya lo atendí» hides the row until a NEW inbound arrives; an outbound reply also clears it", async () => {
  const { raw, db } = openDb();
  const [q] = seed(raw, "5215511111111", [["in", NOW - 2 * H, "¿Info?"]]);
  const first = await getUnansweredForPanel(db, NOW);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]!.wamid, q);
  await markUnansweredDone(db, "5215511111111", q!, "fer", NOW);
  // the shared cache dropped it right away
  assert.equal((await getUnansweredForPanel(db, NOW + 10)).items.length, 0);
  assert.ok(raw.prepare(`SELECT 1 FROM kv WHERE key = ?`).get(unansweredDoneKey("5215511111111", q!)));
  assert.equal((await computeUnanswered(db, NOW + 10)).length, 0);
  // A closer later does not bring it back…
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('c1', '5215511111111', 'in', 'gracias', ?)`).run(NOW - H);
  raw.prepare(`UPDATE contacts SET last_inbound_at = ?, updated_at = ? WHERE phone = '5215511111111'`).run(NOW - H, NOW - H);
  assert.equal((await computeUnanswered(db, NOW + 10)).length, 0);
  // …a new question does.
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('n1', '5215511111111', 'in', '¿Y los sábados?', ?)`).run(NOW - 30 * MIN);
  raw.prepare(`UPDATE contacts SET last_inbound_at = ?, updated_at = ? WHERE phone = '5215511111111'`).run(NOW - 30 * MIN, NOW - 30 * MIN);
  const back = await computeUnanswered(db, NOW + 10);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.wamid, "n1");
  // A WA Business echo answers it.
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('e1', '5215511111111', 'out_human_echo', 'Sí, 10 am', ?)`).run(NOW - 10 * MIN);
  assert.equal((await computeUnanswered(db, NOW + 10)).length, 0);
});

test("computeUnanswered: at most five statements, none of them a table scan", async () => {
  const { raw, db, sqls } = openDb();
  seed(raw, "5215511111111", [["in", NOW - 2 * H, "¿Info?"]]);
  seed(raw, "5215522222222", [["in", NOW - 3 * H, "Hola"], ["out_bot", NOW - 3 * H + 5, "¡Hola! ¿En qué te ayudo?"], ["in", NOW - 2 * H, "ok"]]);
  approval(raw, "5215511111111", "discarded", NOW - 2 * H + 5);
  sqls.length = 0;
  const items = await computeUnanswered(db, NOW);
  assert.equal(items.length, 2);
  assert.ok(sqls.length <= 5, `statements: ${sqls.length}`);
  for (const sql of sqls) {
    const bindsFor = (s: string): unknown[] => {
      const n = Math.max(0, ...[...s.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      return Array.from({ length: n }, (_, i) => (s.includes("json_each") && i === 0 ? "[]" : 0));
    };
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(bindsFor(sql) as never[])) as Array<{ detail: string }>;
    // "SCAN c" (the bounded derived table) and "SCAN j" (json_each) are fine;
    // any SCAN of a real table or alias — even "USING INDEX" (a full index
    // walk) — is not. Real tables must be SEARCHed.
    for (const p of plan) {
      assert.ok(
        !/^SCAN (contacts|messages|pending_approvals|kv|m|m2|pa|p2|p3)\b/.test(p.detail),
        `table scan in plan: ${p.detail}\n${sql}`,
      );
    }
  }
});

test("runUnansweredReminder: one aggregated note, once per inbound, only in the window", async () => {
  const { raw, env } = openDb();
  seed(raw, "5215511111111", [["in", NOW - 90 * MIN, "Hoy a la misma hora vdd?"]], { override: NOW + 86400 });
  seed(raw, "5215522222222", [["in", NOW - 2 * H, "Si por favor"]]);
  seed(raw, "5215533333333", [["in", NOW - 30 * MIN, "¿Info?"]]); // < 60 min: not yet
  const posts: string[] = [];
  const deps = { postTask: async (t: string) => void posts.push(t), panelUrl: "https://x/admin#aprobaciones", chatUrl: (p: string) => `https://x/admin#chats/${p}` };

  // Night: nothing, and no D1 read at all.
  assert.equal(await runUnansweredReminder(env, deps, cdmxToEpoch(2026, 11, 12, 22, 0)), 0);

  assert.equal(await runUnansweredReminder(env, deps, NOW), 2);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /2 chats esperan respuesta/);
  assert.ok(raw.prepare(`SELECT 1 FROM kv WHERE key LIKE 'unanswered_ping:%'`).get());
  // Next tick: same chats, no second post.
  assert.equal(await runUnansweredReminder(env, deps, NOW + 300), 0);
  assert.equal(posts.length, 1);
  // 35 min later the third chat crosses 60 min → a new note with ONLY it.
  assert.equal(await runUnansweredReminder(env, deps, NOW + 35 * MIN), 1);
  assert.equal(posts.length, 2);
  assert.match(posts[1]!, /5215533333333/);
  assert.ok(!/5215511111111/.test(posts[1]!));
  // A failed post leaves no marker (retried next tick).
  seed(raw, "5215544444444", [["in", NOW - 2 * H, "¿Hola?"]]);
  await assert.rejects(() =>
    runUnansweredReminder(env, { ...deps, postTask: async () => { throw new Error("slack down"); } }, NOW + 40 * MIN),
  );
  assert.equal(raw.prepare(`SELECT 1 FROM kv WHERE key = ?`).get(unansweredPingKey("5215544444444", "x")) ?? null, null);
  assert.equal(await runUnansweredReminder(env, deps, NOW + 45 * MIN), 1);
});

test("panel cache is shared and reused by the cron", async () => {
  const { raw, db, env, sqls } = openDb();
  seed(raw, "5215511111111", [["in", NOW - 2 * H, "¿Info?"]]);
  await getUnansweredForPanel(db, NOW);
  assert.ok(raw.prepare(`SELECT 1 FROM kv WHERE key = ?`).get(UNANSWERED_CACHE_KEY));
  sqls.length = 0;
  await getUnansweredForPanel(db, NOW + 60);
  assert.equal(sqls.length, 1); // one kv read
  sqls.length = 0;
  await runUnansweredReminder(env, { postTask: async () => {}, panelUrl: "p", chatUrl: () => null }, NOW + 120);
  assert.ok(!sqls.some((s) => /FROM \(SELECT phone/.test(s)), "cron recomputed despite a fresh panel cache");
});
