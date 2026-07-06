// Anti-no-show + re-engagement engine: pure scheduling (scheduleTrialSequence)
// plus the tick processor (runDueFollowups) and Airtable syncs.
//
// FollowupKind lacks a dedicated "attendance_check" member, so the T+3h Slack
// attendance prompt rides on kind='custom' with note='attendance_check'. See
// docs/notes-d.md — E may promote it to a first-class kind later.

import type { Env, Followup } from "../types.js";
import {
  scheduleFollowup,
  markFollowup,
  dueFollowups,
  kvGet,
  kvSet,
  getContact,
  upsertContact,
  setContactStatus,
} from "../db/queries.js";
import { sendText, sendTemplate, WindowClosedError } from "../services/wa.js";
import type { CronSlackDeps } from "./deps.js";
import {
  clampToWindow,
  cdmxToEpoch,
  cdmxParts,
  cdmxIso,
  DAY,
} from "./time.js";
import {
  listRecentBookings,
  listStudents,
  normalizeMxPhone,
  type BookingRecord,
} from "../services/airtable.js";

const ATTENDANCE_NOTE = "attendance_check";
const MAX_SEND_ATTEMPTS = 3;

// ---- scheduling ----

export interface SequenceStep {
  kind: Followup["kind"];
  dueAt: number; // epoch seconds, already clamped to 09:00–21:00 CDMX
  note?: string;
}

/**
 * Pure computation of the followup sequence for a trial at `trialEpoch`
 * (epoch seconds). Sends are clamped to the 09:00–21:00 CDMX window. Exposed
 * for unit testing; scheduleTrialSequence persists the result.
 */
export function computeTrialSequence(trialEpoch: number): SequenceStep[] {
  const p = cdmxParts(trialEpoch);
  // day-before at 18:00 CDMX
  const dayBefore = cdmxToEpoch(p.year, p.month, p.day, 18, 0, 0) - DAY;
  const steps: SequenceStep[] = [
    { kind: "trial_confirm", dueAt: clampToWindow(trialEpoch) },
    { kind: "day_before", dueAt: clampToWindow(dayBefore) },
    { kind: "same_day", dueAt: clampToWindow(trialEpoch - 4 * 3600) },
    {
      kind: "attendance_check",
      dueAt: clampToWindow(trialEpoch + 3 * 3600),
      note: ATTENDANCE_NOTE,
    },
  ];
  return steps;
}

/** Idempotently schedules the full anti-no-show sequence for a booking. */
export async function scheduleTrialSequence(
  env: Env,
  phone: string,
  recordId: string,
  trialDateTimeIso: string,
): Promise<void> {
  const trialEpoch = Math.floor(Date.parse(trialDateTimeIso) / 1000);
  if (!Number.isFinite(trialEpoch)) return;
  for (const step of computeTrialSequence(trialEpoch)) {
    await scheduleFollowup(env.DB, {
      phone,
      kind: step.kind,
      dueAt: step.dueAt,
      airtableRecordId: recordId,
      note: step.note ?? null,
    });
  }
}

// ---- attempt tracking (in the note field: "...|attempts:N") ----

function readAttempts(note: string | null): number {
  const m = /attempts:(\d+)/.exec(note ?? "");
  return m ? Number(m[1]) : 0;
}

async function bumpAttempts(
  env: Env,
  f: Followup,
): Promise<number> {
  const n = readAttempts(f.note) + 1;
  const base = (f.note ?? "").replace(/\s*\|?attempts:\d+/, "");
  const note = base ? `${base}|attempts:${n}` : `attempts:${n}`;
  await env.DB.prepare(`UPDATE followups SET note = ?2 WHERE id = ?1`)
    .bind(f.id, note)
    .run();
  return n;
}

// ---- tick processing ----

/**
 * Process everything due now. Each followup is dispatched by kind; every send
 * failure re-arms the row as 'scheduled' for one retry next tick, and gives up
 * (status 'cancelled') after MAX_SEND_ATTEMPTS.
 */
export async function runDueFollowups(
  env: Env,
  deps: { slack: CronSlackDeps },
): Promise<void> {
  const due = await dueFollowups(env.DB);
  for (const f of due) {
    try {
      await processOne(env, deps, f);
    } catch (err) {
      await handleSendFailure(env, f, err);
    }
  }
}

