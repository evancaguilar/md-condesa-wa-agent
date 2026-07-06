// Pure, dependency-free Slack helpers: signing-secret verification, interactive
// payload parsing, and the business-hours / approval-timeout decision logic.
// NO Worker-only globals or Env references here so this module is unit-testable
// under `node --test` (only WebCrypto + TextEncoder, both available in Node v24).

// ---- Slack signing-secret verification (v0 scheme) ----

/** Constant-time compare of two byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** HMAC-SHA256 of `msg` keyed by `secret`, returned as lowercase hex. */
export async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export interface SlackVerifyInput {
  signingSecret: string;
  signature: string | null; // X-Slack-Signature header, e.g. "v0=abcdef..."
  timestamp: string | null; // X-Slack-Request-Timestamp header (unix seconds)
  rawBody: string; // exact raw request body
  nowSec?: number; // injectable clock (seconds); defaults to Date.now()
  toleranceSec?: number; // replay window; default 300
}

/**
 * Verifies Slack's v0 request signature over `v0:{timestamp}:{rawBody}` with a
 * constant-time compare, and rejects stale requests outside the replay window.
 */
export async function verifySlackSignature(input: SlackVerifyInput): Promise<boolean> {
  const { signingSecret, signature, timestamp, rawBody } = input;
  if (!signature || !timestamp) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSec ?? 300;
  if (Math.abs(now - ts) > tolerance) return false;

  const [scheme, provided] = signature.split("=", 2);
  if (scheme !== "v0" || !provided) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = await hmacSha256Hex(signingSecret, base);
  return timingSafeEqual(hexToBytes(expected), hexToBytes(provided));
}

// ---- Interactive payload parsing ----

export interface ParsedAction {
  actionId: string; // e.g. "approve|42" or "bot_pause"
  verb: string; // portion before the first "|", e.g. "approve"
  arg: string | null; // portion after "|", e.g. "42" (approval id / record id)
  value: string | null; // button `value`, if present
}

export interface ParsedInteraction {
  kind: "block_actions" | "view_submission" | "unknown";
  triggerId: string | null;
  actions: ParsedAction[]; // block_actions only
  // view_submission:
  privateMetadata: string | null;
  // convenience: first plain_text_input value found in a view_submission, keyed
  // by block_id -> action_id -> value; we expose the flattened first value too.
  viewValues: Record<string, Record<string, string>>;
  firstInputValue: string | null;
}

function splitActionId(actionId: string): { verb: string; arg: string | null } {
  const idx = actionId.indexOf("|");
  if (idx === -1) return { verb: actionId, arg: null };
  return { verb: actionId.slice(0, idx), arg: actionId.slice(idx + 1) };
}

/**
 * Slack POSTs `payload=<urlencoded JSON>` for block_actions / view_submission.
 * Pass the already-url-decoded JSON string (or the raw `payload=` body — we
 * handle both). Returns a normalized shape.
 */
export function parseInteractionPayload(rawOrJson: string): ParsedInteraction {
  let jsonStr = rawOrJson;
  if (rawOrJson.startsWith("payload=")) {
    jsonStr = decodeURIComponent(rawOrJson.slice("payload=".length));
  }
  let obj: any;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return emptyInteraction("unknown");
  }

  const type = typeof obj?.type === "string" ? obj.type : "unknown";

  if (type === "block_actions") {
    const actions: ParsedAction[] = [];
    for (const a of Array.isArray(obj.actions) ? obj.actions : []) {
      const actionId: string = a?.action_id ?? "";
      if (!actionId) continue;
      // Overflow menus carry the chosen option under selected_option.value.
      const overflowValue = a?.selected_option?.value ?? null;
      const effectiveId = overflowValue ?? actionId;
      const { verb, arg } = splitActionId(effectiveId);
      actions.push({
        actionId: effectiveId,
        verb,
        arg,
        value: a?.value ?? overflowValue ?? null,
      });
    }
    return {
      kind: "block_actions",
      triggerId: obj?.trigger_id ?? null,
      actions,
      privateMetadata: null,
      viewValues: {},
      firstInputValue: null,
    };
  }

  if (type === "view_submission") {
    const view = obj?.view ?? {};
    const state = view?.state?.values ?? {};
    const viewValues: Record<string, Record<string, string>> = {};
    let firstInputValue: string | null = null;
    for (const blockId of Object.keys(state)) {
      viewValues[blockId] = {};
      for (const actionId of Object.keys(state[blockId] ?? {})) {
        const v = state[blockId][actionId]?.value;
        if (typeof v === "string") {
          viewValues[blockId][actionId] = v;
          if (firstInputValue === null) firstInputValue = v;
        }
      }
    }
    return {
      kind: "view_submission",
      triggerId: null,
      actions: [],
      privateMetadata: view?.private_metadata ?? null,
      viewValues,
      firstInputValue,
    };
  }

  return emptyInteraction("unknown");
}

