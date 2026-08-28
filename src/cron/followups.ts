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
  phoneForRecordId,
  kvSet,
  kvDelete,
  getContact,
  upsertContact,
  setContactStatus,
  cancelFollowups,
  lastBotMessage,
} from "../db/queries.js";
import {
  bookingRecordedKey,
  parseBookingRecordedMarker,
} from "../services/booking-core.js";
import { cancelFollowupsByKinds, getCampaign } from "../db/queries-admin.js";
import {
  sendText,
  sendTemplate,
  sendBookingVideo,
  WindowClosedError,
} from "../services/send.js";
import { channelOf, displayContact } from "../services/channel.js";
import type { CronSlackDeps } from "./deps.js";
import {
  clampToWindow,
  cdmxToEpoch,
  cdmxParts,
  cdmxDateStr,
  cdmxIso,
  DAY,
} from "./time.js";
import { isQuietHour, next8am, shiftOutOfQuiet } from "./quiet.js";
import { greetingName } from "./display-name.js";
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
  gateOnOpenQuestion,
  ALL_NUDGE_KINDS,
  type NudgeKind,
  type ExtendedKind,
} from "./nudges.js";
import { parseStaffLaterNote, sendStaffText, staffSendClaimKey } from "../services/staff-send.js";
import { auditHumanSend } from "../services/booking-guard.js";
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

export interface SequenceOpts {
  /** When the booking was detected (epoch s). trial_confirm fires here, not at
   *  class time. Defaults to now. */
  nowEpoch?: number;
  /** false for chat bookings — the bot already confirmed inline. */
  includeConfirm?: boolean;
}

/**
 * Pure computation of the followup sequence for a trial at `trialEpoch`
 * (epoch seconds). Sends are clamped to the 09:00–21:00 CDMX window. Exposed
 * for unit testing; scheduleTrialSequence persists the result.
 */
export function computeTrialSequence(
  trialEpoch: number,
  opts: SequenceOpts = {},
): SequenceStep[] {
  const p = cdmxParts(trialEpoch);
  // day-before at 18:00 CDMX
  const dayBefore = cdmxToEpoch(p.year, p.month, p.day, 18, 0, 0) - DAY;
  const steps: SequenceStep[] = [];
  if (opts.includeConfirm !== false) {
    steps.push({
      kind: "trial_confirm",
      dueAt: clampToWindow(opts.nowEpoch ?? nowSec()),
    });
  }
  steps.push(
    { kind: "day_before", dueAt: clampToWindow(dayBefore) },
    { kind: "same_day", dueAt: clampToWindow(trialEpoch - 4 * 3600) },
    {
      kind: "attendance_check",
      dueAt: clampToWindow(trialEpoch + 3 * 3600),
      note: ATTENDANCE_NOTE,
    },
  );
  return steps;
}

