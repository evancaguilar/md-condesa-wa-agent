// Meta Conversions API for Business Messaging (docs/meta-capi.md).
//
// WHY: every campaign is click-to-WhatsApp and optimizes for "conversations
// started", so Meta buys cheap chats that never show up. Sending the DOWNSTREAM
// funnel back (booked → attended → purchase) is what lets a campaign optimize
// for people who actually enroll.
//
// HOW: Meta keys business-messaging conversions on the `ctwa_clid` that rides in
// on the click-to-WhatsApp referral — which the inbound pipeline already stores
// in `contacts.ad_ref` (see types.ts AdRef). Events go to
// POST {GRAPH}/<DATASET_ID>/events with action_source "business_messaging" and
// messaging_channel "whatsapp".
//
// SHAPE OF THIS MODULE:
//  - pure builders (buildMessagingEvent, capiEventsForResult, capiEventId…)
//    — unit-tested, no I/O;
//  - a thin sender (sendMessagingEvents) that NEVER throws and never lets the
//    token reach a log;
//  - a kv-backed queue: the funnel hooks only ENQUEUE (a D1 write, no network,
//    so a Meta outage can never slow a reply or block a booking), and
//    src/cron/capi.ts drains a handful per tick.
//
// SHIPS INERT: everything is a no-op unless CLIENT.features.metaCapi is true
// AND env.META_CAPI_DATASET_ID is set AND a token exists.

import type { Env } from "../types.js";
import type { AdRef } from "../types.js";
import { CLIENT } from "../client.gen.js";
import { GRAPH } from "./ad-meta.js";
import { getContact, kvGet, kvSet, kvSetIfAbsent } from "../db/queries.js";
import { normalizeResult } from "./airtable.js";

// ---- constants ----

/** Funnel steps we report. Kept separate from the Meta event NAME below. */
export type CapiEventKind = "booked" | "attended" | "purchase";

/**
 * Meta event names per funnel step. Business messaging accepts ONLY this list
 * (FAQ, developers.facebook.com/documentation/ads-commerce/conversions-api/
 * business-messaging): Purchase, LeadSubmitted, InitiateCheckout, AddToCart,
 * ViewContent, OrderCreated, OrderShipped, OrderDelivered, OrderCanceled,
 * OrderReturned, CartAbandoned, QualifiedLead, RatingProvided, ReviewProvided.
 * Custom event names are NOT documented as supported — do not invent one.
 *
 * Mapping (see docs/meta-capi.md for the reasoning):
 *  - booked   → LeadSubmitted : the lead committed to a trial slot.
 *  - attended → QualifiedLead : they physically showed up (Schedule/Contact,
 *               the natural names, are NOT on the allowed list).
 *  - purchase → Purchase      : enrolled, carries `Pago Inicial` in MXN.
 */
export const CAPI_EVENT_NAMES: Record<CapiEventKind, string> = {
  booked: "LeadSubmitted",
  attended: "QualifiedLead",
  purchase: "Purchase",
};

/** Every event name Meta documents as allowed for business messaging. */
export const CAPI_ALLOWED_EVENT_NAMES = [
  "Purchase",
  "LeadSubmitted",
  "InitiateCheckout",
  "AddToCart",
  "ViewContent",
  "OrderCreated",
  "OrderShipped",
  "OrderDelivered",
  "OrderCanceled",
  "OrderReturned",
  "CartAbandoned",
  "QualifiedLead",
  "RatingProvided",
  "ReviewProvided",
] as const;

/** Currency for every Purchase value (the academy only ever charges MXN). */
export const CAPI_CURRENCY = "MXN";

/**
 * "The event_time can be up to 7 days before you send an event to Meta. If any
 * event_time in data is greater than 7 days in the past, we return an error for
 * the ENTIRE request and process no events." (CAPI "Using the API"). We stay a
 * few hours inside that edge so a queued event can never expire mid-retry.
 */
export const CAPI_MAX_EVENT_AGE_SEC = 7 * 86400 - 6 * 3600;

/** Events sent per cron tick. One POST each ⇒ at most 5 subrequests. */
export const CAPI_MAX_PER_TICK = 5;

/** Give up on a queued event after this many failed drains. */
export const CAPI_MAX_ATTEMPTS = 3;

