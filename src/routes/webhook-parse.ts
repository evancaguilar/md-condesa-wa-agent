// Pure parser for Meta WhatsApp webhook payloads. No Worker-only globals so it
// is unit-testable under `node --test`. Normalizes the nested payload into a
// flat list of events the pipeline/route can act on.

/** Parsed Meta click-to-WhatsApp referral rider on an inbound message. */
export interface InboundReferral {
  sourceUrl: string | null;
  sourceType: string | null;
  sourceId: string | null; // the ad id
  headline: string | null;
  body: string | null;
  ctwaClid: string | null;
  /** Ad creative preview (fbcdn urls), when Meta includes them. */
  thumbnailUrl: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
}

export type InboundKind =
  | "text"
  | "button"
  | "interactive"
  | "audio"
  | "image"
  | "video"
  | "document"
  | "sticker"
  | "reaction"
  | "other";

export interface InboundEvent {
  type: "inbound";
  wamid: string;
  from: string; // sender phone, digits only
  ts: number; // epoch seconds
  body: string; // extracted text (text/button/interactive; caption for media; empty for audio)
  kind: InboundKind;
  /** WhatsApp profile (push) name from the webhook's contacts rider, if any. */
  profileName?: string;
  /** Present when the message arrived from a click-to-WhatsApp ad. */
  referral?: InboundReferral;
  /** Present for any media message (audio/image/video/document/sticker).
   *  WhatsApp media carries a Graph mediaId (2-hop authed fetch); IG/FB
   *  attachments carry a direct CDN mediaUrl instead. Exactly one is set. */
  media?: {
    mediaId?: string;
    mediaUrl?: string;
    mimeType: string | null;
    filename?: string | null;
  };
}

export interface StatusEvent {
  type: "status";
  wamid: string;
  status: string; // sent|delivered|read|failed
  recipient: string;
  ts: number;
}

export interface EchoEvent {
  type: "echo";
  wamid: string;
  to: string; // recipient phone (the lead), digits only
  ts: number;
  body: string;
}

export interface AppStateSyncEvent {
  type: "app_state_sync";
}

export type WebhookEvent =
  | InboundEvent
  | StatusEvent
  | EchoEvent
  | AppStateSyncEvent;

interface RawMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
  animated?: boolean;
}

interface RawMessage {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  audio?: RawMedia;
  voice?: RawMedia;
  image?: RawMedia;
  video?: RawMedia;
  document?: RawMedia;
  sticker?: RawMedia;
  reaction?: { message_id?: string; emoji?: string };
  referral?: {
    source_url?: string;
    source_type?: string;
    source_id?: string;
    headline?: string;
    body?: string;
    ctwa_clid?: string;
    thumbnail_url?: string;
    image_url?: string;
    video_url?: string;
  };
}

function toEpoch(ts: string | undefined): number {
  const n = ts ? parseInt(ts, 10) : NaN;
  return Number.isFinite(n) ? n : Math.floor(Date.now() / 1000);
}

/** Extracts a text body from any inbound message shape (caption for media). */
function extractBody(m: RawMessage): { body: string; kind: InboundEvent["kind"] } {
  if (m.type === "text" && m.text?.body) return { body: m.text.body, kind: "text" };
  if (m.type === "button" && m.button)
    return { body: m.button.text ?? m.button.payload ?? "", kind: "button" };
  if (m.type === "interactive" && m.interactive) {
    const r = m.interactive.button_reply ?? m.interactive.list_reply;
    return { body: r?.title ?? r?.id ?? "", kind: "interactive" };
  }
  // Voice notes / audio: no text body — the pipeline transcribes from media.id.
  if ((m.type === "audio" || m.type === "voice") && (m.audio?.id || m.voice?.id))
    return { body: "", kind: "audio" };
  if (m.type === "image" && m.image?.id)
    return { body: m.image.caption ?? "", kind: "image" };
  if (m.type === "video" && m.video?.id)
    return { body: m.video.caption ?? "", kind: "video" };
  if (m.type === "document" && m.document?.id)
    return { body: m.document.caption ?? "", kind: "document" };
  if (m.type === "sticker" && m.sticker?.id) return { body: "", kind: "sticker" };
  // Reactions (👍/❤️ on one of our messages): keep the emoji so the dashboard
  // shows something instead of an empty bubble; the pipeline stores it and
  // stops (no brain, no approval — a reaction needs no reply). An empty emoji
  // means the reaction was REMOVED.
  if (m.type === "reaction") {
    const emoji = (m.reaction?.emoji ?? "").trim();
    return {
      body: emoji ? `[reaccionó ${emoji}]` : "[quitó su reacción]",
      kind: "reaction",
    };
  }
  if (m.type === "location") return { body: "[ubicación compartida]", kind: "other" };
  if (m.type === "contacts") return { body: "[contacto compartido]", kind: "other" };
  return { body: "[mensaje no soportado]", kind: "other" };
}

