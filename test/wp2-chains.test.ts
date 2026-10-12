// WP2 (audit 2026-10-09): reminders, drips and post-trial / no-show chains do
// the right thing. Fake clocks for every pure function; replay fixtures
// (test/fixtures/replay) for the three conversations that broke in prod; a
// real in-memory SQLite (node:sqlite) for the SQL that dedupes and cancels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  leadCancelledInChat,
  reminderNote,
  sameDaySentKey,
  shouldSendReminder,
  syncDateAction,
  scheduleTrialSequence,
} from "../src/cron/followups.js";
import {
  chainKey,
  computeNoShowSequence,
  computePostTrialSequence,
  dayWord,
  decodeChainNote,
  encodeChainNote,
  noShowRecordGate,
  noShowTouchCopy,
  postTrialCopy,
  processPostTrial,
  NO_SHOW_DELAY,
} from "../src/cron/post-trial.js";
import {
  bandForContact,
  bandSchedule,
  bandSlot,
  bookingMarkerLive,
  copyInputsForBand,
  nudgeCopy,
  nudgeDayClaimKey,
  processNudge,
} from "../src/cron/nudges.js";
import { isQuietHour, shiftOutOfQuiet } from "../src/cron/quiet.js";
import { slotLabel, stillActionable } from "../src/cron/booking-recon-core.js";
import { SLOTS } from "../src/brain/slots.gen.js";
import { slotGroup } from "../src/services/age-band.js";
import { rescheduleFollowup, cancelReminderRowsForRecord } from "../src/db/queries.js";
import { cdmxToEpoch, cdmxDateStr, cdmxParts, DAY } from "../src/cron/time.js";
import type { BookingRecord } from "../src/services/airtable.js";
import type { Contact, Env, Followup } from "../src/types.js";

const H = 3600;

// ---- helpers ----------------------------------------------------------------

interface Fixture {
  case: string;
  phone: string;
  campaign: string | null;
  contact: { name: string; lang: "es" | "en"; status: string; qualification: string | null; campaign_id: number | null };
  messages: { direction: string; ts: number; body: string }[];
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(`test/fixtures/replay/${name}.json`, "utf8")) as Fixture;
}

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215512345678",
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

function fixtureContact(f: Fixture): Contact {
  return contact({
    phone: f.phone,
    name: f.contact.name,
    lang: f.contact.lang,
    qualification: f.contact.qualification,
    campaign_id: f.contact.campaign_id,
  });
}

function rec(trial: number | null, result: string | null = null): BookingRecord {
  return {
    id: "recA",
    phone: "5215512345678",
    name: "Ana",
    trialDateTimeIso: trial === null ? null : new Date(trial * 1000).toISOString(),
    result,
  };
}

function row(kind: Followup["kind"], trial: number | null, createdAt = 0): Pick<Followup, "kind" | "note" | "created_at"> {
  return { kind, note: trial === null ? null : reminderNote(trial), created_at: createdAt };
}

/** Real SQLite with the production schema, behind the D1 surface. */
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
      /* ALTERs re-adding a column already in the CREATE — prod reruns ignore them too */
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
        return (raw.prepare(sql).get(...binds) ?? null) as T | null;
      },
      async run() {
        const r = raw.prepare(sql).run(...binds);
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...binds) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { raw, db: { prepare: make } as unknown as D1Database };
}

function envWith(db: D1Database): Env {
  return { DB: db, AIRTABLE_BASE_ID: "appTest", AIRTABLE_TRIALS_TABLE: "Trials" } as unknown as Env;
}

