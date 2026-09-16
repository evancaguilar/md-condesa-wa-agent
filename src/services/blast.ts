// Template blasts (bulk sends) — v2 (2026-09-16). Owner-gated, template-only
// out of the 24h window, throttled by the 5-min cron, tracked per run.
//
// Flow (dashboard "Envíos" tab or the /admin/api/blast/* endpoints):
//   1. templates — list the WABA's templates from Meta with status/variables
//                  (docs/blasts.md). A run can only be queued on an APPROVED one.
//   2. preview   — audience counts + samples + what was excluded. NO sends.
//   3. test      — ONE real send to a phone the owner names.
//   4. queue     — inserts one `blast` followup row per recipient + a run
//                  record in kv (`blast_run:<runId>`). Requires {confirm:true}.
//   5. drain     — src/cron/blasts.ts sends BLAST_PER_TICK rows per tick inside
//                  09:00–21:00 CDMX, under a per-day cap, auto-pausing the run
//                  on template/account errors (see classifySendError).
//
// Hard rule upstream (CLAUDE.md): never bulk-send without Evan's explicit OK —
// the queue endpoint needs an owner session AND confirm:true, and nothing here
// starts on its own.
//
// v1 compatibility: rows queued on 2026-08-28 carried {t,l,p2,n} notes; they
// still decode (p2 → 2-param body) so an old run can drain or be cancelled.

import type { Contact, Env } from "../types.js";
import { classifyProgram, type Program } from "../cron/nudge-copy.js";
import { greetingName } from "../cron/display-name.js";
import { kvGet, kvSet, kvSetIfAbsent, scheduleFollowup } from "../db/queries.js";
import { normalizeMxPhone } from "./airtable.js";
import { cdmxParts } from "../cron/time.js";

// ---- constants ----------------------------------------------------------------

/** Rows sent per 5-min cron tick (default; kv `blast_per_tick` overrides 1..MAX).
 *  Sized for the free plan's 50-subrequest cap: each send costs ~5 (claim, Graph
 *  POST, wamid + message rows) and the tick already runs followups/metrics. */
export const BLAST_PER_TICK = 6;
export const BLAST_PER_TICK_MAX = 10;
/** Default per-CDMX-day cap — Meta's lowest business-initiated tier (250 unique
 *  users / 24h on a fresh WABA; grows to 1K/10K/100K with quality). */
export const DEFAULT_DAILY_CAP = 250;
/** Sending window (CDMX hours): marketing pushes stay well inside quiet hours. */
export const BLAST_HOUR_START = 9;
export const BLAST_HOUR_END = 21;
/** Meta rejects an empty body parameter; this stands in for a missing name. */
export const NAME_FALLBACK = "👋";
/** Default: skip anyone who got ANY blast in the last N days. */
export const DEFAULT_EXCLUDE_BLASTED_DAYS = 7;
/** v1 alias kept for the old tests/callers. */
export const BATCH_PER_TICK = BLAST_PER_TICK;

// ---- payload (followups.note JSON) --------------------------------------------

export interface BlastHeader {
  type: "image" | "video" | "document";
  link: string;
}

export interface BlastPayload {
  /** Exact Meta template name (e.g. "promo_octubre_es"). Empty in freeform mode. */
  t: string;
  /** Template language code exactly as approved ("es", "es_MX", "en"). */
  l: string;
  /** v2: body parameters in {{1}}..{{n}} order; "{nombre}" → contact first name. */
  v?: string[];
  /** v2: media header (only when the template has an IMAGE/VIDEO/DOCUMENT header). */
  h?: BlastHeader;
  /** v1: {{2}} class text ({{1}} was the greeting). */
  p2?: string;
  /** v1: real body-variable count (0 ⇒ no components). */
  n?: 0 | 2;
  /** Freeform mode: free text sent with sendText to an OPEN-window lead. */
  txt?: string;
  /** Recipient name from a pasted list (no contacts row to read it from). */
  nm?: string;
  /** Set on 'failed' rows: the send error (for the dashboard's failure list). */
  err?: string;
  /** Retry attempts consumed (transient errors only). */
  a?: number;
}

