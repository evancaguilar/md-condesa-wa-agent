// Gated auto-send ("auto-envío seguro"): a narrow, always-on lane that lets an
// OBVIOUSLY safe reply go straight to the lead even while training wheels are
// ON. It is deliberately much stricter than the wheels-off path — that one
// auto-sends every high-confidence reply; this one only fires when EVERY gate
// below passes, so the worst case is "the lead got a boring correct answer 20
// minutes sooner".
//
// Gate order (first failure wins, and is reported as `blockedBy`):
//   switch        — kv `auto_send_enabled` !== "1" (missing key = OFF).
//   action        — only the brain's plain `send`; drafts/escalations/books stay
//                   in the approval queue.
//   confidence    — only "high".
//   booking_claim — the copy claims a booked class (shared regex with the brain
//                   guard + the nightly reconciliation): a promise about a real
//                   calendar slot always gets human eyes.
//   price         — the copy mentions money/promos/inscripción: pricing is the
//                   #1 thing Evan re-words, so it never auto-sends.
//   first_contact — the phone has no approval a human ever approved/edited. The
//                   FIRST reply of a conversation is always human-reviewed;
//                   the lane only speeds up chats already signed off on once.
//   cap           — AUTO_SEND_DAILY_CAP auto-sends per CDMX day. A blast radius
//                   limit: if the lane misbehaves it stops on its own.
//
// The master override is unchanged: TRAINING_WHEELS off ⇒ the old wheels-off
// path already auto-sends and this lane never runs; kv switch off ⇒ the lane is
// completely dead and every reply queues for approval exactly like today.

import { kvGet, kvSet } from "../db/queries.js";
import { hasResolvedApproval } from "../db/queries-admin.js";
import { cdmxDateStr } from "../cron/time.js";
import { claimsBooking } from "./booking-claims.js";

/** kv master switch. "1" = lane armed; anything else (incl. missing) = OFF. */
export const AUTO_SEND_KV = "auto_send_enabled";

/** Max auto-sends per CDMX day, across all leads. */
export const AUTO_SEND_DAILY_CAP = 20;

/**
 * Money / promo vocabulary. Any hit keeps the reply in the approval queue:
 * prices, promos and inscripción terms are exactly what a human rewrites.
 * Prefix forms (`inscripci`, `membres`) cover inscripción/inscripciones and
 * membresía/membresías without fighting diacritics.
 */
export const PRICE_PROMO_RE =
  /\$|\bprecio|\bcosto|\bpromo|\bdescuento|\bmxn\b|\binscripci|\bmensualidad|\bmembres/i;

/** Why the lane refused. Ordered exactly like the gates run. */
export type AutoSendBlockReason =
  | "switch"
  | "action"
  | "confidence"
  | "booking_claim"
  | "price"
  | "first_contact"
  | "cap";

export interface AutoSendGateInput {
  action: string;
  confidence: string;
  message: string;
  /** Phone had >=1 approval a human resolved as approved|edited. */
  hasPriorResolvedApproval: boolean;
  /** Auto-sends already made today (CDMX). */
  dailyCount: number;
  /** kv master switch. */
  enabled: boolean;
}

export interface AutoSendDecision {
  auto: boolean;
  blockedBy?: AutoSendBlockReason;
}

/** Pure gate stack. No clock, no D1 — the whole safety contract in one place. */
export function decideAutoSend(i: AutoSendGateInput): AutoSendDecision {
  if (!i.enabled) return { auto: false, blockedBy: "switch" };
  if (i.action !== "send") return { auto: false, blockedBy: "action" };
  if (i.confidence !== "high") return { auto: false, blockedBy: "confidence" };
  if (claimsBooking(i.message)) return { auto: false, blockedBy: "booking_claim" };
  if (PRICE_PROMO_RE.test(i.message)) return { auto: false, blockedBy: "price" };
  if (!i.hasPriorResolvedApproval) return { auto: false, blockedBy: "first_contact" };
  if (i.dailyCount >= AUTO_SEND_DAILY_CAP) return { auto: false, blockedBy: "cap" };
  return { auto: true };
}