function insertContact(raw: DatabaseSync, c: Contact): void {
  raw
    .prepare(
      `INSERT INTO contacts(phone, name, lang, status, qualification, human_override_until, last_inbound_at, campaign_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(c.phone, c.name, c.lang, c.status, c.qualification, c.human_override_until, c.last_inbound_at, c.campaign_id);
}

function rows(raw: DatabaseSync): { kind: string; status: string; airtable_record_id: string; due_at: number; note: string | null }[] {
  return raw
    .prepare(`SELECT kind, status, airtable_record_id, due_at, note FROM followups ORDER BY id`)
    .all() as { kind: string; status: string; airtable_record_id: string; due_at: number; note: string | null }[];
}

// ---- quiet hours (08:00–21:00 everywhere) ------------------------------------

test("quiet: 21:00 on is quiet, 08:00 opens; a 21:30 send is pushed to 08:00 next day", () => {
  assert.equal(isQuietHour(cdmxToEpoch(2026, 10, 8, 21, 0)), true);
  assert.equal(isQuietHour(cdmxToEpoch(2026, 10, 8, 20, 59)), false);
  assert.equal(isQuietHour(cdmxToEpoch(2026, 10, 9, 8, 0)), false);
  assert.equal(shiftOutOfQuiet(cdmxToEpoch(2026, 10, 8, 21, 30)), cdmxToEpoch(2026, 10, 9, 8, 0));
});

// ---- 1. reminder send guard ----------------------------------------------------

const CLASS = cdmxToEpoch(2026, 10, 6, 18, 0); // Tue 6 pm
const DAY_BEFORE_AT = cdmxToEpoch(2026, 10, 5, 18, 0);
const SAME_DAY_AT = cdmxToEpoch(2026, 10, 6, 14, 0);

test("shouldSendReminder: the happy path sends (both kinds)", () => {
  assert.deepEqual(shouldSendReminder(row("day_before", CLASS), rec(CLASS), DAY_BEFORE_AT), { send: true, trialEpoch: CLASS });
  assert.deepEqual(shouldSendReminder(row("same_day", CLASS), rec(CLASS), SAME_DAY_AT), { send: true, trialEpoch: CLASS });
});

test("shouldSendReminder: class already started / date cleared / record gone → skip", () => {
  assert.equal(shouldSendReminder(row("same_day", CLASS), rec(CLASS), CLASS + 60).send, false);
  assert.deepEqual(shouldSendReminder(row("same_day", CLASS), rec(null), SAME_DAY_AT), { send: false, why: "date_cleared" });
  assert.deepEqual(shouldSendReminder(row("same_day", CLASS), null, SAME_DAY_AT), { send: false, why: "record_gone" });
});

test("shouldSendReminder: a record moved to another datetime than the row was armed for → skip", () => {
  const moved = CLASS + DAY;
  assert.deepEqual(shouldSendReminder(row("same_day", CLASS), rec(moved), SAME_DAY_AT), { send: false, why: "moved" });
  // an hour later on the same day is a move too
  assert.equal(shouldSendReminder(row("day_before", CLASS), rec(CLASS + H), DAY_BEFORE_AT).send, false);
});

test("shouldSendReminder: Resultado Asistió / No asistió / Se inscribió → skip", () => {
  for (const r of ["Asistió", "No asistió", "Se inscribió", "Asistió, Se inscribió"]) {
    assert.deepEqual(shouldSendReminder(row("same_day", CLASS), rec(CLASS, r), SAME_DAY_AT), { send: false, why: "result_marked" }, r);
  }
  // "Dijo que se va a inscribir" alone is not a result about this class
  assert.equal(shouldSendReminder(row("same_day", CLASS), rec(CLASS, "Dijo que se va a inscribir"), SAME_DAY_AT).send, true);
});

test("shouldSendReminder: student / opted-out contact → skip", () => {
  assert.equal(shouldSendReminder(row("same_day", CLASS), rec(CLASS), SAME_DAY_AT, { contactStatus: "student" }).send, false);
  assert.equal(shouldSendReminder(row("same_day", CLASS), rec(CLASS), SAME_DAY_AT, { contactStatus: "opted_out" }).send, false);
});

test("shouldSendReminder: a cancellation in chat AFTER arming skips; one before arming does not", () => {
  const armedAt = DAY_BEFORE_AT - 2 * DAY;
  const r = row("same_day", CLASS, armedAt);
  for (const body of ["Ya no voy a poder ir", "no podré mañana", "Quiero cancelar", "ya no"]) {
    assert.deepEqual(
      shouldSendReminder(r, rec(CLASS), SAME_DAY_AT, { lastInbound: { body, ts: armedAt + 60 } }),
      { send: false, why: "cancelled_in_chat" },
      body,
    );
  }
  assert.equal(
    shouldSendReminder(r, rec(CLASS), SAME_DAY_AT, { lastInbound: { body: "ya no", ts: armedAt - 60 } }).send,
    true,
  );
  assert.equal(shouldSendReminder(r, rec(CLASS), SAME_DAY_AT, { lastInbound: { body: "Ahí estaré", ts: armedAt + 60 } }).send, true);
});

test("leadCancelledInChat: pure regex + arming time", () => {
  assert.equal(leadCancelledInChat(null, 0), false);
  assert.equal(leadCancelledInChat({ body: "Cancelo la clase", ts: 10 }, 5), true);
  assert.equal(leadCancelledInChat({ body: "Cancelo la clase", ts: 5 }, 5), false);
  assert.equal(leadCancelledInChat({ body: "Perfecto, nos vemos", ts: 10 }, 5), false);
});

test("shouldSendReminder: a reminder that no longer matches the class day is skipped (cron drift / stale rows)", () => {
  // same_day fired the day before the class
  assert.deepEqual(shouldSendReminder(row("same_day", CLASS), rec(CLASS), DAY_BEFORE_AT), { send: false, why: "not_class_day" });
  // day_before fired on the class day itself
  assert.deepEqual(shouldSendReminder(row("day_before", CLASS), rec(CLASS), SAME_DAY_AT), { send: false, why: "not_day_before" });
});

test("shouldSendReminder: Airtable unreachable (record undefined) still runs the local checks off the armed epoch", () => {
  assert.equal(shouldSendReminder(row("same_day", CLASS), undefined, SAME_DAY_AT).send, true);
  assert.equal(shouldSendReminder(row("same_day", CLASS), undefined, CLASS + 1).send, false);
  // legacy row without an armed epoch and no record: nothing to compare, sends
  assert.equal(shouldSendReminder(row("same_day", null), undefined, SAME_DAY_AT).send, true);
});

test("sameDaySentKey: one claim per phone per CDMX class date, whatever the row", () => {
  assert.equal(sameDaySentKey("521", CLASS), sameDaySentKey("521", CLASS - 3 * H));
  assert.notEqual(sameDaySentKey("521", CLASS), sameDaySentKey("521", CLASS + DAY));
});

// ---- 2. syncBookings: what a record's date means ---------------------------------

test("syncDateAction: cleared → cancel all; past → cancel reminders only; future → arm", () => {
  const now = cdmxToEpoch(2026, 10, 4, 12, 0);
  assert.equal(syncDateAction(rec(null), now), "cancel_all");
  assert.equal(syncDateAction(rec(now - H), now), "cancel_reminders");
  assert.equal(syncDateAction(rec(now + DAY), now), "arm");
  assert.equal(syncDateAction(rec(now + DAY, "No asistió, Reprogramó"), now), "arm");
});

// ---- joss_bfc_mini: date moved AFTER "Asistió" on the same record ----------------

test("fixture joss_bfc_mini: reminders are NOT re-armed after Asistió when the date moved later", () => {
  const f = fixture("joss_bfc_mini");
  const attendedCopy = f.messages.find((m) => m.body.includes("Qué gusto verte hoy"))!;
  assert.equal(cdmxDateStr(attendedCopy.ts), "2026-10-03"); // she came on Saturday 10-03
  const dayBefore = f.messages.find((m) => m.ts > attendedCopy.ts && m.body.includes("trial_reminder_day_before"))!;
  const sameDay = f.messages.find((m) => m.ts > attendedCopy.ts && m.body.includes("trial_reminder_same_day"))!;
  // Staff moved Fecha Clase Prueba to 10-05 on the record that says Asistió.
  const moved = cdmxToEpoch(2026, 10, 5, 14, 0);
  const record = rec(moved, "Asistió");
  // The sync never re-arms them (and retires what is there)…
  assert.equal(syncDateAction(record, attendedCopy.ts + H), "cancel_all");
  // …and even a row armed before that cannot go out: both prod sends are blocked.
  assert.deepEqual(shouldSendReminder(row("day_before", moved), record, dayBefore.ts), { send: false, why: "result_marked" });
  assert.deepEqual(shouldSendReminder(row("same_day", moved), record, sameDay.ts), { send: false, why: "result_marked" });
  // Once staff clear the result, a future date is a real rebook again.
  assert.equal(syncDateAction(rec(moved, null), attendedCopy.ts + H), "arm");
});

// ---- emilio_noshow_ayer -----------------------------------------------------

test("fixture emilio_noshow_ayer: one same-day per date, 'hoy' (never 'ayer') on the class day, no duplicate d3", () => {
  const f = fixture("emilio_noshow_ayer");
  const sameDays = f.messages.filter((m) => m.body.includes("trial_reminder_same_day"));
  const second = sameDays[1]!; // Tue 10-06 06:01, the rebooked 7 am class
  const classTue = cdmxToEpoch(2026, 10, 6, 7, 0);
  assert.equal(cdmxDateStr(second.ts), cdmxDateStr(classTue));
  // The rebooked class's reminder is legit…
  assert.equal(shouldSendReminder(row("same_day", classTue), rec(classTue), second.ts).send, true);
  // …the ORIGINAL booking's same_day row (armed for Mon 10-05) cannot fire again
  // on Tuesday — the record moved, and it is not that class's day any more.
  const classMon = cdmxToEpoch(2026, 10, 5, 7, 0);
  assert.equal(shouldSendReminder(row("same_day", classMon), rec(classTue), second.ts).send, false);
  assert.equal(shouldSendReminder(row("same_day", classMon), undefined, second.ts).send, false);
  // and two rows for the same Tuesday share one claim key
  assert.equal(sameDaySentKey(f.phone, classTue), sameDaySentKey(f.phone, classTue - H));

  // The no-show touch: never before class + 2 h, and it says "hoy" on Tuesday.
  const prodNoShow = f.messages.find((m) => m.body.includes("no_show_followup"))!;
  const seq = computeNoShowSequence(classTue, classTue - DAY);
  const hoy = seq.find((s) => s.kind === "no_show_hoy")!;
  assert.equal(hoy.dueAt, classTue + NO_SHOW_DELAY);
  const c = fixtureContact(f);
  const body = noShowTouchCopy(c, "hoy", classTue, prodNoShow.ts);
  assert.ok(body.includes("hoy"), body);
  assert.ok(!/\bayer\b/.test(body), body);
  // Adult lead: singular copy, an ADULT slot only.
  assert.ok(body.includes("¿La reagendamos?"), body);
  // The chain: hoy, d2 (Thu 11:00), d7 (next Tue 11:00) — no second "ayer"
  // touch on Friday 10-09 and no kind twice.
  const kinds = seq.map((s) => s.kind);
  assert.deepEqual(kinds, ["no_show_hoy", "no_show_d2", "no_show_d7"]);
  assert.equal(new Set(kinds).size, kinds.length);
  const d2 = seq.find((s) => s.kind === "no_show_d2")!;
  assert.equal(d2.dueAt, cdmxToEpoch(2026, 10, 8, 11, 0));
  assert.ok(!seq.some((s) => cdmxDateStr(s.dueAt) === cdmxDateStr(f.messages.at(-1)!.ts)));
});

// ---- kids_noshow_bfc ----------------------------------------------------------

test("fixture kids_noshow_bfc: no-show touch not before class + 2 h; the slot proposed is a KIDS slot", () => {
  const f = fixture("kids_noshow_bfc");
  const c = fixtureContact(f);
  const satClass = cdmxToEpoch(2026, 10, 3, 11, 0); // 11 am–1 pm Saturday class
  const hoy = computeNoShowSequence(satClass, satClass - DAY).find((s) => s.kind === "no_show_hoy")!;
  assert.ok(hoy.dueAt >= satClass + 2 * H, "never during the class");
  assert.notEqual(hoy.dueAt, cdmxToEpoch(2026, 10, 3, 12, 1)); // the prod send time
  assert.equal(cdmxParts(hoy.dueAt).hour, 13);

  // Campaign "baby fight club", but the lead is a kid (audience kid): band kids.
  const band = bandForContact(c, f.campaign);
  assert.equal(band, "kids");
  const slot = bandSlot(c, f.campaign, band, hoy.dueAt)!;
  assert.ok(slot, "a kids slot exists");
  const grid = SLOTS.find((s) => s.weekday === slot.weekday && s.time === slot.time && s.discipline === slot.discipline && s.audience === "kid");
  assert.ok(grid && slotGroup(grid) === "kids", JSON.stringify(slot));
  const body = noShowTouchCopy(c, "hoy", satClass, hoy.dueAt, f.campaign);
  assert.ok(!/Baby Fight Club|bebé/i.test(body), body);
  assert.ok(body.includes("no pudieron llegar"), body); // plural, to the parent
});

// ---- band slots / copy inputs ----------------------------------------------------

test("bandSchedule: never an adult slot for a minor, never Kids for mini/baby", () => {
  for (const band of ["baby", "mini", "kids", "teens"] as const) {
    for (const s of bandSchedule(band)) assert.notEqual(slotGroup(s), "adult", band);
  }
  assert.ok(bandSchedule("mini").every((s) => slotGroup(s) === "mini" || s.discipline === "muay"));
  assert.ok(bandSchedule("mini").length > 0);
  assert.ok(bandSchedule("baby").every((s) => s.discipline === "baby"));
  assert.ok(bandSchedule("adults").every((s) => slotGroup(s) === "adult"));
});

test("bandSlot: mini proposes Mini Muay Thai, baby proposes Baby Fight Club, teens never Kids", () => {
  const now = cdmxToEpoch(2026, 10, 12, 9, 0); // Monday morning
  const mini = contact({ qualification: JSON.stringify({ child_age_months: 48 }) });
  const s1 = bandSlot(mini, "Baby Fight Club", "mini", now)!;
  assert.ok(SLOTS.some((s) => s.weekday === s1.weekday && s.time === s1.time && s.group === "mini"), JSON.stringify(s1));
  const baby = contact({ qualification: JSON.stringify({ child_age_months: 20 }) });
  assert.equal(bandSlot(baby, null, "baby", now)!.discipline, "baby");
  const teen = contact({ qualification: JSON.stringify({ child_age_months: 14 * 12 }) });
  const s3 = bandSlot(teen, null, "teens", now);
  if (s3) assert.ok(SLOTS.some((s) => s.weekday === s3.weekday && s.time === s3.time && s.group === "teens"));
});

test("bandForContact: stored age wins over the campaign name", () => {
  const four = contact({ qualification: JSON.stringify({ child_age_months: 50 }) });
  assert.equal(bandForContact(four, "Baby Fight Club"), "mini");
  assert.equal(bandForContact(contact({}), "Baby Fight Club"), "baby");
  assert.equal(bandForContact(contact({}), null), "adults");
});

test("nudge copy by band: a baby lead with no campaign gets baby copy (…0442), an adult never gets kids copy", () => {
  const now = cdmxToEpoch(2026, 10, 12, 9, 0);
  const baby = contact({ qualification: JSON.stringify({ child_age_months: 20 }) });
  const c = copyInputsForBand(baby, null, bandForContact(baby, null));
  const body = nudgeCopy(c.contact, "nudge_1h", c.campaignName, now, c.schedule);
  assert.ok(/bebé/.test(body), body);
  const adult = contact({ qualification: JSON.stringify({ program: "adults" }) });
  const a = copyInputsForBand(adult, "Kids promo", "adults");
  assert.equal(a.campaignName, null);
  const adultBody = nudgeCopy(a.contact, "nudge_1h", a.campaignName, now, a.schedule);
  assert.ok(!/peque|bebé/.test(adultBody), adultBody);
  // mini: kids wording ("tu peque"), never Baby Fight Club
  const mini = contact({ qualification: JSON.stringify({ child_age_months: 48 }) });
  const m = copyInputsForBand(mini, "Baby Fight Club", "mini");
  const miniBody = nudgeCopy(m.contact, "nudge_8h", m.campaignName, now, m.schedule);
  assert.ok(/peque/.test(miniBody) && !/Baby Fight Club/.test(miniBody), miniBody);
});

// ---- 4. nudges: marker + one-per-day claim -----------------------------------------

test("bookingMarkerLive: a booked class ahead blocks the drip; a past one or none does not", () => {
  const now = cdmxToEpoch(2026, 10, 8, 17, 0);
  const marker = (date: string, time: string) => JSON.stringify({ ts: now - DAY, trialDate: date, trialTime: time });
  assert.equal(bookingMarkerLive(marker("2026-10-08", "18:00"), now), true); // …6197: class in 1 h
  assert.equal(bookingMarkerLive(marker("2026-10-07", "18:00"), now), false);
  assert.equal(bookingMarkerLive(null, now), false);
  assert.equal(bookingMarkerLive(String(now - H), now), true); // legacy bare epoch, < 72h
  assert.equal(bookingMarkerLive(String(now - 4 * DAY), now), false);
});

test("nudgeDayClaimKey: one key per phone per CDMX day", () => {
  const a = cdmxToEpoch(2026, 10, 8, 9, 0);
  assert.equal(nudgeDayClaimKey("521", a), nudgeDayClaimKey("521", a + 10 * H));
  assert.notEqual(nudgeDayClaimKey("521", a), nudgeDayClaimKey("521", a + DAY));
});

test("processNudge: two nudges in the same minute → only the first one sends (claim before send)", async () => {
  const { raw, db } = sqliteDb();
  const now = Math.floor(Date.now() / 1000);
  insertContact(raw, contact({ last_inbound_at: now - H }));
  const sent: string[] = [];
  const deps = {
    async sendText(_e: Env, _p: string, body: string) {
      sent.push(body);
      return "wamid";
    },
    isWindowClosed: () => false,
  };
  const first = await processNudge(envWith(db), "5215512345678", "nudge_1h", deps);
  const second = await processNudge(envWith(db), "5215512345678", "nudge_8h", deps);
  assert.equal(first, "sent");
  assert.equal(second, "cancelled");
  assert.equal(sent.length, 1);
});

test("processNudge: a live booking marker cancels the nudge", async () => {
  const { raw, db } = sqliteDb();
  const now = Math.floor(Date.now() / 1000);
  insertContact(raw, contact({ last_inbound_at: now - H }));
  const p = cdmxParts(now + 3 * H);
  const pad = (n: number) => String(n).padStart(2, "0");
  raw
    .prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`)
    .run(
      "booking_recorded:5215512345678",
      JSON.stringify({ ts: now - H, trialDate: `${p.year}-${pad(p.month)}-${pad(p.day)}`, trialTime: `${pad(p.hour)}:${pad(p.minute)}` }),
    );
  let sent = 0;
  const res = await processNudge(envWith(db), "5215512345678", "nudge_1h", {
    async sendText() {
      sent++;
      return "w";
    },
    isWindowClosed: () => false,
  });
  assert.equal(res, "cancelled");
  assert.equal(sent, 0);
});

