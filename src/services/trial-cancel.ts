// DB side of a lead calling off a booked trial in chat (detector + copy:
// src/pipeline/lead-cancel.ts). Called from pipeline/inbound.ts step 1c ONLY
// when detectLeadCancel() fired, so ordinary messages cost nothing.

import type { Env } from "../types.js";
import { getContact, kvGet, kvSet, markFollowup } from "../db/queries.js";
import { decodeChainNote } from "../cron/post-trial.js";
import { formatSlotLabel } from "../cron/next-slot.js";
import { greetingName } from "../cron/display-name.js";
import { cdmxParts } from "../cron/time.js";
import { weekdayIndex } from "../brain/tools.js";
import { displayContact } from "./channel.js";
import {
  TRIAL_CANCEL_KINDS,
  cancelTaskNote,
  mergeTrialCancelMarker,
  parseTrialCancelMarker,
  trialCancelledKey,
  type LeadCancelIntent,
} from "../pipeline/lead-cancel.js";

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

/**
 * Cancel the phone's SCHEDULED pre-class rows (reminders + the first no-show
 * touch), remember which trial(s) were called off (kv `trial_cancelled:<phone>`,
 * read by the no-show chain's send guard), and post ONE task note so staff
 * fix Airtable. Returns null — and touches nothing — when no trial sequence is
 * armed (a lead who never booked saying "no puedo el lunes" is just chatting).
 *
 * The rows are CANCELLED, not deleted: a rebook through book_trial runs
 * scheduleTrialSequence, whose upsert moves a row back to 'scheduled' when its
 * due time changes (rescheduleFollowup), and a different Airtable record or a
 * new trial date inserts fresh rows — so the new class gets its reminders.
 */
export async function applyLeadCancellation(
  env: Env,
  phone: string,
  body: string,
  intent: LeadCancelIntent,
  deps: { postTaskNote: (text: string) => Promise<void> },
  now: number = Math.floor(Date.now() / 1000),
): Promise<TrialCancelResult | null> {
  const kinds = TRIAL_CANCEL_KINDS;
  const placeholders = kinds.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, kind, note FROM followups
     WHERE phone = ?1 AND status = 'scheduled' AND kind IN (${placeholders})`,
  )
    .bind(phone, ...kinds)
    .all<ArmedRow>();
  const rows = results ?? [];
  if (rows.length === 0) return null;

  for (const r of rows) await markFollowup(env.DB, r.id, "cancelled");

  const trials = [
    ...new Set(rows.map((r) => decodeChainNote(r.note).trial).filter((t): t is number => t !== null)),
  ].sort((a, b) => a - b);

  try {
    const prev = parseTrialCancelMarker(await kvGet(env.DB, trialCancelledKey(phone)));
    const next = mergeTrialCancelMarker(prev, { ts: now, intent, trials });
    await kvSet(env.DB, trialCancelledKey(phone), JSON.stringify(next));
  } catch (err) {
    console.warn(`[trial-cancel] marker write failed for ${phone}: ${String(err)}`);
  }

  try {
    const contact = await getContact(env.DB, phone);
    const name = greetingName(contact?.name);
    const who = name ? `${name} (${displayContact(phone)})` : displayContact(phone);
    await deps.postTaskNote(
      cancelTaskNote({
        who,
        intent,
        body,
        classes: trials.map((t) => classLabel(t, now)),
        cancelledRows: rows.length,
      }),
    );
  } catch (err) {
    console.warn(`[trial-cancel] slack note failed for ${phone}: ${String(err)}`);
  }
  return { cancelled: rows.length, trials };
}

/** "hoy a las 4:00 pm" / "el martes 13 a las 4:00 pm" for a trial epoch. */
function classLabel(trialEpoch: number, now: number): string {
  const p = cdmxParts(trialEpoch);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return formatSlotLabel(
    { weekday: weekdayIndex(date) ?? 0, date, time: `${pad(p.hour)}:${pad(p.minute)}` },
    now,
    "es",
  );
}
