// Lead-nudge drip. Day-1 (nudge_1h/6h/8h, in the 24h window → free-form) plus the
// extended multi-day sequence (nudge_d2…d5) from sequences-v2. Scheduling honors
// CDMX quiet hours (21:30–08:00): nudges 1–2 defer out of quiet, nudge 3 uses the
// window-aware placement rule, and the extended chain is quiet-shifted (see
// ./quiet.ts). Copy + program classification live in ./nudge-copy.ts.
//
// Pure math (computeNudgeTimes, computeDayOnePlan, computeExtendedChain,
// underNudgeCap) is unit-tested with fake clocks. armNudges/cancelNudges/
// maybeArmExtended touch the DB.

import type { Contact, Env } from "../types.js";
import {
  cancelFollowups,
  getContact,
  scheduleFollowup,
  kvGet,
  kvSet,
} from "../db/queries.js";
import {
  cancelFollowupsByKinds,
  hasScheduledFollowupOfKind,
} from "../db/queries-admin.js";
import { CLIENT } from "../client.gen.js";
import { DAY } from "./time.js";
import { shiftOutOfQuiet, placeNudge3 } from "./quiet.js";
import {
  NUDGE_KINDS,
  EXTENDED_NUDGE_KINDS,
  ALL_NUDGE_KINDS,
  nudgeCopy,
  classifyProgram,
  extendedCopy,
  extendedTemplateName,
  type NudgeKind,
  type ExtendedKind,
  type Program,
} from "./nudge-copy.js";

// Re-exported so followups.ts + tests keep a single import surface.
export {
  NUDGE_KINDS,
  EXTENDED_NUDGE_KINDS,
  ALL_NUDGE_KINDS,
  nudgeCopy,
  classifyProgram,
  extendedCopy,
  extendedTemplateName,
};
export type { NudgeKind, ExtendedKind, Program };

// Kinds that mean "this lead already has a class booked" → suppress the drip.
export const BOOKING_KINDS = ["trial_confirm", "day_before", "same_day"] as const;

// Rolling cap: at most 3 day-1 nudges per contact per 7 days. NOT applied to the
// extended chain (d2–d5 run once per sequence, guarded by seq_done below).
export const NUDGE_CAP = 3;
export const NUDGE_CAP_WINDOW_SECONDS = 7 * 86400;

// One extended sequence per lead per 30 days.
export const SEQ_GUARD_SECONDS = 30 * DAY;

const HOUR = 3600;

// ---- day-1 scheduling (pure) ----

export interface NudgeTime {
  kind: NudgeKind;
  dueAt: number; // epoch seconds
}

/**
 * The three natural nudge send times relative to the lead's last inbound epoch:
 * +1h, +6h, +8h (before any quiet-hour shifting). Pure.
 */
export function computeNudgeTimes(lastInboundEpoch: number): NudgeTime[] {
  return [
    { kind: "nudge_1h", dueAt: lastInboundEpoch + 1 * HOUR },
    { kind: "nudge_6h", dueAt: lastInboundEpoch + 6 * HOUR },
    { kind: "nudge_8h", dueAt: lastInboundEpoch + 8 * HOUR },
  ];
}

export interface DayOnePlan {
  /** Nudges to insert (kind + quiet-adjusted dueAt), in order, all future. */
  scheduled: NudgeTime[];
  /** True when nudge 3 was dropped (R2) → the extended day-2 message covers it. */
  nudge3Dropped: boolean;
  /** Anchor for the extended chain when nudge 3 is dropped (else null). */
  extendedAnchor: number | null;
}

/**
 * Quiet-aware day-1 schedule (R1 + R2). Given the lead's last-inbound `base` and
 * the current `now`:
 *  - nudges 1 & 2 (+1h/+6h) defer out of quiet to the next 08:00, preserve order,
 *    keep ≥2h between consecutive nudges, and drop if pushed past the 24h window;
 *  - nudge 3 (+8h) uses placeNudge3 (keep / pull-to-21:30 / defer-08:00 / drop).
 * Times already in the past (≤ now) are omitted. Pure over (base, now).
 */
export function computeDayOnePlan(base: number, now: number): DayOnePlan {
  const windowEnd = base + 24 * HOUR;
  const scheduled: NudgeTime[] = [];
  let prev = -Infinity;

  const place = (kind: NudgeKind, natural: number): void => {
    let s = shiftOutOfQuiet(natural);
    // Enforce ≥2h after the previous placed nudge (re-shift if the bump lands
    // back in quiet hours).
    if (Number.isFinite(prev) && s < prev + 2 * HOUR) {
      s = shiftOutOfQuiet(prev + 2 * HOUR);
    }
    if (s >= windowEnd) return; // beyond the window → drop
    prev = s;
    if (s > now) scheduled.push({ kind, dueAt: s });
  };

  place("nudge_1h", base + 1 * HOUR);
  place("nudge_6h", base + 6 * HOUR);

  // nudge 2 reference for the ≥2h guard: placed nudge_6h, else nudge_1h, else the
  // shifted natural +6h (covers the case where both were pushed past now).
  const nudge2Time =
    scheduled.find((p) => p.kind === "nudge_6h")?.dueAt ??
    scheduled.find((p) => p.kind === "nudge_1h")?.dueAt ??
    shiftOutOfQuiet(base + 6 * HOUR);

  const natural3 = base + 8 * HOUR;
  const p3 = placeNudge3(natural3, nudge2Time, windowEnd, now);
  if ("dueAt" in p3) {
    scheduled.push({ kind: "nudge_8h", dueAt: p3.dueAt });
    return { scheduled, nudge3Dropped: false, extendedAnchor: null };
  }
  // Dropped → anchor the extended chain off the (quiet-shifted) natural nudge-3
  // time so the day-2 message takes over.
  return {
    scheduled,
    nudge3Dropped: true,
    extendedAnchor: shiftOutOfQuiet(natural3),
  };
}

