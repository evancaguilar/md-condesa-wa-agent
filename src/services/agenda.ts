// Agenda tab (docs/dashboard-plan.md §11) — I/O: one Airtable read per view
// (cached ~60 s in kv), ONE batched D1 contacts lookup and ONE batched kv
// lookup per load (D1 free plan, 5M rows read/day — never per-row queries),
// and the attendance write-back. Pure logic lives in agenda-core.ts.

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import {
  AirtableWriteError,
  getBookingRecordRaw,
  leadsMap,
  listLeadsByFormula,
  resultFieldName,
  updateRecord,
  type AirtableRecord,
} from "./airtable.js";
import {
  agendaFormula,
  agendaWindow,
  filterForView,
  groupByClassTime,
  joinContacts,
  nextResultValue,
  phonesOf,
  rowFromRecord,
  sameDayKeysOf,
  type AgendaContact,
  type AgendaGroup,
  type AgendaView,
  type MarkResult,
} from "./agenda-core.js";

/** Airtable read cache TTL. Reception refreshes after every action with fresh=1. */
export const AGENDA_CACHE_SECONDS = 60;

export function agendaCacheKey(view: AgendaView, dayKey: string): string {
  return `agenda_cache:${view}:${dayKey}`;
}

/** The Leads columns the tab reads (names from client.mjs, never literals). */
export function agendaFields(env: Env): string[] {
  const m = leadsMap();
  const fields = [m.trialDateTime, m.name, m.childName, m.phone, m.audience, m.discipline, resultFieldName(env)];
  if (m.whoTrains) fields.push(m.whoTrains);
  if (m.cuestionarioStatus) fields.push(m.cuestionarioStatus);
  if (m.enrolled) fields.push(m.enrolled);
  return [...new Set(fields)];
}

interface CacheEntry {
  at: number;
  records: AirtableRecord[];
}

/**
 * Airtable rows for a view's window, served from kv when younger than
 * AGENDA_CACHE_SECONDS. `fresh` bypasses the cache (after an action). When
 * Airtable fails and a stale cache exists, the stale rows are served with
 * `stale: true` rather than an error.
 */
export async function loadAgendaRecords(
  env: Env,
  view: AgendaView,
  now: number,
  opts: { fresh?: boolean } = {},
): Promise<{ records: AirtableRecord[]; cachedAt: number | null; stale: boolean }> {
  const w = agendaWindow(view, now);
  const key = agendaCacheKey(view, String(w.fromEpoch));
  let cached: CacheEntry | null = null;
  try {
    const raw = await kvGet(env.DB, key);
    if (raw) cached = JSON.parse(raw) as CacheEntry;
  } catch {
    cached = null;
  }
  if (cached && !opts.fresh && now - cached.at < AGENDA_CACHE_SECONDS) {
    return { records: cached.records, cachedAt: cached.at, stale: false };
  }
  try {
    const records = await listLeadsByFormula(env, agendaFormula(leadsMap().trialDateTime, w), agendaFields(env));
    try {
      await kvSet(env.DB, key, JSON.stringify({ at: now, records } satisfies CacheEntry));
    } catch (err) {
      console.warn("[agenda] cache write failed", err);
    }
    return { records, cachedAt: null, stale: false };
  } catch (err) {
    if (cached) {
      console.warn(`[agenda] Airtable failed, serving stale ${view}: ${String(err)}`);
      return { records: cached.records, cachedAt: cached.at, stale: true };
    }
    throw err;
  }
}

