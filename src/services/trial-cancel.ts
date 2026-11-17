// DB side of calling off a booked trial (detector + copy:
// src/pipeline/lead-cancel.ts, day check + copy: services/trial-day-check.ts).
// Three callers share one core (cancelTrialCore):
//   - the LEAD cancels in chat: pipeline/inbound.ts step 1c, only when
//     detectLeadCancel() fired, so ordinary messages cost nothing;
//   - STAFF press «Cancelar clase de prueba» in the dashboard
//     (POST /admin/api/conversations/:phone/cancel-trial);
//   - the HOLIDAY check: the class falls on a configured closed / tbd /
//     special day it is not part of (cron/followups.ts send-time guard +
//     the hourly sweep in cron/trial-day-sweep.ts).
// None of them sends anything to the lead or writes to Airtable.

import type { Env } from "../types.js";
import { getContact, kvDelete, kvGet, kvSet, kvSetIfAbsent, markFollowup } from "../db/queries.js";
import { decodeChainNote } from "../cron/post-trial.js";
import { formatSlotLabel } from "../cron/next-slot.js";
import { greetingName } from "../cron/display-name.js";
import { cdmxParts } from "../cron/time.js";
import { weekdayIndex } from "../brain/tools.js";
import { displayContact } from "./channel.js";
import { releaseBookingConfirmation, slotFromEpoch } from "./confirm-once.js";
import {
  TRIAL_CANCEL_KINDS,
  cancelTaskNote,
  mergeTrialCancelMarker,
  parseTrialCancelMarker,
  trialCancelledKey,
  type LeadCancelIntent,
  type TrialCancelBy,
} from "../pipeline/lead-cancel.js";
import { noClassNoteKey, noClassTaskNote, staffCancelTaskNote, type TrialDayVerdict } from "./trial-day-check.js";

export interface TrialCancelResult {
  /** Rows moved scheduled → cancelled. */
  cancelled: number;
  /** Trial epochs those rows were armed for. */
  trials: number[];
}

interface ArmedRow {
  id: number;
  kind: string;
  note: string | null;
}

/** Same tolerance as isCancelledTrial. */
const SAME_TRIAL_SECONDS = 60;

/**
 * Pure. Which of a phone's armed rows belong to the trial at `trialEpoch`:
 * rows whose note names that trial, plus rows that name no trial
 * (trial_confirm carries no note) when no row names a DIFFERENT trial.
 */
export function rowsForTrial<T extends { note: string | null }>(rows: readonly T[], trialEpoch: number): T[] {
  const trialOf = (r: T): number | null => decodeChainNote(r.note).trial;
  const other = rows.some((r) => {
    const t = trialOf(r);
    return t !== null && Math.abs(t - trialEpoch) > SAME_TRIAL_SECONDS;
  });
  return rows.filter((r) => {
    const t = trialOf(r);
    return t === null ? !other : Math.abs(t - trialEpoch) <= SAME_TRIAL_SECONDS;
  });
}

/**
 * Shared core. Cancels the phone's SCHEDULED pre-class rows (TRIAL_CANCEL_KINDS;
 * only those of `opts.trialEpoch` when given), releases the confirm-once claim
 * of every trial involved, and adds those trials to the kv marker
 * `trial_cancelled:<phone>` — which the no-show chain's send guard
 * (post-trial.processPostTrial, every no_show_* kind) and syncBookings' arming
 * read. A row currently being sent ('sending') is the caller's to close.
 *
 * The rows are CANCELLED, not deleted: a rebook through book_trial runs
 * scheduleTrialSequence, whose upsert moves a row back to 'scheduled' when its
 * due time changes (rescheduleFollowup), and a different Airtable record or a
 * new trial date inserts fresh rows — so the new class gets its reminders.
 */