export const KV_CAPI_QUEUE_PREFIX = "capi_q:";
/**
 * Idle gate. The queue lives in kv rows, and a `LIKE 'capi_q:%'` scan on every
 * 5-minute tick is exactly the kind of table scan that burned the D1 row budget
 * three times (docs/STATUS.md). Enqueue sets this to "1"; the drain clears it
 * when it empties the queue, so an idle tick reads ONE row by primary key.
 */
export const KV_CAPI_PENDING = "capi_pending";
/** At-most-once claim per contact per funnel step: `capi:<kind>:<phone>`. */
export const KV_CAPI_CLAIM_PREFIX = "capi:";
export const KV_CAPI_LAST_OK = "capi_last_ok";
export const KV_CAPI_LAST_ERROR = "capi_last_error";
/** Per-CDMX-day counter of events Meta accepted: `capi_count:<YYYY-MM-DD>`. */
export const KV_CAPI_COUNT_PREFIX = "capi_count:";
/** One Slack note per CDMX day on persistent failure: `capi_note:<YYYY-MM-DD>`. */
export const KV_CAPI_NOTE_PREFIX = "capi_note:";

// ---- config ----

export type CapiTokenSource =
  | "META_CAPI_TOKEN"
  | "ADS_ACCESS_TOKEN"
  | "WA_ACCESS_TOKEN"
  | null;

export interface CapiConfig {
  /** True only when the flag, the dataset id AND a token are all present. */
  enabled: boolean;
  datasetId: string | null;
  wabaId: string | null;
  token: string | null;
  tokenSource: CapiTokenSource;
  /** Why it is off, for the admin probe. null when enabled. */
  reason: "feature_off" | "no_dataset" | "no_waba" | "no_token" | null;
}

/**
 * Resolve config.
 *
 * TOKEN: posting to a business-messaging dataset needs `whatsapp_business_
 * management` + `whatsapp_business_manage_events` (ADVANCED access) — NOT the
 * ads permissions the spend import uses. So META_CAPI_TOKEN (a system-user
 * token minted for exactly this) wins; ADS_ACCESS_TOKEN and then the WhatsApp
 * token are fallbacks that work only if that system user also holds the
 * whatsapp_business_* scopes. The probe reports which one is in play.
 */
export function capiConfig(env: Env): CapiConfig {
  const datasetId = (env.META_CAPI_DATASET_ID ?? "").trim() || null;
  const wabaId = (env.WA_WABA_ID ?? "").trim() || null;
  const token = env.META_CAPI_TOKEN || env.ADS_ACCESS_TOKEN || env.WA_ACCESS_TOKEN || null;
  const tokenSource: CapiTokenSource = env.META_CAPI_TOKEN
    ? "META_CAPI_TOKEN"
    : env.ADS_ACCESS_TOKEN
      ? "ADS_ACCESS_TOKEN"
      : env.WA_ACCESS_TOKEN
        ? "WA_ACCESS_TOKEN"
        : null;
  const featureOn = CLIENT.features.metaCapi === true;
  const reason = !featureOn
    ? ("feature_off" as const)
    : !datasetId
      ? ("no_dataset" as const)
      : !wabaId
        ? ("no_waba" as const)
        : !token
          ? ("no_token" as const)
          : null;
  return { enabled: reason === null, datasetId, wabaId, token, tokenSource, reason };
}

// ---- pure builders ----

export interface MessagingEventInput {
  /** A Meta standard event name (see CAPI_EVENT_NAMES). */
  eventName: string;
  /** Unix seconds. Must be within CAPI_MAX_EVENT_AGE_SEC of now. */
  eventTimeSec: number;
  /** The click-to-WhatsApp click id from the referral (never hashed). */
  ctwaClid: string;
  /** WhatsApp Business Account id that received the message (never hashed). */
  wabaId: string;
  /** Deterministic id so a retry dedupes instead of double-counting. */
  eventId: string;
  value?: number | null;
  currency?: string | null;
  /** Extra non-PII custom_data (e.g. {program: "kids"}). */
  customData?: Record<string, string | number>;
}

export interface MessagingEvent {
  event_name: string;
  event_time: number;
  action_source: "business_messaging";
  messaging_channel: "whatsapp";
  event_id: string;
  user_data: {
    whatsapp_business_account_id: string;
    ctwa_clid: string;
  };
  custom_data?: Record<string, string | number>;
}

