// Pure, dependency-free Slack helpers: signing-secret verification, interactive
// payload parsing, and the business-hours / approval-timeout decision logic.
// NO Worker-only globals or Env references here so this module is unit-testable
// under `node --test` (only WebCrypto + TextEncoder, both available in Node v24).

import type { ApprovalsConfig } from "../client-config.js";

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
  /** Who clicked (Slack username, display name, or id) — audit copy only. */
  user: string | null;
  /** Slack member id (U…) of who clicked — checked against SLACK_ALLOWED_USER_IDS. */
  userId: string | null;
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
    // x-www-form-urlencoded: "+" means space (decodeURIComponent alone leaves
    // them in, mangling every space of edited replies). Literal "+" arrives
    // as %2B, so the replace-then-decode order is safe.
    jsonStr = decodeURIComponent(
      rawOrJson.slice("payload=".length).replace(/\+/g, " "),
    );
  }
  let obj: any;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return emptyInteraction("unknown");
  }

  const type = typeof obj?.type === "string" ? obj.type : "unknown";
  // Slack sends user.username on modern payloads, user.name on older ones.
  const user: string | null =
    obj?.user?.username ?? obj?.user?.name ?? obj?.user?.id ?? null;
  const userId: string | null = typeof obj?.user?.id === "string" ? obj.user.id : null;

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
      user,
      userId,
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
      user,
      userId,
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
    user: null,
    userId: null,
    actions: [],
    privateMetadata: null,
    viewValues: {},
    firstInputValue: null,
  };
}

// ---- Business-hours & approval-timeout decision logic ----

const CDMX_TZ = "America/Mexico_City";
const HOLDING_THRESHOLD_SEC = 10 * 60; // 10 min → send holding line
const WINDOW_SECONDS = 24 * 3600;

/**
 * Approval-timeout policy (client.mjs `approvals`, owner-tunable by a push).
 * History: owner directive 2026-08-25 — "if it waits more than an hour with no
 * approval, it sends its best bet as long as it's 25% sure". The 2026-11-11
 * review of 475 conversations found 21 drafts — several of them correct —
 * EXPIRED after 12 h with nothing sent, so the wait dropped to 15 min (inside
 * 08:00–21:30 CDMX) and a draft that is not safe to send now ESCALATES at that
 * moment instead of dying silently.
 */
export const DEFAULT_APPROVALS: ApprovalsConfig = {
  autoSendAfterMin: 15,
  taskAutoSendAfterMin: 60,
  minSureness: 25,
  sendWindow: { start: "08:00", end: "21:30" },
  staleCheckAfterMin: 20,
  expireAfterHours: 12,
};

/** The policy in seconds / minutes-of-day, ready for the pure decision. */
export interface TimeoutPolicy {
  autoSendAfterSec: number;
  taskAutoSendAfterSec: number;
  minSureness: number;
  /** Sureness floor for a send outside the window; null ⇒ never outside it. */
  overnightMinSureness: number | null;
  /** CDMX minute of day, [start, end). */
  windowStart: number;
  windowEnd: number;
  staleCheckAfterSec: number;
  expireAfterSec: number;
}

