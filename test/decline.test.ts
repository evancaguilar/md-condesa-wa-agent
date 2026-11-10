import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DECLINE_CANCEL_KINDS,
  DECLINE_KEPT_KINDS,
  declineNote,
  declinedKey,
  detectDecline,
  encodeDeclineMarker,
  isDeclineCancelKind,
  isNotInterested,
  isObjection,
  parseDeclineMarker,
  promisesNoMoreMessages,
  shouldClearDecline,
  turnDeclineSource,
} from "../src/pipeline/decline.js";
import { isOptOut } from "../src/pipeline/opt-out.js";
import { applyDecline, clearDecline, declineCancelSql, isDeclined } from "../src/services/decline-stop.js";
import { ALL_NUDGE_KINDS, armNudges } from "../src/cron/nudges.js";
import { sendResult } from "../src/brain/claude.js";
import { TOOLS } from "../src/brain/tools.js";
import { buildListAudience, planBlastAudience } from "../src/services/blast.js";
import { classifyCatchupLead, type CatchupContactRow } from "../src/services/nudge-catchup.js";
import type { Contact, Env } from "../src/types.js";

const PHONE = "5215512345678";

// ---- deterministic detection -------------------------------------------------

for (const s of [
  "No me interesa",
  "no me interesa, gracias",
  "Gracias pero no me interesa",
  "La verdad ya no me interesa",
  "No, no me interesa la verdad",
  "No estoy interesada",
  "ya no estamos interesados",
  "No me interesa la clase",
  "No me interesa la verdad. Muy pocas clases para lo que cobran",
  "Ya me inscribí en otro lado",
  "ya la inscribí en otra academia, gracias",
  "Not interested",
  "I'm not interested anymore",
]) {
  test(`isNotInterested: ${s}`, () => assert.equal(isNotInterested(s), true));
}

for (const s of [
  "no me interesa el box, prefiero muay thai",
  "¿No me interesa si pago por clase?",
  "me interesa mucho",
  "no me interesa mucho el horario de la mañana, ¿hay en la tarde?",
  "Hola",
  "Gracias",
  "no gracias",
  "no estoy interesada en el horario de las 7",
]) {
  test(`isNotInterested stays false: ${s}`, () => assert.equal(isNotInterested(s), false));
}

for (const s of [
  "No, me queda bastante lejos",
  "Es q me queda lejos pero les agradezco",
  "De nuevo les menciono que me quedan muy lejos por tanto no estoy interesada",
  "Está muy caro",
  "es caro para mí",
  "no me alcanza",
  "vivo lejos",
  "It's too far",
]) {
  test(`isObjection: ${s}`, () => assert.equal(isObjection(s), true));
}

for (const s of [
  "¿Está muy lejos del metro?",
  "no me queda lejos",
  "no es caro",
  "¿es caro?",
  "Hola",
  "Gracias",
  "no puedo el sábado, ¿el domingo?",
  "¿Dónde están?",
]) {
  test(`isObjection stays false: ${s}`, () => assert.equal(isObjection(s), false));
}

test("detectDecline: not-interested wins over objection; plain greetings are nothing", () => {
  assert.equal(detectDecline("No me interesa, está muy caro"), "not_interested");
  assert.equal(detectDecline("me queda lejos"), "objection");
  assert.equal(detectDecline("Hola"), null);
  assert.equal(detectDecline("Gracias 🙏"), null);
});

test("explicit stop wording is still a baja (opt-out), not just a decline", () => {
  assert.equal(isOptOut("No me interesa, no me manden nada"), true);
  assert.equal(isOptOut("No me interesa"), false);
});

// ---- the bot's promise -------------------------------------------------------

for (const s of [
  "Entendido, gracias por avisarnos 🙏 No te molestamos más por este tema.",
  "Perdón por la insistencia. No te mandamos más mensajes sobre esto.",
  "No te vamos a escribir más, ¡éxito!",
  "Got it, we won't message you again.",
]) {
  test(`promisesNoMoreMessages: ${s}`, () => assert.equal(promisesNoMoreMessages(s), true));
}