// ---- 5. no-show chain v2 ------------------------------------------------------------

test("computeNoShowSequence: class + 2 h, d2 and d7 at 11:00; a 8 pm class's first touch moves to 08:00", () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  assert.deepEqual(computeNoShowSequence(t, t - H), [
    { kind: "no_show_hoy", dueAt: t + 2 * H },
    { kind: "no_show_d2", dueAt: cdmxToEpoch(2026, 10, 8, 11, 0) },
    { kind: "no_show_d7", dueAt: cdmxToEpoch(2026, 10, 13, 11, 0) },
  ]);
  const late = cdmxToEpoch(2026, 10, 6, 20, 0);
  assert.equal(computeNoShowSequence(late, late)[0]!.dueAt, cdmxToEpoch(2026, 10, 7, 8, 0));
});

test("computeNoShowSequence: marked late keeps only what is ahead; the first touch drops once d2 is < 12 h away", () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  // marked the next morning: first touch still goes (day-aware copy), then d2/d7
  assert.deepEqual(
    computeNoShowSequence(t, cdmxToEpoch(2026, 10, 7, 9, 0)).map((s) => s.kind),
    ["no_show_hoy", "no_show_d2", "no_show_d7"],
  );
  // Wed 23:30 → d2 (Thu 11:00) is < 12 h away
  assert.deepEqual(
    computeNoShowSequence(t, cdmxToEpoch(2026, 10, 7, 23, 30)).map((s) => s.kind),
    ["no_show_d2", "no_show_d7"],
  );
  assert.deepEqual(computeNoShowSequence(t, cdmxToEpoch(2026, 10, 14, 9, 0)), []);
  assert.deepEqual(computeNoShowSequence(NaN, t), []);
});