function hhmmToMin(s: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function timeoutPolicy(cfg: ApprovalsConfig = DEFAULT_APPROVALS): TimeoutPolicy {
  return {
    autoSendAfterSec: cfg.autoSendAfterMin * 60,
    taskAutoSendAfterSec: cfg.taskAutoSendAfterMin * 60,
    minSureness: cfg.minSureness,
    overnightMinSureness: typeof cfg.overnightMinSureness === "number" ? cfg.overnightMinSureness : null,
    windowStart: hhmmToMin(cfg.sendWindow.start, 8 * 60),
    windowEnd: hhmmToMin(cfg.sendWindow.end, 21 * 60 + 30),
    staleCheckAfterSec: cfg.staleCheckAfterMin * 60,
    expireAfterSec: cfg.expireAfterHours * 3600,
  };
}

/** Back-compat aliases (tests, card copy). */
export const BESTBET_SURENESS_MIN = DEFAULT_APPROVALS.minSureness;

/** CDMX minute of day (fixed UTC-6, no DST since 2022). */
function cdmxMinuteOfDay(epochSec: number): number {
  const t = epochSec - 6 * 3600;
  return Math.floor((((t % 86400) + 86400) % 86400) / 60);
}

/**
 * Pure. The first moment ≥ `t` inside the send window: `t` itself when it is
 * inside, else the next window opening (today's if `t` is before it, else
 * tomorrow's). A draft written at 23:10 is due at 08:00; one at 21:20 whose
 * wait ends at 21:35 also waits for 08:00.
 */
export function nextInWindow(t: number, p: Pick<TimeoutPolicy, "windowStart" | "windowEnd">): number {
  const m = cdmxMinuteOfDay(t);
  if (m >= p.windowStart && m < p.windowEnd) return t;
  const startOfMinute = t - (t % 60);
  const delta = m < p.windowStart ? p.windowStart - m : 24 * 60 - m + p.windowStart;
  return startOfMinute + delta * 60;
}
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
  /**
   * Brain's read of the room: false = the lead was closing the conversation
   * (thanks/ok) and is NOT waiting on an answer, so the holding line would be
   * noise. Undefined (legacy rows, fallback drafts) = waiting.
   */
  awaitingReply?: boolean;
  /**
   * Model's 0–100 self-report for this draft (kv `sureness:<id>`, written at
   * queue time). Undefined = unknown (legacy row, synthesized fallback, or a
   * guard that stripped it) ⇒ never best-bet.
   */
  sureness?: number;
  /**
   * True when the draft tripped a correctness guard (kv `guarded:<id>`): the
   * text claims a booking nothing backs, or names a slot that isn't on the
   * grid. Hard exclusion from best-bet — a human fixes it or it expires.
   */
  guarded?: boolean;
  /**
   * classifyEscalation() of the draft's escalation reason (kv
   * `reason_kind:<id>`). opt_out / complaint / price / medical / billing never
   * send themselves (they escalate); opt_out / complaint never get the
   * holding line either.
   */
  reasonKind?: EscalationKind | null;
  /** False for a draft-less escalation row (escalate_to_human). Default true. */
  hasDraft?: boolean;
  /** The draft is the brain's failure apology (api_error / max_iterations). */
  apologyDraft?: boolean;
  /** An escalation task (kv `esc_task:<phone>`) tracks THIS approval: the SLA re-pings own it. */
  tasked?: boolean;
  /** The timeout escalation for this approval already went out (kv `tmo_esc:<id>`). */
  escalated?: boolean;
  /** Kill switch: false ⇒ nothing automated goes out. Default true. */
  botEnabled?: boolean;
  optedOut?: boolean;
  /** A declined-stop marker of a "do not chase" source (not_interested / complaint). */
  declined?: boolean;
  /** human_override_until is in the future ("Tomar control" / staff pause). */
  overrideActive?: boolean;
}

/** Why a due draft did not send itself (each one a reason to page a human). */
export type EscalateWhy =
  | "no_draft"
  | "kill_switch"
  | "window_closed"
  | "override"
  | "declined"
  | "reason_kind"
  | "slot_warning"
  | "no_sureness"
  | "low_sureness"
  | "stale_date"
  | "regen_failed"
  | "expired";

/** Reason kinds a human must answer: never sent by the timeout. */
const HUMAN_ONLY_KINDS: ReadonlySet<EscalationKind> = new Set<EscalationKind>([
  "opt_out",
  "complaint",
  "price",
  "medical",
  "billing",
]);

/** A newer lead message younger than this may still have a live turn coming. */
export const NEWER_INBOUND_SETTLE_SEC = 5 * 60;
/** A send due within this many seconds makes the holding line pointless. */
const HOLD_SKIP_IF_DUE_WITHIN_SEC = 10 * 60;

// ---- escalation reason classification (pure) ----

