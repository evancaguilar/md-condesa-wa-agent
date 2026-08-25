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

/** kv key that makes a staff send at-most-once. Exported so the cron can
 *  release a claim after a DEFINITE Graph failure (nothing was sent) and let
 *  the retry actually resend. */
export function staffSendClaimKey(phone: string, clientToken: string): string {
  return `staff_send:${phone}:${clientToken}`;
}

/** "Until Reanudar": setHumanOverride takes hours; a year is effectively ∞. */
export const STAFF_TAKEOVER_HOURS = 24 * 365;

export type StaffSendResult =
  | { ok: true; message: StoredMessage }
  | {
      ok: false;
      reason:
        | "empty"
        | "too_long"
        | "no_contact"
        | "duplicate"
        | "window_closed"
        | "opted_out";
    };

/** Staff sends to an opted-out lead need an explicit override (force:true). */
export interface StaffSendOpts {
  force?: boolean;
}

export interface StaffSendDeps {
  sendText(
    env: Env,
    phone: string,
    body: string,
    opts: { direction: "out_human"; metaExtra: Record<string, unknown> },
  ): Promise<string>;
  isWindowClosed(err: unknown): boolean;
  postNote(env: Env, text: string): Promise<void>;
  /**
   * Slice 4 post-send audit (services/booking-guard.auditHumanSend): a staff
   * reply that CONFIRMS a class writes nothing to Airtable on its own, so this
   * turns it into a one-tap Slack capture card. Optional so existing callers /
   * tests can omit it; awaited, because Workers kill floating promises.
   */
  auditSend?(env: Env, phone: string, text: string, by: string): Promise<void>;
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
  opts?: StaffSendOpts,
): Promise<StaffSendResult> {
  const text = rawText.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > STAFF_TEXT_MAX) return { ok: false, reason: "too_long" };

  const contact = await getContact(env.DB, phone);
  if (!contact) return { ok: false, reason: "no_contact" };
  // Checked before the token claim so an override retry isn't burned.
  if (contact.status === "opted_out" && opts?.force !== true) {
    return { ok: false, reason: "opted_out" };
  }

  const claimed = await kvSetIfAbsent(
    env.DB,
    staffSendClaimKey(phone, clientToken),
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
  if (deps.auditSend) {
    try {
      await deps.auditSend(env, phone, text, byUsername);
    } catch (err) {
      console.error("staff-send booking audit failed", err);
    }
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

// ---- scheduled staff sends (F2 "send later") ----

/** Payload stored in followups.note for kind='staff_later'. */
export interface StaffLaterNote {
  text: string;
  by: string;
}

/** Furthest a staff reply may be queued into the future. */
export const STAFF_LATER_MAX_HORIZON_SECONDS = 14 * 24 * 3600;

/** Client idempotency token shape accepted by the send-later route. */
export const STAFF_LATER_TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function staffLaterNote(text: string, by: string): string {
  return JSON.stringify({ text, by });
}

/**
 * cron/followups.bumpAttempts appends '|attempts:N' to `note` on transient
 * failures, so the suffix MUST be stripped before JSON.parse (mirror of
 * readAttempts). Returns null for anything unparseable — callers cancel the row
 * rather than throwing, so one bad note can never stall the tick.
 */
export function parseStaffLaterNote(note: string | null): StaffLaterNote | null {
  const raw = (note ?? "").replace(/\s*\|?attempts:\d+$/, "").trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as { text?: unknown; by?: unknown };
  if (typeof o.text !== "string" || !o.text.trim()) return null;
  return { text: o.text, by: typeof o.by === "string" ? o.by : "" };
}

// ---- staff media send (R2: dashboard attachments) ----

export interface StaffMediaInput {
  kind: "image" | "video" | "document";
  mediaId: string; // already uploaded via wa.uploadMedia
  caption?: string;
  filename?: string;
}

export interface StaffMediaDeps {
  sendMedia(
    env: Env,
    phone: string,
    kind: StaffMediaInput["kind"],
    mediaId: string,
    opts: {
      caption?: string;
      filename?: string;
      direction: "out_human";
      metaExtra: Record<string, unknown>;
    },
  ): Promise<string>;
  isWindowClosed(err: unknown): boolean;
  postNote(env: Env, text: string): Promise<void>;
}

const KIND_LABEL: Record<StaffMediaInput["kind"], string> = {
  image: "una imagen 📷",
  video: "un video 🎬",
  document: "un documento 📄",
};

/**
 * Sends a staff-attached media message. Identical semantics to sendStaffText:
 * token claimed BEFORE the Graph send (at-most-once), then the takeover triad.
 */
export async function sendStaffMedia(
  env: Env,
  phone: string,
  input: StaffMediaInput,
  byUsername: string,
  clientToken: string,
  deps: StaffMediaDeps,
  opts?: StaffSendOpts,
): Promise<StaffSendResult> {
  const caption = (input.caption ?? "").trim();
  if (caption.length > STAFF_TEXT_MAX) return { ok: false, reason: "too_long" };

  const contact = await getContact(env.DB, phone);
  if (!contact) return { ok: false, reason: "no_contact" };
  if (contact.status === "opted_out" && opts?.force !== true) {
    return { ok: false, reason: "opted_out" };
  }

  const claimed = await kvSetIfAbsent(
    env.DB,
    staffSendClaimKey(phone, clientToken),
    String(Math.floor(Date.now() / 1000)),
  );
  if (!claimed) return { ok: false, reason: "duplicate" };

  let wamid: string;
  try {
    wamid = await deps.sendMedia(env, phone, input.kind, input.mediaId, {
      caption: caption || undefined,
      filename: input.filename,
      direction: "out_human",
      metaExtra: { by: byUsername },
    });
  } catch (err) {
    if (deps.isWindowClosed(err)) return { ok: false, reason: "window_closed" };
    throw err;
  }

  await setHumanOverride(env.DB, phone, STAFF_TAKEOVER_HOURS);
  await cancelPendingApprovals(env.DB, phone, "taken_over");
  try {
    await deps.postNote(
      env,
      `🧑‍💻 ${byUsername} envió ${KIND_LABEL[input.kind]} desde el panel a ${phone}${caption ? `: «${caption.slice(0, 200)}»` : ""}`,
    );
  } catch (err) {
    console.error("staff-media slack note failed", err);
  }

  const placeholder =
    input.kind === "image" ? "[imagen]" : input.kind === "video" ? "[video]" : "[documento]";
  const meta: Record<string, unknown> = {
    type: input.kind,
    mediaId: input.mediaId,
    by: byUsername,
  };
  if (caption) meta.caption = caption;
  if (input.filename) meta.filename = input.filename;
  return {
    ok: true,
    message: {
      wamid,
      phone,
      direction: "out_human",
      body: caption || placeholder,
      ts: Math.floor(Date.now() / 1000),
      meta: JSON.stringify(meta),
    },
  };
}
