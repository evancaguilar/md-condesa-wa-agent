// One booking confirmation (+ video) per phone + trial slot (2026-10-21).
//
// The nightly auditor kept finding "confirmación + video enviados DOS veces"
// even after the one-message confirmation (6cf5a1e). Two independent races,
// both proven from live transcripts:
//
//  1. Overlapping brain turns. The 8 s debounce is check-then-act: a lead who
//     sends the name and then the child's name 10 s apart gets TWO brain turns,
//     and book turns are exempt from the mid-brain supersede (their Airtable
//     record already exists) — so BOTH confirmations + BOTH videos went out
//     5–7 s apart (…6562 10-12, …0711 10-13, …8321 10-14). A sibling variant:
//     the second turn did not book but, having read the history BEFORE the
//     first confirmation landed, restated it ("Ya tienes tu lugar…", …2064
//     10-20 — three confirmations in 35 s).
//  2. syncBookings vs. the brain. The brain writes the Airtable record inside
//     its tool loop; finalizeBooking writes the booking_recorded marker only
//     after the turn ends. A syncBookings pass (the :x0/:x5 cron slot) that
//     reads the brand-new record in between sees "unknown record, no marker"
//     ⇒ a web-form booker ⇒ arms trial_confirm, and the next tick sends the
//     signed-link confirmation + video AGAIN (…9313 10-17: 20:45:59 brain,
//     20:50:50 trial_confirm with meta.cuestionario).
//
// The guard: every automated path that delivers a trial confirmation claims
// `booking_confirm:<phone>:<YYYY-MM-DD>T<HH:mm>` atomically (kv upsert whose
// WHERE only lets it through when the row is absent or older than the
// window). The loser sends nothing (brain turn, trial_confirm) or skips the
// video (a human-approved draft — the human chose to send the text). Each win
// also stamps `booking_confirm_last:<phone>` so a NON-book turn that read the
// history before a parallel confirmation landed can drop its restatement.
//
// Pure helpers + two tiny kv calls; the decision functions are unit-tested.

import { kvClaimIfAbsentOrOlder, kvDelete, kvGet, kvSet } from "../db/queries.js";
import { claimsBooking } from "./booking-claims.js";
import { cdmxParts } from "../cron/time.js";

/**
 * A second confirmation of the SAME slot inside this window is a duplicate.
 * Covers race 1 (seconds), race 2 (≤ one or two 5-min ticks) and a held
 * approval best-betted within the hour; short enough that a lead who cancels
 * and re-books the very same class hours later still gets a confirmation.
 */
export const CONFIRM_DEDUPE_WINDOW_SECONDS = 2 * 3600;

/**
 * A turn that read its history up to this long AFTER a parallel confirmation
 * was claimed still may not see it (the claim precedes the Graph send and
 * the message row by a second or two).
 */
export const CONFIRM_RACE_SLACK_SECONDS = 5;

/** "HH:mm" from "9:00", "09:00", "18:00", "6 pm", "6:30pm", "9:00 a.m."; null otherwise. Pure. */
export function normalizeSlotTime(raw: string | null | undefined): string | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?\s*$/i.exec(raw ?? "");
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = /p/i.test(m[3]);
    h = pm ? (h === 12 ? 12 : h + 12) : h === 12 ? 0 : h;
  } else if (m[2] === undefined) {
    return null; // a bare "9" is not a time we can key on
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "YYYY-MM-DDTHH:mm" for a booking, or null when either half is unreadable. Pure. */
export function bookingSlot(trialDate: string | null | undefined, trialTime: string | null | undefined): string | null {
  const d = /^\s*(\d{4}-\d{2}-\d{2})/.exec(trialDate ?? "");
  const t = normalizeSlotTime(trialTime);
  return d && t ? `${d[1]}T${t}` : null;
}

/** The CDMX slot of a trial epoch (Airtable "Trial DateTime"). Pure. */
export function slotFromEpoch(epoch: number): string {
  const p = cdmxParts(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The CDMX slot of an ISO datetime with offset; null when unparseable. Pure. */
export function slotFromIso(iso: string | null | undefined): string | null {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? slotFromEpoch(Math.floor(ms / 1000)) : null;
}

export function bookingConfirmKey(phone: string, slot: string): string {
  return `booking_confirm:${phone}:${slot}`;
}

export function lastConfirmKey(phone: string): string {
  return `booking_confirm_last:${phone}`;
}

/**
 * Atomically claims THE confirmation of `slot` for `phone`. True ⇒ this
 * caller sends it; false ⇒ one already went out inside the window. A null
 * slot (nothing to key on) always wins — the guard never blocks a
 * confirmation it can't identify. Never throws: a kv failure fails OPEN
 * (better a rare duplicate than a lead with no confirmation).
 */
export async function claimBookingConfirmation(
  db: D1Database,
  phone: string,
  slot: string | null,
  nowSec: number,
  windowSec: number = CONFIRM_DEDUPE_WINDOW_SECONDS,
): Promise<boolean> {
  try {
    if (slot) {
      const won = await kvClaimIfAbsentOrOlder(db, bookingConfirmKey(phone, slot), nowSec, windowSec);
      if (!won) return false;
    }
    await kvSet(db, lastConfirmKey(phone), String(nowSec));
    return true;
  } catch (err) {
    console.error(`[confirm-once] claim failed for ${phone} ${slot ?? "?"}`, err);
    return true;
  }
}

/**
 * Gives a claim back when the confirmation did NOT reach the lead (send
 * failed, demoted to a draft), so the next path can still send it. Best-effort.
 */
export async function releaseBookingConfirmation(
  db: D1Database,
  phone: string,
  slot: string | null,
): Promise<void> {
  if (!slot) return;
  try {
    await kvDelete(db, bookingConfirmKey(phone, slot));
  } catch (err) {
    console.error(`[confirm-once] release failed for ${phone} ${slot}`, err);
  }
}

/** Epoch of the phone's latest claimed confirmation, or null. Never throws. */
export async function lastConfirmationAt(db: D1Database, phone: string): Promise<number | null> {
  try {
    const n = Number(await kvGet(db, lastConfirmKey(phone)));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Pure. Race 1, non-book variant: drop a reply that RESTATES a booking when a
 * parallel turn's confirmation was claimed after (or within the slack before)
 * this turn read its history — the model wrote it without seeing that
 * confirmation, and the lead already has it. Copy that claims no booking
 * (an answer to "¿qué llevo?") is never dropped.
 */
export function isStaleBookingRestatement(input: {
  text: string;
  turnStartedAt: number;
  lastConfirmAt: number | null;
}): boolean {
  if (input.lastConfirmAt === null) return false;
  if (input.lastConfirmAt < input.turnStartedAt - CONFIRM_RACE_SLACK_SECONDS) return false;
  return claimsBooking(input.text);
}

/** Slack ops line when a duplicate confirmation was suppressed. Pure. */
export function duplicateSuppressedNote(phone: string, what: "confirmación" | "repetición de la confirmación"): string {
  return (
    `🔁 ${phone}: se evitó una ${what} duplicada — un turno paralelo ya le confirmó la clase hace segundos. ` +
    `Si su último mensaje traía otra pregunta, contéstala desde el panel.`
  );
}