test("dayWord: hoy / ayer / el sábado (and English)", () => {
  const sat = cdmxToEpoch(2026, 10, 3, 11, 0);
  assert.equal(dayWord(sat, sat + 2 * H, "es"), "hoy");
  assert.equal(dayWord(sat, sat + DAY, "es"), "ayer");
  assert.equal(dayWord(sat, sat + 2 * DAY, "es"), "el sábado");
  assert.equal(dayWord(sat, sat + 2 * DAY, "en"), "on Saturday");
  assert.equal(dayWord(sat, sat + DAY, "en"), "yesterday");
});

test("noShowRecordGate: only an empty Resultado or plain 'No asistió' passes", () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  assert.equal(noShowRecordGate(rec(t, null), t).send, true);
  assert.equal(noShowRecordGate(rec(t, "No asistió"), t).send, true);
  for (const r of ["Asistió", "Se inscribió", "No asistió, Reprogramó", "No asistió, Perdido"]) {
    assert.equal(noShowRecordGate(rec(t, r), t).send, false, r);
  }
  assert.equal(noShowRecordGate(rec(t + DAY), t).why, "moved");
  assert.equal(noShowRecordGate(rec(null), t).why, "date_cleared");
  assert.equal(noShowRecordGate(null, t).why, "record_gone");
});