// ---- extended scheduling (pure) ----

export interface ExtendedTime {
  kind: ExtendedKind;
  dueAt: number;
}

/**
 * The extended chain relative to nudge 3's actual send: d2 = +24h, d3 = +24h
 * after d2, … each quiet-shifted to the next 08:00 when it lands in quiet hours.
 * Pure over the anchor.
 */
export function computeExtendedChain(anchorSend: number): ExtendedTime[] {
  const out: ExtendedTime[] = [];
  let t = anchorSend;
  for (const kind of EXTENDED_NUDGE_KINDS) {
    t = shiftOutOfQuiet(t + 24 * HOUR);
    out.push({ kind, dueAt: t });
  }
  return out;
}

// ---- rolling cap (pure) ----

interface NudgeCountKv {
  sends: number[]; // epoch seconds of recent nudge sends
}

function parseNudgeKv(json: string | null): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Partial<NudgeCountKv>;
    if (Array.isArray(parsed.sends)) {
      return parsed.sends.filter((n): n is number => typeof n === "number");
    }
  } catch {
    // corrupt kv → treat as empty
  }
  return [];
}

function sendsInWindow(sends: number[], now: number): number[] {
  const cutoff = now - NUDGE_CAP_WINDOW_SECONDS;
  return sends.filter((t) => t > cutoff);
}

/** True if the contact is still under the day-1 nudge cap. Pure. */
export function underNudgeCap(kvJson: string | null, now: number): boolean {
  return sendsInWindow(parseNudgeKv(kvJson), now).length < NUDGE_CAP;
}

/** Record a nudge send in the rolling-cap kv; returns the JSON to persist. */
export function recordNudgeSend(kvJson: string | null, now: number): string {
  const sends = sendsInWindow(parseNudgeKv(kvJson), now);
  sends.push(now);
  return JSON.stringify({ sends } satisfies NudgeCountKv);
}

function nudgeCountKey(phone: string): string {
  return `nudge_count:${phone}`;
}

function seqDoneKey(phone: string): string {
  return `seq_done:${phone}`;
}

// ---- arming / cancelling (DB) ----

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Whether the day-1 drip may be armed for this contact now: status lead, no
 * active override, no active/future booking, and under the rolling cap.
 */
async function canArm(env: Env, contact: Contact): Promise<boolean> {
  if (!CLIENT.features.nudges) return false;
  if (contact.status !== "lead") return false;
  const now = nowSec();
  if (contact.human_override_until && contact.human_override_until > now) {
    return false;
  }
  const hasBooking = await hasScheduledFollowupOfKind(
    env.DB,
    contact.phone,
    BOOKING_KINDS,
  );
  if (hasBooking) return false;
  const kv = await kvGet(env.DB, nudgeCountKey(contact.phone));
  if (!underNudgeCap(kv, now)) return false;
  return true;
}

/**
 * Arm (or re-arm) the day-1 lead-nudge drip after a bot reply was SENT to a lead.
 * Clears existing pending day-1 nudges, then inserts the quiet-aware schedule
 * (computeDayOnePlan). If nudge 3 is dropped, the extended sequence is armed
 * immediately so the day-2 message takes over. No-op when conditions aren't met.
 */
export async function armNudges(env: Env, phone: string): Promise<void> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return;

  // Always clear existing pending day-1 nudges first (re-arm / suppression).
  await cancelFollowupsByKinds(env.DB, phone, NUDGE_KINDS);

  if (!(await canArm(env, contact))) return;

  const base = contact.last_inbound_at ?? nowSec();
  const now = nowSec();
  const plan = computeDayOnePlan(base, now);
  for (const t of plan.scheduled) {
    await scheduleFollowup(env.DB, {
      phone,
      kind: t.kind,
      dueAt: t.dueAt,
      airtableRecordId: "", // '' → UNIQUE(phone,kind,'') dedupe
      note: null,
    });
  }
  if (plan.nudge3Dropped && plan.extendedAnchor !== null) {
    await maybeArmExtended(env, phone, plan.extendedAnchor);
  }
}

/**
 * Schedule the extended chain (d2–d5) once per lead per 30 days, anchored at
 * `anchorSend` (nudge 3's actual send, or the dropped-nudge-3 anchor). Guarded by
 * kv `seq_done:<phone>` (epoch). Rows carry a per-sequence record-id token so a
 * later (>30d) sequence can be re-inserted despite the followups UNIQUE index.
 */
