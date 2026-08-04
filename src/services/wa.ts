// Meta Graph API (WhatsApp Cloud) client. Every send records to outbound_wamids
// (echo detection) + messages, and returns the wamid.

import type { Env, MessageDirection } from "../types.js";
import { getContact, recordOutboundWamid, insertMessageIfNew } from "../db/queries.js";

const GRAPH_VERSION = "v21.0";
const WINDOW_SECONDS = 24 * 3600;

/** Thrown by sendText when the 24h customer-service window is closed.
 *  `message` override lets non-WA channels state their own escape hatch
 *  (IG/FB have no templates — see services/messenger.ts). */
export class WindowClosedError extends Error {
  readonly phone: string;
  constructor(phone: string, message?: string) {
    super(message ?? `24h window closed for ${phone}; a template message is required`);
    this.name = "WindowClosedError";
    this.phone = phone;
  }
}

/**
 * Thrown by sendTemplate when the contact is opted out (baja). Templates are
 * proactive by construction, so this guard is the universal backstop for every
 * proactive path — present and future (drips, broadcasts). Only a caller that
 * has an explicit human-authorized reason passes {force:true}.
 */
export class OptedOutError extends Error {
  readonly phone: string;
  constructor(phone: string) {
    super(`${phone} is opted out (baja); proactive sends are blocked`);
    this.name = "OptedOutError";
    this.phone = phone;
  }
}

interface WaSendResponse {
  messages?: { id: string }[];
  error?: { message: string; code: number };
}

