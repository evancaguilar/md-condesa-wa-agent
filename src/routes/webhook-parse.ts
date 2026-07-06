// Pure parser for Meta WhatsApp webhook payloads. No Worker-only globals so it
// is unit-testable under `node --test`. Normalizes the nested payload into a
// flat list of events the pipeline/route can act on.

export interface InboundEvent {
  type: "inbound";
  wamid: string;
  from: string; // sender phone, digits only
  ts: number; // epoch seconds
  body: string; // extracted text (from text / button / interactive)
  kind: "text" | "button" | "interactive" | "other";
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
  return { body: "", kind: "other" };
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
        events.push({
          type: "inbound",
          wamid: m.id ?? "",
          from: m.from ?? "",
          ts: toEpoch(m.timestamp),
          body,
          kind,
        });
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