export async function cancelTrialCore(
  env: Env,
  phone: string,
  opts: { by: TrialCancelBy; intent?: LeadCancelIntent; trialEpoch?: number },
  now: number,
): Promise<TrialCancelResult> {
  const kinds = TRIAL_CANCEL_KINDS;
  const placeholders = kinds.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, kind, note FROM followups
     WHERE phone = ?1 AND status = 'scheduled' AND kind IN (${placeholders})`,
  )
    .bind(phone, ...kinds)
    .all<ArmedRow>();
  const all = results ?? [];
  const rows = opts.trialEpoch === undefined ? all : rowsForTrial(all, opts.trialEpoch);

  for (const r of rows) await markFollowup(env.DB, r.id, "cancelled");

  const epochs = rows.map((r) => decodeChainNote(r.note).trial).filter((t): t is number => t !== null);
  if (opts.trialEpoch !== undefined) epochs.push(opts.trialEpoch);
  const trials = [...new Set(epochs)].sort((a, b) => a - b);
  if (rows.length === 0 && trials.length === 0) return { cancelled: 0, trials };

  // A rebook of the same class must get its confirmation again — clear the
  // confirm-once claim of every cancelled trial (best-effort, never throws).
  for (const t of trials) await releaseBookingConfirmation(env.DB, phone, slotFromEpoch(t));

  if (trials.length) {
    try {
      const prev = parseTrialCancelMarker(await kvGet(env.DB, trialCancelledKey(phone)));
      const next = mergeTrialCancelMarker(prev, { ts: now, intent: opts.intent ?? "cancel", trials }, opts.by);
      await kvSet(env.DB, trialCancelledKey(phone), JSON.stringify(next));
    } catch (err) {
      console.warn(`[trial-cancel] marker write failed for ${phone}: ${String(err)}`);
    }
  }
  return { cancelled: rows.length, trials };
}

/** "Ana (55 1234 5678)" — name + display phone, as every task note shows a lead. */
async function whoLabel(env: Env, phone: string): Promise<string> {
  const contact = await getContact(env.DB, phone);
  const name = greetingName(contact?.name);
  return name ? `${name} (${displayContact(phone)})` : displayContact(phone);
}

/**
 * The LEAD called the class off in chat. Returns null — and touches nothing —
 * when no trial sequence is armed (a lead who never booked saying "no puedo el
 * lunes" is just chatting). One task note so staff fix Airtable.
 */
export async function applyLeadCancellation(
  env: Env,
  phone: string,
  body: string,
  intent: LeadCancelIntent,
  deps: { postTaskNote: (text: string) => Promise<void> },
  now: number = Math.floor(Date.now() / 1000),
): Promise<TrialCancelResult | null> {
  const res = await cancelTrialCore(env, phone, { by: "lead", intent }, now);
  if (res.cancelled === 0) return null;
  try {
    await deps.postTaskNote(
      cancelTaskNote({
        who: await whoLabel(env, phone),
        intent,
        body,
        classes: res.trials.map((t) => classLabel(t, now)),
        cancelledRows: res.cancelled,
      }),
    );
  } catch (err) {
    console.warn(`[trial-cancel] slack note failed for ${phone}: ${String(err)}`);
  }
  return res;
}

/**
 * STAFF pressed «Cancelar clase de prueba» in the dashboard. null when nothing
 * is armed. Never messages the lead, never writes Airtable.
 */
export async function applyStaffCancellation(
  env: Env,
  phone: string,
  by: string,
  deps: { postTaskNote: (text: string) => Promise<void> },
  now: number = Math.floor(Date.now() / 1000),
): Promise<(TrialCancelResult & { classes: string[] }) | null> {
  const res = await cancelTrialCore(env, phone, { by: "staff" }, now);
  if (res.cancelled === 0) return null;
  const classes = res.trials.map((t) => classLabel(t, now));
  try {
    await deps.postTaskNote(
      staffCancelTaskNote({ who: await whoLabel(env, phone), by, classes, cancelledRows: res.cancelled }),
    );
  } catch (err) {
    console.warn(`[trial-cancel] slack note failed for ${phone}: ${String(err)}`);
  }
  return { ...res, classes };
}

/**
 * The class at `trialEpoch` does not run that day (trialDayCheck said so):
 * cancel that trial's armed rows, mark it, and tell staff ONCE per phone +
 * trial (kv claim `trial_noclass_note:<phone>:<trial>`), whichever row or tick
 * gets here first. `alsoClosed` = rows the caller closed itself (the row being
 * sent), counted in the note.
 */
export async function applyNoClassCancellation(
  env: Env,
  phone: string,
  trialEpoch: number,
  verdict: Extract<TrialDayVerdict, { runs: false }>,
  deps: { postTaskNote: (text: string) => Promise<void> },
  now: number = Math.floor(Date.now() / 1000),
  alsoClosed = 0,
): Promise<TrialCancelResult & { noted: boolean }> {
  const res = await cancelTrialCore(env, phone, { by: "holiday", trialEpoch }, now);
  let noted = false;
  let claimed = false;
  try {
    claimed = await kvSetIfAbsent(env.DB, noClassNoteKey(phone, trialEpoch), String(now));
  } catch (err) {
    console.warn(`[trial-cancel] no-class note claim failed for ${phone}: ${String(err)}`);
  }
  if (claimed) {
    try {
      await deps.postTaskNote(
        noClassTaskNote({
          who: await whoLabel(env, phone),
          classLabel: classLabel(trialEpoch, now),
          verdict,
          cancelledRows: res.cancelled + alsoClosed,
        }),
      );
      noted = true;
    } catch (err) {
      console.warn(`[trial-cancel] no-class note failed for ${phone}: ${String(err)}`);
      // Release the claim so a later row / tick retries the note.
      await kvDelete(env.DB, noClassNoteKey(phone, trialEpoch)).catch(() => {});
    }
  }
  return { ...res, noted };
}

/** "hoy a las 4:00 pm" / "el martes 13 a las 4:00 pm" for a trial epoch. */
export function classLabel(trialEpoch: number, now: number): string {
  const p = cdmxParts(trialEpoch);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return formatSlotLabel(
    { weekday: weekdayIndex(date) ?? 0, date, time: `${pad(p.hour)}:${pad(p.minute)}` },
    now,
    "es",
  );
}