export async function maybeArmExtended(
  env: Env,
  phone: string,
  anchorSend: number,
): Promise<void> {
  if (!CLIENT.features.nudges) return;
  const now = nowSec();
  const key = seqDoneKey(phone);
  const prev = await kvGet(env.DB, key);
  if (prev) {
    const prevEpoch = Number(prev);
    if (Number.isFinite(prevEpoch) && now - prevEpoch < SEQ_GUARD_SECONDS) {
      return; // already ran an extended sequence within the last 30 days
    }
  }
  await kvSet(env.DB, key, String(now));
  const token = `seq:${anchorSend}`;
  for (const t of computeExtendedChain(anchorSend)) {
    await scheduleFollowup(env.DB, {
      phone,
      kind: t.kind,
      dueAt: t.dueAt,
      airtableRecordId: token,
      note: null,
    });
  }
}

/** Cancel all pending nudge rows (day-1 + extended) for a phone. */
export async function cancelNudges(
  env: Env,
  phone: string,
  status: string = "cancelled",
): Promise<void> {
  await cancelFollowupsByKinds(env.DB, phone, ALL_NUDGE_KINDS, status);
}

/**
 * Send-time processing for a due DAY-1 nudge. Re-verifies eligibility (lead / not
 * opted / not overridden / no booking / under cap), sends the free-form nudge,
 * and records the send in the rolling cap. A closed window → cancel (no template
 * for day-1 nudges; they are in-window by construction).
 */
export async function processNudge(
  env: Env,
  phone: string,
  kind: NudgeKind,
  deps: {
    sendText: (env: Env, phone: string, body: string) => Promise<string>;
    isWindowClosed: (err: unknown) => boolean;
  },
): Promise<"sent" | "cancelled" | "skipped_optout"> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return "cancelled";
  if (contact.status === "opted_out") return "skipped_optout";
  if (contact.status !== "lead") return "cancelled";

  const now = nowSec();
  if (contact.human_override_until && contact.human_override_until > now) {
    return "cancelled";
  }
  if (await hasScheduledFollowupOfKind(env.DB, phone, BOOKING_KINDS)) {
    return "cancelled";
  }
  const kvKey = nudgeCountKey(phone);
  const kv = await kvGet(env.DB, kvKey);
  if (!underNudgeCap(kv, now)) return "cancelled";

  try {
    await deps.sendText(env, phone, nudgeCopy(contact, kind));
  } catch (err) {
    if (deps.isWindowClosed(err)) return "cancelled";
    throw err;
  }
  await kvSet(env.DB, kvKey, recordNudgeSend(kv, now));
  return "sent";
}

/**
 * Send-time processing for a due EXTENDED nudge (d2–d5). Re-verifies eligibility
 * (NO cap check — the extended chain is not capped). Tries free-form first (CTWA
 * 72h windows make this common); on a closed window falls back to the per-program
 * template. When the template is missing/unapproved the caller is told to skip
 * (returns null) so it can post the throttled Slack note.
 */
export async function processExtendedNudge(
  env: Env,
  phone: string,
  kind: ExtendedKind,
  deps: {
    sendText: (env: Env, phone: string, body: string) => Promise<string>;
    sendTemplate: (
      env: Env,
      phone: string,
      name: string,
      lang: string,
    ) => Promise<string>;
    templateName: (base: string, lang: string) => string;
    isWindowClosed: (err: unknown) => boolean;
    campaignName: (env: Env, campaignId: number) => Promise<string | null>;
  },
): Promise<
  | { outcome: "sent" }
  | { outcome: "cancelled" }
  | { outcome: "skipped_optout" }
  | { outcome: "template_missing"; template: string }
> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return { outcome: "cancelled" };
  if (contact.status === "opted_out") return { outcome: "skipped_optout" };
  if (contact.status !== "lead") return { outcome: "cancelled" };
  const now = nowSec();
  if (contact.human_override_until && contact.human_override_until > now) {
    return { outcome: "cancelled" };
  }
  if (await hasScheduledFollowupOfKind(env.DB, phone, BOOKING_KINDS)) {
    return { outcome: "cancelled" };
  }

  const campaignName =
    contact.campaign_id !== null
      ? await deps.campaignName(env, contact.campaign_id)
      : null;
  const program = classifyProgram(contact, campaignName);
  const body = extendedCopy(contact, kind, program);

  try {
    await deps.sendText(env, phone, body); // free-form (window open)
    return { outcome: "sent" };
  } catch (err) {
    if (!deps.isWindowClosed(err)) throw err;
  }

  // Window closed → per-program template fallback.
  const lang = contact.lang === "en" ? "en" : "es";
  const base = extendedTemplateName(kind, program);
  const template = deps.templateName(base, lang);
  try {
    await deps.sendTemplate(env, phone, template, lang);
    return { outcome: "sent" };
  } catch {
    return { outcome: "template_missing", template };
  }
}

// Re-exported for the pipeline opt-out path convenience.
export { cancelFollowups };
