// Promised-but-unbooked recovery (2026-11-12). Pure: no D1, no fetch, no clock.
//
// Why: the model regularly CLOSES a booking in words ("¡Va! Te apunto el lunes
// 23 a las 6 pm. Nos vemos 💪") without calling book_trial — no Airtable
// record, no confirmation link, no reminders. guardUnbackedBookingClaim
// (claude.ts) already stops that reply from auto-sending, but the lead is then
// left unbooked, waiting on a human. Before falling back to that ⚠️ draft,
// respond() makes ONE corrective brain call: the instruction below rides at
// the end of the per-turn <context> (never in the cached system blocks), and
// the call either books (normal 'book' path, every date/slot guard intact),
// asks for the missing data, or we keep the draft.

import type { BrainResult, ConvoContext, Language } from "../types.js";
import { claimsBooking } from "../services/booking-claims.js";
import { classifyEscalation } from "../services/slack-timeouts.js";

/** Hard deadline for the corrective call(s), book_trial round trip included. */
export const BOOKING_RETRY_TIMEOUT_MS = 20_000;
/** The retry never pushes the whole brain turn past this (first pass + retry). */
export const BOOKING_RETRY_TURN_BUDGET_MS = 45_000;
/** Less time than this left in the budget ⇒ no retry (it would only time out). */
export const BOOKING_RETRY_MIN_MS = 5_000;

export interface BookingRetryGate {
  /** The first pass's send_reply message. */
  reply: string;
  /** send_reply.escalation_reason of the first pass. */
  escalationReason?: string | null;
  /** A book_trial succeeded in the first pass (then there is nothing to fix). */
  bookedThisTurn: boolean;
  /** ctx.recordedBooking is set: the claim is backed by a real booking. */
  recordedBooking: boolean;
  /** ctx.staleReply is set: the redrive prompt forbids booking this turn. */
  staleReply: boolean;
  /** The client has the booking feature (book_trial exists in TOOLS). */
  bookingEnabled: boolean;
  /** ms the brain turn has already spent. */
  elapsedMs: number;
}

/**
 * Pure. The deadline (ms) for the ONE corrective call, or null when it must not
 * run. Fires exactly when guardUnbackedBookingClaim would demote the reply: it
 * claims a booking (claimsBooking), nothing was booked this turn and no
 * recorded booking backs it. Never on a stale redrive (its prompt says "NO
 * agendes"), never on an opt-out / complaint / private-class reply (those are
 * human paths whatever the text says), and never when the turn budget is spent.
 */
export function bookingRetryTimeoutMs(g: BookingRetryGate): number | null {
  if (!g.bookingEnabled || g.bookedThisTurn || g.recordedBooking || g.staleReply) return null;
  if (!claimsBooking(g.reply)) return null;
  const reason = g.escalationReason ?? "";
  if (/^\s*(?:opt[_ -]?out|complaint)\b/i.test(reason)) return null;
  const esc = classifyEscalation(reason);
  if (esc === "opt_out" || esc === "complaint" || esc === "private_class") return null;
  const left = BOOKING_RETRY_TURN_BUDGET_MS - Math.max(0, g.elapsedMs);
  const ms = Math.min(BOOKING_RETRY_TIMEOUT_MS, left);
  return ms >= BOOKING_RETRY_MIN_MS ? ms : null;
}

