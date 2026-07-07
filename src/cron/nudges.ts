// Lead-nudge drip (replicates the old ManyChat sequence). When a LEAD receives a
// bot reply and goes quiet, we nudge them at +1h, +6h, +8h AFTER their last
// inbound — all inside the 24h WhatsApp window by construction, so every nudge
// is a free-form text. The final step surfaces the free trial + booking links.
//
// Copy lives here (pure, easy to edit). Scheduling math (computeNudgeTimes) and
// the rolling cap (underNudgeCap) are pure and unit-tested. armNudges/cancelNudges
// touch the DB and re-arm the drip idempotently.

import type { Contact, Env, Language, Qualification } from "../types.js";
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

// The three nudge kinds, in send order.
export const NUDGE_KINDS = ["nudge_1h", "nudge_6h", "nudge_8h"] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

// Kinds that mean "this lead already has a class booked" → suppress the drip.
export const BOOKING_KINDS = ["trial_confirm", "day_before", "same_day"] as const;

// Rolling cap: at most 3 nudges per contact per 7 days.
export const NUDGE_CAP = 3;
export const NUDGE_CAP_WINDOW_SECONDS = 7 * 86400;

const HOUR = 3600;

// ---- scheduling (pure) ----

export interface NudgeTime {
  kind: NudgeKind;
  dueAt: number; // epoch seconds
}

/**
 * The three nudge send times relative to the lead's last inbound epoch:
 * +1h, +6h, +8h. Pure. Callers skip any entry already in the past.
 */
export function computeNudgeTimes(lastInboundEpoch: number): NudgeTime[] {
  return [
    { kind: "nudge_1h", dueAt: lastInboundEpoch + 1 * HOUR },
    { kind: "nudge_6h", dueAt: lastInboundEpoch + 6 * HOUR },
    { kind: "nudge_8h", dueAt: lastInboundEpoch + 8 * HOUR },
  ];
}

// ---- rolling cap (pure) ----

/** kv payload for the rolling nudge cap: send timestamps within the window. */
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

/** Sends still inside the rolling 7-day window ending at `now`. */
function sendsInWindow(sends: number[], now: number): number[] {
  const cutoff = now - NUDGE_CAP_WINDOW_SECONDS;
  return sends.filter((t) => t > cutoff);
}

/**
 * True if the contact is still under the cap (fewer than NUDGE_CAP nudge sends
 * in the trailing 7 days). Pure over the kv JSON + now.
 */
export function underNudgeCap(kvJson: string | null, now: number): boolean {
  return sendsInWindow(parseNudgeKv(kvJson), now).length < NUDGE_CAP;
}

/**
 * Record a nudge send in the rolling-cap kv (drops entries older than the
 * window). Returns the updated JSON to persist.
 */
export function recordNudgeSend(kvJson: string | null, now: number): string {
  const sends = sendsInWindow(parseNudgeKv(kvJson), now);
  sends.push(now);
  return JSON.stringify({ sends } satisfies NudgeCountKv);
}

function nudgeCountKey(phone: string): string {
  return `nudge_count:${phone}`;
}

// ---- copy (pure) ----

function parseQualification(contact: Contact | null): Qualification {
  if (!contact?.qualification) return {};
  try {
    return JSON.parse(contact.qualification) as Qualification;
  } catch {
    return {};
  }
}

const ADULT_LINK = "https://mdcondesa.com/clase-prueba-adultos/";
const KIDS_LINK = "https://mdcondesa.com/clase-prueba-ninos/";

function firstName(contact: Contact | null, q: Qualification): string {
  const raw = (q.name ?? contact?.name ?? "").trim();
  if (!raw) return "";
  return raw.split(/\s+/)[0] ?? "";
}

function bookingLink(q: Qualification): string {
  return q.audience === "kid" ? KIDS_LINK : ADULT_LINK;
}

/**
 * Deterministic nudge copy per step. Warm, short, WhatsApp-style; escalating.
 * Step 3 (nudge_8h) names the free trial + booking link. Light personalization
 * with first name and discipline when known. Pure over (contact, kind).
 */