/** Pulls the media {mediaId, mimeType, filename} for any media message. */
function extractMedia(m: RawMessage): InboundEvent["media"] | undefined {
  const a =
    m.audio ?? m.voice ?? m.image ?? m.video ?? m.document ?? m.sticker;
  if (!a?.id) return undefined;
  return {
    mediaId: a.id,
    mimeType: a.mime_type ?? null,
    filename: a.filename ?? null,
  };
}

/** Maps a raw referral rider to the normalized InboundReferral, or undefined. */
function extractReferral(m: RawMessage): InboundReferral | undefined {
  const r = m.referral;
  if (!r) return undefined;
  return {
    sourceUrl: r.source_url ?? null,
    sourceType: r.source_type ?? null,
    sourceId: r.source_id ?? null,
    headline: r.headline ?? null,
    body: r.body ?? null,
    ctwaClid: r.ctwa_clid ?? null,
    thumbnailUrl: r.thumbnail_url ?? null,
    imageUrl: r.image_url ?? null,
    videoUrl: r.video_url ?? null,
  };
}

// ---- Messenger Platform (Instagram DMs + Facebook Messenger) ----
//
// IG/FB webhooks use a different envelope than WhatsApp: object:"instagram"|
// "page", entry[].messaging[] with {sender.id, recipient.id, timestamp(ms!),
// message|postback|referral}. Contact ids are namespaced ("ig:<IGSID>" /
// "fb:<PSID>") so the rest of the system can treat them as opaque strings in
// the same `phone` column (see services/channel.ts).

interface RawMessengerAttachment {
  type?: string; // image | video | audio | file | story_mention | share | fallback | reel | ...
  payload?: { url?: string; title?: string };
}

interface RawMessengerReferral {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string;
  ads_context_data?: {
    ad_title?: string;
    photo_url?: string;
    video_url?: string;
  };
}

interface RawMessagingItem {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: RawMessengerAttachment[];
    referral?: RawMessengerReferral;
  };
  postback?: {
    mid?: string;
    title?: string;
    payload?: string;
    referral?: RawMessengerReferral;
  };
  referral?: RawMessengerReferral; // messaging_referrals (ig.me / m.me links)
  read?: unknown;
  delivery?: unknown;
}

/** Epoch normalizer for messaging[] items: Messenger timestamps are ms. */
function toEpochMs(ts: number | undefined): number {
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return Math.floor(Date.now() / 1000);
  }
  // Defensive: >= 1e11 can only be milliseconds (seconds are ~1.7e9).
  return ts >= 1e11 ? Math.floor(ts / 1000) : Math.floor(ts);
}

function mapMessengerReferral(
  r: RawMessengerReferral | undefined,
): InboundReferral | undefined {
  if (!r) return undefined;
  return {
    sourceUrl: r.ref ?? null,
    sourceType: r.type ?? r.source ?? null,
    sourceId: r.ad_id ?? null,
    headline: r.ads_context_data?.ad_title ?? null,
    body: null,
    ctwaClid: null,
    thumbnailUrl: r.ads_context_data?.photo_url ?? null,
    imageUrl: r.ads_context_data?.photo_url ?? null,
    videoUrl: r.ads_context_data?.video_url ?? null,
  };
}

const MESSENGER_KIND: Record<string, InboundKind> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
};

