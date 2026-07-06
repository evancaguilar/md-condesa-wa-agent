// Meta Graph API (WhatsApp Cloud) client. Every send records to outbound_wamids
// (echo detection) + messages, and returns the wamid.

import type { Env } from "../types.js";
import { getContact, recordOutboundWamid, insertMessageIfNew } from "../db/queries.js";

const GRAPH_VERSION = "v21.0";
const WINDOW_SECONDS = 24 * 3600;

/** Thrown by sendText when the 24h customer-service window is closed. */
export class WindowClosedError extends Error {
  readonly phone: string;
  constructor(phone: string) {
    super(`24h window closed for ${phone}; a template message is required`);
    this.name = "WindowClosedError";
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
): Promise<void> {
  await recordOutboundWamid(env.DB, wamid);
  await insertMessageIfNew(env.DB, {
    wamid,
    phone,
    direction: "out_bot",
    body,
    ts: Math.floor(Date.now() / 1000),
    meta: JSON.stringify(meta),
  });
}

/**
 * Free-form text send. Throws WindowClosedError if the contact's last inbound
 * is older than 24h (callers must switch to sendTemplate).
 */
export async function sendText(
  env: Env,
  phone: string,
  body: string,
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
  await recordOutbound(env, phone, wamid, body, { type: "text" });
  return wamid;
}

/** Template send (allowed even when the window is closed). */
export async function sendTemplate(
  env: Env,
  phone: string,
  name: string,
  lang: string,
  components?: unknown[],
): Promise<string> {
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