/**
 * Buckets the brain's free-text escalation reason (send_reply.escalation_reason
 * or escalate_to_human.reason). The model is told to use the literal tokens
 * `opt_out` / `complaint` (src/brain/tools.ts); the keyword fallbacks catch
 * older/looser phrasings.
 */
export type EscalationKind =
  | "opt_out"
  | "complaint"
  | "price"
  | "private_class"
  | "nivel0"
  | "special_needs"
  | "visitor"
  | "medical"
  | "billing";

function foldReason(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function classifyEscalation(reason: string | null | undefined): EscalationKind | null {
  if (!reason) return null;
  const r = foldReason(reason);
  // opt_out ONLY on the explicit token: a keyword guess ("baja" de peso) must
  // never silently end a lead.
  if (/\bopt[_ -]?out\b/.test(r)) return "opt_out";
  if (/\bcomplaint\b|\bqueja\b|enojad|molest[oa]|reclam|publicidad enganosa|enganos|\babuso\b|inconform/.test(r)) return "complaint";
  // Private classes are sold (owner, 2026-11-10): the bot says the sales
  // manager will reach out; a human task AND an owner alert go out.
  if (/\bclases?[_ -]?privadas?\b|\bprivate[_ -]?(?:class|lesson|session)s?\b|\bclases? particular|one[- ]on[- ]one/.test(r)) return "private_class";
  if (/\bnivel ?0\b|\bnivel cero\b|menor(?:es)? de (?:1|un) ano|under 12 months|\bbebe de \d{1,2} mes/.test(r)) return "nivel0";
  if (/\btdah\b|\badhd\b|autis|asperger|discapacidad|necesidades especiales|special needs|\bcondicion\b|diagnost|neurodiverg|\btea\b/.test(r)) return "special_needs";
  if (/visitante|visitor|drop[- ]?in|pase (?:de|por) (?:dia|clase)|clase suelta|paquete de visita|turista/.test(r)) return "visitor";
  if (/price negotiation|negocia|regate|descuento|rebaja|discount/.test(r)) return "price";
  // 2026-11-11 review: a medical question (…7505, knee surgery) and a billing
  // complaint (…8184, charge + cancel) carried a reason no bucket caught. They
  // never send themselves at the approval timeout; they escalate instead.
  if (/\bmedic|\bmedical\b|lesion|lastim|injur|operaci|cirugi|surgery|embaraz|pregnan|enfermedad|\basma\b|diabet|rodilla|\bknee\b|espalda|hernia/.test(r)) return "medical";
  if (/reembols|refund|me cobraron|\bcobraron\b|cobro (?:indebido|doble|duplicado|no reconocido)|cargo (?:indebido|doble|duplicado|no reconocido)|factura|invoice|billing|cancelar (?:la |mi |su )?(?:membresia|suscripcion|domiciliacion|plan)|baja de (?:la |mi |su )?(?:membresia|inscripcion)|cancel(?:ar)? (?:the |my )?membership/.test(r)) return "billing";
  return null;
}

/** Kinds that always become a human task (never a bot promise of "te aviso"). */
export function escalationNeedsTask(kind: EscalationKind | null): boolean {
  return (
    kind === "complaint" ||
    kind === "private_class" ||
    kind === "nivel0" ||
    kind === "special_needs" ||
    kind === "visitor"
  );
}

/** Kinds that, besides the #wa-leads task, alert the owner (#evan-alerts) at once. */
export function escalationAlertsOwner(kind: EscalationKind | null): boolean {
  return kind === "private_class";
}

/**
 * The #evan-alerts line for a private-class inquiry. Pure. `drafted` = the
 * bot's "el gerente de ventas te contactará" reply is on an approval card
 * (escalate_to_human sends nothing at all).
 */
export function privateClassAlertText(phone: string, reason: string, drafted: boolean): string {
  const why = reason.trim() ? ` (${reason.trim().slice(0, 300)})` : "";
  const bot = drafted
    ? "El bot le dice que el gerente de ventas lo contactará (borrador en Aprobar)."
    : "El bot NO le respondió nada.";
  return `🥋 Clase privada — ${phone} pregunta por clases privadas${why}. ${bot} Tarea en #wa-leads.`;
}

// ---- escalation SLA (one open task per phone, re-pings) ----

/** Unanswered escalation re-ping cadence. */
export const ESCALATION_REPING_SEC = 45 * 60;

/** The open-task record kept per phone (kv `esc_task:<phone>`). */
export interface EscalationTaskState {
  /** Slack ts of the task message (updated in place for later escalations). */
  ts: string;
  /** Approval row the task tracks (closed once it is no longer pending). */
  approvalId: number;
  /** When the task was first posted (epoch s) — the SLA clock. */
  createdAt: number;
  /** Re-pings already sent: 0, 1 (thread <!here>), 2 (owner DM). */
  pings: number;
}

export function escalationTaskKey(phone: string): string {
  return `esc_task:${phone}`;
}

export function parseEscalationTask(raw: string | null): EscalationTaskState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<EscalationTaskState>;
    if (typeof o.ts !== "string" || typeof o.approvalId !== "number" || typeof o.createdAt !== "number") return null;
    return { ts: o.ts, approvalId: o.approvalId, createdAt: o.createdAt, pings: typeof o.pings === "number" ? o.pings : 0 };
  } catch {
    return null;
  }
}