for (const s of [
  "No te mandamos la ubicación porque ya la tienes",
  "Entiendo, no hay problema 🙌 aquí estamos si más adelante te late.",
  "¿Te late el sábado a las 2 pm?",
]) {
  test(`promisesNoMoreMessages stays false: ${s}`, () => assert.equal(promisesNoMoreMessages(s), false));
}

test("turnDeclineSource: brain flag first, then the promise backstop", () => {
  assert.equal(turnDeclineSource({ leadDeclined: true, message: "¿Te late el sábado?" }), "brain");
  assert.equal(turnDeclineSource({ message: "No te molestamos más." }), "promise");
  assert.equal(turnDeclineSource({ message: "¿Te late el sábado?" }), null);
});

// ---- marker ------------------------------------------------------------------

test("marker round-trips; garbage still counts as declined", () => {
  const m = parseDeclineMarker(encodeDeclineMarker({ ts: 100, source: "objection", text: "me queda lejos" }));
  assert.deepEqual(m, { ts: 100, source: "objection", text: "me queda lejos" });
  assert.deepEqual(parseDeclineMarker("{bad"), { ts: 0, source: "brain" });
  assert.equal(parseDeclineMarker(null), null);
  assert.equal(declinedKey(PHONE), `declined:${PHONE}`);
});

// ---- re-opening ----------------------------------------------------------------

const MARK = { ts: 1000, source: "objection" as const };

test("shouldClearDecline: only interest that ANSWERS something we said after the stop", () => {
  const replied = [
    { direction: "in", ts: 990 }, // the objection
    { direction: "out", ts: 1010 }, // our one re-invite
    { direction: "in", ts: 1100 }, // "¿y el sábado a qué hora?"
  ];
  assert.equal(shouldClearDecline(MARK, { interested: true, declinedThisTurn: false, history: replied }), true);
  // the brain did not flag interest (a bare "Hola" / "Gracias")
  assert.equal(shouldClearDecline(MARK, { declinedThisTurn: false, history: replied }), false);
  // declined again on the same turn
  assert.equal(shouldClearDecline(MARK, { interested: true, declinedThisTurn: true, history: replied }), false);
  // interest inside the objection message itself / before our reply went out
  assert.equal(
    shouldClearDecline(MARK, { interested: true, declinedThisTurn: false, history: [{ direction: "in", ts: 990 }, { direction: "in", ts: 1005 }] }),
    false,
  );
  // no marker → nothing to clear
  assert.equal(shouldClearDecline(null, { interested: true, declinedThisTurn: false, history: replied }), false);
});

// ---- kinds ---------------------------------------------------------------------

test("every nudge / drip kind is cancelled; a booked class's reminders are kept", () => {
  for (const k of ALL_NUDGE_KINDS) assert.equal(isDeclineCancelKind(k), true, k);
  for (const k of ["reengage_7d", "no_show_hoy", "no_show_d2", "no_show_d7", "post_trial_d3", "post_trial_d6", "custom", "origin_ask", "blast"]) {
    assert.equal(isDeclineCancelKind(k), true, k);
  }
  for (const k of DECLINE_KEPT_KINDS) assert.equal(isDeclineCancelKind(k), false, k);
  const overlap = DECLINE_CANCEL_KINDS.filter((k) => (DECLINE_KEPT_KINDS as readonly string[]).includes(k));
  assert.deepEqual(overlap, []);
});

test("declineNote: one line, names the source and the reset path", () => {
  const n = declineNote(PHONE, "objection", 3);
  assert.match(n, /declinó/);
  assert.match(n, /3 envío\(s\)/);
  assert.match(n, /Estado «Lead»/);
});

// ---- brain plumbing -------------------------------------------------------------

test("send_reply carries lead_declined / lead_interested; decline wins on the same turn", () => {
  const send = TOOLS.find((t) => t.name === "send_reply")!;
  assert.ok("lead_declined" in send.input_schema.properties);
  assert.ok("lead_interested" in send.input_schema.properties);
  const base = { message: "Entiendo 🙌 ¿Te late el sábado 2 pm?", language: "es", sureness: 90, confidence: "high", awaiting_reply: true };
  const r1 = sendResult({ type: "tool_use", id: "1", name: "send_reply", input: { ...base, lead_declined: true } });
  assert.equal(r1.action === "send" && r1.leadDeclined, true);
  const r2 = sendResult({ type: "tool_use", id: "2", name: "send_reply", input: { ...base, lead_declined: true, lead_interested: true } });
  assert.equal(r2.action === "send" && r2.leadInterested, undefined);
  const r3 = sendResult({ type: "tool_use", id: "3", name: "send_reply", input: { ...base, sureness: 40, lead_interested: true } });
  assert.equal(r3.action === "draft" && r3.leadInterested, true);
  const r4 = sendResult({ type: "tool_use", id: "4", name: "send_reply", input: { ...base, lead_declined: "yes" } });
  assert.equal(r4.action === "send" && r4.leadDeclined, undefined);
});