/**
 * Pure. One event object exactly as the business-messaging guide documents it:
 *
 *   {"event_name":"Purchase","event_time":1675999999,
 *    "action_source":"business_messaging","messaging_channel":"whatsapp",
 *    "user_data":{"whatsapp_business_account_id":"…","ctwa_clid":"…"},
 *    "custom_data":{"currency":"USD","value":123}}
 *
 * `user_data` here is NOT hashed: the CAPI parameters page lists `ctwa_clid`
 * among the fields sent in the clear, and whatsapp_business_account_id is a
 * plain business id. We deliberately send NO phone, email or name — the
 * ctwa_clid is all Meta needs to attribute the click, so nothing that would
 * require SHA-256 ever leaves the worker.
 *
 * `event_id` is not part of the documented business-messaging sample (Meta
 * states it does NOT deduplicate these events for you), but it is a valid
 * server-event parameter and costs nothing, so we send a deterministic one and
 * do the real deduplication ourselves in D1.
 *
 * A value is only attached when it is a finite positive number; "no amount"
 * must never become 0 (that would tell Meta the sale was worthless).
 */
export function buildMessagingEvent(input: MessagingEventInput): MessagingEvent {
  const event: MessagingEvent = {
    event_name: input.eventName,
    event_time: Math.floor(input.eventTimeSec),
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    event_id: input.eventId,
    user_data: {
      whatsapp_business_account_id: input.wabaId,
      ctwa_clid: input.ctwaClid,
    },
  };
  const custom: Record<string, string | number> = { ...(input.customData ?? {}) };
  const value = typeof input.value === "number" && Number.isFinite(input.value) && input.value > 0
    ? input.value
    : null;
  if (value !== null) {
    custom.value = value;
    custom.currency = (input.currency || CAPI_CURRENCY).toUpperCase();
  }
  if (Object.keys(custom).length > 0) event.custom_data = custom;
  return event;
}

/**
 * Pure. Which funnel events an Airtable `Resultado Clase Prueba` value implies.
 * Deliberately independent of classifyResult (which another workstream owns):
 * this reads the RAW value so a new option there can never silently stop the
 * reporting.
 *
 *  - "Se inscribió"      → attended + purchase (you cannot enroll without showing up)
 *  - "Asistió"           → attended
 *  - "No asistió"        → nothing (the "asistio" inside it is stripped first)
 */
export function capiEventsForResult(raw: string | null | undefined): CapiEventKind[] {
  const n = normalizeResult(raw);
  if (!n) return [];
  if (n.includes("se inscribio")) return ["attended", "purchase"];
  // "no asistio" contains "asistio" — remove the negative form before testing.
  const positive = n.replace(/\bno\s+asistio\b/g, " ");
  if (positive.includes("asistio")) return ["attended"];
  return [];
}

/**
 * Pure. 32-bit FNV-1a as 8 hex chars. Used to keep phone numbers out of the
 * event ids we hand to Meta while staying deterministic across retries.
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Pure. Deterministic dedup id: same contact + same funnel step ⇒ same id, so a
 * retry (or a second queue row) is collapsed by Meta instead of double-counted.
 */
export function capiEventId(kind: CapiEventKind, phone: string, recordId?: string | null): string {
  return `${CLIENT.clientId}-${kind}-${shortHash(`${kind}:${phone}:${recordId ?? ""}`)}`;
}

/** The at-most-once claim key for a contact + funnel step. */
export function capiClaimKey(kind: CapiEventKind, phone: string): string {
  return `${KV_CAPI_CLAIM_PREFIX}${kind}:${phone}`;
}

/** Queue row key for an event id. */
export function capiQueueKey(eventId: string): string {
  return `${KV_CAPI_QUEUE_PREFIX}${eventId}`;
}

/** Pure. Is this event still inside Meta's accepted age window? */
export function capiEventFresh(eventTimeSec: number, nowSec: number): boolean {
  if (!Number.isFinite(eventTimeSec)) return false;
  const age = nowSec - eventTimeSec;
  // A little clock skew into the future is fine; stale is not.
  return age >= -3600 && age <= CAPI_MAX_EVENT_AGE_SEC;
}