function graphUrl(env: Env, path: string): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/${path}`;
}

async function post(env: Env, body: unknown): Promise<string> {
  const res = await fetch(graphUrl(env, "messages"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as WaSendResponse;
  if (!res.ok || data.error || !data.messages?.[0]?.id) {
    throw new Error(
      `WA send failed (${res.status}): ${data.error?.message ?? "no wamid returned"}`,
    );
  }
  return data.messages[0].id;
}

async function recordOutbound(
  env: Env,
  phone: string,
  wamid: string,
  body: string,
  meta: unknown,
  direction: MessageDirection = "out_bot",
): Promise<void> {
  await recordOutboundWamid(env.DB, wamid);
  await insertMessageIfNew(env.DB, {
    wamid,
    phone,
    direction,
    body,
    ts: Math.floor(Date.now() / 1000),
    meta: JSON.stringify(meta),
  });
}

/** Options for sendText. Staff sends pass direction:"out_human" + {by}. */
export interface SendTextOpts {
  direction?: MessageDirection;
  metaExtra?: Record<string, unknown>;
}

/**
 * Free-form text send. Throws WindowClosedError if the contact's last inbound
 * is older than 24h (callers must switch to sendTemplate).
 */
export async function sendText(
  env: Env,
  phone: string,
  body: string,
  opts?: SendTextOpts,
): Promise<string> {
  const contact = await getContact(env.DB, phone);
  const last = contact?.last_inbound_at ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - last >= WINDOW_SECONDS) {
    throw new WindowClosedError(phone);
  }
  const wamid = await post(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "text",
    text: { preview_url: false, body },
  });
  await recordOutbound(
    env,
    phone,
    wamid,
    body,
    { type: "text", ...(opts?.metaExtra ?? {}) },
    opts?.direction ?? "out_bot",
  );
  return wamid;
}

/**
 * Video send (Graph `type:"video"`, `video:{link, caption?}`). Records the wamid +
 * message row like sendText and enforces the identical 24h-window guard. Bookings
 * are always in-window, so this only throws when misused out-of-window.
 */
export async function sendVideo(
  env: Env,
  phone: string,
  videoUrl: string,
  caption?: string,
): Promise<string> {
  const contact = await getContact(env.DB, phone);
  const last = contact?.last_inbound_at ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - last >= WINDOW_SECONDS) {
    throw new WindowClosedError(phone);
  }
  const video: Record<string, unknown> = { link: videoUrl };
  if (caption) video.caption = caption;
  const wamid = await post(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "video",
    video,
  });
  await recordOutbound(env, phone, wamid, caption ?? "[video]", {
    type: "video",
    link: videoUrl,
  });
  return wamid;
}

// ---- staff media (dashboard inbox attachments) ----

/** Media kinds the dashboard can send. */
export type OutboundMediaKind = "image" | "video" | "document";

/**
 * Uploads a file to the number's Graph /media endpoint. Returns the media id.
 * FormData per Cloud API: messaging_product=whatsapp + the file blob.
 */
export async function uploadMedia(
  env: Env,
  file: Blob,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", file, filename);
  const res = await fetch(graphUrl(env, "media"), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    body: form,
  });
  const data = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !data.id) {
    throw new Error(
      `WA media upload failed (${res.status}): ${data.error?.message ?? "no id returned"}`,
    );
  }
  return data.id;
}

/**
 * Sends an uploaded media object (by id) as image/video/document. Same 24h
 * window guard as sendText. Records the row with the caption (or a
 * placeholder) as body and {type, mediaId, caption, filename} meta.
 */
export async function sendMedia(
  env: Env,
  phone: string,
  kind: OutboundMediaKind,
  mediaId: string,
  opts?: {
    caption?: string;
    filename?: string;
    direction?: MessageDirection;
    metaExtra?: Record<string, unknown>;
  },
): Promise<string> {
  const contact = await getContact(env.DB, phone);
  const last = contact?.last_inbound_at ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - last >= WINDOW_SECONDS) {
    throw new WindowClosedError(phone);
  }
  const mediaObj: Record<string, unknown> = { id: mediaId };
  if (opts?.caption) mediaObj.caption = opts.caption;
  if (kind === "document" && opts?.filename) mediaObj.filename = opts.filename;
  const wamid = await post(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: kind,
    [kind]: mediaObj,
  });
  const placeholder =
    kind === "image" ? "[imagen]" : kind === "video" ? "[video]" : "[documento]";
  const meta: Record<string, unknown> = {
    type: kind,
    mediaId,
    ...(opts?.metaExtra ?? {}),
  };
  if (opts?.caption) meta.caption = opts.caption;
  if (opts?.filename) meta.filename = opts.filename;
  await recordOutbound(
    env,
    phone,
    wamid,
    opts?.caption || placeholder,
    meta,
    opts?.direction ?? "out_bot",
  );
  return wamid;
}

/** Default booking-confirmation video (already live). Overridable via env. */
export const DEFAULT_BOOKING_VIDEO_URL =
  "https://mdcondesa.com/media/confirmar-reserva.mp4";

/**
 * Fire-and-forget booking video: sends the confirmation clip right after a
 * booking-confirmation text. Best-effort — never throws (video must never block
 * or fail the confirmation). Uses env.BOOKING_VIDEO_URL or the default.
 */
export async function sendBookingVideo(env: Env, phone: string): Promise<void> {
  const url = env.BOOKING_VIDEO_URL || DEFAULT_BOOKING_VIDEO_URL;
  try {
    await sendVideo(env, phone, url);
  } catch (err) {
    console.error(`[wa] booking video send failed for ${phone}: ${String(err)}`);
  }
}

/**
 * Template send (allowed even when the window is closed). Throws OptedOutError
 * for an opted-out contact unless {force:true} — see OptedOutError.
 */
export async function sendTemplate(
  env: Env,
  phone: string,
  name: string,
  lang: string,
  components?: unknown[],
  opts?: { force?: boolean },
): Promise<string> {
  if (opts?.force !== true) {
    const contact = await getContact(env.DB, phone);
    if (contact?.status === "opted_out") throw new OptedOutError(phone);
  }
  const template: Record<string, unknown> = {
    name,
    language: { code: lang },
  };
  if (components && components.length > 0) template.components = components;
  const wamid = await post(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "template",
    template,
  });
  await recordOutbound(env, phone, wamid, `[template:${name}]`, {
    type: "template",
    name,
    lang,
  });
  return wamid;
}

/** Best-effort read receipt; never throws. */
export async function markRead(env: Env, wamid: string): Promise<void> {
  try {
    await fetch(graphUrl(env, "messages"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: wamid,
      }),
    });
  } catch {
    // best-effort
  }
}