/**
 * Pure. Next SLA step for a still-open escalation task: "reping" (thread
 * <!here>) at 45 min, "dm_owner" at 90 min — only 09:00–21:00 CDMX, at most
 * one step per call, never more than two.
 */
export function decideEscalationPing(
  t: Pick<EscalationTaskState, "createdAt" | "pings">,
  now: number,
): "none" | "reping" | "dm_owner" {
  if (!isBusinessHours(now)) return "none";
  const age = now - t.createdAt;
  if (t.pings <= 0 && age >= ESCALATION_REPING_SEC) return "reping";
  if (t.pings === 1 && age >= 2 * ESCALATION_REPING_SEC) return "dm_owner";
  return "none";
}

/** Holding line floor: a draft the model is < 50 % sure of gets no "ya te respondemos". */
export const HOLDING_SURENESS_MIN = 50;
/** The lead's last message older than this ⇒ a holding line reads absurd. */
export const HOLDING_MAX_LEAD_SILENCE_SEC = 2 * 3600;

export type TimeoutAction =
  | { kind: "hold"; id: number; phone: string } // send holding line
  /** Send the draft as written — the wait passed and every safety check held. */
  | { kind: "bestbet"; id: number; phone: string; sureness: number }
  /** Run the brain again on the newest lead message (the draft is moot). */
  | { kind: "regenerate"; id: number; phone: string; why: "lead_wrote_again" | "no_answer" }
  /** Not safe to send: page a human once (task + owner alert). Row stays pending. */
  | { kind: "escalate"; id: number; phone: string; why: EscalateWhy[] }
  | { kind: "expire"; id: number; phone: string; windowClosed: boolean; escalate: boolean }
  /** The lead opted out since: the draft dies as `discarded`. */
  | { kind: "discard"; id: number; phone: string }
  | { kind: "none"; id: number };

/** When this row's timeout comes due (send or escalate). Pure. */
export function timeoutDueAt(a: Pick<TimeoutApprovalView, "createdAt" | "tasked">, p: TimeoutPolicy): number {
  const wait = a.tasked ? p.taskAutoSendAfterSec : p.autoSendAfterSec;
  return nextInWindow(a.createdAt + wait, p);
}

/**
 * Pure. What stands between a due draft and the lead. `hard` blockers are
 * facts about the CONTACT (kill switch, window, baja, human control, a reason a
 * human must answer); `soft` ones are about THIS draft's text (⚠️ warning,
 * sureness). `regenerate` = the draft is moot but a fresh brain turn may
 * answer (the lead wrote again, or the brain failed and left its apology).
 */
