// The ONE place a trial booking is finalized, regardless of who booked it.
//
// Before Slice 4 the only path that wrote Airtable + armed the anti-no-show
// sequence was the brain's book_trial (routeResult's `book` branch). Humans
// confirm classes over WhatsApp all the time — approving/editing a draft in
// Slack, or typing straight from the dashboard — and none of that reached the
// CRM. This module extracts the post-booking work so both callers share it:
//
//  - finalizeBooking  : Slack FYI + anti-no-show sequence + qualification +
//                       lead sync. Called by routeResult (record already exists,
//                       created inside the brain's tool loop) and by
//                       registerBooking below.
//  - registerBooking  : the HUMAN entry point. validateSlot → Airtable
//                       bookTrial → finalizeBooking → booking video, plus the
//                       `booking_recorded:<phone>` marker booking-guard reads to
//                       know a claim is backed.
//
// Every dependency is injectable (defaults built lazily inside each call, so the
// booking-core ↔ cron/followups import cycle can never see a half-initialized
// module) — the unit tests drive the whole flow with fakes.

import type { BookTrialInput, Env, SlackPort } from "../types.js";
import { kvSet, setQualification } from "../db/queries.js";
import { syncLead } from "./lead-sync.js";
import { scheduleTrialSequence } from "../cron/followups.js";
import { cdmxIso } from "../cron/time.js";
import { normalizeDiscipline, validateSlot } from "../brain/tools.js";
import { bookTrial } from "./airtable.js";
import { sendBookingVideo } from "./send.js";

/** A booking that already has its Airtable record id. */
export interface FinalizeBookingInput extends BookTrialInput {
  recordId: string;
}

/**
 * kv marker written on every HUMAN registration: `booking_recorded:<phone>` =
 * epoch seconds. booking-guard treats a marker younger than 72h as proof that a
 * confirmation is backed, so re-confirming the same class never re-cards.
 */
export function bookingRecordedKey(phone: string): string {
  return `booking_recorded:${phone}`;
}

export interface BookingCoreDeps {
  scheduleTrialSequence: typeof scheduleTrialSequence;
  setQualification: typeof setQualification;
  syncLead: typeof syncLead;
  bookTrial: (env: Env, input: BookTrialInput) => Promise<string>;
  validateSlot: typeof validateSlot;
  sendBookingVideo: typeof sendBookingVideo;
  kvSet: typeof kvSet;
  now(): number;
}

/** Built per call (not at module scope) so import cycles stay harmless. */
export function realBookingDeps(): BookingCoreDeps {
  return {
    scheduleTrialSequence,
    setQualification,
    syncLead,
    bookTrial,
    validateSlot,
    sendBookingVideo,
    kvSet,
    now: () => Math.floor(Date.now() / 1000),
  };
}

/**
 * Everything that must happen once a trial record EXISTS in Airtable: the Slack
 * FYI card, the anti-no-show sequence keyed to that record, the stored
 * qualification, and the `booking_created` lead sync.
 *
 * Lifted verbatim from routeResult's `book` branch — including the
 * `includeConfirm:false` sequence option (the confirmation goes out inline, so
 * the scheduled trial_confirm is only for web-form bookers) and the inner
 * try/catch that isolates a qualification/sync failure from the rest.
 *
 * Deliberate change vs. the old inline code: this NEVER throws. The old branch
 * let a Slack or sequence failure propagate out of routeResult, which meant the
 * lead never got their confirmation text. Swallowing (+logging) is strictly
 * safer and invisible unless something is already broken.
 */