test("chain notes + keys: per phone + date, round-trip, tolerant of the retry suffix", () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  assert.equal(chainKey("ns", t), "ns:2026-10-06");
  assert.equal(chainKey("pt", t), chainKey("pt", t + 3 * H)); // two kids, same day → one chain
  assert.deepEqual(decodeChainNote(encodeChainNote({ rec: "recA", trial: t }) + "|attempts:2"), { rec: "recA", trial: t });
  assert.deepEqual(decodeChainNote("ayer"), { rec: null, trial: null });
  assert.deepEqual(decodeChainNote(null), { rec: null, trial: null });
});

/** processPostTrial against real SQLite with fake senders. */
async function runChainRow(
  kind: "no_show_hoy" | "no_show_d2" | "no_show_d7" | "post_trial_d3" | "post_trial_d6",
  opts: {
    trial: number;
    now: number;
    record?: BookingRecord | null;
    windowClosed?: boolean;
    templateFails?: boolean;
    c?: Contact;
  },
) {
  const { raw, db } = sqliteDb();
  insertContact(raw, opts.c ?? contact({}));
  const sent: string[] = [];
  const armed: string[] = [];
  class Closed extends Error {}
  const res = await processPostTrial(
    envWith(db),
    {
      phone: "5215512345678",
      kind,
      created_at: opts.trial - DAY,
      note: encodeChainNote({ rec: "recA", trial: opts.trial }),
    },
    {
      async sendText(_e, _p, body) {
        if (opts.windowClosed) throw new Closed();
        sent.push(body);
        return "w";
      },
      async sendTemplate(_e, _p, name) {
        if (opts.templateFails) throw new Error("WA send failed (404) [132001]: template does not exist");
        sent.push(`[template:${name}]`);
        return "w";
      },
      templateName: (b, l) => `${b}_${l}`,
      isWindowClosed: (e) => e instanceof Closed,
      getRecord: async () => (opts.record === undefined ? rec(opts.trial) : opts.record),
      schedule: async (_e, input) => {
        armed.push(input.kind);
      },
    },
    opts.now,
  );
  return { res, sent, armed };
}