function emptyInteraction(kind: ParsedInteraction["kind"]): ParsedInteraction {
  return {
    kind,
    triggerId: null,
    actions: [],
    privateMetadata: null,
    viewValues: {},
    firstInputValue: null,
  };
}

// ---- Business-hours & approval-timeout decision logic ----

const CDMX_TZ = "America/Mexico_City";
const HOLDING_THRESHOLD_SEC = 10 * 60; // 10 min → send holding line
const EXPIRE_THRESHOLD_SEC = 12 * 3600; // 12 h → expire
const WINDOW_SECONDS = 24 * 3600;
const BIZ_OPEN_HOUR = 9; // 09:00 CDMX
const BIZ_CLOSE_HOUR = 21; // 21:00 CDMX (exclusive)

/** Hour-of-day (0–23) for an epoch in America/Mexico_City. */
export function cdmxHour(epochSec: number): number {
  const s = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: CDMX_TZ,
  }).format(new Date(epochSec * 1000));
  // "24" is emitted for midnight by some engines; normalize to 0.
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h;
}

/** True when the CDMX local hour is within [09:00, 21:00). */
export function isBusinessHours(epochSec: number): boolean {
  const h = cdmxHour(epochSec);
  return h >= BIZ_OPEN_HOUR && h < BIZ_CLOSE_HOUR;
}

/** Minimal view of a pending approval the timeout logic needs. */
export interface TimeoutApprovalView {
  id: number;
  phone: string;
  createdAt: number; // epoch seconds
  holdingSent: boolean;
  lastInboundAt: number | null; // drives window-open check
}

export type TimeoutAction =
  | { kind: "hold"; id: number; phone: string } // send holding line + re-ping
  | { kind: "expire"; id: number; phone: string; windowClosed: boolean }
  | { kind: "none"; id: number };

/**
 * Pure decision for a single approval. Injectable `now` (seconds).
 * - age > 12h                         ⇒ expire (windowClosed reported so the
 *                                       caller can offer the template button).
 * - age > 10min, business hours,
 *   window open, holding not yet sent ⇒ send holding line.
 * - otherwise                         ⇒ none.
 */
export function decideTimeout(a: TimeoutApprovalView, now: number): TimeoutAction {
  const age = now - a.createdAt;
  const windowOpen = a.lastInboundAt !== null && now - a.lastInboundAt < WINDOW_SECONDS;

  if (age > EXPIRE_THRESHOLD_SEC) {
    return { kind: "expire", id: a.id, phone: a.phone, windowClosed: !windowOpen };
  }
  if (
    age > HOLDING_THRESHOLD_SEC &&
    !a.holdingSent &&
    windowOpen &&
    isBusinessHours(now)
  ) {
    return { kind: "hold", id: a.id, phone: a.phone };
  }
  return { kind: "none", id: a.id };
}

/** Ventana-restante en horas (redondeo hacia arriba), min 0. */
export function windowHoursLeft(lastInboundAt: number | null, now: number): number {
  if (lastInboundAt === null) return 0;
  const remaining = WINDOW_SECONDS - (now - lastInboundAt);
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 3600);
}

export const HOLDING_LINE =
  "¡Gracias por escribir! 🙌 Dame un momento y te confirmo enseguida.";