export function timeoutBlockers(
  a: TimeoutApprovalView,
  now: number,
  p: TimeoutPolicy,
): { hard: EscalateWhy[]; soft: EscalateWhy[]; regenerate?: "lead_wrote_again" | "no_answer"; settling?: boolean } {
  const hard: EscalateWhy[] = [];
  const soft: EscalateWhy[] = [];
  const windowOpen = a.lastInboundAt !== null && now - a.lastInboundAt < WINDOW_SECONDS;
  if (a.hasDraft === false) hard.push("no_draft");
  if (a.botEnabled === false) hard.push("kill_switch");
  if (!windowOpen) hard.push("window_closed");
  if (a.overrideActive) hard.push("override");
  if (a.declined) hard.push("declined");
  if (a.reasonKind && HUMAN_ONLY_KINDS.has(a.reasonKind)) hard.push("reason_kind");
  if (a.guarded) soft.push("slot_warning");
  if (a.sureness === undefined) soft.push("no_sureness");
  else if (a.sureness < p.minSureness) soft.push("low_sureness");
  if (hard.length > 0) return { hard, soft };
  // The lead wrote AFTER this draft was made: it answers an older message.
  if (a.lastInboundAt !== null && a.lastInboundAt > a.createdAt) {
    if (now - a.lastInboundAt < NEWER_INBOUND_SETTLE_SEC) return { hard, soft, settling: true };
    return { hard, soft, regenerate: "lead_wrote_again" };
  }
  if (a.apologyDraft) return { hard, soft, regenerate: "no_answer" };
  return { hard, soft };
}

/**
 * Pure decision for a single approval. Injectable `now` (seconds), policy from
 * client.mjs `approvals`.
 *
 * - age > expireAfterHours ⇒ expire (escalate: true when nobody was paged yet).
 *   A draft that would still send passes first (the cron was down, not a "no").
 * - before the due time (createdAt + autoSendAfterMin, pushed into the CDMX
 *   send window; taskAutoSendAfterMin for rows with a human task) ⇒ the
 *   10-min holding line as before, skipped when a clean send is ≤ 10 min away.
 * - due:
 *   · opted out                         ⇒ discard
 *   · any hard/soft blocker             ⇒ escalate once (task + owner alert);
 *     rows whose escalation task already re-pings (tasked) stay with the SLA
 *   · lead wrote again / brain apology  ⇒ regenerate (fresh brain turn)
 *   · otherwise                         ⇒ bestbet (send as written; the
 *     runtime re-checks hoy/mañana against the clock first)
 */