// ---- audiences ------------------------------------------------------------------

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: PHONE,
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

test("blasts: declined phones are excluded from CRM and list audiences", () => {
  const now = 10_000_000;
  const a = planBlastAudience(
    [contact({ phone: "5215500000001" }), contact({ phone: "5215500000002" })],
    new Set(),
    now,
    { declined: new Set(["5215500000001"]) },
  );
  assert.equal(a.excluded.declined, 1);
  assert.deepEqual(a.adults.map((c) => c.phone), ["5215500000002"]);
  const l = buildListAudience(
    [{ phone: "5215500000001", name: null }, { phone: "5215500000002", name: null }],
    new Map(),
    { declined: new Set(["5215500000001"]) },
  );
  assert.equal(l.excluded.declined, 1);
  assert.deepEqual(l.candidates.map((c) => c.phone), ["5215500000002"]);
});

test("catch-up: a declined lead is skipped", () => {
  const NOW = 2_000_000_000;
  const row: CatchupContactRow = {
    phone: "5215500000001",
    name: "Ana",
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: NOW - 3 * 86400,
    campaign_id: null,
    created_at: NOW - 4 * 86400,
  };
  const probes = { pendingApproval: false, bookingMarker: null, followups: [], messages: [] };
  assert.equal(classifyCatchupLead(row, probes, NOW, ["nudge_d2", "nudge_d4"]).skip, null);
  assert.equal(classifyCatchupLead(row, { ...probes, declined: true }, NOW, ["nudge_d2", "nudge_d4"]).skip, "declined");
});

// ---- stateful fake D1 (kv + followups) -------------------------------------------

interface Row {
  phone: string;
  kind: string;
  status: string;
}