async function processOne(
  env: Env,
  deps: { slack: CronSlackDeps },
  f: Followup,
): Promise<void> {
  const contact = await getContact(env.DB, f.phone);
  if (contact?.status === "opted_out") {
    await markFollowup(env.DB, f.id, "skipped_optout");
    return;
  }
  const lang = contact?.lang ?? "es";
  const name = contact?.name ?? "";
  const recordId = f.airtable_record_id ?? "";

  switch (f.kind) {
    case "trial_confirm":
      await sendTrialConfirm(env, f.phone, name, lang);
      await markFollowup(env.DB, f.id, "sent");
      return;

    case "day_before":
      await sendTemplate(env, f.phone, tpl("trial_reminder_day_before", lang), lang, [
        bodyParams([name]),
      ]);
      await markFollowup(env.DB, f.id, "sent");
      return;

    case "same_day":
      await sendTemplate(env, f.phone, tpl("trial_reminder_same_day", lang), lang, [
        bodyParams([name]),
      ]);
      await markFollowup(env.DB, f.id, "sent");
      return;

    case "attendance_check":
      await deps.slack.postAttendanceCheck({ phone: f.phone, name, recordId });
      await markFollowup(env.DB, f.id, "sent");
      return;

    case "custom":
      // generic custom follow-up (set_followup): warm text if in-window, else
      // skip quietly. Legacy rows may still carry the attendance note.
      if (f.note?.startsWith(ATTENDANCE_NOTE)) {
        await deps.slack.postAttendanceCheck({ phone: f.phone, name, recordId });
      } else {
        await tryText(env, f.phone, customText(f.note, lang));
      }
      await markFollowup(env.DB, f.id, "sent");
      return;

    case "no_show_1": {
      const att = await kvGet(env.DB, `attendance:${recordId}`);
      if (att === "yes") {
        await markFollowup(env.DB, f.id, "cancelled");
        return;
      }
      if (att === "no") {
        await sendTemplate(env, f.phone, tpl("no_show_followup", lang), lang, [
          bodyParams([name]),
        ]);
        await markFollowup(env.DB, f.id, "sent");
        return;
      }
      // absent attendance signal → reschedule once (+12h), then give up
      if (readAttempts(f.note) >= 1) {
        await markFollowup(env.DB, f.id, "cancelled");
        return;
      }
      await bumpAttempts(env, f);
      await rescheduleRow(env, f, clampToWindow(nowSec() + 12 * 3600));
      return;
    }

    case "reengage_7d":
      // Skip re-engagement if the contact wrote back after this row was created
      // (they're no longer cold). The row is created when the no-show is
      // detected, so last_inbound_at > created_at means an inbound since then.
      if ((contact?.last_inbound_at ?? 0) > f.created_at) {
        await markFollowup(env.DB, f.id, "cancelled");
        return;
      }
      await sendTemplate(env, f.phone, tpl("reengage_lead", lang), lang, [
        bodyParams([name]),
      ]);
      await markFollowup(env.DB, f.id, "sent");
      return;

    default:
      await markFollowup(env.DB, f.id, "cancelled");
  }
}

/** trial_confirm: warm free-form text (address + what to bring); fallback template. */
async function sendTrialConfirm(
  env: Env,
  phone: string,
  name: string,
  lang: string,
): Promise<void> {
  const text = confirmText(name, lang);
  try {
    await sendText(env, phone, text);
  } catch (err) {
    if (err instanceof WindowClosedError) {
      await sendTemplate(env, phone, tpl("trial_confirm", lang), lang, [
        bodyParams([name]),
      ]);
      return;
    }
    throw err;
  }
}

async function tryText(env: Env, phone: string, body: string): Promise<void> {
  try {
    await sendText(env, phone, body);
  } catch (err) {
    if (err instanceof WindowClosedError) return; // no template for generic custom
    throw err;
  }
}