export function encodeBlastNote(p: BlastPayload): string {
  return JSON.stringify(p);
}

export function decodeBlastNote(note: string | null): BlastPayload | null {
  if (!note) return null;
  try {
    const p = JSON.parse(note) as Partial<BlastPayload>;
    if (typeof p.t !== "string" || typeof p.l !== "string") return null;
    const out: BlastPayload = { t: p.t, l: p.l };
    if (Array.isArray(p.v) && p.v.every((x) => typeof x === "string")) out.v = p.v;
    if (p.h && typeof p.h.link === "string" && isHeaderType(p.h.type)) {
      out.h = { type: p.h.type, link: p.h.link };
    }
    if (typeof p.p2 === "string") out.p2 = p.p2;
    if (p.n === 0) out.n = 0;
    if (typeof p.txt === "string" && p.txt) out.txt = p.txt;
    if (typeof p.nm === "string" && p.nm) out.nm = p.nm;
    if (typeof p.err === "string") out.err = p.err;
    if (typeof p.a === "number") out.a = p.a;
    if (!out.txt && !out.t) return null;
    return out;
  } catch {
    return null; // malformed note ⇒ the row is skipped, never retried forever
  }
}

function isHeaderType(t: unknown): t is BlastHeader["type"] {
  return t === "image" || t === "video" || t === "document";
}

// ---- parameters ---------------------------------------------------------------

const NAME_TOKEN_RE = /\{\s*(nombre|name)\s*\}/gi;

/**
 * Pure. Fills "{nombre}" / "{name}" in each body parameter with the contact's
 * greeting-safe first name (or NAME_FALLBACK when unknown). A parameter that
 * ends up empty gets the fallback too — Meta rejects empty params outright.
 */
export function renderParams(params: string[], rawName: string | null | undefined): string[] {
  const name = greetingName(rawName) || NAME_FALLBACK;
  return params.map((p) => {
    const out = p.replace(NAME_TOKEN_RE, name).trim();
    return out || NAME_FALLBACK;
  });
}

/** Pure. Meta template components for a v2 (or v1) payload. undefined ⇒ none. */
export function templateComponents(
  payload: BlastPayload,
  rawName: string | null | undefined,
): unknown[] | undefined {
  const out: unknown[] = [];
  if (payload.h) {
    out.push({
      type: "header",
      parameters: [{ type: payload.h.type, [payload.h.type]: { link: payload.h.link } }],
    });
  }
  if (payload.v) {
    if (payload.v.length > 0) {
      out.push({
        type: "body",
        parameters: renderParams(payload.v, rawName).map((text) => ({ type: "text", text })),
      });
    }
  } else if (payload.n !== 0) {
    // v1 shape: {{1}} greeting, {{2}} class text.
    return blastComponents(greetingName(rawName) || NAME_FALLBACK, payload.p2 ?? "");
  }
  return out.length > 0 ? out : undefined;
}

/** v1: body {{1}}=greeting, {{2}}=class text. */
export function blastComponents(greeting: string, p2: string): unknown[] {
  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: greeting },
        { type: "text", text: p2 },
      ],
    },
  ];
}

// ---- send-error classification ------------------------------------------------

export type SendErrorClass = "pause" | "skip" | "retry";

/** Graph error codes that mean the whole run cannot proceed (template, account,
 *  auth, media) — the run pauses and Slack is told. */
const PAUSE_CODES = new Set([
  100, // invalid parameter (component/param shape)
  10, 190, 200, // auth / permission
  131031, // account locked
  131042, // payment / eligibility issue
  131053, // media upload failed (header link)
  132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069, // template
  133010, // number not registered
]);
/** Throughput / spam-rate limits: stop this tick, leave the row scheduled. */
const RETRY_CODES = new Set([80007, 130429, 131048, 131056]);

/**
 * Pure. Classify a send error message (wa.ts formats "WA send failed (STATUS)
 * [CODE]: message"). Unknown 4xx codes are per-recipient failures ("skip");
 * 5xx / network errors are transient ("retry").
 */