// ---- runtime helpers (D1-backed) ----

/** kv key holding the auto-send counter for one CDMX day. */
export function autoSendCountKey(day: string): string {
  return `auto_send_count:${day}`;
}

/** Master switch read. A MISSING key means disabled — the lane ships inert. */
export async function isAutoSendEnabled(db: D1Database): Promise<boolean> {
  return (await kvGet(db, AUTO_SEND_KV)) === "1";
}

/** Flips the master switch (Slack control panel + /admin/api/autosend). */
export async function setAutoSendEnabled(
  db: D1Database,
  enabled: boolean,
): Promise<void> {
  await kvSet(db, AUTO_SEND_KV, enabled ? "1" : "0");
}

/** Parses a stored counter value; garbage/absent reads as 0. */
function parseCount(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Auto-sends made so far on `day` (defaults to today in CDMX). */
export async function getAutoSendCount(
  db: D1Database,
  day: string = cdmxDateStr(Math.floor(Date.now() / 1000)),
): Promise<number> {
  return parseCount(await kvGet(db, autoSendCountKey(day)));
}

/**
 * Read-modify-write bump of the per-day counter; returns the new count. The
 * key is day-scoped so a new CDMX day starts at zero with no cleanup step (a
 * lost race would undercount by one — acceptable for a blast-radius cap).
 */
export async function bumpAutoSendCount(
  db: D1Database,
  cdmxDay: string,
): Promise<number> {
  const key = autoSendCountKey(cdmxDay);
  const next = parseCount(await kvGet(db, key)) + 1;
  await kvSet(db, key, String(next));
  return next;
}

/** True when a human already approved/edited at least one draft for `phone`. */
export function hasPriorResolvedApproval(
  db: D1Database,
  phone: string,
): Promise<boolean> {
  return hasResolvedApproval(db, phone);
}

export interface AutoSendLaneInput {
  phone: string;
  action: string;
  confidence: string;
  message: string;
  /** Injectable clock (epoch seconds) for tests. */
  now?: number;
}

export interface AutoSendLaneResult extends AutoSendDecision {
  /** Auto-sends already made today, BEFORE this one. */
  dailyCount: number;
  /** CDMX day the decision was made on — pass it to bumpAutoSendCount. */
  day: string;
  /** Cap, so the caller can render "n/cap hoy" without re-importing it. */
  cap: number;
}

/**
 * The whole lane decision for one brain reply, D1 reads included. Kept here
 * (not in the pipeline) so it is unit-testable: inbound.ts only calls this and
 * acts on the answer.
 *
 * Two passes over the pure gate: the first runs with the per-lead facts
 * OPTIMISTICALLY assumed to pass, purely so a message that is ineligible on its
 * own text (wrong action, low confidence, booking claim, price) costs a single
 * kv read instead of three queries. The returned decision always comes from the
 * second pass, with the real values.
 */
export async function evaluateAutoSendLane(
  db: D1Database,
  input: AutoSendLaneInput,
): Promise<AutoSendLaneResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const day = cdmxDateStr(now);
  const base = {
    action: input.action,
    confidence: input.confidence,
    message: input.message,
  };
  const enabled = await isAutoSendEnabled(db);
  const cheap = decideAutoSend({
    ...base,
    enabled,
    hasPriorResolvedApproval: true,
    dailyCount: 0,
  });
  if (!cheap.auto) return { ...cheap, dailyCount: 0, day, cap: AUTO_SEND_DAILY_CAP };

  const prior = await hasPriorResolvedApproval(db, input.phone);
  const dailyCount = await getAutoSendCount(db, day);
  const decision = decideAutoSend({
    ...base,
    enabled,
    hasPriorResolvedApproval: prior,
    dailyCount,
  });
  return { ...decision, dailyCount, day, cap: AUTO_SEND_DAILY_CAP };
}
