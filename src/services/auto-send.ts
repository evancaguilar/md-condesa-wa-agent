// Gated auto-send ("auto-envío seguro"): the lane that lets a reply go straight
// to the lead while training wheels are ON.
//
// Owner directive 2026-08-25 — "if it's at least 75% sure it has the correct
// answer, it sends. only asks for approval if it's less than 75% sure" — turned
// this from a narrow, hand-tuned allowlist into a straight sureness threshold.
// The topic-based gates (price copy, first contact of a conversation) were
// REMOVED: calibration now lives in the model's sureness checklist (persona.md
// box 3 is exactly the price caution the `price` gate used to encode), and a
// reply the model is <75% sure about never reaches this lane in the first place.
//
// Gate order (first failure wins, and is reported as `blockedBy`):
//   switch        — kv `auto_send_enabled` !== "1" (missing key = OFF).
//   action        — only the brain's plain `send`; drafts/escalations/books stay
//                   in the approval queue.
//   sureness      — the model's 0–100 self-report must be >= SURENESS_SEND_MIN.
//                   Missing (legacy result) ⇒ derived from the old enum.
//   booking_claim — the copy claims a booked class (shared regex with the brain
//                   guard + the nightly reconciliation). NOT a caution gate but
//                   a correctness lock: an unbacked "ya quedó agendado" means no
//                   Airtable record and no anti-no-show sequence, whatever the
//                   model's sureness says. Real bookings never come through here
//                   (they return a 'book' result and take the booking path).
//   cap           — AUTO_SEND_DAILY_CAP auto-sends per CDMX day: a circuit
//                   breaker, not a throttle. The gate below only PRE-SCREENS the
//                   count; the binding decision is tryClaimAutoSendSlot, claimed
//                   atomically right before the send so concurrent webhooks
//                   can't overshoot the cap.
//
// The master override is unchanged: TRAINING_WHEELS off ⇒ the old wheels-off
// path already auto-sends and this lane never runs; kv switch off ⇒ the lane is
// completely dead and every reply queues for approval exactly like today.

import { kvDecrement, kvGet, kvIncrementIfBelow, kvSet } from "../db/queries.js";
import { cdmxDateStr } from "../cron/time.js";
import { claimsBooking } from "./booking-claims.js";

/** kv master switch. "1" = lane armed; anything else (incl. missing) = OFF. */
export const AUTO_SEND_KV = "auto_send_enabled";

/**
 * Max auto-sends per CDMX day, across all leads. Raised 20 → 100 by the same
 * 2026-08-25 directive: with sureness deciding what sends, the cap stops being
 * a daily ration and becomes a blast-radius limit — if the lane misbehaves it
 * stops on its own, but it must not silently mute a busy day of ad traffic.
 */
export const AUTO_SEND_DAILY_CAP = 100;

/** A reply this sure (0–100) sends with no human in the loop. */
export const SURENESS_SEND_MIN = 75;

/**
 * Sureness for a result that predates the field (or whose model call dropped
 * it): map the legacy enum onto the scale. "high" lands above the send
 * threshold, "low" comfortably below it and above the best-bet floor, so old
 * and new results behave identically.
 */
export function surenessOf(sureness: number | undefined, confidence: string): number {
  return sureness ?? (confidence === "high" ? 85 : 50);
}

/** Why the lane refused. Ordered exactly like the gates run. */
export type AutoSendBlockReason =
  | "switch"
  | "action"
  | "sureness"
  | "booking_claim"
  | "cap";

export interface AutoSendGateInput {
  action: string;
  /** Legacy enum — only used as the fallback when `sureness` is absent. */
  confidence: string;
  /** Model's 0–100 self-report (BrainResult.sureness). */
  sureness?: number;
  message: string;
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
  if (surenessOf(i.sureness, i.confidence) < SURENESS_SEND_MIN) {
    return { auto: false, blockedBy: "sureness" };
  }
  if (claimsBooking(i.message)) return { auto: false, blockedBy: "booking_claim" };
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
 * Atomically claim ONE of the day's auto-send slots: true only if the counter
 * was still below `cap`, and it has now been bumped. This — not the pure gate's
 * `dailyCount < cap` pre-screen — is what actually enforces the cap: the old
 * read-modify-write bump let two concurrent webhooks both read `cap-1` and both
 * send. The key is day-scoped, so a new CDMX day starts at zero with no cleanup.
 */
export function tryClaimAutoSendSlot(
  db: D1Database,
  cdmxDay: string,
  cap: number = AUTO_SEND_DAILY_CAP,
): Promise<boolean> {
  return kvIncrementIfBelow(db, autoSendCountKey(cdmxDay), cap);
}

/** Hand a claimed slot back when the send never happened (delivery degraded). */
export function releaseAutoSendSlot(
  db: D1Database,
  cdmxDay: string,
): Promise<void> {
  return kvDecrement(db, autoSendCountKey(cdmxDay));
}

export interface AutoSendLaneInput {
  phone: string;
  action: string;
  confidence: string;
  /** Model's 0–100 self-report; absent falls back to the enum (surenessOf). */
  sureness?: number;
  message: string;
  /** Injectable clock (epoch seconds) for tests. */
  now?: number;
}

export interface AutoSendLaneResult extends AutoSendDecision {
  /** Auto-sends already made today, BEFORE this one. */
  dailyCount: number;
  /** CDMX day the decision was made on — pass it to tryClaimAutoSendSlot. */
  day: string;
  /** Cap, so the caller can render "n/cap hoy" without re-importing it. */
  cap: number;
}

/**
 * The whole lane decision for one brain reply, D1 reads included. Kept here
 * (not in the pipeline) so it is unit-testable: inbound.ts only calls this and
 * acts on the answer.
 *
 * Two passes over the pure gate: the first runs with the counter optimistically
 * at zero, purely so a message that is ineligible on its own (wrong action, not
 * sure enough, booking claim) costs a single kv read instead of two. The
 * returned decision always comes from the second pass, with the real count.
 * (The per-lead prior-approval query died with the first_contact gate.)
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
    sureness: input.sureness,
    message: input.message,
  };
  const enabled = await isAutoSendEnabled(db);
  const cheap = decideAutoSend({ ...base, enabled, dailyCount: 0 });
  if (!cheap.auto) return { ...cheap, dailyCount: 0, day, cap: AUTO_SEND_DAILY_CAP };

  const dailyCount = await getAutoSendCount(db, day);
  const decision = decideAutoSend({ ...base, enabled, dailyCount });
  return { ...decision, dailyCount, day, cap: AUTO_SEND_DAILY_CAP };
}
