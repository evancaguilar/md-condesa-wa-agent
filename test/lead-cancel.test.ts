// Lead cancellations (audit 2026-10-14 / 10-21): "ya no voy a poder ir" and
// friends must stop the trial reminders and the no-show touch, tell staff,
// and leave a rebook path that re-arms everything for the NEW class.
// Detector cases are pure; the DB flow runs on real in-memory SQLite with the
// production schema (node:sqlite) so the cancel → rebook upsert is the real SQL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  CANCEL_HINT_SECONDS,
  cancelTaskNote,
  detectLeadCancel,
  isCancelledTrial,
  mergeTrialCancelMarker,
  parseTrialCancelMarker,
  recentCancelIntent,
  trialCancelledKey,
} from "../src/pipeline/lead-cancel.js";
import { applyLeadCancellation } from "../src/services/trial-cancel.js";
import { scheduleTrialSequence, shouldSendReminder } from "../src/cron/followups.js";
import { encodeChainNote, processPostTrial } from "../src/cron/post-trial.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { Env } from "../src/types.js";

// ---- detector ----

const CANCELS = [
  "Ya no voy a poder ir",
  "no voy a poder asistir mañana, una disculpa",
  "Hola, no podré asistir 🙏",
  "Cancelo mi clase por favor",
  "Quiero cancelar",
  "No vamos a poder llegar hoy",
  "Me surgió algo en el trabajo 😔",
  "se me complicó, hoy no llego",
  "Tuve un imprevisto",
  "Perdón, ya no podemos ir",
  "No podremos ir el sábado",
  "no puedo ir hoy",
  "No puedo el martes, disculpa",
  "Mi hijo amaneció enfermo",
  "me salió un viaje de trabajo",
  "No iremos, gracias",
  "Sorry, I can't make it today",
];

const RESCHEDULES = [
  "lo dejamos para otro día",
  "¿Podemos reagendar?",
  "Necesito reagendar",
  "¿La puedo cambiar para el jueves?",
  "Mejor otro día",
  "¿Se puede mover la clase al viernes?",
  "no voy a poder ir hoy, pero mañana sí",
  "¿Podemos posponerla una semana?",
  "mejor la próxima semana",
  "Can we reschedule?",
  "Ya no podré ir, ¿la pasamos para el lunes? Lo dejamos para el lunes mejor",
];

const NOT_CANCELS = [
  "Ahí estaré",
  "Sí voy, gracias",
  "¿Qué pasa si no llego?",
  "Si no puedo ir te aviso",
  "Voy a llegar 10 minutos tarde",
  "no llego a tiempo, llego como 10 min tarde",
  "Quiero cancelar mi mensualidad",
  "no puedo esperar a empezar 💪",
  "ya no tengo dudas, nos vemos",
  "¿Tienen clase el domingo?",
  "Gracias!",
  "Perfecto, ¿qué debo llevar?",
  "no podré pagar en efectivo, ¿aceptan tarjeta?",
  "¿y otro día de la semana hay clase?",
  "",
];

test("detectLeadCancel: Spanish (and English) cancellations", () => {
  for (const t of CANCELS) assert.equal(detectLeadCancel(t), "cancel", t);
});

test("detectLeadCancel: reschedules win over a bare cancel", () => {
  for (const t of RESCHEDULES) assert.equal(detectLeadCancel(t), "reschedule", t);
});

test("detectLeadCancel: confirmations, hypotheticals, lateness and memberships never count", () => {
  for (const t of NOT_CANCELS) assert.equal(detectLeadCancel(t), null, t);
  assert.equal(detectLeadCancel(null), null);
});

// ---- marker + note (pure) ----

