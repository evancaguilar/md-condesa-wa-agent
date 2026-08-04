// Meta Messenger Platform client (Instagram DMs + Facebook Messenger). Same
// contract as services/wa.ts: every send records to outbound_wamids (echo
// detection) + messages, and returns the platform message id (mid).
//
// Sends go to POST graph.facebook.com/<v>/<FB_PAGE_ID>/messages with the
// page-scoped PAGE_ACCESS_TOKEN — the one endpoint serves both IG and FB
// recipients (the IG professional account is linked to the page). Window
// policy lives in channel.planMessengerSend: <24h free-form RESPONSE,
// 24h–7d HUMAN_AGENT tag, >7d blocked (no template escape on these channels).

import type { Env, MessageDirection } from "../types.js";
import { getContact, recordOutboundWamid, insertMessageIfNew } from "../db/queries.js";
import { WindowClosedError, type SendTextOpts } from "./wa.js";
import { planMessengerSend, platformId, channelOf } from "./channel.js";

const GRAPH_VERSION = "v21.0";

interface MessengerSendResponse {
  message_id?: string;
  error?: { message?: string; code?: number };
}

function requireConfig(env: Env): { pageId: string; token: string } {
  const pageId = env.FB_PAGE_ID;
  const token = env.PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    throw new Error(
      "IG/FB send unavailable: FB_PAGE_ID / PAGE_ACCESS_TOKEN not configured",
    );
  }
  return { pageId, token };
}

async function post(env: Env, body: Record<string, unknown>): Promise<string> {
  const { pageId, token } = requireConfig(env);
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json()) as MessengerSendResponse;
  if (!res.ok || data.error || !data.message_id) {
    throw new Error(
      `Messenger send failed (${res.status}): ${data.error?.message ?? "no message_id returned"}`,
    );
  }
  return data.message_id;
}

// Same shape as wa.ts recordOutbound (private there; replicated to keep wa.ts
// untouched — the WA path must not change behavior).
async function recordOutbound(
  env: Env,
  phone: string,
  mid: string,
  body: string,
  meta: unknown,
  direction: MessageDirection = "out_bot",
): Promise<void> {
  await recordOutboundWamid(env.DB, mid);
  await insertMessageIfNew(env.DB, {
    wamid: mid,
    phone,
    direction,
    body,
    ts: Math.floor(Date.now() / 1000),
    meta: JSON.stringify(meta),
  });
}

function windowClosed(phone: string): WindowClosedError {
  return new WindowClosedError(
    phone,
    `7-day Meta messaging window closed for ${phone}; no sends possible on ${channelOf(phone)} until the lead writes again`,
  );
}

/** Builds the recipient/messaging_type envelope per the window plan. */
async function envelopeFor(
  env: Env,
  phone: string,
): Promise<Record<string, unknown>> {
  const contact = await getContact(env.DB, phone);
  const nowSec = Math.floor(Date.now() / 1000);
  const plan = planMessengerSend(contact?.last_inbound_at, nowSec);
  if (plan === "blocked") throw windowClosed(phone);
  const base: Record<string, unknown> = {
    recipient: { id: platformId(phone) },
  };
  if (plan === "human_agent") {
    base.messaging_type = "MESSAGE_TAG";
    base.tag = "HUMAN_AGENT";
  } else {
    base.messaging_type = "RESPONSE";
  }
  return base;
}

/** Free-form text to an IG/FB contact. Same signature semantics as wa.sendText. */
export async function sendText(
  env: Env,
  phone: string,
  body: string,
  opts?: SendTextOpts,
): Promise<string> {
  const envelope = await envelopeFor(env, phone);
  const mid = await post(env, { ...envelope, message: { text: body } });
  await recordOutbound(
    env,
    phone,
    mid,
    body,
    { type: "text", channel: channelOf(phone), ...(opts?.metaExtra ?? {}) },
    opts?.direction ?? "out_bot",
  );
  return mid;
}

/**
 * URL attachment send (video/image). Messenger attachments carry no caption —
 * when one is given we follow with a best-effort text message.
 */
export async function sendAttachmentUrl(
  env: Env,
  phone: string,
  kind: "image" | "video",
  url: string,
  caption?: string,
): Promise<string> {
  const envelope = await envelopeFor(env, phone);
  const mid = await post(env, {
    ...envelope,
    message: {
      attachment: { type: kind, payload: { url, is_reusable: false } },
    },
  });
  await recordOutbound(env, phone, mid, caption ?? `[${kind}]`, {
    type: kind,
    link: url,
    channel: channelOf(phone),
  });
  if (caption) {
    try {
      await sendText(env, phone, caption);
    } catch {
      // caption is decorative; the attachment already went out
    }
  }
  return mid;
}

/** Best-effort mark-seen (the read-receipt analogue); never throws. */
export async function markSeen(env: Env, phone: string): Promise<void> {
  try {
    const { pageId, token } = requireConfig(env);
    await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: { id: platformId(phone) },
          sender_action: "mark_seen",
        }),
      },
    );
  } catch {
    // best-effort
  }
}
