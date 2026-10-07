// Airtable side of the Conversions API (docs/meta-capi.md).
//
// Three jobs, all keyed on columns named in CLIENT.airtableLeads (never
// hardcoded here):
//  - the 15-minute SWEEP reads the three 0/1 formulas (Agendó / Asistió /
//    Cerró) for leads that carry a click id and have not had that event
//    reported yet — the pure parts (formula + row → events) live here so the
//    cron stays a thin loop;
//  - the DRAIN marks `Eventos Meta Enviados` after Meta answered 2xx — never
//    before, so the column is a truthful record of what Meta accepted;
//  - the owner BACKFILL copies click ids the worker already stored in
//    contacts.ad_ref into `CTWA Click ID` for leads synced before the column
//    existed (fill-if-empty, never overwrites).

import type { Env } from "../types.js";
import type { AirtableLeadsMap } from "../client-config.js";
import { kvGet, kvSet } from "../db/queries.js";
import {
  AirtableWriteError,
  airtableFetch,
  asAmount,
  baseUrl,
  leadsMap,
  parseAirtableError,
  updateRecord,
  type AirtableRecord,
} from "./airtable.js";
import { ctwaClidFromAdRef, type CapiEventKind } from "./meta-capi.js";

/** Option names in `metaEventsSent` when the client map does not override them. */
export const DEFAULT_EVENT_LABELS: Record<CapiEventKind, string> = {
  booked: "Agendó",
  attended: "Asistió",
  purchase: "Compró",
};

export function capiEventLabel(kind: CapiEventKind, map: AirtableLeadsMap = leadsMap()): string {
  return map.metaEventsSentValues?.[kind] ?? DEFAULT_EVENT_LABELS[kind];
}

/** The columns the sweep needs; null when the client map leaves any unset. */
export interface CapiLeadColumns {
  phone: string;
  ctwaClid: string;
  booked: string;
  attended: string;
  closed: string;
  metaEventsSent: string;
  trialDateTime: string;
  leadIncome: string | null;
}

export function capiLeadColumns(map: AirtableLeadsMap = leadsMap()): CapiLeadColumns | null {
  if (!map.ctwaClid || !map.booked || !map.attended || !map.closed || !map.metaEventsSent) {
    return null;
  }
  return {
    phone: map.phone,
    ctwaClid: map.ctwaClid,
    booked: map.booked,
    attended: map.attended,
    closed: map.closed,
    metaEventsSent: map.metaEventsSent,
    trialDateTime: map.trialDateTime,
    leadIncome: map.leadIncome ?? null,
  };
}

/** Airtable string literal (single quotes, backslash-escaped). */
function lit(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Pure. filterByFormula for the sweep: leads with a click id, touched in the
 * last 7 days (Meta rejects older event_times, and the window keeps the scan
 * small), where at least one funnel flag is 1 and its label is NOT yet in the
 * sent multi-select. `& ''` makes a blank multi-select a string so FIND() is 0.
 */
export function capiSweepFormula(
  sinceIso: string,
  map: AirtableLeadsMap = leadsMap(),
): string | null {
  const c = capiLeadColumns(map);
  if (!c) return null;
  const sent = `ARRAYJOIN({${c.metaEventsSent}}) & ''`;
  const pending = (flag: string, kind: CapiEventKind): string =>
    `AND({${flag}} = 1, NOT(FIND(${lit(capiEventLabel(kind, map))}, ${sent})))`;
  return (
    `AND({${c.ctwaClid}} != '', ` +
    `IS_AFTER(LAST_MODIFIED_TIME(), ${lit(sinceIso)}), ` +
    `OR(${pending(c.booked, "booked")}, ${pending(c.attended, "attended")}, ${pending(c.closed, "purchase")}))`
  );
}

/** The fields[] the sweep asks Airtable for. */
export function capiSweepFields(c: CapiLeadColumns): string[] {
  return [
    c.phone,
    c.ctwaClid,
    c.booked,
    c.attended,
    c.closed,
    c.metaEventsSent,
    c.trialDateTime,
    ...(c.leadIncome ? [c.leadIncome] : []),
  ];
}

export interface LeadFunnelEvent {
  kind: CapiEventKind;
  /** Unix seconds: the trial datetime for attended, the sweep time otherwise. */
  eventTimeSec: number;
  /** Purchase only: `leadIncome` when > 0. */
  value?: number;
}

function flagOn(v: unknown): boolean {
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return v.trim() === "1";
  if (typeof v === "boolean") return v;
  return false;
}

function labels(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v) return v.split(",").map((s) => s.trim());
  return [];
}