export async function finalizeBooking(
  env: Env,
  slack: Pick<SlackPort, "postBookingFyi">,
  b: FinalizeBookingInput,
  deps: BookingCoreDeps = realBookingDeps(),
): Promise<void> {
  const booking: BookTrialInput = {
    name: b.name,
    discipline: b.discipline,
    audience: b.audience,
    trialDate: b.trialDate,
    trialTime: b.trialTime,
    phone: b.phone,
  };
  try {
    await slack.postBookingFyi(booking);
    // Chat booking: the bot/human confirms inline, so skip the scheduled
    // trial_confirm (it's for web-form bookers detected via syncBookings).
    await deps.scheduleTrialSequence(
      env,
      b.phone,
      b.recordId,
      cdmxIso(b.trialDate, b.trialTime),
      { includeConfirm: false },
    );
  } catch (err) {
    console.error(`[booking] finalize failed for ${b.phone}:`, err);
  }
  // Persist qualification (gives classifyProgram real data) then sync the
  // booking to Airtable + fire program rules. Isolated so a sync failure never
  // derails the caller's confirmation/video path.
  try {
    await deps.setQualification(
      env.DB,
      b.phone,
      JSON.stringify({
        discipline: b.discipline,
        audience: b.audience,
        name: b.name,
      }),
    );
    await deps.syncLead(env, b.phone, "booking_created");
  } catch (err) {
    console.warn(`[booking] booking sync failed for ${b.phone}:`, err);
  }
}

export type RegisterBookingResult =
  | { ok: true; recordId: string }
  | {
      ok: false;
      reason: "invalid_slot" | "airtable_error";
      detail: string;
      alternatives?: string[];
    };

export interface RegisterBookingOpts {
  /** Skip validateSlot — "Registrar de todos modos" / an explicit override. */
  force?: boolean;
  /** Admin username, when a human registered it from the dashboard. */
  by?: string;
  /** Send the booking video after registering. Default TRUE (R4 parity). */
  sendVideo?: boolean;
}

/**
 * Register a trial a HUMAN already promised the lead. Mirrors the brain's
 * book_trial path end to end, minus the model: validate the slot (unless
 * forced), create/patch the Airtable row, then finalizeBooking, then the video.
 *
 * Failure is returned, never thrown — both call sites (the Slack capture card
 * and the dashboard endpoint) render the reason back to a human.
 */
export async function registerBooking(
  env: Env,
  slack: Pick<SlackPort, "postBookingFyi" | "postNote">,
  input: BookTrialInput,
  opts?: RegisterBookingOpts,
  deps: BookingCoreDeps = realBookingDeps(),
): Promise<RegisterBookingResult> {
  // validateSlot normalizes internally, but Airtable's select mapping keys off
  // the service key — so normalize once, up front, for both.
  const discipline = normalizeDiscipline(input.discipline ?? "");
  const booking: BookTrialInput = { ...input, discipline };

  if (opts?.force !== true) {
    const check = deps.validateSlot(
      booking.trialDate,
      booking.trialTime,
      booking.audience,
      discipline,
    );
    if (!check.ok) {
      return {
        ok: false,
        reason: "invalid_slot",
        detail: check.reason ?? "horario inválido",
        ...(check.alternatives ? { alternatives: check.alternatives } : {}),
      };
    }
  }

  let recordId: string;
  try {
    recordId = await deps.bookTrial(env, booking);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[booking] airtable register failed for ${booking.phone}:`, err);
    return { ok: false, reason: "airtable_error", detail };
  }

  // Written BEFORE the (best-effort) finalize work so the "this claim is
  // backed" marker exists even if Slack/D1 hiccups after the Airtable write.
  try {
    await deps.kvSet(env.DB, bookingRecordedKey(booking.phone), String(deps.now()));
  } catch (err) {
    console.error(`[booking] recorded marker failed for ${booking.phone}:`, err);
  }

  await finalizeBooking(env, slack, { ...booking, recordId }, deps);

  // Attribution note only when a named human did it from the dashboard — the
  // Slack capture card swaps itself, so a note there would just be noise.
  if (opts?.by) {
    try {
      await slack.postNote(
        `🗓 ${opts.by} registró el agendado de ${booking.phone} en Airtable (${recordId}) — secuencia anti-no-show activada.`,
      );
    } catch (err) {
      console.error("[booking] attribution note failed", err);
    }
  }

  if (opts?.sendVideo !== false) {
    try {
      await deps.sendBookingVideo(env, booking.phone);
    } catch (err) {
      console.error(`[booking] video failed for ${booking.phone}:`, err);
    }
  }

  return { ok: true, recordId };
}