/** One line, no tags / guillemets, capped: the quote can't break the block. */
function quoteReply(reply: string, max = 300): string {
  const one = reply.replace(/\s+/g, " ").replace(/[<>«»]/g, "").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/**
 * Pure. The corrective block appended LAST to the per-turn <context>
 * (ConvoContext.bookingRetryInstruction). Spanish unless the contact is English.
 */
export function bookingRetryInstruction(lang: Language, reply: string): string {
  const q = quoteReply(reply);
  if (lang === "en") {
    return [
      "<reintento_agendado>",
      `Your previous reply tells the lead they are already booked («${q}») but you did NOT call book_trial, so nothing was registered.`,
      "- If the lead already accepted a day, time and discipline and you have the required data, call book_trial NOW with exactly that class, then end with send_reply confirming it.",
      "- If a required piece is missing (e.g. the name, or a minor's name and age) or the lead has not confirmed the time yet, do NOT say they are booked: ask for that piece in one short line with send_reply.",
      "</reintento_agendado>",
    ].join("\n");
  }
  return [
    "<reintento_agendado>",
    `Tu respuesta anterior le dice al lead que ya quedó apuntado («${q}») pero NO llamaste book_trial, así que no quedó nada registrado.`,
    "- Si el lead ya aceptó día, hora y disciplina y tienes los datos obligatorios, llama book_trial AHORA con esa misma clase y termina con send_reply confirmándola.",
    "- Si te falta un dato obligatorio (p. ej. el nombre, o el nombre y la edad de un menor) o el lead aún no confirma la hora, NO digas que quedó apuntado ni agendado: pide ese dato en una línea con send_reply.",
    "</reintento_agendado>",
  ].join("\n");
}

/** What the corrective call produced (claude.ts maps its tool loop onto this). */
export type BookingRetryRun =
  /** book_trial succeeded: `result` is the 'book' BrainResult (bookResult). */
  | { kind: "booked"; result: BrainResult }
  /** No booking; send_reply came back. `result` is the guarded send/draft. */
  | { kind: "reply"; result: BrainResult }
  | { kind: "timeout" }
  | { kind: "error"; detail: string }
  /** Escalation, text-only or iterations exhausted without a send_reply. */
  | { kind: "no_reply"; detail: string };

export type BookingRetryEnding =
  | "booked"
  | "asked"
  | "claimed_again"
  | "timeout"
  | "error"
  | "no_reply";

/**
 * Pure. Which result the turn returns after the retry. A booking wins; a reply
 * that no longer claims a booking (it asks for the missing data) replaces the
 * draft; anything else — the claim again, a timeout, an error, no send_reply —
 * keeps the first pass's ⚠️ draft exactly as it was.
 */
export function resolveBookingRetry(
  firstDraft: BrainResult,
  run: BookingRetryRun,
): { result: BrainResult; ending: BookingRetryEnding } {
  switch (run.kind) {
    case "booked":
      return { result: run.result, ending: "booked" };
    case "reply": {
      const r = run.result;
      if ((r.action === "send" || r.action === "draft") && !claimsBooking(r.message)) {
        return { result: r, ending: "asked" };
      }
      if (r.action !== "send" && r.action !== "draft") return { result: firstDraft, ending: "no_reply" };
      return { result: firstDraft, ending: "claimed_again" };
    }
    case "timeout":
      return { result: firstDraft, ending: "timeout" };
    case "error":
      return { result: firstDraft, ending: "error" };
    case "no_reply":
      return { result: firstDraft, ending: "no_reply" };
  }
}

/** Observability event for one retry (BrainDeps.onBookingRetry → ops_log). */
export interface BookingRetryEvent {
  phone: string;
  ending: BookingRetryEnding;
  /** Wall time of the corrective call(s). */
  ms: number;
  detail?: string;
}

const ENDING_ES: Record<BookingRetryEnding, string> = {
  booked: "agendó con book_trial ✅",
  asked: "ya no promete: pide el dato que falta",
  claimed_again: "volvió a prometer sin agendar → borrador ⚠️",
  timeout: "se agotó el tiempo → borrador ⚠️",
  error: "error de la API → borrador ⚠️",
  no_reply: "sin send_reply → borrador ⚠️",
};

/** Pure. The ONE ops_log line per retry. */
export function bookingRetryNote(ev: BookingRetryEvent): string {
  const tail = ev.detail ? ` (${ev.detail.replace(/\s+/g, " ").slice(0, 120)})` : "";
  return `🔁 Reintento de agendado ${ev.phone}: la respuesta prometía clase sin book_trial; reintento ${ENDING_ES[ev.ending]} en ${(ev.ms / 1000).toFixed(1)} s${tail}.`;
}

/** Pure. The ctx for the corrective call: same turn, instruction appended. */
export function withBookingRetry(ctx: ConvoContext, instruction: string): ConvoContext {
  return { ...ctx, bookingRetryInstruction: instruction };
}