export function decideTimeout(
  a: TimeoutApprovalView,
  now: number,
  p: TimeoutPolicy = timeoutPolicy(),
): TimeoutAction {
  const age = now - a.createdAt;
  const windowOpen = a.lastInboundAt !== null && now - a.lastInboundAt < WINDOW_SECONDS;
  const kind = a.reasonKind ?? null;
  const due = timeoutDueAt(a, p);
  const b = timeoutBlockers(a, now, p);
  const clean = b.hard.length === 0 && b.soft.length === 0 && !b.settling;
  const paged = a.tasked === true || a.escalated === true;

  // Outside the send window (the lead wrote at night): a clean, CONFIDENT
  // draft still goes once its wait is over — the lead is awake and asking.
  // Everything else (regeneration, escalation pages, shakier drafts) keeps
  // waiting for the window to open.
  const rawDue = a.createdAt + (a.tasked ? p.taskAutoSendAfterSec : p.autoSendAfterSec);
  if (
    now >= rawDue &&
    now < due &&
    p.overnightMinSureness !== null &&
    clean &&
    !b.regenerate &&
    !a.optedOut &&
    a.sureness !== undefined &&
    a.sureness >= p.overnightMinSureness
  ) {
    return { kind: "bestbet", id: a.id, phone: a.phone, sureness: a.sureness };
  }

  if (now >= due) {
    if (a.optedOut && a.hasDraft !== false) return { kind: "discard", id: a.id, phone: a.phone };
    if (clean && b.regenerate) return { kind: "regenerate", id: a.id, phone: a.phone, why: b.regenerate };
    // Clean drafts still send late (the cron was down) — up to expireAfterHours past due.
    if (clean && now - due <= p.expireAfterSec) {
      return { kind: "bestbet", id: a.id, phone: a.phone, sureness: a.sureness! };
    }
    // regenerate beats the draft's own soft blockers (it is moot anyway).
    if (b.hard.length === 0 && b.regenerate) {
      return { kind: "regenerate", id: a.id, phone: a.phone, why: b.regenerate };
    }
  }

  // Never before the due time: an overnight draft must reach its 08:00 turn
  // even if the owner shortens expireAfterHours.
  if (age > p.expireAfterSec && now >= due) {
    return { kind: "expire", id: a.id, phone: a.phone, windowClosed: !windowOpen, escalate: !paged };
  }

  if (now >= due) {
    if (b.settling) return { kind: "none", id: a.id };
    if (paged) return { kind: "none", id: a.id };
    return { kind: "escalate", id: a.id, phone: a.phone, why: [...b.hard, ...b.soft] };
  }

  const sendSoon = clean && !b.regenerate && due - now <= HOLD_SKIP_IF_DUE_WITHIN_SEC;
  if (
    age > HOLDING_THRESHOLD_SEC &&
    !sendSoon &&
    !a.holdingSent &&
    windowOpen &&
    isBusinessHours(now) &&
    a.awaitingReply !== false &&
    // 2026-10-11 (…4595): the 09:00 holding line went to a lead who had
    // complained and asked us to stop at 21:38 the night before. Never for an
    // opt-out/complaint, never for a shaky draft (< 50 %, or a guarded one
    // whose sureness was stripped), never when the lead went quiet > 2 h ago.
    kind !== "opt_out" &&
    kind !== "complaint" &&
    !(a.sureness !== undefined && a.sureness < HOLDING_SURENESS_MIN) &&
    !(a.guarded && a.sureness === undefined) &&
    a.lastInboundAt !== null &&
    now - a.lastInboundAt <= HOLDING_MAX_LEAD_SILENCE_SEC
  ) {
    return { kind: "hold", id: a.id, phone: a.phone };
  }
  return { kind: "none", id: a.id };
}

/** Spanish label for each escalation reason (task / alert copy). */
export function escalateWhyLabel(why: EscalateWhy, a?: { sureness?: number; reasonKind?: EscalationKind | null }): string {
  switch (why) {
    case "no_draft": return "el bot no redactó respuesta";
    case "kill_switch": return "bot apagado";
    case "window_closed": return "ventana de 24 h cerrada (usa plantilla)";
    case "override": return "control humano activo";
    case "declined": return "el lead dijo que no le interesa";
    case "reason_kind": return `tema para humano (${a?.reasonKind ?? "?"})`;
    case "slot_warning": return "⚠️ horario/agendado por verificar";
    case "no_sureness": return "sin nivel de seguridad";
    case "low_sureness": return `seguridad ${a?.sureness ?? "?"}%`;
    case "stale_date": return "fecha/hora del borrador ya no aplica";
    case "regen_failed": return "no se pudo regenerar la respuesta";
    case "expired": return "expiró sin respuesta";
  }
}

export interface EscalationLine {
  phone: string;
  name: string | null;
  question: string;
  why: string[];
  approvalId: number;
}

/** The lead's newest line (👤 …) from an approval's stored transcript. Pure. */
export function lastLeadLine(context: string | null): string {
  if (!context) return "";
  const lines = context.split("\n").filter((l) => l.startsWith("👤"));
  const last = lines[lines.length - 1] ?? "";
  const body = last.replace(/^👤\s*(?:🎤\s*)?/, "").replace(/\s+/g, " ").trim();
  return body.length > 140 ? `${body.slice(0, 139)}…` : body;
}

