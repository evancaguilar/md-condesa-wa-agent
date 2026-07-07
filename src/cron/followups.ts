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
  cancelFollowups,
} from "../db/queries.js";
import { cancelFollowupsByKinds } from "../db/queries-admin.js";
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
  classifyResult,
  type BookingRecord,
} from "../services/airtable.js";
import { processNudge, NUDGE_KINDS, type NudgeKind } from "./nudges.js";

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

    case "nudge_1h":
    case "nudge_6h":
    case "nudge_8h": {
      // Lead-nudge drip. processNudge re-verifies eligibility at send time,
      // sends the free-form nudge, and bumps the rolling cap. Nudges are always
      // in-window by construction; a closed window → cancel (no template).
      const status = await processNudge(env, f.phone, f.kind as NudgeKind, {
        sendText,
        isWindowClosed: (err) => err instanceof WindowClosedError,
      });
      await markFollowup(env.DB, f.id, status);
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
 * Booking sync (runs every ~15 min via the dispatcher gate). Reads records
 * modified since the kv cursor. For each record with a phone:
 *  - future Trial DateTime → upsert contact, schedule the trial sequence
 *    (idempotent via the UNIQUE constraint), and CANCEL the lead-nudge drip so a
 *    link-booker never gets the drip (F2). WhatsApp-sourced records were already
 *    scheduled by bookTrial — re-processing is a no-op.
 *  - a `Resultado clase prueba` value → run the F4 result watcher (no-show /
 *    enrolled), acting once per record+value.
 */
export async function syncBookings(
  env: Env,
  airtable: {
    listRecentBookings: (env: Env, sinceIso: string) => Promise<BookingRecord[]>;
  } = { listRecentBookings },
  deps: { slack: Pick<CronSlackDeps, "postNote"> } = {
    slack: {
      async postNote(text: string): Promise<void> {
        console.log(`[syncBookings] ${text}`);
      },
    },
  },
): Promise<number> {
  const cursor =
    (await kvGet(env.DB, "airtable_sync_cursor")) ??
    new Date((nowSec() - 2 * 3600) * 1000).toISOString();
  const records = await airtable.listRecentBookings(env, cursor);
  let scheduled = 0;
  for (const rec of records) {
    if (!rec.phone) continue;
    const phone = normalizeMxPhone(rec.phone);

    // Future booking → schedule the sequence and kill the drip.
    if (rec.trialDateTimeIso) {
      const trialEpoch = Math.floor(Date.parse(rec.trialDateTimeIso) / 1000);
      if (Number.isFinite(trialEpoch) && trialEpoch > nowSec()) {
        await upsertContact(env.DB, { phone, name: rec.name ?? null });
        await scheduleTrialSequence(env, phone, rec.id, rec.trialDateTimeIso);
        await cancelFollowupsByKinds(env.DB, phone, NUDGE_KINDS);
        scheduled++;
      }
    }

    // Result watcher (independent of the trial datetime).
    if (rec.result) {
      await processResult(env, deps, rec.id, phone, rec.result, rec.name ?? null);
    }
  }
  await kvSet(env.DB, "airtable_sync_cursor", new Date(nowSec() * 1000).toISOString());
  return scheduled;
}

/**
 * F4 result watcher for one record. Acts ONCE per record+normalized-value via
 * kv `resultado:<recordId>`:
 *  - "no asistio"  → cancel ALL pending followups, send a warm reschedule
 *    (free-form if window open, else no_show_followup template; failure → Slack).
 *  - "se inscribio" → set status=student, cancel ALL pending followups, send a
 *    warm welcome (free-form if window open, else human_followup template
 *    fallback; failure → Slack).
 */
async function processResult(
  env: Env,
  deps: { slack: Pick<CronSlackDeps, "postNote"> },
  recordId: string,
  phone: string,
  rawResult: string,
  name: string | null,
): Promise<void> {
  const action = classifyResult(rawResult);
  if (!action) return;

  const kvKey = `resultado:${recordId}`;
  const already = await kvGet(env.DB, kvKey);
  const marker = `${action}`;
  if (already === marker) return; // acted on this record+value already

  await upsertContact(env.DB, { phone, name });
  const contact = await getContact(env.DB, phone);
  const lang = contact?.lang ?? "es";
  const who = name ? ` ${name.split(/\s+/)[0] ?? ""}` : "";

  if (action === "no_show") {
    await cancelFollowups(env.DB, phone); // all kinds
    const link = "https://mdcondesa.com/clase-prueba-adultos/";
    const body =
      lang === "en"
        ? `Hi${who}! We missed you at your trial class 🥋 No worries — want to reschedule? You can pick a new time here: ${link}`
        : `¡Hola${who}! Te esperábamos en tu clase de prueba 🥋 No pasa nada, ¿la reagendamos? Elige otro horario aquí: ${link}`;
    try {
      await sendText(env, phone, body);
    } catch (err) {
      if (err instanceof WindowClosedError) {
        try {
          await sendTemplate(env, phone, tpl("no_show_followup", lang), lang, [
            bodyParams([name ?? ""]),
          ]);
        } catch (tErr) {
          await deps.slack.postNote(
            `No pude enviar reagenda a ${phone} (plantilla no_show_followup falló): ${String(tErr)}`,
          );
        }
      } else {
        throw err;
      }
    }
  } else {
    // enrolled
    await setContactStatus(env.DB, phone, "student");
    await cancelFollowups(env.DB, phone); // all kinds; student stops marketing
    const scheduleLink = "https://mdcondesa.com/#horarios";
    const body =
      lang === "en"
        ? `Welcome to the family${who}! 🥋🎉 So glad you joined. Next: check the schedule (${scheduleLink}) and remember there's a 10% discount when you sign up as a team. See you on the mats!`
        : `¡Bienvenid@ a la familia${who}! 🥋🎉 Nos da mucho gusto tenerte. Lo que sigue: revisa los horarios (${scheduleLink}) y recuerda que hay 10% de descuento si te inscribes en equipo. ¡Nos vemos en el tatami!`;
    try {
      await sendText(env, phone, body);
    } catch (err) {
      if (err instanceof WindowClosedError) {
        try {
          await sendTemplate(env, phone, tpl("human_followup", lang), lang, [
            bodyParams([name ?? ""]),
          ]);
        } catch (tErr) {
          await deps.slack.postNote(
            `No pude enviar bienvenida a ${phone} (plantilla human_followup falló): ${String(tErr)}`,
          );
        }
      } else {
        throw err;
      }
    }
  }

  await kvSet(env.DB, kvKey, marker);
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