test("trial-cancel marker: merge, match ±60 s, recent hint window", () => {
  const a = mergeTrialCancelMarker(null, { ts: 100, intent: "cancel", trials: [5000] });
  const b = mergeTrialCancelMarker(a, { ts: 200, intent: "reschedule", trials: [5000, 9000] });
  assert.deepEqual(b, { ts: 200, intent: "reschedule", trials: [5000, 9000] });
  const raw = JSON.stringify(b);
  assert.deepEqual(parseTrialCancelMarker(raw), b);
  assert.equal(isCancelledTrial(raw, 5030), true);
  assert.equal(isCancelledTrial(raw, 7000), false);
  assert.equal(isCancelledTrial(raw, null), false);
  assert.equal(isCancelledTrial(null, 5000), false);
  assert.equal(recentCancelIntent(raw, 200 + CANCEL_HINT_SECONDS), "reschedule");
  assert.equal(recentCancelIntent(raw, 201 + CANCEL_HINT_SECONDS), null);
  assert.equal(parseTrialCancelMarker("nope"), null);
  assert.equal(trialCancelledKey("521"), "trial_cancelled:521");
});

test("cancelTaskNote: names the class, quotes the lead, tells staff what to do in Airtable", () => {
  const note = cancelTaskNote({
    who: "Ana (5215512345678)",
    intent: "cancel",
    body: "Ya no voy a poder ir",
    classes: ["mañana martes a las 7:00 pm"],
    cancelledRows: 2,
  });
  assert.match(note, /Ana \(5215512345678\) canceló su clase de prueba \(mañana martes a las 7:00 pm\): «Ya no voy a poder ir»/);
  assert.match(note, /Cancelé 2 recordatorio/);
  assert.match(note, /En Airtable/);
  assert.match(note, /no lo marques «No asistió»/);
  assert.match(cancelTaskNote({ who: "x", intent: "reschedule", body: "b", classes: [], cancelledRows: 1 }), /x quiere reagendar su clase de prueba:/);
});

test("shouldSendReminder: a cancellation followed by 'gracias' still skips the reminder", () => {
  const CLASS = cdmxToEpoch(2026, 10, 22, 19, 0, 0);
  const armedAt = CLASS - 3 * 86400;
  const row = { kind: "same_day" as const, note: `trial:${CLASS}`, created_at: armedAt };
  const at = CLASS - 4 * 3600;
  const recentInbound = [
    { body: "lo dejamos para otro día", ts: armedAt + 100 },
    { body: "gracias!", ts: armedAt + 200 },
  ];
  assert.deepEqual(
    shouldSendReminder(row, undefined, at, { lastInbound: recentInbound[1]!, recentInbound }),
    { send: false, why: "cancelled_in_chat" },
  );
  // Without the cancellation the reminder goes.
  assert.equal(shouldSendReminder(row, undefined, at, { lastInbound: recentInbound[1]!, recentInbound: [recentInbound[1]!] }).send, true);
});

// ---- DB flow on real SQLite ----

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

function openDb(): { raw: DatabaseSync; env: Env } {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of schemaStatements()) raw.exec(stmt);
  for (const sql of INDEX_SQL) raw.exec(sql);
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (raw.prepare(sql).get(...binds) ?? null) as T | null;
      },
      async run() {
        const r = raw.prepare(sql).run(...binds);
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...binds) as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  const db = { prepare: make } as unknown as D1Database;
  return { raw, env: { DB: db } as Env };
}

const PHONE = "5215512345678";
// Booked Mon 2026-10-19 10:00 for Wed 2026-10-21 19:00; cancels Tue 12:00.
const BOOKED_AT = cdmxToEpoch(2026, 10, 19, 10, 0, 0);
const CLASS = cdmxToEpoch(2026, 10, 21, 19, 0, 0);
const CANCEL_AT = cdmxToEpoch(2026, 10, 20, 12, 0, 0);
const CLASS_ISO = "2026-10-21T19:00:00-06:00";

function rows(raw: DatabaseSync): Array<{ kind: string; status: string; due_at: number }> {
  return raw
    .prepare(`SELECT kind, status, due_at FROM followups WHERE phone = ? ORDER BY kind`)
    .all(PHONE) as Array<{ kind: string; status: string; due_at: number }>;
}

