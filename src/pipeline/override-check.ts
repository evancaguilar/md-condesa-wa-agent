// Human override v2 (owner decision 2026-10-11). Pure module — unit-tested.
//
// A staff reply from the WhatsApp app (echo) pauses the bot for 8 h. Audit
// 2026-10: …1521 and …5625 wrote again after a staff reply and got NOTHING for
// a whole day. Now: when the lead writes during an override that a staff reply
// set, we arm a check (kv `override_check:<phone>`); if no human reply goes out
// within 60 min, the cron runs the brain for that message and sends directly
// only when the model is ≥ 70 % sure (and training wheels are off), else it
// drafts. The silent case (lead doesn't write) keeps the plain 8 h pause.

export const OVERRIDE_CHECK_DELAY_SEC = 60 * 60;
export const OVERRIDE_SEND_SURENESS_MIN = 70;

export interface OverrideCheckState {
  /** Newest inbound the check covers. */
  wamid: string;
  /** Its timestamp: any human/bot outbound after it means it was answered. */
  ts: number;
  /** Its body (capped) — the brain turn's `msg.body`. */
  body: string;
  /** When the check was first armed: the 60-min clock (not reset by later messages). */
  armedAt: number;
}

export function overrideCheckKey(phone: string): string {
  return `override_check:${phone}`;
}

export const OVERRIDE_CHECK_PREFIX = "override_check:";

export function parseOverrideCheck(raw: string | null): OverrideCheckState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<OverrideCheckState>;
    if (typeof o.wamid !== "string" || typeof o.ts !== "number" || typeof o.armedAt !== "number") return null;
    return { wamid: o.wamid, ts: o.ts, body: typeof o.body === "string" ? o.body : "", armedAt: o.armedAt };
  } catch {
    return null;
  }
}

/**
 * Pure. Was the active override set by a STAFF REPLY? True when the newest
 * outbound in `history` (any order) is a human one (dashboard send or a WA-app
 * echo). A bare "Tomar control" with no reply yet stays a plain pause.
 */
export function overrideFromStaffReply(
  history: readonly { direction: string; ts: number }[],
): boolean {
  const outs = history
    .filter((m) => m.direction !== "in")
    .slice()
    .sort((a, b) => a.ts - b.ts);
  const last = outs[outs.length - 1];
  return last !== undefined && (last.direction === "out_human" || last.direction === "out_human_echo");
}

/** Pure. Next state when another inbound lands while a check may be armed. */
export function armOverrideCheck(
  prev: OverrideCheckState | null,
  msg: { wamid: string; ts: number; body: string },
  now: number,
): OverrideCheckState {
  return {
    wamid: msg.wamid,
    ts: msg.ts,
    body: msg.body.slice(0, 2000),
    armedAt: prev ? prev.armedAt : now,
  };
}

/**
 * Pure. "wait" until 60 min passed; then "drop" when someone already answered
 * after the lead's message (or the contact is no longer a plain lead), else
 * "run" the brain.
 */
export function decideOverrideCheck(opts: {
  state: OverrideCheckState;
  now: number;
  answeredAfter: boolean;
  contactStatus: string | null;
}): "wait" | "drop" | "run" {
  if (opts.now - opts.state.armedAt < OVERRIDE_CHECK_DELAY_SEC) return "wait";
  if (opts.answeredAfter) return "drop";
  if (opts.contactStatus !== "lead") return "drop";
  return "run";
}

/** Pure. Direct send vs draft for the override-check brain turn. */
export function overrideRouting(opts: {
  sureness: number | undefined;
  trainingWheels: boolean;
  guarded: boolean;
}): "send" | "draft" {
  if (opts.trainingWheels || opts.guarded) return "draft";
  return (opts.sureness ?? 0) >= OVERRIDE_SEND_SURENESS_MIN ? "send" : "draft";
}
