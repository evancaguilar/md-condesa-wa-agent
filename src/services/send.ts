// Channel-dispatching send facade. Same surface as services/wa.ts; callers
// import from here instead of wa.ts so a contact id decides the transport:
// digits-only → WhatsApp Cloud API (wa.ts, unchanged), "ig:"/"fb:" prefixed →
// Messenger Platform (messenger.ts). WhatsApp-only capabilities (templates,
// media-id sends) throw ChannelCapabilityError for IG/FB contacts.

import type { Env } from "../types.js";
import * as wa from "./wa.js";
import * as messenger from "./messenger.js";
import { channelOf, ChannelCapabilityError } from "./channel.js";

// Error classes are re-exported from their single definition so instanceof
// checks hold no matter which module a caller imported from.
export { WindowClosedError, OptedOutError, DEFAULT_BOOKING_VIDEO_URL } from "./wa.js";
export { ChannelCapabilityError } from "./channel.js";
export type { SendTextOpts, OutboundMediaKind } from "./wa.js";

export async function sendText(
  env: Env,
  phone: string,
  body: string,
  opts?: wa.SendTextOpts,
): Promise<string> {
  return channelOf(phone) === "wa"
    ? wa.sendText(env, phone, body, opts)
    : messenger.sendText(env, phone, body, opts);
}

export async function sendVideo(
  env: Env,
  phone: string,
  videoUrl: string,
  caption?: string,
): Promise<string> {
  return channelOf(phone) === "wa"
    ? wa.sendVideo(env, phone, videoUrl, caption)
    : messenger.sendAttachmentUrl(env, phone, "video", videoUrl, caption);
}

/** Fire-and-forget booking video; best-effort on every channel. */
export async function sendBookingVideo(env: Env, phone: string): Promise<void> {
  if (channelOf(phone) === "wa") return wa.sendBookingVideo(env, phone);
  const url = env.BOOKING_VIDEO_URL || wa.DEFAULT_BOOKING_VIDEO_URL;
  try {
    await messenger.sendAttachmentUrl(env, phone, "video", url);
  } catch (err) {
    console.error(`[send] booking video failed for ${phone}: ${String(err)}`);
  }
}

/** WA-only: Graph media upload (staff attachments). Channel-agnostic input. */
export const uploadMedia = wa.uploadMedia;

/** Media-id send — WhatsApp only; IG/FB staff attachments are unsupported v1. */
export async function sendMedia(
  env: Env,
  phone: string,
  kind: wa.OutboundMediaKind,
  mediaId: string,
  opts?: Parameters<typeof wa.sendMedia>[4],
): Promise<string> {
  if (channelOf(phone) !== "wa") {
    throw new ChannelCapabilityError(phone, "media attachment send");
  }
  return wa.sendMedia(env, phone, kind, mediaId, opts);
}

/** Templates only exist on WhatsApp; IG/FB callers must catch and fall back. */
export async function sendTemplate(
  env: Env,
  phone: string,
  name: string,
  lang: string,
  components?: unknown[],
  opts?: { force?: boolean },
): Promise<string> {
  if (channelOf(phone) !== "wa") {
    throw new ChannelCapabilityError(phone, "template send");
  }
  return wa.sendTemplate(env, phone, name, lang, components, opts);
}

/**
 * Best-effort read receipt. WA reads by message id; IG/FB use a mark_seen
 * sender action keyed by the contact — pass `phone` so non-WA works.
 */
export async function markRead(
  env: Env,
  wamid: string,
  phone?: string,
): Promise<void> {
  if (phone && channelOf(phone) !== "wa") return messenger.markSeen(env, phone);
  return wa.markRead(env, wamid);
}