function parseMessengerEvents(
  prefix: "ig:" | "fb:",
  entries: { messaging?: RawMessagingItem[] }[],
): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  for (const entry of entries) {
    for (const item of entry.messaging ?? []) {
      const ts = toEpochMs(item.timestamp);

      if (item.message?.is_echo) {
        // Sent from the page/IG inbox (or our own API — filtered later via
        // outbound_wamids, same as WA echoes).
        events.push({
          type: "echo",
          wamid: item.message.mid ?? "",
          to: item.recipient?.id ? prefix + item.recipient.id : "",
          ts,
          body: item.message.text ?? "",
        });
        continue;
      }

      const from = item.sender?.id ? prefix + item.sender.id : "";

      if (item.message) {
        const m = item.message;
        let body = m.text ?? "";
        let kind: InboundKind = "text";
        let media: InboundEvent["media"] | undefined;
        const att = (m.attachments ?? [])[0];
        if (att) {
          kind = MESSENGER_KIND[att.type ?? ""] ?? "other";
          if (kind !== "other" && att.payload?.url) {
            media = { mediaUrl: att.payload.url, mimeType: null, filename: null };
          }
          if (!body && kind === "other") {
            body =
              att.type === "story_mention"
                ? "[mención en historia]"
                : att.type === "share" || att.type === "reel"
                  ? "[contenido compartido]"
                  : "[adjunto no soportado]";
          }
        } else if (!m.text) {
          kind = "other";
        }
        const ev: InboundEvent = {
          type: "inbound",
          wamid: m.mid ?? "",
          from,
          ts,
          body,
          kind,
        };
        const referral = mapMessengerReferral(m.referral ?? item.referral);
        if (referral) ev.referral = referral;
        if (media) ev.media = media;
        events.push(ev);
        continue;
      }

      if (item.postback) {
        const p = item.postback;
        const ev: InboundEvent = {
          type: "inbound",
          wamid: p.mid ?? "",
          from,
          ts,
          body: p.title ?? p.payload ?? "",
          kind: "button",
        };
        const referral = mapMessengerReferral(p.referral ?? item.referral);
        if (referral) ev.referral = referral;
        events.push(ev);
        continue;
      }

      // read / delivery / reactions: nothing to do.
    }
  }
  return events;
}

/**
 * Parses a webhook envelope into normalized events. WhatsApp payloads
 * (object:"whatsapp_business_account") use entry[].changes[]; `field` on each
 * change tells us the subscription: `messages` (inbound/status),
 * `smb_message_echoes` (echo), `smb_app_state_sync` (coexistence sync).
 * Instagram/Messenger payloads (object:"instagram"|"page") use
 * entry[].messaging[] and normalize into the same event union with
 * channel-prefixed contact ids.
 */
export function parseWebhook(payload: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const objectType = (payload as { object?: string } | null)?.object;
  if (objectType === "instagram" || objectType === "page") {
    const root = payload as { entry?: { messaging?: RawMessagingItem[] }[] };
    return parseMessengerEvents(
      objectType === "instagram" ? "ig:" : "fb:",
      root.entry ?? [],
    );
  }
  const root = payload as {
    entry?: {
      changes?: {
        field?: string;
        value?: {
          messages?: RawMessage[];
          contacts?: { wa_id?: string; profile?: { name?: string } }[];
          statuses?: {
            id?: string;
            status?: string;
            recipient_id?: string;
            timestamp?: string;
          }[];
        };
      }[];
    }[];
  };

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const field = change.field ?? "";
      const value = change.value ?? {};

      if (field === "smb_app_state_sync") {
        events.push({ type: "app_state_sync" });
        continue;
      }

      if (field === "smb_message_echoes") {
        for (const m of value.messages ?? []) {
          const { body } = extractBody(m);
          events.push({
            type: "echo",
            wamid: m.id ?? "",
            to: m.to ?? "",
            ts: toEpoch(m.timestamp),
            body,
          });
        }
        continue;
      }

      // Default `messages` field: inbound messages + delivery statuses.
      for (const m of value.messages ?? []) {
        const { body, kind } = extractBody(m);
        const ev: InboundEvent = {
          type: "inbound",
          wamid: m.id ?? "",
          from: m.from ?? "",
          ts: toEpoch(m.timestamp),
          body,
          kind,
        };
        // WhatsApp profile (push) name rides in value.contacts, keyed by wa_id.
        const profile = (value.contacts ?? [])
          .find((c) => c.wa_id === m.from)
          ?.profile?.name?.trim();
        if (profile) ev.profileName = profile;
        const referral = extractReferral(m);
        if (referral) ev.referral = referral;
        const media = extractMedia(m);
        if (media) ev.media = media;
        events.push(ev);
      }
      for (const s of value.statuses ?? []) {
        events.push({
          type: "status",
          wamid: s.id ?? "",
          status: s.status ?? "",
          recipient: s.recipient_id ?? "",
          ts: toEpoch(s.timestamp),
        });
      }
    }
  }

  return events;
}
