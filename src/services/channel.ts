// Channel identity for multi-platform contacts. WhatsApp contacts keep their
// digits-only phone as the id; Instagram/Messenger contacts are namespaced as
// "ig:<IGSID>" / "fb:<PSID>" in the same `phone` column — the prefix keeps the
// namespace disjoint from real phones and makes the channel derivable anywhere.
// Pure module (no Worker globals) so it is unit-testable under `node --test`.

export type Channel = "wa" | "ig" | "fb";

export const IG_PREFIX = "ig:";
export const FB_PREFIX = "fb:";

const MESSENGER_WINDOW_SECONDS = 24 * 3600;
const HUMAN_AGENT_WINDOW_SECONDS = 7 * 24 * 3600;

/** Derives the channel from a contact id ("phone" column value). */
export function channelOf(id: string): Channel {
  if (id.startsWith(IG_PREFIX)) return "ig";
  if (id.startsWith(FB_PREFIX)) return "fb";
  return "wa";
}

/** Strips the channel prefix: the raw IGSID/PSID for Graph API calls. */
export function platformId(id: string): string {
  const ch = channelOf(id);
  return ch === "wa" ? id : id.slice(3);
}

/** Human-facing label for Slack notes / logs, e.g. "IG 17841…4123". */
export function displayContact(id: string): string {
  const ch = channelOf(id);
  if (ch === "wa") return id;
  const raw = platformId(id);
  const short =
    raw.length > 10 ? `${raw.slice(0, 5)}…${raw.slice(-4)}` : raw;
  return `${ch.toUpperCase()} ${short}`;
}

/**
 * Messenger/IG send-window decision. Both platforms allow free-form replies
 * within 24h of the last inbound; 24h–7d needs the HUMAN_AGENT message tag
 * (its own App Review permission); beyond 7d nothing can be sent (there is no
 * template escape hatch like WhatsApp's).
 */
export type MessengerSendPlan = "free" | "human_agent" | "blocked";

export function planMessengerSend(
  lastInboundAt: number | null | undefined,
  nowSec: number,
): MessengerSendPlan {
  const last = lastInboundAt ?? 0;
  if (last <= 0) return "blocked";
  const age = nowSec - last;
  if (age < MESSENGER_WINDOW_SECONDS) return "free";
  if (age < HUMAN_AGENT_WINDOW_SECONDS) return "human_agent";
  return "blocked";
}

/**
 * Thrown by the send facade when a WhatsApp-only capability (templates,
 * media-id sends) is invoked for an IG/FB contact. Callers treat it like a
 * permanent per-channel "not supported", never a retryable failure.
 */
export class ChannelCapabilityError extends Error {
  readonly phone: string;
  readonly capability: string;
  constructor(phone: string, capability: string) {
    super(`${capability} is not available on ${channelOf(phone)} (${phone})`);
    this.name = "ChannelCapabilityError";
    this.phone = phone;
    this.capability = capability;
  }
}
