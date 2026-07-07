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
import { cancelFollowupsByKinds, getCampaign } from "../db/queries-admin.js";
import {
  sendText,
  sendTemplate,
  sendBookingVideo,
  WindowClosedError,
} from "../services/wa.js";
import type { CronSlackDeps } from "./deps.js";
import {
  clampToWindow,
  cdmxToEpoch,
  cdmxParts,
  cdmxDateStr,
  cdmxIso,
  DAY,
} from "./time.js";
import { isQuietHour, next8am } from "./quiet.js";
import {
  listRecentBookings,
  listStudents,
  normalizeMxPhone,
  classifyResult,
  type BookingRecord,
} from "../services/airtable.js";
import {
  processNudge,
  processExtendedNudge,
  maybeArmExtended,
  ALL_NUDGE_KINDS,
  type NudgeKind,
  type ExtendedKind,
} from "./nudges.js";
import { CLIENT } from "../client.gen.js";
import { renderCopy } from "../client-config.js";

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
      // Quiet-hour re-check: if cron drift fired this inside 21:30–08:00, push to
      // the next 08:00 rather than sending an unsolicited message.
      if (isQuietHour(nowSec())) {
        await rescheduleRow(env, f, next8am(nowSec()));
        return;
      }
      // Lead-nudge drip. processNudge re-verifies eligibility at send time,
      // sends the free-form nudge, and bumps the rolling cap. Nudges are always
      // in-window by construction; a closed window → cancel (no template).
      const status = await processNudge(env, f.phone, f.kind as NudgeKind, {
        sendText,
        isWindowClosed: (err) => err instanceof WindowClosedError,
      });
      await markFollowup(env.DB, f.id, status);
      // Nudge 3 actually landed → arm the extended chain (d2–d5) off its real
      // send time, once per lead per 30 days.
      if (f.kind === "nudge_8h" && status === "sent") {
        await maybeArmExtended(env, f.phone, nowSec());
      }
      return;
    }

    case "nudge_d2":
    case "nudge_d3":
    case "nudge_d4":
    case "nudge_d5": {
      // Extended drip. Quiet re-check first, then free-form-first / template-
      // fallback. A missing/unapproved template → skip + one throttled Slack note.
      if (isQuietHour(nowSec())) {
        await rescheduleRow(env, f, next8am(nowSec()));
        return;
      }
      const res = await processExtendedNudge(env, f.phone, f.kind as ExtendedKind, {
        sendText,
        sendTemplate,
        templateName: tpl,
        isWindowClosed: (err) => err instanceof WindowClosedError,
        campaignName: async (e, id) => (await getCampaign(e.DB, id))?.name ?? null,
      });
      if (res.outcome === "template_missing") {
        await noteTemplateMissing(env, deps, f.phone, res.template);
        await markFollowup(env.DB, f.id, "cancelled");
      } else {
        await markFollowup(env.DB, f.id, res.outcome);
      }
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

/** trial_confirm: warm free-form text (address + what to bring); fallback template.
 *  After the confirmation lands, fire the booking video (best-effort; R4). */
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
      await sendBookingVideo(env, phone); // after the template confirmation
      return;
    }
    throw err;
  }
  await sendBookingVideo(env, phone); // after the free-form confirmation
}

/**
 * Post at most ONE Slack note per CDMX day about a missing/unapproved extended-
 * drip template (kv `tmpl_missing_note:<YYYY-MM-DD>`). The send was skipped.
 */
async function noteTemplateMissing(
  env: Env,
  deps: { slack: CronSlackDeps },
  phone: string,
  template: string,
): Promise<void> {
  const dayKey = `tmpl_missing_note:${cdmxDateStr(nowSec())}`;
  if (await kvGet(env.DB, dayKey)) return;
  await kvSet(env.DB, dayKey, "1");
  await deps.slack.postNote(
    `Plantilla de seguimiento extendido no disponible (${template}); se omitió un envío a ${phone}. Falta enviar las plantillas d2–d5 a Meta (ver docs/templates.md).`,
  );
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
        await cancelFollowupsByKinds(env.DB, phone, ALL_NUDGE_KINDS);
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
    const link = CLIENT.links.booking;
    const body = renderCopy(
      lang === "en" ? CLIENT.copy.noShowEn : CLIENT.copy.noShowEs,
      { who, link },
    );
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
    const body = renderCopy(
      lang === "en" ? CLIENT.copy.welcomeEn : CLIENT.copy.welcomeEs,
      { who, link: CLIENT.links.schedule },
    );
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

function confirmText(name: string, lang: string): string {
  const who = name ? ` ${name}` : "";
  return renderCopy(lang === "en" ? CLIENT.copy.confirmEn : CLIENT.copy.confirmEs, {
    who,
    address: CLIENT.address,
  });
}

function customText(note: string | null, lang: string): string {
  const n = (note ?? "").trim();
  if (n) return n;
  return lang === "en" ? CLIENT.copy.checkinEn : CLIENT.copy.checkinEs;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// re-export for the dispatcher/tests
export { cdmxIso };
