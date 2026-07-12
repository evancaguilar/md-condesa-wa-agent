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
}

export interface InboundEvent {
  type: "inbound";
  wamid: string;
  from: string; // sender phone, digits only
  ts: number; // epoch seconds
  body: string; // extracted text (from text / button / interactive; empty for audio)
  kind: "text" | "button" | "interactive" | "audio" | "other";
  /** WhatsApp profile (push) name from the webhook's contacts rider, if any. */
  profileName?: string;
  /** Present when the message arrived from a click-to-WhatsApp ad. */
  referral?: InboundReferral;
  /** Present for voice notes / audio (kind:'audio'): the Graph media id + mime. */
  media?: { mediaId: string; mimeType: string | null };
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
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  voice?: { id?: string; mime_type?: string };
  referral?: {
    source_url?: string;
    source_type?: string;
    source_id?: string;
    headline?: string;
    body?: string;
    ctwa_clid?: string;
  };
}

function toEpoch(ts: string | undefined): number {
  const n = ts ? parseInt(ts, 10) : NaN;
  return Number.isFinite(n) ? n : Math.floor(Date.now() / 1000);
}

/** Extracts a text body from any inbound message shape. */
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
  return { body: "", kind: "other" };
}

/** Pulls the audio media {mediaId, mimeType} for a voice/audio message, if any. */
function extractMedia(m: RawMessage): InboundEvent["media"] | undefined {
  const a = m.audio ?? m.voice;
  if (!a?.id) return undefined;
  return { mediaId: a.id, mimeType: a.mime_type ?? null };
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
  };
}

/**
 * Parses a webhook envelope into normalized events. `field` on each change tells
 * us the subscription: `messages` (inbound/status), `smb_message_echoes` (echo),
 * `smb_app_state_sync` (coexistence sync).
 */
export function parseWebhook(payload: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
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
