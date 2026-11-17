// Incident 2026-11-16: a kids trial booked for Mon 16 Nov 3:15 pm kept its
// day-before, same-day and first no-show messages after that Monday became a
// "special" holiday (four adult classes only). Covers the pure day check, the
// no-class handling (one staff note per phone + trial), the hourly sweep and
// its index, the staff «Cancelar clase» core, and that an Airtable re-sync of
// the old date never re-arms a cancelled class while a new date still arms.
// DB flows run on in-memory SQLite with the production schema (node:sqlite).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  hasClosureWithin,
  noClassNoteKey,
  noClassTaskNote,
  trialDayCheck,
} from "../src/services/trial-day-check.js";
import { applyNoClassCancellation, applyStaffCancellation, rowsForTrial } from "../src/services/trial-cancel.js";
import { isCancelledTrial, mergeTrialCancelMarker, recentCancelIntent, trialCancelledKey } from "../src/pipeline/lead-cancel.js";
import { runTrialDaySweep, sweepPairs, TRIAL_DAY_SWEEP_SQL } from "../src/cron/trial-day-sweep.js";
import { runDueFollowups, scheduleTrialSequence, syncBookings } from "../src/cron/followups.js";
import { bookingRecordedKey, bookingRecordedValue } from "../src/services/booking-core.js";
import { CLIENT } from "../src/client.gen.js";
import type { ClosedDate } from "../src/client-config.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { Env } from "../src/types.js";

const NOV16 = (CLIENT.closedDates ?? []).find((c) => c.date === "2026-11-16");
const KIDS_1515 = cdmxToEpoch(2026, 11, 16, 15, 15, 0);
const ADULT_1900 = cdmxToEpoch(2026, 11, 16, 19, 0, 0);

// ---- pure day check ----

test("trialDayCheck: the real 2026-11-16 special row — kids 15:15 does not run, adult 19:00 does", () => {
  assert.ok(NOV16, "client.mjs still carries the 2026-11-16 row");
  const rows = [NOV16!];
  const v = trialDayCheck(KIDS_1515, rows);
  assert.equal(v.runs, false);
  if (!v.runs) {
    assert.equal(v.why, "horario especial");
    assert.equal(v.reason, "lunes feriado");
    assert.equal(v.date, "2026-11-16");
  }
  assert.deepEqual(trialDayCheck(ADULT_1900, rows), { runs: true });
  assert.deepEqual(trialDayCheck(cdmxToEpoch(2026, 11, 16, 10, 0, 0), rows), { runs: true });
});

test("trialDayCheck: closed / tbd / special without the slot / special without slots / ordinary day", () => {
  const closed: ClosedDate[] = [{ date: "2026-09-16", reason: "Día de la Independencia" }];
  const sep16 = cdmxToEpoch(2026, 9, 16, 18, 0, 0);
  assert.deepEqual(trialDayCheck(sep16, closed), { runs: false, why: "cerrado", reason: "Día de la Independencia", date: "2026-09-16" });
  assert.deepEqual(trialDayCheck(sep16, [{ date: "2026-09-16", mode: "closed" }]), { runs: false, why: "cerrado", reason: null, date: "2026-09-16" });

  const tbd: ClosedDate[] = [{ date: "2026-12-24", mode: "tbd", reason: "Nochebuena" }];
  const v = trialDayCheck(cdmxToEpoch(2026, 12, 24, 11, 0, 0), tbd);
  assert.equal(v.runs, false);
  if (!v.runs) assert.equal(v.why, "horario por confirmar");

  const special: ClosedDate[] = [
    { date: "2026-12-31", mode: "special", slots: [{ time: "10:00", discipline: "kids", group: "kids" }] },
  ];
  assert.deepEqual(trialDayCheck(cdmxToEpoch(2026, 12, 31, 10, 0, 0), special), { runs: true }); // any group
  assert.equal(trialDayCheck(cdmxToEpoch(2026, 12, 31, 10, 30, 0), special).runs, false);
  assert.equal(trialDayCheck(cdmxToEpoch(2026, 12, 31, 10, 0, 0), [{ date: "2026-12-31", mode: "special" }]).runs, false);

  // Ordinary day: never judged, whatever the time (staff book custom times).
  assert.deepEqual(trialDayCheck(cdmxToEpoch(2026, 11, 17, 15, 15, 0), [NOV16!]), { runs: true });
  assert.deepEqual(trialDayCheck(cdmxToEpoch(2026, 11, 17, 3, 7, 0), []), { runs: true });
});

