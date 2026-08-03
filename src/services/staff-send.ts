// Staff replies from the admin dashboard inbox. One entry point, deps-injected
// (like cron/nudges) so the decision logic is unit-testable with a fake db and
// stub senders. Semantics mirror the coexistence-echo takeover (routes/
// whatsapp.ts onEcho): a human replying = the human owns the conversation —
// log the message, pause the bot, cancel pending drafts, note it in Slack.
// Per Evan's call (2026-08-03): the pause is effectively indefinite (1 year)
// until someone taps Reanudar in the dashboard.

import type { Env, StoredMessage } from "../types.js";
import {
  cancelPendingApprovals,
  getContact,
  kvSetIfAbsent,
  setHumanOverride,
} from "../db/queries.js";

/** WA Cloud API text body limit. */
export const STAFF_TEXT_MAX = 4096;

/** "Until Reanudar": setHumanOverride takes hours; a year is effectively ∞. */
export const STAFF_TAKEOVER_HOURS = 24 * 365;

export type StaffSendResult =
  | { ok: true; message: StoredMessage }
  | {
      ok: false;
      reason: "empty" | "too_long" | "no_contact" | "duplicate" | "window_closed";
    };

export interface StaffSendDeps {
  sendText(
    env: Env,
    phone: string,
    body: string,
    opts: { direction: "out_human"; metaExtra: Record<string, unknown> },
  ): Promise<string>;
  isWindowClosed(err: unknown): boolean;
  postNote(env: Env, text: string): Promise<void>;
}

/**
 * Sends a staff-typed reply to a lead. `clientToken` is a per-submit UUID from
 * the SPA — claimed in kv BEFORE the Graph call so a retry after an ambiguous
 * failure can never double-message the lead (at-most-once bias: a burned token
 * on a genuinely failed send just means the SPA retries with a fresh token).
 */
export async function sendStaffText(
  env: Env,
  phone: string,
  rawText: string,
  byUsername: string,
  clientToken: string,
  deps: StaffSendDeps,
): Promise<StaffSendResult> {
  const text = rawText.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > STAFF_TEXT_MAX) return { ok: false, reason: "too_long" };

  const contact = await getContact(env.DB, phone);
  if (!contact) return { ok: false, reason: "no_contact" };

  const claimed = await kvSetIfAbsent(
    env.DB,
    `staff_send:${phone}:${clientToken}`,
    String(Math.floor(Date.now() / 1000)),
  );
  if (!claimed) return { ok: false, reason: "duplicate" };

  let wamid: string;
  try {
    wamid = await deps.sendText(env, phone, text, {
      direction: "out_human",
      metaExtra: { by: byUsername },
    });
  } catch (err) {
    if (deps.isWindowClosed(err)) return { ok: false, reason: "window_closed" };
    throw err; // route surfaces a 500; token stays burned (at-most-once)
  }

  // Takeover triad (onEcho precedent). The message row itself was already
  // written by sendText/recordOutbound.
  await setHumanOverride(env.DB, phone, STAFF_TAKEOVER_HOURS);
  await cancelPendingApprovals(env.DB, phone, "taken_over");
  const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  try {
    await deps.postNote(env, `🧑‍💻 ${byUsername} respondió desde el panel a ${phone}: «${preview}»`);
  } catch (err) {
    console.error("staff-send slack note failed", err);
  }

  return {
    ok: true,
    message: {
      wamid,
      phone,
      direction: "out_human",
      body: text,
      ts: Math.floor(Date.now() / 1000),
      meta: JSON.stringify({ type: "text", by: byUsername }),
    },
  };
}