async function handleSendFailure(
  env: Env,
  f: Followup,
  err: unknown,
): Promise<void> {
  const attempts = await bumpAttempts(env, f);
  if (attempts >= MAX_SEND_ATTEMPTS) {
    await markFollowup(env.DB, f.id, "cancelled");
    console.error(
      `[followups] giving up on #${f.id} (${f.kind}) after ${attempts} attempts: ${String(err)}`,
    );
  } else {
    // leave status 'scheduled' → retried next tick
    console.warn(
      `[followups] send failed #${f.id} (${f.kind}) attempt ${attempts}: ${String(err)}`,
    );
  }
}

async function rescheduleRow(
  env: Env,
  f: Followup,
  dueAt: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE followups SET due_at = ?2, status = 'scheduled' WHERE id = ?1`,
  )
    .bind(f.id, dueAt)
    .run();
}

// ---- Airtable syncs ----

/**
 * Hourly booking sync. Reads records modified since the kv cursor; for each with
 * a future Trial DateTime and a phone, upserts the contact and schedules the
 * trial sequence (idempotent via the followups UNIQUE constraint). WhatsApp-
 * sourced records were already scheduled by bookTrial — re-processing is a no-op.
 */
export async function syncBookings(
  env: Env,
  airtable: {
    listRecentBookings: (env: Env, sinceIso: string) => Promise<BookingRecord[]>;
  } = { listRecentBookings },
): Promise<number> {
  const cursor =
    (await kvGet(env.DB, "airtable_sync_cursor")) ??
    new Date((nowSec() - 2 * 3600) * 1000).toISOString();
  const records = await airtable.listRecentBookings(env, cursor);
  let scheduled = 0;
  for (const rec of records) {
    if (!rec.phone || !rec.trialDateTimeIso) continue;
    const trialEpoch = Math.floor(Date.parse(rec.trialDateTimeIso) / 1000);
    if (!Number.isFinite(trialEpoch) || trialEpoch <= nowSec()) continue;
    const phone = normalizeMxPhone(rec.phone);
    await upsertContact(env.DB, { phone, name: rec.name ?? null });
    await scheduleTrialSequence(env, phone, rec.id, rec.trialDateTimeIso);
    scheduled++;
  }
  await kvSet(env.DB, "airtable_sync_cursor", new Date(nowSec() * 1000).toISOString());
  return scheduled;
}

/**
 * Daily student sync. Marks matching contacts status='student' so the lead line
 * stays silent for known students.
 */
export async function syncStudents(
  env: Env,
  airtable: { listStudents: (env: Env) => Promise<{ phone: string | null }[]> } = {
    listStudents,
  },
): Promise<number> {
  const students = await airtable.listStudents(env);
  let marked = 0;
  for (const s of students) {
    if (!s.phone) continue;
    const phone = normalizeMxPhone(s.phone);
    const existing = await getContact(env.DB, phone);
    if (existing && existing.status !== "student") {
      await setContactStatus(env.DB, phone, "student");
      marked++;
    }
  }
  return marked;
}

// ---- template + copy helpers ----

// Template names carry the language suffix Meta requires (one template per lang).
function tpl(base: string, lang: string): string {
  return lang === "en" ? `${base}_en` : `${base}_es`;
}

function bodyParams(values: string[]): {
  type: "body";
  parameters: { type: "text"; text: string }[];
} {
  return {
    type: "body",
    parameters: values.map((text) => ({ type: "text" as const, text: text || "" })),
  };
}

const ADDRESS = "Av. México 49, 1º piso, Condesa";

function confirmText(name: string, lang: string): string {
  const who = name ? ` ${name}` : "";
  if (lang === "en") {
    return `Hi${who}! 🥋 Your trial class is booked. We're at ${ADDRESS}. Bring comfortable clothes and a water bottle — no gear needed, we lend it. See you soon!`;
  }
  return `¡Hola${who}! 🥋 Tu clase de prueba quedó agendada. Estamos en ${ADDRESS}. Trae ropa cómoda y una botella de agua — no necesitas equipo, nosotros te lo prestamos. ¡Nos vemos!`;
}

function customText(note: string | null, lang: string): string {
  const n = (note ?? "").trim();
  if (n) return n;
  return lang === "en"
    ? "Hi! Just checking in from MD Condesa 🥋"
    : "¡Hola! Te escribimos de MD Condesa 🥋";
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// re-export for the dispatcher/tests
export { cdmxIso };
