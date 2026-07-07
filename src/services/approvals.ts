// Shared approval flows: the single implementation of approve / edit / discard /
// takeover / mark-student, called BOTH by the Slack route (thin wrappers) and by
// the /admin API. Concurrency-safe via claimApproval (atomic conditional UPDATE)
// so a Slack tap and a dashboard tap on the same approval can't double-send.
//
// Card updates go through the existing services/slack.ts helpers, which no-op
// when slack_ts is null (dashboard-created approvals have no Slack card).

import type { ApprovalStatus, Env, PendingApproval } from "../types.js";
import {
  claimApproval,
  clearHumanOverride,
} from "../db/queries-admin.js";
import {
  insertEdit,
  kvGet,
  resolveApproval,
  setContactStatus,
  setHumanOverride,
} from "../db/queries.js";
import { sendText, sendBookingVideo, WindowClosedError } from "../services/wa.js";
import { armNudges } from "../cron/nudges.js";
import {
  markApprovedCard,
  markDiscardedCard,
  markEditedCard,
  markStudentCard,
  markTakenOverCard,
  markWindowClosedCard,
} from "../services/slack.js";

/** Result of an approval flow. `ok:false` carries a machine-readable reason. */
export type ApprovalResult =
  | { ok: true }
  | { ok: false; reason: "not_pending" | "window_closed" };

const NOT_PENDING: ApprovalResult = { ok: false, reason: "not_pending" };
const WINDOW_CLOSED: ApprovalResult = { ok: false, reason: "window_closed" };

/**
 * kv key marking an approval as a booking-confirmation draft. The pipeline sets
 * it when queuing a book-result draft; approve/edit read it to fire the booking
 * video after the confirmation text is sent (R4). Keyed by approval id so it
 * survives cron re-posts and works for both Slack and dashboard resolution.
 */
export function bookingApprovalKey(id: number): string {
  return `booking_approval:${id}`;
}

async function isBookingApproval(env: Env, id: number): Promise<boolean> {
  return (await kvGet(env.DB, bookingApprovalKey(id))) === "1";
}

/** Loads any approval row by id (pending or resolved) for card rendering. */
async function loadApproval(
  env: Env,
  id: number,
): Promise<PendingApproval | null> {
  return await env.DB.prepare(`SELECT * FROM pending_approvals WHERE id = ?1`)
    .bind(id)
    .first<PendingApproval>();
}

/**
 * Shared "claim, then send" core for approve/edit. Claims the row atomically to
 * `claimedStatus` (with `finalText`), then sends. On WindowClosedError the row
 * is downgraded to `expired` and the card swapped to offer the template button.
 * On any OTHER send error the claim is reverted to `pending` and the error is
 * rethrown so the caller surfaces it.
 */
async function claimAndSend(
  env: Env,
  id: number,
  claimedStatus: Extract<ApprovalStatus, "approved" | "edited">,
  bodyToSend: string,
  finalText: string,
): Promise<ApprovalResult> {
  const a = await loadApproval(env, id);
  if (!a) return NOT_PENDING;

  const won = await claimApproval(env.DB, id, claimedStatus, finalText);
  if (!won) return NOT_PENDING; // lost the race (already resolved elsewhere)

  try {
    await sendText(env, a.phone, bodyToSend);
  } catch (err) {
    if (err instanceof WindowClosedError) {
      await resolveApproval(env.DB, id, "expired");
      await markWindowClosedCard(env, a);
      return WINDOW_CLOSED;
    }
    // Transient / unexpected send failure: undo the claim so a retry can win.
    await resolveApproval(env.DB, id, "pending");
    throw err;
  }
  return { ok: true };
}

/** Approve the drafted reply as-is and send it. */
export async function approveAndSend(
  env: Env,
  id: number,
): Promise<ApprovalResult> {
  const a = await loadApproval(env, id);
  if (!a) return NOT_PENDING;
  const res = await claimAndSend(env, id, "approved", a.draft, a.draft);
  if (res.ok) {
    await markApprovedCard(env, a, a.draft);
    // Booking-confirmation draft → fire the booking video right after (R4).
    if (await isBookingApproval(env, id)) await sendBookingVideo(env, a.phone);
    // Approved bot reply landed → arm/re-arm the lead-nudge drip (no-op unless
    // the contact is a lead with no active booking/override, under the cap).
    await armNudges(env, a.phone);
  }
  return res;
}

/** Send an edited version of the reply, logging the draft→final edit. */
export async function editAndSend(
  env: Env,
  id: number,
  finalText: string,
): Promise<ApprovalResult> {
  const a = await loadApproval(env, id);
  if (!a) return NOT_PENDING;
  const res = await claimAndSend(env, id, "edited", finalText, finalText);
  if (res.ok) {
    await insertEdit(env.DB, a.phone, a.draft, finalText);
    await markEditedCard(env, a, finalText);
    // Booking-confirmation draft → fire the booking video right after (R4).
    if (await isBookingApproval(env, id)) await sendBookingVideo(env, a.phone);
    // Edited bot reply landed → arm/re-arm the lead-nudge drip (conditional).
    await armNudges(env, a.phone);
  }
  return res;
}

/** Discard the draft without sending anything. */
export async function discardApproval(
  env: Env,
  id: number,
): Promise<ApprovalResult> {
  const a = await loadApproval(env, id);
  if (!a) return NOT_PENDING;
  const won = await claimApproval(env.DB, id, "discarded");
  if (!won) return NOT_PENDING;
  await markDiscardedCard(env, a);
  return { ok: true };
}

/** Human takes over: pause the bot for HUMAN_SNOOZE_HOURS and expire the draft. */
export async function takeoverApproval(
  env: Env,
  id: number,
): Promise<ApprovalResult> {
  const a = await loadApproval(env, id);
  if (!a) return NOT_PENDING;
  const won = await claimApproval(env.DB, id, "taken_over");
  if (!won) return NOT_PENDING;
  const hours = Number(env.HUMAN_SNOOZE_HOURS) || 8;
  await setHumanOverride(env.DB, a.phone, hours);
  await markTakenOverCard(env, a);
  return { ok: true };
}

/** Mark the contact as a student and discard the draft (no send). */
export async function markStudentFromApproval(
  env: Env,
  id: number,
): Promise<ApprovalResult> {
  const a = await loadApproval(env, id);
  if (!a) return NOT_PENDING;
  const won = await claimApproval(env.DB, id, "discarded");
  if (!won) return NOT_PENDING;
  await setContactStatus(env.DB, a.phone, "student");
  await markStudentCard(env, a);
  return { ok: true };
}

// Re-export so the /admin resume flow (W3) has a single approvals surface.
export { clearHumanOverride };