export function classifySendError(message: string): { cls: SendErrorClass; code: number | null } {
  const codeM = /\[(\d+)\]/.exec(message);
  const code = codeM ? Number(codeM[1]) : null;
  if (code !== null) {
    if (PAUSE_CODES.has(code)) return { cls: "pause", code };
    if (RETRY_CODES.has(code)) return { cls: "retry", code };
    return { cls: "skip", code };
  }
  if (/does not exist|not exist in the translation|Template name/i.test(message)) {
    return { cls: "pause", code: null };
  }
  const statusM = /\((\d{3})\)/.exec(message);
  const status = statusM ? Number(statusM[1]) : 0;
  if (status >= 500 || status === 0 || /fetch failed|network|timeout/i.test(message)) {
    return { cls: "retry", code: null };
  }
  return { cls: "skip", code: null };
}

// ---- sending window -----------------------------------------------------------

/** Pure. True when `epoch` is inside 09:00–20:59 CDMX (blast sending hours). */
export function blastWindowOpen(epoch: number): boolean {
  const p = cdmxParts(epoch);
  return p.hour >= BLAST_HOUR_START && p.hour < BLAST_HOUR_END;
}

/** v1 helper kept for compatibility: the first send instant at/after `start`
 *  inside the sending window. Pacing is now done by the drain's LIMIT, so every
 *  row of a run shares this due_at. */
export function blastDueAt(startEpoch: number): number {
  const p = cdmxParts(startEpoch);
  if (p.hour < BLAST_HOUR_START) {
    return startEpoch + (BLAST_HOUR_START * 60 - (p.hour * 60 + p.minute)) * 60 - p.second;
  }
  if (p.hour >= BLAST_HOUR_END) {
    const toMidnight = (24 * 60 - (p.hour * 60 + p.minute)) * 60 - p.second;
    return startEpoch + toMidnight + BLAST_HOUR_START * 3600;
  }
  return startEpoch;
}

// ---- audience -------------------------------------------------------------------

export interface BlastCandidate {
  phone: string;
  name: string | null;
  program: Program;
}

export interface BlastAudience {
  adults: BlastCandidate[];
  kids: BlastCandidate[];
  baby: BlastCandidate[];
  /** Leads whose 24h window is OPEN (wrote <24h ago): reachable FREE via
   *  free-form text (freeform mode) instead of a paid template. */
  inWindow: { adults: BlastCandidate[]; kids: BlastCandidate[]; baby: BlastCandidate[] };
  excluded: { booked: number; inWindow: number; notLead: number; recentBlast: number };
}

export interface PlanAudienceOpts {
  /** Keep leads who already booked (default false = exclude). */
  includeBooked?: boolean;
  /** Phones that got a blast recently → excluded (default empty). */
  recentlyBlasted?: Set<string>;
}

/**
 * Pure audience split. `contacts` = candidate leads; `bookedPhones` = phones
 * with booking evidence; leads who wrote within the last 24h are split out
 * (their conversation is live and free-form; a paid template would interrupt).
 */
export function planBlastAudience(
  contacts: (Contact & { campaign_name?: string | null })[],
  bookedPhones: Set<string>,
  nowEpoch: number,
  opts: PlanAudienceOpts = {},
): BlastAudience {
  const out: BlastAudience = {
    adults: [],
    kids: [],
    baby: [],
    inWindow: { adults: [], kids: [], baby: [] },
    excluded: { booked: 0, inWindow: 0, notLead: 0, recentBlast: 0 },
  };
  const seen = new Set<string>();
  for (const c of contacts) {
    if (seen.has(c.phone)) continue;
    seen.add(c.phone);
    if (c.status !== "lead") {
      out.excluded.notLead++;
      continue;
    }
    if (!opts.includeBooked && bookedPhones.has(c.phone)) {
      out.excluded.booked++;
      continue;
    }
    if (opts.recentlyBlasted?.has(c.phone)) {
      out.excluded.recentBlast++;
      continue;
    }
    const program = classifyProgram(c, c.campaign_name ?? null);
    const cand: BlastCandidate = { phone: c.phone, name: c.name, program };
    const windowOpen = (c.last_inbound_at ?? 0) > nowEpoch - 24 * 3600;
    const bucket = windowOpen ? out.inWindow : out;
    if (windowOpen) out.excluded.inWindow++;
    if (program === "adults") bucket.adults.push(cand);
    else if (program === "kids") bucket.kids.push(cand);
    else bucket.baby.push(cand);
  }
  return out;
}