test("hasClosureWithin: only a closure in the next N days wakes the sweep", () => {
  const rows = [NOV16!];
  assert.equal(hasClosureWithin(rows, cdmxToEpoch(2026, 11, 14, 12, 0, 0), 14), true);
  assert.equal(hasClosureWithin(rows, cdmxToEpoch(2026, 11, 16, 20, 0, 0), 14), true); // same day still counts
  assert.equal(hasClosureWithin(rows, cdmxToEpoch(2026, 11, 17, 0, 30, 0), 14), false);
  assert.equal(hasClosureWithin(rows, cdmxToEpoch(2026, 10, 30, 12, 0, 0), 14), false);
  assert.equal(hasClosureWithin([], cdmxToEpoch(2026, 11, 14, 12, 0, 0), 14), false);
});

test("noClassTaskNote: who, which class, why, reminders stopped, staff tell + rebook", () => {
  const v = trialDayCheck(KIDS_1515, [NOV16!]);
  assert.equal(v.runs, false);
  if (v.runs) return;
  const t = noClassTaskNote({ who: "Ana (55 1234 5678)", classLabel: "el lunes 16 a las 3:15 pm", verdict: v, cancelledRows: 3 });
  assert.match(t, /Ana \(55 1234 5678\) tiene clase de prueba el lunes 16 a las 3:15 pm/);
  assert.match(t, /horario especial \(lunes feriado\)/);
  assert.match(t, /Detuve los recordatorios automáticos/);
  assert.match(t, /avísale tú\* y reagenda/);
  assert.doesNotMatch(t, /10:00|11:00|18:00|19:00/); // never offers a class time
});

test("marker: a staff / holiday cancel adds trials but never fakes a fresh LEAD cancel (no brain hint)", () => {
  const now = 1_800_000_000;
  const m = mergeTrialCancelMarker(null, { ts: now, intent: "cancel", trials: [KIDS_1515] }, "holiday");
  assert.equal(m.ts, 0);
  assert.equal(recentCancelIntent(JSON.stringify(m), now), null);
  assert.equal(isCancelledTrial(JSON.stringify(m), KIDS_1515), true);
  const lead = mergeTrialCancelMarker(null, { ts: now, intent: "reschedule", trials: [1] });
  const after = mergeTrialCancelMarker(lead, { ts: now + 5, intent: "cancel", trials: [2] }, "staff");
  assert.deepEqual(after, { ts: now, intent: "reschedule", trials: [1, 2] });
});

test("rowsForTrial / sweepPairs: rows of that trial (+ note-less confirm only when no other trial is armed)", () => {
  const a = { id: 1, note: `trial:${KIDS_1515}` };
  const conf = { id: 2, note: null };
  const other = { id: 3, note: `rec:recB;trial:${ADULT_1900}` };
  assert.deepEqual(rowsForTrial([a, conf], KIDS_1515).map((r) => r.id), [1, 2]);
  assert.deepEqual(rowsForTrial([a, conf, other], KIDS_1515).map((r) => r.id), [1]);
  assert.deepEqual(
    sweepPairs([
      { phone: "p1", note: `trial:${KIDS_1515}` },
      { phone: "p1", note: `rec:x;trial:${KIDS_1515}` },
      { phone: "p2", note: null },
    ]),
    [{ phone: "p1", trial: KIDS_1515 }],
  );
});

// ---- DB flows on real SQLite ----

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
  return { raw, env: { DB: db } as Env };
}

const KID_PHONE = "5215511110000";
const ADULT_PHONE = "5215522220000";
const BOOKED_AT = cdmxToEpoch(2026, 11, 12, 10, 0, 0);
const CONFIGURED_AT = cdmxToEpoch(2026, 11, 14, 12, 0, 0);
const KIDS_ISO = "2026-11-16T15:15:00-06:00";
const ADULT_ISO = "2026-11-16T19:00:00-06:00";

function rowsOf(raw: DatabaseSync, phone: string): Array<{ kind: string; status: string; due_at: number }> {
  return raw
    .prepare(`SELECT kind, status, due_at FROM followups WHERE phone = ? ORDER BY kind`)
    .all(phone) as Array<{ kind: string; status: string; due_at: number }>;
}