/** Pure. Replace every occurrence of the token (and any Bearer form) with ***. */
export function redactToken(text: string, token: string | null | undefined): string {
  let out = text;
  if (token && token.length >= 8) out = out.split(token).join("***");
  // Belt and braces: anything that still looks like an access token in a URL.
  return out.replace(/access_token=[^&\s]+/gi, "access_token=***");
}

// ---- queue rows ----

export interface QueuedCapiEvent {
  kind: CapiEventKind;
  /** Contact id (phone digits) — stays in D1, never sent to Meta. */
  phone: string;
  ctwaClid: string;
  eventTime: number;
  value?: number;
  currency?: string;
  /** Airtable record the event came from, when there is one (diagnostics). */
  recordId?: string;
  attempts?: number;
}

/** Pure. Parse a queue row; returns null for anything malformed. */
export function parseQueuedEvent(raw: string | null): QueuedCapiEvent | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<QueuedCapiEvent>;
    if (!p.kind || !p.phone || !p.ctwaClid) return null;
    if (!(p.kind in CAPI_EVENT_NAMES)) return null;
    if (!Number.isFinite(p.eventTime)) return null;
    return {
      kind: p.kind,
      phone: p.phone,
      ctwaClid: p.ctwaClid,
      eventTime: Number(p.eventTime),
      ...(typeof p.value === "number" ? { value: p.value } : {}),
      ...(p.currency ? { currency: p.currency } : {}),
      ...(p.recordId ? { recordId: p.recordId } : {}),
      ...(typeof p.attempts === "number" ? { attempts: p.attempts } : {}),
    };
  } catch {
    return null;
  }
}

/** Pure. A queue row → the Graph event object. */
export function eventFromQueued(row: QueuedCapiEvent, wabaId: string): MessagingEvent {
  return buildMessagingEvent({
    eventName: CAPI_EVENT_NAMES[row.kind],
    eventTimeSec: row.eventTime,
    ctwaClid: row.ctwaClid,
    wabaId,
    eventId: capiEventId(row.kind, row.phone, row.recordId ?? null),
    value: row.value ?? null,
    currency: row.currency ?? null,
  });
}

// ---- the sender ----

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CapiSendResult {
  ok: boolean;
  /** Events Meta reported as received, when it said. */
  received: number;
  status: number | null;
  /** Token-free error message; null on success. */
  error: string | null;
  /** Set when nothing was attempted. */
  skipped: "disabled" | "no_events" | null;
}

export interface SendOpts {
  /** Events Manager → Test events code, so Evan can watch a test land. */
  testEventCode?: string | null;
}

/**
 * POST events to the dataset: ONE subrequest per call regardless of batch size.
 * Never throws — the caller gets a result object; the token is sent as a Bearer
 * header (never in the URL, which would put it in every log line) and scrubbed
 * from every error string.
 *
 * NOTE the drain deliberately calls this with ONE event at a time: Meta rejects
 * the ENTIRE batch if any single event in it is invalid, so batching would let
 * one bad row (e.g. a malformed ctwa_clid) drop good conversions.
 */