/** Drop the cached rows of every view that could contain `dayKey` (after a write). */
export async function invalidateAgendaCache(env: Env, now: number): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM kv WHERE key LIKE 'agenda_cache:%'`).run();
  } catch (err) {
    console.warn("[agenda] cache invalidate failed", err);
  }
  void now;
}

const CHUNK = 50;

/** contacts rows for the given wa_ids — chunked IN(), PK lookups only. */
export async function contactsForAgenda(db: D1Database, phones: readonly string[]): Promise<Map<string, AgendaContact>> {
  const out = new Map<string, AgendaContact>();
  for (let i = 0; i < phones.length; i += CHUNK) {
    const batch = phones.slice(i, i + CHUNK);
    const marks = batch.map((_, j) => `?${j + 1}`).join(", ");
    const { results } = await db
      .prepare(`SELECT phone, name, status, last_inbound_at FROM contacts WHERE phone IN (${marks})`)
      .bind(...batch)
      .all<{ phone: string; name: string | null; status: string | null; last_inbound_at: number | null }>();
    for (const r of results) out.set(r.phone, { phone: r.phone, name: r.name, status: r.status, lastInboundAt: r.last_inbound_at });
  }
  return out;
}

/** Which of the given kv keys exist — chunked IN() on the kv PK. */
export async function existingKvKeys(db: D1Database, keys: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const batch = keys.slice(i, i + CHUNK);
    const marks = batch.map((_, j) => `?${j + 1}`).join(", ");
    const { results } = await db
      .prepare(`SELECT key FROM kv WHERE key IN (${marks})`)
      .bind(...batch)
      .all<{ key: string }>();
    for (const r of results) out.add(r.key);
  }
  return out;
}

export interface AgendaPayload {
  view: AgendaView;
  now: number;
  groups: AgendaGroup[];
  total: number;
  cachedAt: number | null;
  stale: boolean;
  /** Columns the active client does not map (the UI hides those cells). */
  columns: { whoTrains: boolean; cuestionario: boolean; enrolled: boolean };
}

/** The whole tab payload for one view: Airtable rows → filtered → joined → grouped. */
export async function buildAgenda(
  env: Env,
  view: AgendaView,
  now: number,
  opts: { fresh?: boolean } = {},
): Promise<AgendaPayload> {
  const m = leadsMap();
  const resultField = resultFieldName(env);
  const { records, cachedAt, stale } = await loadAgendaRecords(env, view, now, opts);
  const rows = filterForView(
    records.map((r) => rowFromRecord(r, m, resultField)),
    view,
    now,
  );
  const [contacts, sent] = await Promise.all([
    contactsForAgenda(env.DB, phonesOf(rows)),
    existingKvKeys(env.DB, sameDayKeysOf(rows)),
  ]);
  const groups = groupByClassTime(joinContacts(rows, contacts, sent, now));
  return {
    view,
    now,
    groups,
    total: rows.length,
    cachedAt,
    stale,
    columns: { whoTrains: !!m.whoTrains, cuestionario: !!m.cuestionarioStatus, enrolled: !!m.enrolled },
  };
}

export type MarkAttendanceResult =
  | { ok: true; result: string[] }
  | { ok: false; reason: "not_found" | "airtable_error"; detail?: string };

/**
 * Reception marks Asistió / No asistió from the dashboard: read the row's
 * current multi-select, swap only that pair (agenda-core.nextResultValue) and
 * PATCH it. The result-watcher cron then reacts exactly as to a manual
 * Airtable edit (post-trial chain, no-show chain, CAPI). Never writes any
 * other column.
 */
export async function markAttendance(env: Env, recordId: string, mark: MarkResult): Promise<MarkAttendanceResult> {
  const field = resultFieldName(env);
  let current: AirtableRecord | null;
  try {
    current = await getBookingRecordRaw(env, recordId);
  } catch (err) {
    return { ok: false, reason: "airtable_error", detail: String(err) };
  }
  if (!current) return { ok: false, reason: "not_found" };
  const next = nextResultValue(current.fields[field], mark);
  try {
    await updateRecord(env, env.AIRTABLE_TRIALS_TABLE, recordId, { [field]: next });
  } catch (err) {
    const detail = err instanceof AirtableWriteError ? err.message : String(err);
    return { ok: false, reason: "airtable_error", detail };
  }
  return { ok: true, result: next };
}