function statefulDb(contactRow: () => Contact): { db: D1Database; kv: Map<string, string>; rows: Row[]; notes: string[] } {
  const kv = new Map<string, string>();
  const rows: Row[] = [];
  const notes: string[] = [];
  const exec = (sql: string, b: unknown[]): { first?: unknown; all?: unknown[]; changes?: number } => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT * FROM contacts")) return { first: contactRow() };
    if (s.startsWith("SELECT value FROM kv WHERE key = ?1")) {
      const v = kv.get(String(b[0]));
      return { first: v === undefined ? null : { value: v } };
    }
    if (s.startsWith("INSERT INTO kv(key, value)")) {
      kv.set(String(b[0]), String(b[1]));
      return { changes: 1 };
    }
    if (s.startsWith("DELETE FROM kv WHERE key = ?1")) {
      kv.delete(String(b[0]));
      return { changes: 1 };
    }
    if (s.includes("INTO followups(")) {
      rows.push({ phone: String(b[0]), kind: String(b[1]), status: "scheduled" });
      return { changes: 1 };
    }
    if (s.startsWith("UPDATE followups SET status")) {
      // cancelFollowupsByKinds: (?1 phone, ?2 status, ?3.. kinds) ; decline cancel: (?1 phone, ?2.. kinds)
      const isDecline = s.includes("status IN ('scheduled', 'paused')");
      const phone = String(b[0]);
      const kinds = new Set((isDecline ? b.slice(1) : b.slice(2)).map(String));
      const to = isDecline ? "cancelled" : String(b[1]);
      let n = 0;
      for (const r of rows) {
        if (r.phone === phone && kinds.has(r.kind) && (r.status === "scheduled" || (isDecline && r.status === "paused"))) {
          r.status = to;
          n++;
        }
      }
      return { changes: n };
    }
    return {}; // booking probes, engagement, sent kinds: nothing
  };
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (exec(sql, binds).first ?? null) as T | null;
      },
      async run() {
        return { results: [], meta: { changes: exec(sql, binds).changes ?? 0 } };
      },
      async all<T>() {
        return { results: (exec(sql, binds).all ?? []) as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { db: { prepare: make } as unknown as D1Database, kv, rows, notes };
}

const env = (db: D1Database): Env => ({ DB: db } as unknown as Env);

test("applyDecline: marker + cancels chasing rows (scheduled and paused) but keeps reminders; one note", async () => {
  const s = statefulDb(() => contact({ last_inbound_at: Math.floor(Date.now() / 1000) }));
  s.rows.push(
    { phone: PHONE, kind: "nudge_1h", status: "scheduled" },
    { phone: PHONE, kind: "nudge_d2", status: "scheduled" },
    { phone: PHONE, kind: "blast", status: "paused" },
    { phone: PHONE, kind: "no_show_d2", status: "scheduled" },
    { phone: PHONE, kind: "day_before", status: "scheduled" },
    { phone: PHONE, kind: "staff_later", status: "scheduled" },
  );
  const notes: string[] = [];
  const r = await applyDecline(s.db, PHONE, "objection", { text: "me queda lejos", now: 1000, postNote: async (t) => void notes.push(t) });
  assert.deepEqual(r, { cancelled: 4, fresh: true });
  assert.deepEqual(
    s.rows.map((x) => `${x.kind}:${x.status}`),
    ["nudge_1h:cancelled", "nudge_d2:cancelled", "blast:cancelled", "no_show_d2:cancelled", "day_before:scheduled", "staff_later:scheduled"],
  );
  assert.equal(notes.length, 1);
  assert.equal(await isDeclined(s.db, PHONE), true);
  // refresh with nothing to cancel: quiet
  await applyDecline(s.db, PHONE, "brain", { now: 2000, postNote: async (t) => void notes.push(t) });
  assert.equal(notes.length, 1);
  assert.equal(await clearDecline(s.db, PHONE), true);
  assert.equal(await isDeclined(s.db, PHONE), false);
  assert.equal(await clearDecline(s.db, PHONE), false);
});

test("decline cancel SQL is phone-scoped (followups UNIQUE(phone, kind, …) autoindex)", () => {
  const sql = declineCancelSql(3);
  assert.match(sql, /WHERE phone = \?1 AND status IN \('scheduled', 'paused'\) AND kind IN \(\?2, \?3, \?4\)/);
});

test("armNudges: a declined phone arms nothing", async () => {
  const s = statefulDb(() => contact({ last_inbound_at: Math.floor(Date.now() / 1000) }));
  await armNudges(env(s.db), PHONE);
  assert.ok(s.rows.length > 0, "control: an undeclined lead does arm");
  s.rows.length = 0;
  await applyDecline(s.db, PHONE, "brain");
  await armNudges(env(s.db), PHONE);
  assert.equal(s.rows.length, 0);
});

// ---- regression: the Hatt sequence (baby campaign, 2026-11) ----------------------
//
// Replays every inbound through the deterministic detector and every bot reply
// through the brain-turn rule WITHOUT the brain flag (worst case: the model
// forgets lead_declined), arming after each delivered reply exactly like
// deliverOrDraft / approvals do. After her first "No, me queda bastante lejos"
// nothing is armed, and any row that existed is refused at send time.

test("Hatt regression: after the first objection nothing automated is armed or sent", async () => {
  const now = Math.floor(Date.now() / 1000);
  const s = statefulDb(() => contact({ last_inbound_at: now }));
  const sendTimeAllowed = async (kind: string) => !(isDeclineCancelKind(kind) && (await isDeclined(s.db, PHONE)));
  const inbound = async (text: string) => {
    const hit = detectDecline(text);
    if (hit) await applyDecline(s.db, PHONE, hit, { text });
  };
  const botReply = async (text: string, flags: { leadDeclined?: true; leadInterested?: true } = {}, history: { direction: string; ts: number }[] = []) => {
    const src = turnDeclineSource({ ...flags, message: text });
    if (src) await applyDecline(s.db, PHONE, src, { text });
    else if (flags.leadInterested) {
      const raw = s.kv.get(declinedKey(PHONE)) ?? null;
      if (shouldClearDecline(parseDeclineMarker(raw), { interested: true, declinedThisTurn: false, history })) await clearDecline(s.db, PHONE);
    }
    await armNudges(env(s.db), PHONE); // reply delivered → arm
  };
  const live = () => s.rows.filter((r) => r.status === "scheduled" || r.status === "paused");

  // Day 0 11:51 — asks for info; the bot answers; the drip arms (correct).
  await inbound("Hola, quiero información de Baby Fight Club");
  await botReply("¡Hola! 🙌 Baby Fight Club es para bebés de 1 a 3 años… ¿Te late venir el sábado a las 2 pm?");
  assert.ok(live().length > 0, "control: an interested lead gets the drip");

  // "No, me queda bastante lejos" / "Gracias" → the stop is set on the FIRST objection.
  await inbound("No, me queda bastante lejos");
  assert.equal(live().length, 0, "the pending drip is cancelled");
  await inbound("Gracias");
  await botReply("Entiendo, no hay problema 🙌 Muchos vienen en sábado sin tráfico. Aquí estamos si más adelante te late.");
  assert.equal(live().length, 0);
  for (const k of ["nudge_1h", "nudge_8h", "nudge_d2", "nudge_d3", "nudge_d4", "nudge_d7"]) {
    assert.equal(await sendTimeAllowed(k), false, `${k} refused at send time`);
  }

  // 13:03 "Es q me queda lejos pero les agradezco" → bot closes again.
  await inbound("Es q me queda lejos pero les agradezco");
  await botReply("¡Gracias a ti! Seguimos pendientes 💪");
  // Day 3 "Hola" — a bare greeting re-opens nothing.
  await inbound("Hola");
  await botReply("¡Hola! 🙌 ¿En qué te puedo ayudar?");
  await inbound("De nuevo les menciono que me quedan muy lejos por tanto no estoy interesada");
  await botReply("Entendido, gracias por avisarnos 🙏 No te molestamos más por este tema.");
  // "Otra vez ustedes" (the brain would flag it; here it does not) → apology + promise.
  await inbound("Otra vez ustedes");
  await botReply("Perdón por la insistencia 🙏 No te mandamos más mensajes sobre esto.");

  assert.equal(live().length, 0, "no nudge, drip, catch-up or blast row is ever live after the first close");
  assert.equal(await isDeclined(s.db, PHONE), true);
  // A blast queued later would drop her, and the drain refuses her row.
  assert.equal(planBlastAudience([contact()], new Set(), now, { declined: new Set([PHONE]) }).excluded.declined, 1);
  assert.equal(await sendTimeAllowed("blast"), false);
  // Her booked-class reminders would still go out (none here, but never blocked).
  assert.equal(await sendTimeAllowed("day_before"), true);
});

test("objection → one re-invite → silence: no further automated message ever", async () => {
  const now = Math.floor(Date.now() / 1000);
  const s = statefulDb(() => contact({ last_inbound_at: now }));
  if (detectDecline("Está muy caro")) await applyDecline(s.db, PHONE, "objection");
  // The re-invite itself (brain flags lead_declined on that turn, per persona).
  if (turnDeclineSource({ leadDeclined: true, message: "Te entiendo 🙌 ¿Te late probar gratis el sábado 10 am?" })) {
    await applyDecline(s.db, PHONE, "brain");
  }
  await armNudges(env(s.db), PHONE);
  assert.equal(s.rows.length, 0);
});

test("objection → re-invite → lead asks for a time → the chase resumes", async () => {
  const now = Math.floor(Date.now() / 1000);
  const s = statefulDb(() => contact({ last_inbound_at: now }));
  await applyDecline(s.db, PHONE, "objection", { now: now - 600 });
  const history = [
    { direction: "in", ts: now - 601 },
    { direction: "out", ts: now - 590 },
    { direction: "in", ts: now - 10 }, // "va, ¿a qué hora el sábado?"
  ];
  const marker = parseDeclineMarker(s.kv.get(declinedKey(PHONE)) ?? null);
  assert.equal(shouldClearDecline(marker, { interested: true, declinedThisTurn: false, history }), true);
  await clearDecline(s.db, PHONE);
  await armNudges(env(s.db), PHONE);
  assert.ok(s.rows.length > 0);
});