export async function sendMessagingEvents(
  env: Env,
  events: MessagingEvent[],
  doFetch: FetchLike = (url, init) => fetch(url, init),
  opts: SendOpts = {},
): Promise<CapiSendResult> {
  const cfg = capiConfig(env);
  if (!cfg.enabled || !cfg.datasetId || !cfg.token) {
    return { ok: false, received: 0, status: null, error: null, skipped: "disabled" };
  }
  if (events.length === 0) {
    return { ok: false, received: 0, status: null, error: null, skipped: "no_events" };
  }
  const body: Record<string, unknown> = { data: events };
  if (opts.testEventCode) body.test_event_code = opts.testEventCode;
  try {
    const res = await doFetch(`${GRAPH}/${cfg.datasetId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      events_received?: number;
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    if (!res.ok) {
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      const code = json.error?.code !== undefined ? ` (code ${json.error.code})` : "";
      return {
        ok: false,
        received: 0,
        status: res.status,
        error: redactToken(`${msg}${code}`, cfg.token),
        skipped: null,
      };
    }
    return {
      ok: true,
      received: typeof json.events_received === "number" ? json.events_received : events.length,
      status: res.status,
      error: null,
      skipped: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      received: 0,
      status: null,
      error: redactToken(msg, cfg.token),
      skipped: null,
    };
  }
}

// ---- enqueue (what the funnel hooks call) ----

export type CapiEnqueueResult =
  | "queued"
  | "duplicate"
  | "disabled"
  | "no_clid"
  | "too_old";

export interface EnqueueInput {
  kind: CapiEventKind;
  phone: string;
  /** When the funnel step happened (unix seconds). Defaults to now. */
  eventTimeSec?: number;
  /** Purchase amount; ignored for the other kinds. */
  value?: number | null;
  currency?: string | null;
  recordId?: string | null;
  /** Pre-read ctwa_clid; omit and the contact row is read. */
  ctwaClid?: string | null;
}

/** Pure. Pull the ctwa_clid out of a contacts.ad_ref JSON blob. */
export function ctwaClidFromAdRef(adRef: string | null | undefined): string | null {
  if (!adRef) return null;
  try {
    const parsed = JSON.parse(adRef) as Partial<AdRef>;
    const clid = typeof parsed.ctwaClid === "string" ? parsed.ctwaClid.trim() : "";
    return clid || null;
  } catch {
    return null;
  }
}

/**
 * Record one funnel event for later delivery. Cheap (no network) and safe to
 * call from a request path. At most ONE event per contact per kind, ever —
 * the claim row is what enforces it, so retries and re-syncs are free.
 */
export async function enqueueCapiEvent(
  env: Env,
  input: EnqueueInput,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<CapiEnqueueResult> {
  const cfg = capiConfig(env);
  if (!cfg.enabled) return "disabled";

  let clid = input.ctwaClid ?? null;
  if (!clid) {
    const contact = await getContact(env.DB, input.phone);
    clid = ctwaClidFromAdRef(contact?.ad_ref ?? null);
  }
  // Not an ad lead (organic, referral, old row) → nothing to attribute.
  if (!clid) return "no_clid";

  const eventTime = input.eventTimeSec ?? nowSec;
  if (!capiEventFresh(eventTime, nowSec)) return "too_old";

  // At-most-once per contact per funnel step.
  const claimed = await kvSetIfAbsent(env.DB, capiClaimKey(input.kind, input.phone), String(nowSec));
  if (!claimed) return "duplicate";

  const row: QueuedCapiEvent = {
    kind: input.kind,
    phone: input.phone,
    ctwaClid: clid,
    eventTime,
    ...(input.kind === "purchase" && typeof input.value === "number" && input.value > 0
      ? { value: input.value, currency: (input.currency || CAPI_CURRENCY).toUpperCase() }
      : {}),
    ...(input.recordId ? { recordId: input.recordId } : {}),
  };
  await kvSet(
    env.DB,
    capiQueueKey(capiEventId(input.kind, input.phone, input.recordId ?? null)),
    JSON.stringify(row),
  );
  // Wake the drain (see KV_CAPI_PENDING).
  await kvSet(env.DB, KV_CAPI_PENDING, "1");
  return "queued";
}

/**
 * Fire-and-forget wrapper used by the funnel hooks: never throws, never logs a
 * token, and is a no-op while the feature is off.
 */
export async function captureCapiEvent(
  env: Env,
  input: EnqueueInput,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<CapiEnqueueResult | "error"> {
  try {
    return await enqueueCapiEvent(env, input, nowSec);
  } catch (err) {
    console.warn(`[capi] enqueue ${input.kind} failed: ${String(err)}`);
    return "error";
  }
}

/**
 * The result-watcher hook (called from cron/followups.processResult). Maps the
 * raw Airtable result to its funnel events and queues each one. Self-contained
 * and idempotent so it can sit next to — never inside — the existing branches.
 */
export async function captureResultCapiEvents(
  env: Env,
  args: {
    phone: string;
    recordId: string;
    rawResult: string | null | undefined;
    trialDateTimeIso?: string | null;
    /** `Pago Inicial` from the Airtable row, when the column holds a number. */
    initialPayment?: number | null;
  },
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<CapiEnqueueResult[]> {
  const kinds = capiEventsForResult(args.rawResult);
  if (kinds.length === 0) return [];
  // The trial datetime is when the visit actually happened; a late-marked
  // result would otherwise report today. Falls back to now when unknown, and
  // anything outside Meta's window is dropped by capiEventFresh.
  const trialEpoch = args.trialDateTimeIso
    ? Math.floor(Date.parse(args.trialDateTimeIso) / 1000)
    : NaN;
  const eventTimeSec = Number.isFinite(trialEpoch) ? trialEpoch : undefined;
  const out: CapiEnqueueResult[] = [];
  for (const kind of kinds) {
    const res = await captureCapiEvent(
      env,
      {
        kind,
        phone: args.phone,
        recordId: args.recordId,
        ...(eventTimeSec !== undefined ? { eventTimeSec } : {}),
        ...(kind === "purchase" ? { value: args.initialPayment ?? null } : {}),
      },
      nowSec,
    );
    out.push(res === "error" ? "disabled" : res);
  }
  return out;
}

// ---- probe support (admin) ----

export interface CapiProbe {
  enabled: boolean;
  featureFlag: boolean;
  datasetIdSet: boolean;
  wabaIdSet: boolean;
  tokenSource: CapiTokenSource;
  reason: CapiConfig["reason"];
  eventNames: Record<CapiEventKind, string>;
  lastOk: string | null;
  lastError: string | null;
  countToday: number;
  queued: number;
}

/** Read-only state for GET /admin/api/capi/probe. Never returns the token. */
export async function capiProbe(env: Env, today: string): Promise<CapiProbe> {
  const cfg = capiConfig(env);
  const [lastOk, lastError, count, queued] = await Promise.all([
    kvGet(env.DB, KV_CAPI_LAST_OK),
    kvGet(env.DB, KV_CAPI_LAST_ERROR),
    kvGet(env.DB, `${KV_CAPI_COUNT_PREFIX}${today}`),
    countQueued(env),
  ]);
  return {
    enabled: cfg.enabled,
    featureFlag: CLIENT.features.metaCapi === true,
    datasetIdSet: !!cfg.datasetId,
    wabaIdSet: !!cfg.wabaId,
    tokenSource: cfg.tokenSource,
    reason: cfg.reason,
    eventNames: CAPI_EVENT_NAMES,
    lastOk,
    lastError,
    countToday: Number(count ?? 0) || 0,
    queued,
  };
}

export interface DatasetLookup {
  ok: boolean;
  /** Dataset ids already linked to the WABA (Meta allows one per asset). */
  datasetIds: string[];
  /** The id currently configured in META_CAPI_DATASET_ID, when set. */
  configured: string | null;
  error: string | null;
}

/**
 * GET {GRAPH}/<WABA_ID>/dataset — the documented way to find the dataset linked
 * to a WhatsApp Business Account (POST to the same edge creates one). Exists so
 * Evan can read the id from the dashboard: the token is a Cloudflare secret, so
 * he cannot run the curl himself. Read-only; never throws; never leaks the token.
 */
export async function lookupDataset(
  env: Env,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<DatasetLookup> {
  const cfg = capiConfig(env);
  const out: DatasetLookup = {
    ok: false,
    datasetIds: [],
    configured: cfg.datasetId,
    error: null,
  };
  if (!cfg.wabaId) {
    out.error = "WA_WABA_ID unset";
    return out;
  }
  if (!cfg.token) {
    out.error = "no Meta token (META_CAPI_TOKEN / ADS_ACCESS_TOKEN / WA_ACCESS_TOKEN unset)";
    return out;
  }
  try {
    const res = await doFetch(`${GRAPH}/${cfg.wabaId}/dataset`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      data?: { id?: string }[];
      error?: { message?: string; code?: number };
    };
    if (!res.ok) {
      const code = json.error?.code !== undefined ? ` (code ${json.error.code})` : "";
      out.error = redactToken(`${json.error?.message ?? `HTTP ${res.status}`}${code}`, cfg.token);
      return out;
    }
    const ids = [
      ...(json.id ? [json.id] : []),
      ...(json.data ?? []).map((d) => d.id).filter((id): id is string => !!id),
    ];
    out.datasetIds = [...new Set(ids)];
    out.ok = true;
  } catch (err) {
    out.error = redactToken(err instanceof Error ? err.message : String(err), cfg.token);
  }
  return out;
}

async function countQueued(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM kv WHERE key LIKE '${KV_CAPI_QUEUE_PREFIX}%'`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0) || 0;
}