test("no_show_hoy: Resultado still empty → sends day-aware copy and hands over to d2 / d7", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const r = await runChainRow("no_show_hoy", { trial: t, now: t + 2 * H });
  assert.deepEqual(r.res, { outcome: "sent" });
  assert.ok(r.sent[0]!.includes("hoy"), r.sent[0]);
  assert.deepEqual(r.armed, ["no_show_d2", "no_show_d7"]);
});

test("no_show_hoy: the front desk marked Asistió (or moved the date) → nothing goes out, chain stops", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const attended = await runChainRow("no_show_hoy", { trial: t, now: t + 2 * H, record: rec(t, "Asistió") });
  assert.deepEqual(attended.res, { outcome: "cancelled", stopChain: true });
  assert.deepEqual(attended.sent, []);
  assert.deepEqual(attended.armed, []);
  const moved = await runChainRow("no_show_hoy", { trial: t, now: t + 2 * H, record: rec(t + 2 * DAY) });
  assert.deepEqual(moved.res, { outcome: "cancelled", stopChain: true });
});

test("no_show_hoy: window closed on the class day → no_show_hoy template with name + slot", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const r = await runChainRow("no_show_hoy", { trial: t, now: t + 2 * H, windowClosed: true });
  assert.deepEqual(r.res, { outcome: "sent" });
  assert.deepEqual(r.sent, ["[template:no_show_hoy_es]"]);
});