export interface ListEntry {
  phone: string;
  name: string | null;
}

export interface ParsedList {
  entries: ListEntry[];
  /** Lines with no usable phone (headers, blanks, junk). */
  invalid: number;
  /** Repeated phones dropped (first occurrence wins, keeps its name). */
  duplicates: number;
}

/**
 * Pure. Parse a pasted list — one contact per line, "phone" or "phone,name" or
 * "name,phone" (comma / semicolon / tab separated; a CSV export pastes fine).
 * Phones go through normalizeMxPhone (10-digit MX → 521…); anything shorter
 * than 10 digits is invalid. Header rows have no phone and count as invalid.
 */
export function parseContactList(text: string): ParsedList {
  const out: ParsedList = { entries: [], invalid: 0, duplicates: 0 };
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = line
      .split(/[,;\t]/)
      .map((c) => c.trim().replace(/^"|"$/g, "").trim())
      .filter(Boolean);
    let phone: string | null = null;
    const rest: string[] = [];
    for (const cell of cells) {
      // A phone cell is digits plus phone punctuation only ("+52 1 (55) 1234-5678").
      const compact = cell.replace(/[\s()+\-.]/g, "");
      if (phone === null && /^\d{10,15}$/.test(compact)) {
        phone = normalizeMxPhone(compact);
      } else {
        rest.push(cell);
      }
    }
    if (!phone || phone.length < 10) {
      out.invalid++;
      continue;
    }
    if (seen.has(phone)) {
      out.duplicates++;
      continue;
    }
    seen.add(phone);
    const name = rest.find((r) => /\p{L}/u.test(r) && !/@|^\d/.test(r)) ?? null;
    out.entries.push({ phone, name });
  }
  return out;
}

export interface ListAudienceOpts {
  /** Drop contacts whose CRM status is student (default true). */
  excludeStudents?: boolean;
  recentlyBlasted?: Set<string>;
}

export interface ListAudience {
  candidates: BlastCandidate[];
  excluded: { optedOut: number; student: number; recentBlast: number };
}

/**
 * Pure. Apply the CRM's knowledge to a pasted list: opted-out contacts are
 * always dropped (the send guard would refuse them anyway), students by default,
 * recently blasted phones when the set is given. Names: list first, CRM second.
 */
export function buildListAudience(
  entries: ListEntry[],
  contactsByPhone: Map<string, Pick<Contact, "status" | "name">>,
  opts: ListAudienceOpts = {},
): ListAudience {
  const out: ListAudience = { candidates: [], excluded: { optedOut: 0, student: 0, recentBlast: 0 } };
  const exStudents = opts.excludeStudents !== false;
  for (const e of entries) {
    const c = contactsByPhone.get(e.phone);
    if (c?.status === "opted_out") {
      out.excluded.optedOut++;
      continue;
    }
    if (exStudents && c?.status === "student") {
      out.excluded.student++;
      continue;
    }
    if (opts.recentlyBlasted?.has(e.phone)) {
      out.excluded.recentBlast++;
      continue;
    }
    out.candidates.push({ phone: e.phone, name: e.name ?? c?.name ?? null, program: "adults" });
  }
  return out;
}

// ---- run registry (kv `blast_run:<runId>`) ---------------------------------------

export type BlastRunStatus = "active" | "paused" | "cancelled" | "done";

export interface BlastRunMeta {
  id: string;
  name: string;
  mode: "template" | "freeform";
  template: string;
  lang: string;
  params: string[];
  header: BlastHeader | null;
  text: string | null;
  total: number;
  status: BlastRunStatus;
  createdAt: number;
  startAt: number;
  dailyCap: number;
  by: string;
  /** Why it paused (auto-pause error text) — cleared on resume. */
  pausedReason: string | null;
  /** Epoch of the last status change. */
  updatedAt: number;
}