/**
 * Pure. Which funnel events a Leads row still owes Meta. Mirrors the formula
 * (defence in depth: a stale formula result or a race with the drain can never
 * produce a second event — the kv claim is the last line anyway).
 *
 *  - booked   : {Agendó}=1   → event_time = now (the sweep runs every 15 min)
 *  - attended : {Asistió}=1  → event_time = trial datetime when it is in the
 *               past, else now; an out-of-window trial is dropped by enqueue
 *  - purchase : {Cerró}=1    → event_time = now, value = Ingresos Lead (> 0)
 */
export function capiEventsForLead(
  fields: Record<string, unknown>,
  c: CapiLeadColumns,
  nowSec: number,
  map: AirtableLeadsMap = leadsMap(),
): LeadFunnelEvent[] {
  const sent = new Set(labels(fields[c.metaEventsSent]));
  const out: LeadFunnelEvent[] = [];
  const owed = (kind: CapiEventKind, flag: string): boolean =>
    flagOn(fields[flag]) && !sent.has(capiEventLabel(kind, map));

  if (owed("booked", c.booked)) out.push({ kind: "booked", eventTimeSec: nowSec });
  if (owed("attended", c.attended)) {
    const raw = fields[c.trialDateTime];
    const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
    const trial = Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
    out.push({
      kind: "attended",
      eventTimeSec: Number.isFinite(trial) && trial <= nowSec ? trial : nowSec,
    });
  }
  if (owed("purchase", c.closed)) {
    const value = c.leadIncome ? asAmount(fields[c.leadIncome]) : null;
    out.push({ kind: "purchase", eventTimeSec: nowSec, ...(value ? { value } : {}) });
  }
  return out;
}

// ---- I/O ----

/**
 * GET one Leads record. null on 404; throws (with Airtable's own detail, which
 * never contains the PAT) otherwise. The single-record endpoint takes NO
 * `fields[]` filter — that is a list-endpoint parameter and the first version
 * of this helper sent it, which failed every call — so the whole row comes back.
 */
export async function getLeadRecord(env: Env, recordId: string): Promise<AirtableRecord | null> {
  const res = await airtableFetch(
    env,
    `${baseUrl(env, env.AIRTABLE_TRIALS_TABLE)}/${encodeURIComponent(recordId)}`,
    { method: "GET" },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Parameters<typeof parseAirtableError>[1];
    const err = parseAirtableError(res.status, data);
    // A deleted/merged lead whose id is still in contacts.airtable_lead_id:
    // Airtable answers 403 "…the requested model was not found" — a missing
    // row, not a permission problem. Same contract as the 404.
    if (res.status === 403 && /not found/i.test(err.detail)) return null;
    throw new Error(`airtable get ${recordId} failed: HTTP ${res.status} ${err.detail}`);
  }
  const data = (await res.json()) as { id?: string; fields?: Record<string, unknown> };
  if (!data.id) return null;
  return { id: data.id, fields: data.fields ?? {} };
}

export type MarkSentResult = "marked" | "already" | "skipped" | "error";

/**
 * Add the event's label to `Eventos Meta Enviados` (union — a multi-select
 * PATCH replaces the whole array). Called by the drain ONLY after a 2xx from
 * Meta. Never throws: an Airtable hiccup must not make the drain re-send an
 * event Meta already accepted; the sweep's formula simply shows the row again
 * and the kv claim turns that into a no-op.
 */
export async function markEventSentInAirtable(
  env: Env,
  recordId: string,
  kind: CapiEventKind,
  map: AirtableLeadsMap = leadsMap(),
): Promise<MarkSentResult> {
  const col = map.metaEventsSent;
  if (!col) return "skipped";
  const label = capiEventLabel(kind, map);
  try {
    const rec = await getLeadRecord(env, recordId);
    if (!rec) return "skipped";
    const current = labels(rec.fields[col]);
    if (current.includes(label)) return "already";
    await updateRecord(env, env.AIRTABLE_TRIALS_TABLE, recordId, {
      [col]: [...current, label],
    });
    return "marked";
  } catch (err) {
    const msg = err instanceof AirtableWriteError ? err.message : String(err);
    console.warn(`[capi] mark ${kind} on ${recordId} failed: ${msg}`);
    return "error";
  }
}