test("applyLeadCancellation: cancels the armed reminders + first no-show touch, marks the trial, notes staff", async () => {
  const { raw, env } = openDb();
  raw.prepare(`INSERT INTO contacts(phone, name, status, created_at, updated_at) VALUES(?, 'Ana', 'lead', 1, 1)`).run(PHONE);
  await scheduleTrialSequence(env, PHONE, "recA", CLASS_ISO, { nowEpoch: BOOKED_AT, includeConfirm: false });
  const armed = rows(raw);
  assert.deepEqual(armed.map((r) => `${r.kind}:${r.status}`), ["day_before:scheduled", "no_show_hoy:scheduled", "same_day:scheduled"]);

  const notes: string[] = [];
  const res = await applyLeadCancellation(env, PHONE, "Ya no voy a poder ir", "cancel", { postTaskNote: async (t) => void notes.push(t) }, CANCEL_AT);
  assert.deepEqual(res, { cancelled: 3, trials: [CLASS] });
  assert.ok(rows(raw).every((r) => r.status === "cancelled"));
  const marker = (raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(trialCancelledKey(PHONE)) as { value: string }).value;
  assert.equal(isCancelledTrial(marker, CLASS), true);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /Ana \(5215512345678\) canceló su clase de prueba \(mañana miércoles a las 7:00 pm\)/);

  // Airtable re-sync of the SAME record/slot (staff touches another field):
  // the cancelled rows stay cancelled — nothing resurrects them.
  await scheduleTrialSequence(env, PHONE, "recA", CLASS_ISO, { nowEpoch: CANCEL_AT + 600, includeConfirm: false });
  assert.ok(rows(raw).every((r) => r.status === "cancelled"), JSON.stringify(rows(raw)));

  // Rebook through book_trial (same Airtable record, new date): the
  // reminders come back for the NEW class, and its no-show touch is not
  // blocked by the marker.
  const NEW_CLASS = cdmxToEpoch(2026, 10, 23, 9, 0, 0);
  await scheduleTrialSequence(env, PHONE, "recA", "2026-10-23T09:00:00-06:00", { nowEpoch: CANCEL_AT + 900, includeConfirm: false });
  const after = rows(raw).filter((r) => r.status === "scheduled");
  assert.deepEqual(after.map((r) => r.kind).sort(), ["day_before", "no_show_hoy", "same_day"]);
  assert.ok(after.every((r) => r.due_at > CANCEL_AT && r.due_at <= NEW_CLASS + 3 * 3600), JSON.stringify(after));
  assert.equal(isCancelledTrial(marker, NEW_CLASS), false);
});

test("applyLeadCancellation: no armed trial ⇒ nothing touched, no note", async () => {
  const { raw, env } = openDb();
  const notes: string[] = [];
  const res = await applyLeadCancellation(env, PHONE, "no puedo el lunes", "cancel", { postTaskNote: async (t) => void notes.push(t) }, CANCEL_AT);
  assert.equal(res, null);
  assert.equal(notes.length, 0);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM kv`).get() as { n: number }).n, 0);
});

test("no-show chain: a class the lead called off is never chased, even if Airtable says No asistió", async () => {
  const { raw, env } = openDb();
  raw
    .prepare(`INSERT INTO contacts(phone, name, status, last_inbound_at, created_at, updated_at) VALUES(?, 'Ana', 'lead', ?, 1, 1)`)
    .run(PHONE, CANCEL_AT);
  raw
    .prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`)
    .run(trialCancelledKey(PHONE), JSON.stringify({ ts: CANCEL_AT, intent: "cancel", trials: [CLASS] }));
  let sent = 0;
  const deps = {
    sendText: async () => {
      sent++;
      return "wamid";
    },
    sendTemplate: async () => {
      sent++;
      return "wamid";
    },
    templateName: (b: string, l: string) => `${b}_${l}`,
    isWindowClosed: () => false,
  };
  // d2 armed by the result watcher AFTER the cancel message (so "the lead
  // wrote in" does not stop it on its own).
  const res = await processPostTrial(
    env,
    { phone: PHONE, kind: "no_show_d2", created_at: CLASS + 3600, note: encodeChainNote({ rec: null, trial: CLASS }) },
    deps,
    CLASS + 2 * 86400,
  );
  assert.deepEqual(res, { outcome: "cancelled", stopChain: true });
  assert.equal(sent, 0);
});