test("no_show_hoy: window closed the NEXT day → skipped silently (never a 'hoy'/'ayer' template on the wrong day)", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 18, 0);
  const r = await runChainRow("no_show_hoy", { trial: t, now: cdmxToEpoch(2026, 10, 7, 9, 0), windowClosed: true });
  assert.deepEqual(r.res, { outcome: "cancelled" });
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.armed, ["no_show_d2", "no_show_d7"], "the chain still continues");
});

test("no_show_d2: an unapproved template is skipped silently (no template_missing)", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const r = await runChainRow("no_show_d2", { trial: t, now: cdmxToEpoch(2026, 10, 8, 11, 0), windowClosed: true, templateFails: true });
  assert.deepEqual(r.res, { outcome: "cancelled" });
});

test("no_show_d7: the goodbye, then a Slack TASK to mark Perdido (the bot never writes it)", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const r = await runChainRow("no_show_d7", { trial: t, now: cdmxToEpoch(2026, 10, 13, 11, 0) });
  assert.equal(r.res.outcome, "sent");
  assert.ok("task" in r.res && r.res.task === "Marcar Perdido: Ana · 5215512345678", JSON.stringify(r.res));
  assert.ok(/última vez/.test(r.sent[0]!), r.sent[0]);
});

test("no-show chain: a reply from the lead since class start stops it", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const r = await runChainRow("no_show_hoy", { trial: t, now: t + 2 * H, c: contact({ last_inbound_at: t + H }) });
  assert.deepEqual(r.res, { outcome: "cancelled", stopChain: true });
  // …but "ok, ahí nos vemos" the night before does not
  const r2 = await runChainRow("no_show_hoy", { trial: t, now: t + 2 * H, c: contact({ last_inbound_at: t - 12 * H }) });
  assert.equal(r2.res.outcome, "sent");
});

// ---- 6. attended-not-enrolled v2 ------------------------------------------------------

test("post-trial copy per band: parents read '¿Cómo les fue?', adults stay singular; no adult text to parents", () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const now = t + 4 * H;
  const kid = contact({ qualification: JSON.stringify({ child_age_months: 7 * 12, child_name: "Leo" }) });
  const d0kid = postTrialCopy(kid, "post_trial_d0", null, false, { trialEpoch: t, now });
  assert.ok(d0kid.includes("¿Cómo les fue?") && d0kid.includes("Leo") && d0kid.includes("hoy"), d0kid);
  const d3kid = postTrialCopy(kid, "post_trial_d3", null, false, { trialEpoch: t, now: cdmxToEpoch(2026, 10, 9, 11, 0) });
  assert.ok(!/amaneció el cuerpo/.test(d3kid) && /Les gustaría/.test(d3kid), d3kid);
  const adult = contact({});
  const d3 = postTrialCopy(adult, "post_trial_d3", null, false, { trialEpoch: t, now: cdmxToEpoch(2026, 10, 9, 11, 0) });
  assert.ok(/Te gustaría/.test(d3), d3);
  const en = postTrialCopy(contact({ lang: "en", qualification: JSON.stringify({ child_age_months: 30 }) }), "post_trial_d6", null, false, { trialEpoch: t, now });
  assert.ok(/your baby/.test(en), en);
});

test("post_trial_d3 / d6: free-form in window; unknown template skipped silently", async () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  const ok = await runChainRow("post_trial_d3", { trial: t, now: cdmxToEpoch(2026, 10, 9, 11, 0) });
  assert.equal(ok.res.outcome, "sent");
  const skipped = await runChainRow("post_trial_d6", {
    trial: t,
    now: cdmxToEpoch(2026, 10, 12, 11, 0),
    windowClosed: true,
    templateFails: true,
  });
  assert.deepEqual(skipped.res, { outcome: "cancelled" });
  const tpl = await runChainRow("post_trial_d6", {
    trial: t,
    now: cdmxToEpoch(2026, 10, 12, 11, 0),
    windowClosed: true,
    c: contact({ qualification: JSON.stringify({ child_age_months: 90 }) }),
  });
  assert.deepEqual(tpl.sent, ["[template:post_trial_d6_fam_es]"]);
});

test("computePostTrialSequence v2: d0 same evening, d3 / d6 at 11:00", () => {
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  assert.deepEqual(
    computePostTrialSequence(t, t + H).map((s) => [s.kind, s.dueAt]),
    [
      ["post_trial_d0", cdmxToEpoch(2026, 10, 6, 14, 30)],
      ["post_trial_d3", cdmxToEpoch(2026, 10, 9, 11, 0)],
      ["post_trial_d6", cdmxToEpoch(2026, 10, 12, 11, 0)],
    ],
  );
});

// ---- SQL: per-phone dedupe, note re-arm, record cancellation ---------------------------