// ---- owner backfill: contacts.ad_ref.ctwaClid → CTWA Click ID ----

export const KV_CAPI_BACKFILL_CURSOR = "capi_backfill_cursor";
/** 2 Airtable calls per contact (GET + maybe PATCH) ⇒ ≤30 subrequests per call. */
export const CAPI_BACKFILL_MAX = 15;

export interface BackfillResult {
  scanned: number;
  written: number;
  alreadySet: number;
  missing: number;
  errors: number;
  /** The first failure's message (token-free), so the owner can see WHY. */
  firstError: string | null;
  /** True when the walk reached the end (cursor reset). */
  done: boolean;
  dryRun: boolean;
  cursor: string;
}

/**
 * One page of the backfill: walk `contacts` by phone, for every ad lead with a
 * stored click id AND a synced Airtable row, write the id when the cell is
 * blank. Resumable via a kv cursor; the caller loops until `done`.
 */
export async function backfillCtwaClids(
  env: Env,
  opts: { limit?: number; dryRun?: boolean; reset?: boolean } = {},
  map: AirtableLeadsMap = leadsMap(),
): Promise<BackfillResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? CAPI_BACKFILL_MAX, CAPI_BACKFILL_MAX));
  const dryRun = opts.dryRun === true;
  const col = map.ctwaClid;
  const out: BackfillResult = {
    scanned: 0,
    written: 0,
    alreadySet: 0,
    missing: 0,
    errors: 0,
    firstError: null,
    done: false,
    dryRun,
    cursor: "",
  };
  if (!col) return { ...out, done: true };

  // `reset` restarts the walk from the first contact (e.g. after a run whose
  // pages all errored and still advanced the cursor).
  const after = opts.reset ? "" : ((await kvGet(env.DB, KV_CAPI_BACKFILL_CURSOR)) ?? "");
  const { results } = await env.DB.prepare(
    `SELECT phone, ad_ref, airtable_lead_id FROM contacts
     WHERE ad_ref LIKE '%"ctwaClid":"%' AND airtable_lead_id IS NOT NULL AND phone > ?1
     ORDER BY phone LIMIT ?2`,
  )
    .bind(after, limit)
    .all<{ phone: string; ad_ref: string | null; airtable_lead_id: string }>();

  let last = after;
  for (const row of results) {
    out.scanned++;
    last = row.phone;
    const clid = ctwaClidFromAdRef(row.ad_ref);
    if (!clid) continue;
    try {
      const rec = await getLeadRecord(env, row.airtable_lead_id);
      if (!rec) {
        out.missing++;
        continue;
      }
      const cur = rec.fields[col];
      if (typeof cur === "string" && cur.trim() !== "") {
        out.alreadySet++;
        continue;
      }
      if (!dryRun) await updateRecord(env, env.AIRTABLE_TRIALS_TABLE, rec.id, { [col]: clid });
      out.written++;
    } catch (err) {
      out.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (out.firstError === null) out.firstError = msg;
      console.warn(`[capi] backfill ${row.phone} failed: ${msg}`);
      // A page where nothing works is a config/auth problem, not a bad row:
      // stop early so the cursor does not race past hundreds of contacts.
      if (out.errors >= 3 && out.written + out.alreadySet + out.missing === 0) break;
    }
  }
  const abortedEarly = out.scanned < results.length;
  // A page that produced nothing but errors is never "progress": the cursor
  // stays where it was and the walk is not done, so a retry revisits it.
  const advance = out.written + out.alreadySet + out.missing > 0 || out.errors === 0;
  out.done = advance && !abortedEarly && results.length < limit;
  out.cursor = out.done ? "" : advance ? last : after;
  if (!dryRun) await kvSet(env.DB, KV_CAPI_BACKFILL_CURSOR, out.cursor);
  return out;
}