function kv(raw: DatabaseSync, key: string): string | null {
  return (raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
}

async function seedTwoTrials(raw: DatabaseSync, env: Env): Promise<void> {
  raw.prepare(`INSERT INTO contacts(phone, name, status, created_at, updated_at) VALUES(?, 'Ana', 'lead', 1, 1)`).run(KID_PHONE);
  raw.prepare(`INSERT INTO contacts(phone, name, status, created_at, updated_at) VALUES(?, 'Beto', 'lead', 1, 1)`).run(ADULT_PHONE);
  await scheduleTrialSequence(env, KID_PHONE, "recKIDS000000000", KIDS_ISO, { nowEpoch: BOOKED_AT, includeConfirm: false });
  await scheduleTrialSequence(env, ADULT_PHONE, "recADULT00000000", ADULT_ISO, { nowEpoch: BOOKED_AT, includeConfirm: false });
}

test("applyNoClassCancellation: cancels that trial's rows, marks it, ONE note per phone + trial", async () => {
  const { raw, env } = openDb();
  await seedTwoTrials(raw, env);
  const notes: string[] = [];
  const deps = { postTaskNote: async (t: string) => void notes.push(t) };
  const v = trialDayCheck(KIDS_1515, [NOV16!]);
  assert.equal(v.runs, false);
  if (v.runs) return;

  const r1 = await applyNoClassCancellation(env, KID_PHONE, KIDS_1515, v, deps, CONFIGURED_AT);
  assert.equal(r1.cancelled, 3);
  assert.equal(r1.noted, true);
  assert.ok(rowsOf(raw, KID_PHONE).every((r) => r.status === "cancelled"));
  assert.ok(rowsOf(raw, ADULT_PHONE).every((r) => r.status === "scheduled"), "another lead's class is untouched");
  assert.equal(isCancelledTrial(kv(raw, trialCancelledKey(KID_PHONE)), KIDS_1515), true);
  assert.equal(recentCancelIntent(kv(raw, trialCancelledKey(KID_PHONE)), CONFIGURED_AT), null);
  assert.ok(kv(raw, noClassNoteKey(KID_PHONE, KIDS_1515)));

  // A second row / a later tick: no second note.
  const r2 = await applyNoClassCancellation(env, KID_PHONE, KIDS_1515, v, deps, CONFIGURED_AT + 3600, 1);
  assert.equal(r2.noted, false);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /Ana \(.*\) tiene clase de prueba el lunes a las 3:15 pm, pero ese día hay horario especial \(lunes feriado\)/);
  assert.match(notes[0]!, /\(3 programado\(s\)\)/);
});