/** Pure. ONE #wa-leads task + ONE owner alert for every row escalated this tick. */
export function escalationNotes(lines: EscalationLine[]): { task: string; alert: string } | null {
  if (lines.length === 0) return null;
  const item = (l: EscalationLine): string =>
    `• ${l.name ? `${l.name} · ` : ""}${l.phone} — «${l.question || "(sin texto)"}» — ${l.why.join(", ")} (#${l.approvalId})`;
  const n = lines.length;
  const head =
    n === 1
      ? "<!here> ⏰ Un lead espera respuesta y el bot NO puede enviarla solo — contéstale tú (Aprobar / Editar):"
      : `<!here> ⏰ ${n} leads esperan respuesta y el bot NO puede enviarla solo — contéstales tú (Aprobar / Editar):`;
  const task = [head, ...lines.slice(0, 15).map(item), ...(n > 15 ? [`…y ${n - 15} más en Aprobar.`] : [])].join("\n");
  const alert =
    `⏰ ${n} ${n === 1 ? "borrador no pudo" : "borradores no pudieron"} salir solos y esperan a un humano en #wa-leads: ` +
    lines
      .slice(0, 8)
      .map((l) => `${l.phone} (${l.why[0] ?? "?"})`)
      .join(", ") +
    (n > 8 ? `, +${n - 8}` : "");
  return { task, alert };
}

/** Ventana-restante en horas (redondeo hacia arriba), min 0. */
export function windowHoursLeft(lastInboundAt: number | null, now: number): number {
  if (lastInboundAt === null) return 0;
  const remaining = WINDOW_SECONDS - (now - lastInboundAt);
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 3600);
}

// Neutral on purpose: "te confirmo" reads like a booking confirmation when the
// lead was mid-scheduling, so the copy must only promise a human reply.
export const HOLDING_LINE =
  "¡Gracias por escribir! 🙌 En un momento te respondemos por aquí.";
/** English twin (2026-11-11 review: an English-speaking parent got the Spanish line twice). */
export const HOLDING_LINE_EN =
  "Thanks for your message! 🙌 Give me a moment and I'll get right back to you.";

export function holdingLineFor(lang: string | null | undefined): string {
  return lang === "en" ? HOLDING_LINE_EN : HOLDING_LINE;
}

/** The brain's failure apology (claude.ts safeApology) is exactly a holding line. */
export function isApologyDraft(draft: string | null | undefined): boolean {
  const d = (draft ?? "").trim();
  return d === HOLDING_LINE || d === HOLDING_LINE_EN;
}

// ---- ad/campaign attribution line (draft-approval card) ----

/**
 * Builds the attribution context line for a draft card from the contact's raw
 * ad_ref JSON + the matched campaign's name. Shows the campaign when one is
 * assigned, "_sin asignar_" when the lead came from an ad that no campaign
 * claims (Evan's cue to map the ad id in Campañas), the ad headline with a
 * snippet of the creative text, and the ad id. Null when there's nothing to
 * show (no referral and no campaign). Tolerant of malformed JSON.
 */
export function adAttributionLine(
  adRef: string | null,
  campaignName: string | null,
): string | null {
  let headline = "";
  let body = "";
  let id = "";
  if (adRef) {
    try {
      const r = JSON.parse(adRef) as {
        headline?: string | null;
        body?: string | null;
        sourceId?: string | null;
      };
      headline = (r.headline ?? "").trim();
      body = (r.body ?? "").trim();
      id = (r.sourceId ?? "").trim();
    } catch {
      // malformed ad_ref → treat as no ad
    }
  }
  const hasAd = Boolean(headline || body || id);
  const parts: string[] = [];
  if (campaignName) parts.push(`🎯 Campaña: *${campaignName}*`);
  else if (hasAd) parts.push("🎯 Campaña: _sin asignar_");
  if (hasAd) {
    let ad = `📣 Anuncio: ${headline || id}`;
    if (body) ad += ` — «${body.length > 90 ? `${body.slice(0, 89)}…` : body}»`;
    if (headline && id) ad += ` (${id})`;
    parts.push(ad);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Pure: allowlist check. Unset/blank allowlist ⇒ allow (legacy). */
export function isAllowedSlackUser(
  env: { SLACK_ALLOWED_USER_IDS?: string },
  userId: string | null,
): boolean {
  const allowed = (env.SLACK_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return userId !== null && allowed.includes(userId);
}