test("SQL: two Airtable rows for one mother arm ONE chain (UNIQUE on phone + kind + date key)", async () => {
  const { raw, db } = sqliteDb();
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  for (const recId of ["recKid1", "recKid2"]) {
    for (const s of computePostTrialSequence(t, t + H)) {
      raw
        .prepare(
          `INSERT OR IGNORE INTO followups(phone, kind, due_at, status, airtable_record_id, note, created_at) VALUES(?, ?, ?, 'scheduled', ?, ?, 0)`,
        )
        .run("521", s.kind, s.dueAt, chainKey("pt", t), encodeChainNote({ rec: recId, trial: t }));
    }
  }
  assert.equal(rows(raw).length, 3);
  void db;
});

test("SQL: rescheduleFollowup re-notes a moved class without reviving a SENT reminder", async () => {
  const { raw, db } = sqliteDb();
  const t1 = cdmxToEpoch(2026, 10, 6, 19, 0);
  const t2 = cdmxToEpoch(2026, 10, 6, 20, 0); // same day, later hour → same day_before slot
  const due = cdmxToEpoch(2026, 10, 5, 18, 0);
  await rescheduleFollowup(db, { phone: "521", kind: "day_before", dueAt: due, airtableRecordId: "recA", note: reminderNote(t1) });
  raw.prepare(`UPDATE followups SET status = 'sent', note = note || '|attempts:1'`).run();
  // same class again (retry suffix on the stored note) → untouched
  await rescheduleFollowup(db, { phone: "521", kind: "day_before", dueAt: due, airtableRecordId: "recA", note: reminderNote(t1) });
  assert.equal(rows(raw)[0]!.note, `${reminderNote(t1)}|attempts:1`);
  // moved to 8 pm: note follows, status stays sent (no second "mañana")
  await rescheduleFollowup(db, { phone: "521", kind: "day_before", dueAt: due, airtableRecordId: "recA", note: reminderNote(t2) });
  assert.deepEqual([rows(raw)[0]!.status, rows(raw)[0]!.note], ["sent", reminderNote(t2)]);
  // moved to another day: re-armed
  await rescheduleFollowup(db, { phone: "521", kind: "day_before", dueAt: due + DAY, airtableRecordId: "recA", note: reminderNote(t2 + DAY) });
  assert.equal(rows(raw)[0]!.status, "scheduled");
});

test("SQL: cancelReminderRowsForRecord retires that record's reminders (+#n rows) and, on request, its no-show touch", async () => {
  const { raw, db } = sqliteDb();
  const t = cdmxToEpoch(2026, 10, 6, 11, 0);
  await scheduleTrialSequence(envWith(db), "521", "recA", new Date(t * 1000).toISOString(), {
    includeConfirm: false,
    nowEpoch: t - 3 * DAY,
  });
  await scheduleTrialSequence(envWith(db), "521", "recA#1", new Date(t * 1000).toISOString(), {
    includeConfirm: false,
    nowEpoch: t - 3 * DAY,
  });
  raw
    .prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id, note, created_at) VALUES('521', 'day_before', 1, 'scheduled', 'recOTHER', NULL, 0)`)
    .run();
  const before = rows(raw).filter((r) => r.status === "scheduled").map((r) => `${r.kind}@${r.airtable_record_id}`);
  assert.deepEqual(before.sort(), [
    "day_before@recA",
    "day_before@recA#1",
    "day_before@recOTHER",
    "no_show_hoy@ns:2026-10-06",
    "same_day@recA",
    "same_day@recA#1",
  ].sort());
  await cancelReminderRowsForRecord(db, "521", "recA", false);
  const mid = rows(raw).filter((r) => r.status === "scheduled").map((r) => `${r.kind}@${r.airtable_record_id}`);
  assert.deepEqual(mid.sort(), ["day_before@recOTHER", "no_show_hoy@ns:2026-10-06"]);
  await cancelReminderRowsForRecord(db, "521", "recA", true);
  assert.deepEqual(
    rows(raw).filter((r) => r.status === "scheduled").map((r) => r.kind),
    ["day_before"],
  );
});

// ---- 8. booking recon repeats until resolved ------------------------------------------

test("booking recon: an unbacked claim repeats daily until its class day is well past, and names the slot", () => {
  const now = cdmxToEpoch(2026, 10, 9, 10, 0);
  const m = { phone: "521", ts: now - 3 * DAY, snippet: "x", claimedDate: "2026-10-10", claimedTime: "14:00" };
  assert.equal(stillActionable(m, now), true);
  assert.equal(stillActionable(m, cdmxToEpoch(2026, 10, 11, 10, 0)), true);
  assert.equal(stillActionable(m, cdmxToEpoch(2026, 10, 12, 10, 0)), false);
  assert.equal(stillActionable({ phone: "521", ts: now - 8 * DAY, snippet: "x" }, now), false);
  assert.equal(slotLabel(m), "sáb 2026-10-10 14:00");
  assert.equal(slotLabel({}), "");
});
