// Booking confirmations send on their own (owner, 2026-11-10: "if the age
// makes sense, let it book on its own"). Pure, unit-tested.
//
// With training wheels ON, a turn whose book_trial SUCCEEDED (Airtable record
// created, slot validated by validateSlot, and for a minor the age known —
// handleBookTrial refuses an unknown age — and the class inside the child's
// group — validateSlotBand) sends its confirmation immediately instead of
// queueing it in Aprobar. Everything else keeps the human path:
//
//   feature_off      — clients/<id>/client.mjs features.autoConfirmBookings off.
//   force_review     — outage redrive / late rescue: always Aprobar.
//   override_check   — a staff member took the chat over ("Tomar control").
//   existing_booking — a reschedule / cancel turn, or the phone already had a
//                      recorded booking when the turn started (a change).
//   no_reply         — the model never closed the turn with send_reply.
//   escalation       — send_reply carried an escalation reason (complaint,
//                      opt-out, price negotiation, anything at all).
//   sureness         — send_reply sureness below the auto-send threshold.
//   slot_warning     — the confirmation text failed guardUnverifiedSlotClaim
//                      ("Horario que no existe…", impossible hour).
//   price            — the confirmation text names a price / promo: the
//                      approved confirmation copy (intake «Después de agendar»)
//                      carries none, and nothing else checks a booking's text.
//   minor_age        — defence in depth: a minor's booking with no known age.
//
// Wheels OFF is untouched: the old path already sends every confirmation.
// Runtime safety that is NOT decided here (applied by the pipeline, the same
// as the auto-send lane): kill switch + opt-out + human override are pipeline
// gates before the brain (re-read right before the send), the 24h window is
// enforced by sendText (closed ⇒ an Aprobar card), and confirm-once
// (services/confirm-once.ts) stops a second confirmation of the same slot.

import { SURENESS_SEND_MIN } from "./auto-send.js";

export type AutoConfirmBlock =
  | "feature_off"
  | "force_review"
  | "override_check"
  | "existing_booking"
  | "no_reply"
  | "escalation"
  | "sureness"
  | "slot_warning"
  | "price"
  | "minor_age";

export interface AutoConfirmBooking {
  audience: "adult" | "kid";
  childName?: string;
  /** Age band the booking was checked against (BookTrialInput.program). */
  program?: string;
  childAgeMonths?: number;
}

export interface AutoConfirmInput {
  featureOn: boolean;
  forceReview: boolean;
  overrideCheck: boolean;
  /** Reschedule button / lead-cancel turn. */
  reschedule: boolean;
  /** ctx.recordedBooking was set when the turn started. */
  hadRecordedBooking: boolean;
  /** The book result carried no send_reply (max iterations). */
  replyMissing: boolean;
  replyReason?: string | null;
  replySureness?: number;
  /** Reason guardUnverifiedSlotClaim attached to the confirmation text. */
  slotWarning?: string | null;
  confirmation: string;
  bookings: AutoConfirmBooking[];
  /** A stated age stored in the qualification (months), if any. */
  storedAgeMonths?: number | null;
}

/** Currency figures and promo words — none belong in a booking confirmation. */
const CONFIRM_PRICE_RE = /\$\s?\d|\bmxn\b|\bpesos\b|\bpromo|\bdescuento|\bprecio|\bcosto\b|\bmensualidad|\bmembres[ií]a|\binscripci[oó]n/i;

export function confirmationMentionsPrice(text: string): boolean {
  return CONFIRM_PRICE_RE.test(text);
}

function isMinor(b: AutoConfirmBooking): boolean {
  return b.audience === "kid" || !!b.childName?.trim() || (!!b.program && b.program !== "adults");
}

export function decideAutoConfirm(i: AutoConfirmInput): { auto: boolean; blockedBy?: AutoConfirmBlock } {
  const no = (blockedBy: AutoConfirmBlock) => ({ auto: false, blockedBy });
  if (!i.featureOn) return no("feature_off");
  if (i.forceReview) return no("force_review");
  if (i.overrideCheck) return no("override_check");
  if (i.reschedule || i.hadRecordedBooking) return no("existing_booking");
  if (i.replyMissing) return no("no_reply");
  if (i.replyReason && i.replyReason.trim()) return no("escalation");
  if (i.replySureness !== undefined && i.replySureness < SURENESS_SEND_MIN) return no("sureness");
  if (i.slotWarning && i.slotWarning.trim()) return no("slot_warning");
  if (confirmationMentionsPrice(i.confirmation)) return no("price");
  const storedAge = typeof i.storedAgeMonths === "number" && Number.isFinite(i.storedAgeMonths);
  for (const b of i.bookings) {
    if (isMinor(b) && typeof b.childAgeMonths !== "number" && !storedAge) return no("minor_age");
  }
  return { auto: true };
}