test("runTrialDaySweep: flags only the class that does not run, at most once an hour, via the kind/status/due index", async () => {
  const { raw, env } = openDb();
  await seedTwoTrials(raw, env);
  const notes: string[] = [];
  const deps = { postTaskNote: async (t: string) => void notes.push(t) };
  const rows = [NOV16!];

  // No closure within 14 days ⇒ gated off before any D1 read.
  assert.equal(await runTrialDaySweep(env, deps, cdmxToEpoch(2026, 10, 20, 12, 0, 0), rows), null);
  assert.equal(kv(raw, "trial_day_sweep_at"), null);

  const r = await runTrialDaySweep(env, deps, CONFIGURED_AT, rows);
  assert.ok(r);
  assert.equal(r!.flagged, 1);
  assert.equal(r!.cancelled, 3);
  assert.equal(r!.notes, 1);
  assert.ok(rowsOf(raw, KID_PHONE).every((x) => x.status === "cancelled"));
  assert.ok(rowsOf(raw, ADULT_PHONE).every((x) => x.status === "scheduled"));
  assert.equal(notes.length, 1);

  // Within the hour: gated. After it: runs again, nothing new to say.
  assert.equal(await runTrialDaySweep(env, deps, CONFIGURED_AT + 600, rows), null);
  const again = await runTrialDaySweep(env, deps, CONFIGURED_AT + 3700, rows);
  assert.ok(again);
  assert.equal(again!.flagged, 0);
  assert.equal(notes.length, 1);

  // The sweep's SELECT is served by idx_followups_kind_status_due, no table scan.
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${TRIAL_DAY_SWEEP_SQL}`).all(CONFIGURED_AT) as Array<{ detail: string }>;
  const detail = plan.map((p) => p.detail).join(" | ");
  assert.match(detail, /USING INDEX idx_followups_kind_status_due/, detail);
  assert.doesNotMatch(detail, /SCAN followups(?! USING)/, detail);
});

test("applyStaffCancellation: cancels the armed trial, names who pressed it; nothing armed ⇒ null", async () => {
  const { raw, env } = openDb();
  await seedTwoTrials(raw, env);
  const notes: string[] = [];
  const deps = { postTaskNote: async (t: string) => void notes.push(t) };
  const res = await applyStaffCancellation(env, ADULT_PHONE, "Fer", deps, CONFIGURED_AT);
  assert.ok(res);
  assert.equal(res!.cancelled, 3);
  assert.deepEqual(res!.trials, [ADULT_1900]);
  assert.equal(res!.classes.length, 1);
  assert.match(res!.classes[0]!, /7:00 pm/);
  assert.ok(rowsOf(raw, ADULT_PHONE).every((r) => r.status === "cancelled"));
  assert.equal(isCancelledTrial(kv(raw, trialCancelledKey(ADULT_PHONE)), ADULT_1900), true);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^🚫 Fer canceló desde el panel la clase de prueba de Beto/);
  assert.match(notes[0]!, /En Airtable/);

  assert.equal(await applyStaffCancellation(env, ADULT_PHONE, "Fer", deps, CONFIGURED_AT + 10), null);
  assert.equal(notes.length, 1);
});

test("re-arm: an Airtable re-sync of the OLD date never revives a cancelled class; a NEW date arms", async () => {
  const { raw, env } = openDb();
  await seedTwoTrials(raw, env);
  // A row whose due_at drifted from the recomputed one (a quiet-hour /
  // ceiling push, or a reminder-timing change since it was armed): without
  // the marker gate, rescheduleFollowup would set it back to 'scheduled'.
  raw.prepare(`UPDATE followups SET due_at = due_at + 60 WHERE phone = ? AND kind = 'day_before'`).run(ADULT_PHONE);
  const deps = { postTaskNote: async () => {} };
  await applyStaffCancellation(env, ADULT_PHONE, "Fer", deps, CONFIGURED_AT);
  // A recent chat-booking marker ⇒ the sync's questionnaire send is skipped (no Airtable call).
  raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run(
    bookingRecordedKey(ADULT_PHONE),
    bookingRecordedValue(CONFIGURED_AT, "2026-11-16", "19:00"),
  );

  let iso = ADULT_ISO;
  const airtable = {
    async listRecentBookings() {
      return [{ id: "recADULT00000000", phone: ADULT_PHONE, name: "Beto", trialDateTimeIso: iso, result: null }];
    },
  };
  const realNow = Date.now;
  Date.now = () => (CONFIGURED_AT + 900) * 1000;
  try {
    assert.equal(await syncBookings(env, airtable), 0);
    assert.ok(rowsOf(raw, ADULT_PHONE).every((r) => r.status === "cancelled"), JSON.stringify(rowsOf(raw, ADULT_PHONE)));

    // Staff move the date in Airtable: the new class arms normally.
    iso = "2026-11-18T19:00:00-06:00";
    assert.equal(await syncBookings(env, airtable), 1);
    const live = rowsOf(raw, ADULT_PHONE).filter((r) => r.status === "scheduled");
    assert.deepEqual(live.map((r) => r.kind).sort(), ["day_before", "no_show_hoy", "same_day"]);
    assert.ok(live.every((r) => r.due_at > cdmxToEpoch(2026, 11, 17, 0, 0, 0)), JSON.stringify(live));
  } finally {
    Date.now = realNow;
  }
});

test("send-time guard (runDueFollowups): day_before + no_show_hoy for the holiday class never send; ONE note", async () => {
  const { raw, env } = openDb();
  await seedTwoTrials(raw, env);
  const notes: string[] = [];
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in tests");
  }) as typeof fetch;
  const realNow = Date.now;
  const slack = {
    postNote: async () => {},
    postAttendanceCheck: async () => {},
    postPostTrialCard: async () => {},
    postTaskNote: async (t: string) => void notes.push(t),
  };
  try {
    // Sun 15 Nov 18:05: the day-before reminders of BOTH Monday classes are due.
    Date.now = () => cdmxToEpoch(2026, 11, 15, 18, 5, 0) * 1000;
    await runDueFollowups(env, { slack });
    const kid = rowsOf(raw, KID_PHONE);
    assert.ok(kid.every((r) => r.status === "cancelled"), JSON.stringify(kid));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /3:15 pm/);
    assert.equal(isCancelledTrial(kv(raw, trialCancelledKey(KID_PHONE)), KIDS_1515), true);
    // The adult 19:00 class runs: its day_before was attempted (network stub ⇒ retry), never cancelled by the guard.
    assert.equal(rowsOf(raw, ADULT_PHONE).find((r) => r.kind === "day_before")!.status, "scheduled");
    assert.ok(fetched > 0);

    // A no-show touch for the holiday class (re-armed by hand, d2 included): closed, no second note.
    raw.prepare(`UPDATE followups SET status = 'scheduled' WHERE phone = ? AND kind = 'no_show_hoy'`).run(KID_PHONE);
    raw
      .prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, note, created_at) VALUES(?, 'no_show_d2', ?, 'scheduled', 'ns:x', ?, 1)`)
      .run(KID_PHONE, cdmxToEpoch(2026, 11, 18, 11, 0, 0), `rec:recKIDS000000000;trial:${KIDS_1515}`);
    Date.now = () => cdmxToEpoch(2026, 11, 18, 11, 5, 0) * 1000;
    const before = fetched;
    await runDueFollowups(env, { slack });
    const ns = raw
      .prepare(`SELECT kind, status FROM followups WHERE phone = ? AND kind LIKE 'no_show%'`)
      .all(KID_PHONE) as Array<{ kind: string; status: string }>;
    assert.ok(ns.every((r) => r.status === "cancelled"), JSON.stringify(ns));
    assert.equal(notes.length, 1);
    void before;
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
});