/** Idempotently schedules the full anti-no-show sequence for a booking. */
export async function scheduleTrialSequence(
  env: Env,
  phone: string,
  recordId: string,
  trialDateTimeIso: string,
  opts: SequenceOpts = {},
): Promise<void> {
  const trialEpoch = Math.floor(Date.parse(trialDateTimeIso) / 1000);
  if (!Number.isFinite(trialEpoch)) return;
  for (const step of computeTrialSequence(trialEpoch, opts)) {
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

// End-anchored: staff_later notes carry free staff text that may itself
// contain "attempts:N" — only the suffix bumpAttempts appends may ever match.
function readAttempts(note: string | null): number {
  const m = /\|?attempts:(\d+)$/.exec(note ?? "");
  return m ? Number(m[1]) : 0;
}

async function bumpAttempts(
  env: Env,
  f: Followup,
): Promise<number> {
  const n = readAttempts(f.note) + 1;
  const base = (f.note ?? "").replace(/\s*\|?attempts:\d+$/, "");
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
  // Same guard as the nudges: a WhatsApp push name that isn't clearly a first
  // name (email, handle, fancy font) must never be greeted by name.
  const name = greetingName(contact?.name);
  const recordId = f.airtable_record_id ?? "";

  switch (f.kind) {
    case "trial_confirm":
      await sendTrialConfirm(env, f.phone, name, lang);
      await markFollowup(env.DB, f.id, "sent");
      return;

    case "day_before": {
      const outcome = await sendReminder(env, deps, f.phone, {
        template: "trial_reminder_day_before",
        lang,
        params: [name],
        freeform: messengerReminderText("day_before", name, lang),
      });
      await markFollowup(env.DB, f.id, outcome);
      return;
    }

    case "same_day": {
      const outcome = await sendReminder(env, deps, f.phone, {
        template: "trial_reminder_same_day",
        lang,
        params: [name],
        freeform: messengerReminderText("same_day", name, lang),
      });
      await markFollowup(env.DB, f.id, outcome);
      return;
    }

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
        const outcome = await sendReminder(env, deps, f.phone, {
          template: "no_show_followup",
          lang,
          params: [name],
          freeform: messengerReminderText("no_show", name, lang),
        });
        await markFollowup(env.DB, f.id, outcome);
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
      // Never stomp the bot's own open question (B3): defer, don't cancel.
      if (await deferForOpenQuestion(env, f)) return;
      // Lead-nudge drip. processNudge re-verifies eligibility at send time,
      // sends the free-form nudge, and bumps the rolling cap. Nudges are always
      // in-window by construction; a closed window → cancel (no template).
      const status = await processNudge(env, f.phone, f.kind as NudgeKind, {
        sendText,
        isWindowClosed: (err) => err instanceof WindowClosedError,
        campaignName: async (e, id) => (await getCampaign(e.DB, id))?.name ?? null,
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
      if (await deferForOpenQuestion(env, f)) return;
      const res = await processExtendedNudge(env, f.phone, f.kind as ExtendedKind, {
        sendText,
        sendTemplate,
        templateName: tpl,
        isWindowClosed: (err) => err instanceof WindowClosedError,
        campaignName: async (e, id) => (await getCampaign(e.DB, id))?.name ?? null,
      });
      if (res.outcome === "template_missing") {
        // On IG/FB "template_missing" really means the 7-day Meta window closed
        // (the facade's sendTemplate throws — no templates on those channels).
        if (channelOf(f.phone) !== "wa") {
          await noteMessengerWindowClosed(env, deps, f.phone, f.kind);
        } else {
          await noteTemplateMissing(env, deps, f.phone, res.template);
        }
        await markFollowup(env.DB, f.id, "cancelled");
      } else {
        await markFollowup(env.DB, f.id, res.outcome);
      }
      return;
    }

    case "staff_later": {
      // Staff-composed reply queued from the dashboard composer. Opt-out was
      // already handled by the early return at the top of processOne.
      const later = parseStaffLaterNote(f.note);
      if (!later) {
        console.error(`[followups] staff_later #${f.id}: unparseable note`);
        await markFollowup(env.DB, f.id, "cancelled");
        return;
      }
      // The lead wrote first → the queued reply is stale. The row keeps its
      // text so the panel can hand it back to staff.
      if ((contact?.last_inbound_at ?? 0) > f.created_at) {
        await markFollowup(env.DB, f.id, "cancelled");
        await deps.slack.postNote(
          `🕐 Envío programado de ${byLabel(later.by)} a ${f.phone} cancelado: el lead escribió primero — el texto quedó guardado en el panel.`,
        );
        return;
      }
      if (isQuietHour(nowSec())) {
        await rescheduleRow(env, f, next8am(nowSec()));
        return;
      }
      // clientToken derives from the row id. On a DEFINITE Graph failure the
      // claim is released below so the retry actually resends — kvSetIfAbsent
      // can never re-claim a burned key on its own. Residual double-send risk
      // only on an ambiguous network timeout where the message DID land; that
      // beats the alternative (failure laundered into a silent fake 'sent').
      const token = `later:${f.id}`;
      let res;
      try {
        res = await sendStaffText(env, f.phone, later.text, later.by, token, {
          sendText: (e, p, b, opts) => sendText(e, p, b, opts),
          isWindowClosed: (err) => err instanceof WindowClosedError,
          postNote: (_e, text) => deps.slack.postNote(text),
          auditSend: (e, p, t, by) => auditHumanSend(e, p, t, "staff_later", by),
        });
      } catch (err) {
        await kvDelete(env.DB, staffSendClaimKey(f.phone, token));
        throw err; // handleSendFailure bumps attempts; next tick resends
      }
      if (res.ok) {
        await markFollowup(env.DB, f.id, "sent");
        return;
      }
      // 'duplicate' = the claim survived a prior attempt, which (post claim-
      // release) means a send that landed — a concurrent tick, or a crash
      // between claim and release. Mark sent but never silently.
      if (res.reason === "duplicate") {
        await deps.slack.postNote(
          `🕐 Envío programado #${f.id} a ${f.phone}: reclamo duplicado — marcado como enviado; verifica el chat en el panel.`,
        );
        await markFollowup(env.DB, f.id, "sent");
        return;
      }
      await markFollowup(env.DB, f.id, "cancelled");
      if (res.reason === "window_closed") {
        // Loud: a human decides whether to re-engage (never an auto template).
        await deps.slack.postNote(
          `⏰ Mensaje programado de ${byLabel(later.by)} para ${f.phone} NO enviado: ventana de 24h cerrada.`,
        );
      } else if (res.reason !== "opted_out") {
        // opted_out is already audited by the kv marker + the opt-out gate.
        console.error(`[followups] staff_later #${f.id} not sent: ${res.reason}`);
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
      {
        const outcome = await sendReminder(env, deps, f.phone, {
          template: "reengage_lead",
          lang,
          params: [name],
          freeform: messengerReminderText("reengage", name, lang),
        });
        await markFollowup(env.DB, f.id, outcome);
      }
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
      // IG/FB: no template escape — the 7d window is closed, nothing to send.
      if (channelOf(phone) !== "wa") throw err;
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
 * Template-first reminder that stays correct on IG/FB, where templates don't
 * exist: WA sends the template (unchanged behavior, throws bubble to the
 * caller's retry machinery); IG/FB send equivalent free-form copy — the send
 * facade auto-applies the HUMAN_AGENT tag between 24h and 7d — and a closed
 * 7-day window becomes 'cancelled' plus one throttled Slack note.
 */
async function sendReminder(
  env: Env,
  deps: { slack: Pick<CronSlackDeps, "postNote"> },
  phone: string,
  opts: { template: string; lang: string; params: string[]; freeform: string },
): Promise<"sent" | "cancelled"> {
  if (channelOf(phone) === "wa") {
    await sendTemplate(env, phone, tpl(opts.template, opts.lang), opts.lang, [
      bodyParams(opts.params),
    ]);
    return "sent";
  }
  try {
    await sendText(env, phone, opts.freeform);
    return "sent";
  } catch (err) {
    if (err instanceof WindowClosedError) {
      await noteMessengerWindowClosed(env, deps, phone, opts.template);
      return "cancelled";
    }
    throw err;
  }
}

/**
 * Pure. Free-form stand-in copy for the WA reminder templates, used on IG/FB.
 * No prices/schedule — just warm nudges (source-of-truth rule).
 */
export function messengerReminderText(
  kind: "day_before" | "same_day" | "no_show" | "reengage",
  name: string,
  lang: string,
): string {
  const who = name ? ` ${name.split(/\s+/)[0] ?? ""}` : "";
  if (kind === "no_show") {
    return renderCopy(
      lang === "en" ? CLIENT.copy.noShowEn : CLIENT.copy.noShowEs,
      { who, link: CLIENT.links.booking },
    );
  }
  const gym = CLIENT.shortName;
  if (lang === "en") {
    switch (kind) {
      case "day_before":
        return `Hi${who}! Quick reminder — your trial class at ${gym} is tomorrow 🥋 See you there!`;
      case "same_day":
        return `Hi${who}! Today's the day — your trial class at ${gym} 🥋 See you soon!`;
      default:
        return `Hi${who}! Still thinking about trying a class at ${gym}? Write us and we'll set it up 🥋`;
    }
  }
  switch (kind) {
    case "day_before":
      return `¡Hola${who}! Recordatorio rápido — mañana es tu clase de prueba en ${gym} 🥋 ¡Te esperamos!`;
    case "same_day":
      return `¡Hola${who}! Hoy es tu clase de prueba en ${gym} 🥋 ¡Nos vemos!`;
    default:
      return `¡Hola${who}! ¿Sigues con ganas de probar una clase en ${gym}? Escríbenos y la agendamos 🥋`;
  }
}

/**
 * At most ONE Slack note per CDMX day about IG/FB sends dropped because the
 * 7-day Meta window closed (kv `msgr_window_note:<YYYY-MM-DD>`).
 */
async function noteMessengerWindowClosed(
  env: Env,
  deps: { slack: Pick<CronSlackDeps, "postNote"> },
  phone: string,
  what: string,
): Promise<void> {
  const dayKey = `msgr_window_note:${cdmxDateStr(nowSec())}`;
  if (await kvGet(env.DB, dayKey)) return;
  await kvSet(env.DB, dayKey, "1");
  await deps.slack.postNote(
    `Seguimiento (${what}) a ${displayContact(phone)} omitido: en IG/FB no hay plantillas y la ventana de 7 días de Meta ya cerró. Solo el lead puede reabrir la conversación.`,
  );
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

/**
 * True when this nudge row was pushed back because the bot's last message to the
 * lead is a question less than 2h old — the row stays 'scheduled' and comes back
 * the moment the guard lifts (quiet-shifted), so nothing is ever cancelled here.
 */
async function deferForOpenQuestion(env: Env, f: Followup): Promise<boolean> {
  const gate = gateOnOpenQuestion(await lastBotMessage(env.DB, f.phone), nowSec());
  if (gate.send) return false;
  await rescheduleRow(env, f, shiftOutOfQuiet(gate.retryAt));
  return true;
}

async function rescheduleRow(
  env: Env,
  f: Followup,
  dueAt: number,
): Promise<void> {
  // status guard: a cancel (staff tap or lead-inbound) that lands between the
  // due-row load and this write must win — never resurrect a cancelled row.
  await env.DB.prepare(
    `UPDATE followups SET due_at = ?2, status = 'scheduled'
     WHERE id = ?1 AND status = 'scheduled'`,
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
        // trial_confirm is ONLY for bookings this system has never seen (a
        // web-form booker). A record whose sequence already exists, or a phone
        // with a recent booking_recorded marker (chat/manual booking — the
        // confirmation was already sent inline), must not get a second
        // confirmation + video ~15 min later, which is exactly what every
        // in-chat booking got on 2026-08-25/26.
        const knownRecord = (await phoneForRecordId(env.DB, rec.id)) !== null;
        const marker = parseBookingRecordedMarker(
          await kvGet(env.DB, bookingRecordedKey(phone)),
        );
        const recentlyConfirmedInline =
          marker !== null && nowSec() - marker.ts < 72 * 3600;
        await scheduleTrialSequence(env, phone, rec.id, rec.trialDateTimeIso, {
          includeConfirm: !knownRecord && !recentlyConfirmedInline,
        });
        await cancelFollowupsByKinds(env.DB, phone, ALL_NUDGE_KINDS);
        scheduled++;
      }
    }

    // Result watcher (independent of the trial datetime).
    if (rec.result) {
      await processResult(
        env,
        deps,
        rec.id,
        phone,
        rec.result,
        rec.name ?? null,
        rec.trialDateTimeIso,
      );
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
 *
 * Messages only go out when the trial date is TODAY (CDMX). Old records get
 * their modified-time bumped whenever the contact writes in again (lead-sync
 * touches the row), which re-surfaces months-old results here — those still get
 * status/cancel/marker treatment, silently, so no ghost welcomes.
 */
async function processResult(
  env: Env,
  deps: { slack: Pick<CronSlackDeps, "postNote"> },
  recordId: string,
  phone: string,
  rawResult: string,
  name: string | null,
  trialDateTimeIso: string | null,
): Promise<void> {
  const action = classifyResult(rawResult);
  if (!action) return;

  const kvKey = `resultado:${recordId}`;
  const already = await kvGet(env.DB, kvKey);
  const marker = `${action}`;
  if (already === marker) return; // acted on this record+value already

  const trialEpoch = trialDateTimeIso
    ? Math.floor(Date.parse(trialDateTimeIso) / 1000)
    : NaN;
  const sendReaction =
    Number.isFinite(trialEpoch) &&
    cdmxDateStr(trialEpoch) === cdmxDateStr(nowSec());

  await upsertContact(env.DB, { phone, name });
  const contact = await getContact(env.DB, phone);
  const lang = contact?.lang ?? "es";
  const who = name ? ` ${name.split(/\s+/)[0] ?? ""}` : "";
  // Baja beats everything Airtable says: bookkeeping still runs (cancel + kv
  // marker, so this record is never re-processed) but nothing goes out, and the
  // enrolled branch does NOT overwrite status — opted_out wins.
  const optedOut = contact?.status === "opted_out";

  if (action === "no_show") {
    await cancelFollowups(env.DB, phone); // all kinds
    if (optedOut || !sendReaction) {
      await kvSet(env.DB, kvKey, marker);
      return;
    }
    const link = CLIENT.links.booking;
    const body = renderCopy(
      lang === "en" ? CLIENT.copy.noShowEn : CLIENT.copy.noShowEs,
      { who, link },
    );
    try {
      await sendText(env, phone, body);
    } catch (err) {
      if (err instanceof WindowClosedError) {
        if (channelOf(phone) !== "wa") {
          await noteMessengerWindowClosed(env, deps, phone, "no_show_followup");
        } else {
          try {
            await sendTemplate(env, phone, tpl("no_show_followup", lang), lang, [
              bodyParams([name ?? ""]),
            ]);
          } catch (tErr) {
            await deps.slack.postNote(
              `No pude enviar reagenda a ${phone} (plantilla no_show_followup falló): ${String(tErr)}`,
            );
          }
        }
      } else {
        throw err;
      }
    }
  } else {
    // enrolled
    if (!optedOut) await setContactStatus(env.DB, phone, "student");
    await cancelFollowups(env.DB, phone); // all kinds; student stops marketing
    if (optedOut || !sendReaction) {
      await kvSet(env.DB, kvKey, marker);
      return;
    }
    const body = renderCopy(
      lang === "en" ? CLIENT.copy.welcomeEn : CLIENT.copy.welcomeEs,
      { who, link: CLIENT.links.schedule },
    );
    try {
      await sendText(env, phone, body);
    } catch (err) {
      if (err instanceof WindowClosedError) {
        if (channelOf(phone) !== "wa") {
          await noteMessengerWindowClosed(env, deps, phone, "human_followup");
        } else {
          try {
            await sendTemplate(env, phone, tpl("human_followup", lang), lang, [
              bodyParams([name ?? ""]),
            ]);
          } catch (tErr) {
            await deps.slack.postNote(
              `No pude enviar bienvenida a ${phone} (plantilla human_followup falló): ${String(tErr)}`,
            );
          }
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

/**
 * Neutral filler for a template variable we have no value for. Meta REJECTS an
 * empty body parameter, and our reminder copy puts {{1}} in a bare vocative slot
 * ("¡Hola {{1}}!"), so a blank would also read broken. A waving hand degrades
 * gracefully in every template that takes a name.
 */
const EMPTY_PARAM_FALLBACK = "👋";

function bodyParams(values: string[]): {
  type: "body";
  parameters: { type: "text"; text: string }[];
} {
  return {
    type: "body",
    parameters: values.map((text) => ({
      type: "text" as const,
      text: text.trim() || EMPTY_PARAM_FALLBACK,
    })),
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

/** Slack attribution for a staff_later row whose note predates the `by` field. */
function byLabel(by: string): string {
  return by || "el equipo";
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// re-export for the dispatcher/tests
export { cdmxIso };