export const RUN_KEY_PREFIX = "blast_run:";
/** kv flag "1" while at least one run is active — the drain reads ONLY this
 *  when idle (one kv row per tick instead of a followups scan). Set on queue /
 *  resume, recomputed on pause / cancel / done. */
export const KV_BLAST_ACTIVE = "blast_active";
/** followups.airtable_record_id of a run's rows: "blast:<runId>". */
export const ROW_RID_PREFIX = "blast:";

/** Pure. Parse a kv value; v1 rows stored the start epoch as a bare string. */
export function parseRunMeta(id: string, value: string | null): BlastRunMeta | null {
  if (value == null) return null;
  const legacy = /^\d+$/.test(value.trim());
  if (legacy) {
    const start = Number(value);
    return {
      id,
      name: id,
      mode: "template",
      template: "",
      lang: "",
      params: [],
      header: null,
      text: null,
      total: 0,
      status: "active",
      createdAt: start,
      startAt: start,
      dailyCap: DEFAULT_DAILY_CAP,
      by: "",
      pausedReason: null,
      updatedAt: start,
    };
  }
  try {
    const p = JSON.parse(value) as Partial<BlastRunMeta>;
    if (typeof p.total !== "number") return null;
    const status: BlastRunStatus =
      p.status === "paused" || p.status === "cancelled" || p.status === "done" ? p.status : "active";
    return {
      id,
      name: typeof p.name === "string" && p.name ? p.name : id,
      mode: p.mode === "freeform" ? "freeform" : "template",
      template: typeof p.template === "string" ? p.template : "",
      lang: typeof p.lang === "string" ? p.lang : "",
      params: Array.isArray(p.params) ? p.params.filter((x): x is string => typeof x === "string") : [],
      header: p.header && isHeaderType(p.header.type) && typeof p.header.link === "string" ? p.header : null,
      text: typeof p.text === "string" ? p.text : null,
      total: p.total,
      status,
      createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
      startAt: typeof p.startAt === "number" ? p.startAt : 0,
      dailyCap: typeof p.dailyCap === "number" && p.dailyCap > 0 ? p.dailyCap : DEFAULT_DAILY_CAP,
      by: typeof p.by === "string" ? p.by : "",
      pausedReason: typeof p.pausedReason === "string" ? p.pausedReason : null,
      updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function encodeRunMeta(m: BlastRunMeta): string {
  const { id: _id, ...rest } = m;
  return JSON.stringify(rest);
}

/** Per-status row counts of one run (from followups). */
export interface RunCounts {
  scheduled: number;
  paused: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export const EMPTY_COUNTS: RunCounts = {
  scheduled: 0,
  paused: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
};

/** Pure. Fold `SELECT airtable_record_id, status, COUNT(*)` rows per run. */
export function foldRunCounts(
  rows: { rid: string | null; status: string; n: number }[],
): Map<string, RunCounts> {
  const out = new Map<string, RunCounts>();
  for (const r of rows) {
    const rid = r.rid ?? "";
    if (!rid.startsWith(ROW_RID_PREFIX)) continue;
    const id = rid.slice(ROW_RID_PREFIX.length);
    const c = out.get(id) ?? { ...EMPTY_COUNTS };
    if (r.status === "scheduled") c.scheduled += r.n;
    else if (r.status === "paused") c.paused += r.n;
    else if (r.status === "sent") c.sent += r.n;
    else if (r.status === "failed") c.failed += r.n;
    else if (r.status === "skipped_optout") c.skipped += r.n;
    else if (r.status === "cancelled") c.cancelled += r.n;
    out.set(id, c);
  }
  return out;
}

export interface BlastRunView extends BlastRunMeta {
  counts: RunCounts;
  /** Rows still to send (scheduled + paused). */
  remaining: number;
}

/** Pure. Join metas with counts; newest first. A run whose rows are all
 *  terminal but whose meta still says active is reported as done. */
export function summarizeRuns(
  metas: BlastRunMeta[],
  counts: Map<string, RunCounts>,
): BlastRunView[] {
  return metas
    .map((m) => {
      const c = counts.get(m.id) ?? { ...EMPTY_COUNTS };
      const remaining = c.scheduled + c.paused;
      const status: BlastRunStatus =
        m.status === "active" && remaining === 0 && m.total > 0 ? "done" : m.status;
      return { ...m, status, counts: c, remaining };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---- IO ------------------------------------------------------------------------

/** Booking-evidence kinds: any row of these means the lead DID book at some point. */
const BOOKED_KINDS = ["trial_confirm", "day_before", "same_day", "attendance_check"] as const;

export interface CrmAudienceOpts extends PlanAudienceOpts {
  /** Leads created or active since this epoch. */
  sinceEpoch: number;
}

/** Leads active since `sinceEpoch` + the booking-evidence phone set → split. */
export async function loadBlastAudience(
  env: Env,
  sinceEpoch: number,
  nowEpoch: number,
  opts: PlanAudienceOpts = {},
): Promise<BlastAudience> {
  const { results: contacts } = await env.DB.prepare(
    // Newest lead first: a per-group `limit` then takes the FRESHEST leads,
    // who are far likelier to still be shopping than a week-3 ghost.
    `SELECT c.*, ca.name AS campaign_name
       FROM contacts c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
      WHERE (c.created_at >= ?1 OR COALESCE(c.last_inbound_at, 0) >= ?1)
      ORDER BY COALESCE(c.last_inbound_at, c.created_at) DESC`,
  )
    .bind(sinceEpoch)
    .all<Contact & { campaign_name: string | null }>();

  const kinds = BOOKED_KINDS.map((k) => `'${k}'`).join(",");
  const { results: booked } = await env.DB.prepare(
    `SELECT DISTINCT phone FROM followups WHERE kind IN (${kinds})`,
  ).all<{ phone: string }>();
  const { results: markers } = await env.DB.prepare(
    `SELECT key FROM kv WHERE key LIKE 'booking_recorded:%'`,
  ).all<{ key: string }>();
  const bookedSet = new Set<string>([
    ...booked.map((r) => r.phone),
    ...markers.map((r) => r.key.slice("booking_recorded:".length)),
  ]);
  return planBlastAudience(contacts, bookedSet, nowEpoch, opts);
}

/** Phones that received (or are queued for) a blast created since `sinceEpoch`. */
export async function recentlyBlastedPhones(env: Env, sinceEpoch: number): Promise<Set<string>> {
  if (sinceEpoch <= 0) return new Set();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT phone FROM followups
      WHERE kind = 'blast' AND status IN ('sent','scheduled','paused') AND created_at >= ?1`,
  )
    .bind(sinceEpoch)
    .all<{ phone: string }>();
  return new Set(results.map((r) => r.phone));
}

/** status + name for a set of phones (chunked IN queries). */
export async function contactsByPhone(
  env: Env,
  phones: string[],
): Promise<Map<string, Pick<Contact, "status" | "name">>> {
  const out = new Map<string, Pick<Contact, "status" | "name">>();
  const CHUNK = 90;
  for (let i = 0; i < phones.length; i += CHUNK) {
    const slice = phones.slice(i, i + CHUNK);
    const marks = slice.map((_, j) => `?${j + 1}`).join(",");
    const { results } = await env.DB.prepare(
      `SELECT phone, status, name FROM contacts WHERE phone IN (${marks})`,
    )
      .bind(...slice)
      .all<{ phone: string; status: Contact["status"]; name: string | null }>();
    for (const r of results) out.set(r.phone, { status: r.status, name: r.name });
  }
  return out;
}

export interface QueueBlastSpec {
  meta: Omit<BlastRunMeta, "total" | "status" | "updatedAt" | "pausedReason">;
  candidates: BlastCandidate[];
  payload: BlastPayload;
}

/**
 * Claims the runId in kv, then inserts one `blast` row per recipient (all due
 * at the run's start; the drain's LIMIT paces them). Returns the queued count,
 * or null when the runId was already claimed (double-click / double-POST).
 */
export async function queueBlast(env: Env, spec: QueueBlastSpec): Promise<number | null> {
  const meta: BlastRunMeta = {
    ...spec.meta,
    total: spec.candidates.length,
    status: "active",
    pausedReason: null,
    updatedAt: spec.meta.createdAt,
  };
  if (!(await kvSetIfAbsent(env.DB, RUN_KEY_PREFIX + meta.id, encodeRunMeta(meta)))) {
    return null;
  }
  await kvSet(env.DB, KV_BLAST_ACTIVE, "1");
  const note = encodeBlastNote(spec.payload);
  const dueAt = blastDueAt(meta.startAt);
  let queued = 0;
  for (const cand of spec.candidates) {
    // UNIQUE(phone, kind, airtable_record_id): the record id carries the runId,
    // so one phone never gets the same run twice, but a FUTURE run can reach it.
    // A list-sourced name rides in the row (contacts may have no row for it).
    await scheduleFollowup(env.DB, {
      phone: cand.phone,
      kind: "blast",
      dueAt,
      airtableRecordId: `${ROW_RID_PREFIX}${meta.id}`,
      note: cand.name ? encodeBlastNote({ ...spec.payload, nm: cand.name }) : note,
    });
    queued++;
  }
  return queued;
}

/** Recompute the idle flag from the run metas (kv only, no followups read). */
export async function refreshActiveFlag(env: Env): Promise<boolean> {
  const metas = await listRunMetas(env);
  const active = metas.some((m) => m.status === "active");
  await kvSet(env.DB, KV_BLAST_ACTIVE, active ? "1" : "0");
  return active;
}

export async function getRunMeta(env: Env, id: string): Promise<BlastRunMeta | null> {
  return parseRunMeta(id, await kvGet(env.DB, RUN_KEY_PREFIX + id));
}

export async function saveRunMeta(env: Env, meta: BlastRunMeta): Promise<void> {
  await kvSet(env.DB, RUN_KEY_PREFIX + meta.id, encodeRunMeta(meta));
}

export async function listRunMetas(env: Env): Promise<BlastRunMeta[]> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM kv WHERE key LIKE '${RUN_KEY_PREFIX}%'`,
  ).all<{ key: string; value: string }>();
  const out: BlastRunMeta[] = [];
  for (const r of results) {
    const m = parseRunMeta(r.key.slice(RUN_KEY_PREFIX.length), r.value);
    if (m) out.push(m);
  }
  return out;
}

export async function loadRunCounts(env: Env): Promise<Map<string, RunCounts>> {
  const { results } = await env.DB.prepare(
    `SELECT airtable_record_id AS rid, status, COUNT(*) AS n
       FROM followups WHERE kind = 'blast' GROUP BY airtable_record_id, status`,
  ).all<{ rid: string | null; status: string; n: number }>();
  return foldRunCounts(results);
}

/** Flip every still-sendable row of a run to `to` (pause/resume/cancel). */
export async function setRunRowsStatus(
  env: Env,
  id: string,
  from: ("scheduled" | "paused")[],
  to: "scheduled" | "paused" | "cancelled",
): Promise<number> {
  const marks = from.map((s) => `'${s}'`).join(",");
  const res = await env.DB.prepare(
    `UPDATE followups SET status = ?2
      WHERE kind = 'blast' AND airtable_record_id = ?1 AND status IN (${marks})`,
  )
    .bind(`blast:${id}`, to)
    .run();
  return res.meta.changes ?? 0;
}

/** Failed rows of a run: phone + error (newest first, capped). */
export async function listRunFailures(
  env: Env,
  id: string,
  limit = 100,
): Promise<{ phone: string; error: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT phone, note FROM followups
      WHERE kind = 'blast' AND airtable_record_id = ?1 AND status = 'failed'
      ORDER BY id DESC LIMIT ?2`,
  )
    .bind(`blast:${id}`, limit)
    .all<{ phone: string; note: string | null }>();
  return results.map((r) => ({ phone: r.phone, error: decodeBlastNote(r.note)?.err ?? "" }));
}

/** Store the send error on a row and mark it failed. */
export async function markRowFailed(
  env: Env,
  rowId: number,
  payload: BlastPayload,
  err: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE followups SET status = 'failed', note = ?2 WHERE id = ?1`)
    .bind(rowId, encodeBlastNote({ ...payload, err: err.slice(0, 300) }))
    .run();
}
