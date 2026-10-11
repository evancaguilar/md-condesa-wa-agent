// Replies to the trial-reminder templates' quick-reply buttons ("Ahí estaré" /
// "Necesito reagendar", docs/templates.md). Pure module — unit-tested.
//
// 2026-10 (…2139): "Ahí estaré" went through the brain and was answered 6.5 h
// later with "te esperamos hoy a las 9 am" — after the class. Owner decision:
// "Ahí estaré" → no brain turn (silence, or a fixed one-liner when
// CLIENT.copy.reminderAckEs is set); "Necesito reagendar" → a brain turn with a
// <reschedule> hint. Nothing is written to Airtable here.

import { normalizeText } from "./campaigns.js";

export type ReminderReply = "confirm" | "reschedule";

/** A typed (non-button) reply only counts this soon after a reminder went out. */
export const REMINDER_REPLY_WINDOW_SEC = 12 * 3600;

const CONFIRM = new Set(["ahi estare", "alli estare", "ahi estaremos", "i ll be there", "ill be there", "we ll be there"]);
const RESCHEDULE = new Set(["necesito reagendar", "i need to reschedule", "need to reschedule", "quiero reagendar"]);

/**
 * Pure. "confirm" / "reschedule" for a reminder reply, else null.
 *  - `kind === "button"` (template quick reply): the button text alone decides.
 *  - typed text: exact phrase (normalized, emoji/punctuation stripped) AND a
 *    day_before / same_day reminder sent within the last 12 h.
 */
export function classifyReminderReply(opts: {
  body: string;
  kind?: string;
  reminders: readonly { kind: string; due_at: number }[];
  now: number;
}): ReminderReply | null {
  const n = normalizeText(opts.body);
  const which: ReminderReply | null = CONFIRM.has(n) ? "confirm" : RESCHEDULE.has(n) ? "reschedule" : null;
  if (!which) return null;
  if (opts.kind === "button") return which;
  const recent = opts.reminders.some(
    (r) =>
      (r.kind === "day_before" || r.kind === "same_day") &&
      r.due_at <= opts.now &&
      opts.now - r.due_at <= REMINDER_REPLY_WINDOW_SEC,
  );
  return recent ? which : null;
}

/** "{name}" filled with the first word of the contact name (or dropped). */
export function reminderAckText(template: string, name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = /\p{L}/u.test(first) ? first : "";
  return template.replace(/\s*\{name\}/g, clean ? ` ${clean}` : "").trim();
}