export function nudgeCopy(contact: Contact | null, kind: NudgeKind): string {
  const lang: Language = contact?.lang === "en" ? "en" : "es";
  const q = parseQualification(contact);
  const name = firstName(contact, q);
  const disc = (q.discipline ?? "").trim();
  const link = bookingLink(q);

  if (lang === "en") {
    const hi = name ? `Hi ${name}!` : "Hi!";
    switch (kind) {
      case "nudge_1h":
        return disc
          ? `${hi} Still here if you have any questions about ${disc} 🙂`
          : `${hi} Still around if you have any questions 🙂`;
      case "nudge_6h":
        return `${hi} No rush — whenever you're ready, I can help you find a class time that works for you 💪`;
      case "nudge_8h":
        return `${hi} Your first class is a FREE trial 🥋 Want to lock in a spot? You can book here: ${link}`;
    }
  }

  const hola = name ? `¡Hola ${name}!` : "¡Hola!";
  switch (kind) {
    case "nudge_1h":
      return disc
        ? `${hola} Sigo por aquí si te quedó alguna duda sobre ${disc} 🙂`
        : `${hola} Sigo por aquí si te quedó alguna duda 🙂`;
    case "nudge_6h":
      return `${hola} Sin prisa 🙂 cuando gustes te ayudo a encontrar un horario que te acomode 💪`;
    case "nudge_8h":
      return `${hola} Tu primera clase es una prueba GRATIS 🥋 ¿La agendamos? Puedes reservar aquí: ${link}`;
  }
  // Unreachable: kind is exhaustively a NudgeKind. Keeps the return type `string`.
  return `${hola} 🥋`;
}

// ---- arming / cancelling (DB) ----

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Whether the drip may be armed for this contact right now. All of:
 *  - status === 'lead'
 *  - not opted out (implied by status, but checked defensively)
 *  - no active human override
 *  - no active/future booking (no scheduled trial_confirm|day_before|same_day)
 *  - under the rolling nudge cap
 */
async function canArm(env: Env, contact: Contact): Promise<boolean> {
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
 * Arm (or re-arm) the lead-nudge drip after a bot reply was actually SENT to a
 * lead. Called from BOTH auto-send (pipeline) and approval approve/edit flows.
 *
 * Re-arm semantics: cancel any existing pending nudge_* rows first, then insert
 * fresh ones relative to the contact's last_inbound_at (skipping times already
 * past). Idempotent via UNIQUE(phone, kind, '') — but we cancel-then-insert so
 * a moved last_inbound produces a fresh schedule rather than stale rows.
 *
 * No-op (and cancels any stragglers) when conditions aren't met.
 */
export async function armNudges(env: Env, phone: string): Promise<void> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return;

  // Always clear existing pending nudges first (re-arm / suppression both need this).
  await cancelFollowupsByKinds(env.DB, phone, NUDGE_KINDS);

  if (!(await canArm(env, contact))) return;

  const base = contact.last_inbound_at ?? nowSec();
  const now = nowSec();
  for (const t of computeNudgeTimes(base)) {
    if (t.dueAt <= now) continue; // skip anything already past
    await scheduleFollowup(env.DB, {
      phone,
      kind: t.kind,
      dueAt: t.dueAt,
      airtableRecordId: "", // '' → UNIQUE(phone,kind,'') dedupe
      note: null,
    });
  }
}

/** Cancel all pending nudge_* rows for a phone (e.g. new inbound resets drip). */
export async function cancelNudges(
  env: Env,
  phone: string,
  status: string = "cancelled",
): Promise<void> {
  await cancelFollowupsByKinds(env.DB, phone, NUDGE_KINDS, status);
}

/**
 * Send-time processing for a due nudge row. Re-verifies the lead is still
 * eligible (lead / not opted / not overridden / no booking / under cap); sends
 * the free-form nudge; records the send in the rolling cap. Returns the terminal
 * status the caller should mark the followup with.
 *
 * `deps.sendText` throws WindowClosedError when the window is somehow closed
 * (shouldn't happen by construction) → we cancel rather than send a template.
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

// Re-exported for the pipeline opt-out path convenience.
export { cancelFollowups };
