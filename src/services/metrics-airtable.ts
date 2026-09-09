// Airtable side of the marketing-metrics feeder (docs/marketing-metrics.md).
// Airtable does the math (rollups + formulas on Días/Meses/Anuncios Meta/
// Campañas Meta); this module only writes spend rows + link fields and reads
// back the period rollups. All names come from CLIENT.airtableMetrics so a
// rename in the base is a config change, never a code change.
//
// Every write uses `typecast:true`: a link field written as ["2026-09-08"] or
// ["<adId>"] matches the linked table's primary field and CREATES the row when
// it doesn't exist yet — that's how Días/Meses/Anuncios/Campañas populate
// themselves. Batches are 10 records (Airtable's limit) and paced (~3 rps) so
// the live lead-sync path keeps headroom under the 5 rps per-base limit.

import type { Env } from "../types.js";
import type { AirtableMetricsMap } from "../client-config.js";
import { CLIENT } from "../client.gen.js";
import {
  airtableFetch,
  baseUrl,
  parseAirtableError,
  phoneMatchFormula,
  leadsMap,
  normalizeMxPhone,
  type AirtableErrorBody,
} from "./airtable.js";
import { lookupAdMeta } from "./ad-meta.js";
import type { InsightRow } from "./meta-insights.js";

/** md-condesa's contract; also the fallback when a client sets the feature but no map. */
export const DEFAULT_METRICS_MAP: AirtableMetricsMap = {
  tables: {
    spend: "Ad Spend Diario",
    ads: "Anuncios Meta",
    campaigns: "Campañas Meta",
    days: "Días",
    months: "Meses",
    students: "Alumnos",
    movements: "Movimientos",
  },
  spend: {
    key: "Clave",
    date: "Fecha",
    account: "Cuenta",
    adId: "Ad ID",
    adName: "Nombre Anuncio",
    adSetName: "Ad Set",
    adSetId: "Ad Set ID",
    campaignId: "Campaña Meta ID",
    campaignName: "Campaña Meta Nombre",
    spend: "Gasto",
    impressions: "Impresiones",
    clicks: "Clics",
    reach: "Alcance",
    conversations: "Conversaciones (Meta)",
    updated: "Actualizado",
    adLink: "Anuncio",
    campaignLink: "Campaña Meta",
    dayLink: "Día",
    monthLink: "Mes",
  },
  ads: { adId: "Ad ID", name: "Nombre", adSet: "Ad Set", campaignLink: "Campaña Meta" },
  campaigns: { campaignId: "Campaña ID", name: "Nombre" },
  leads: {
    created: "Fecha de Creación",
    dayText: "Día Lead",
    monthText: "Mes Lead",
    adId: "Ad ID",
    dayLink: "Día",
    monthLink: "Mes",
    adLink: "Anuncio",
    pendingAttendance: "Asistencia Pendiente",
    closed: "Cerró",
    origin: "Origen",
    originUnknown: "Desconocido",
  },
  students: {
    name: "Alumno",
    phone: "Teléfono",
    leadLink: "Lead Original",
    created: "Fecha de creación",
    totalPaid: "Total Pagado",
    eligibleIncome: "Ingresos Elegibles",
  },
  movements: {
    date: "Fecha de Pago",
    concept: "Concepto",
    type: "Ingreso/Egreso",
    typeIncome: "Ingreso",
    conceptSurplus: "Sobrante",
    studentLink: "Alumnos",
  },
  periods: {
    dayKey: "Día",
    monthKey: "Mes",
    spend: "Gasto",
    conversations: "Conversaciones Meta",
    leads: "Total Leads",
    paidLeads: "Leads Pagados",
    unknownLeads: "Desconocidos",
    booked: "Agendaron",
    pastTrials: "Pruebas Vencidas",
    showed: "Asistieron",
    pending: "Pendientes",
    closed: "Cerraron",
    closedAfterTrial: "Cerraron Tras Prueba",
    directCloses: "Cierres Directos",
    marked: "Inscritos (marcados)",
    revenue: "Ingresos",
    revenue90: "Ingresos 90d",
    cpl: "CPL",
    costPerBooking: "Costo por Agendada",
    costPerShow: "Costo por Asistencia",
    costPerClose: "Costo por Cierre",
    showRate: "Show Rate",
    closeRate: "Close Rate",
    roas: "ROAS",
    roas90: "ROAS 90d",
    provisional: "Provisional",
  },
};

export function metricsMap(): AirtableMetricsMap {
  return CLIENT.airtableMetrics ?? DEFAULT_METRICS_MAP;
}

/** Default pause between batch calls (~3 rps of a 5 rps per-base budget). */
export const PACE_MS = 350;
const BATCH = 10;

export interface MetricsRecord {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
}

export interface UpsertStats {
  created: number;
  updated: number;
  errors: string[];
}

/** Thrown when Airtable reports an unknown field: the base drifted from the map. */
export class MetricsSchemaError extends Error {
  constructor(
    message: string,
    readonly table: string,
  ) {
    super(message);
    this.name = "MetricsSchemaError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function chunk<T>(arr: readonly T[], n = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Upsert key of a spend row: "YYYY-MM-DD · <adId>". */
export function spendKey(date: string, adId: string): string {
  return `${date} · ${adId}`;
}

/** "YYYY-MM-DD" → "YYYY-MM". */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Escape a string for use inside single quotes in an Airtable formula. */
function fq(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---- spend rows / ads / campaigns ----

/** Pure. One insights row → Ad Spend Diario fields (links as primary-value strings). */
export function spendRowFields(
  r: InsightRow,
  account: string,
  updatedIso: string,
  m: AirtableMetricsMap = metricsMap(),
): Record<string, unknown> {
  const s = m.spend;
  const f: Record<string, unknown> = {
    [s.key]: spendKey(r.date, r.adId),
    [s.date]: r.date,
    [s.account]: account,
    [s.adId]: r.adId,
    [s.adName]: r.adName,
    [s.adSetName]: r.adSetName,
    [s.adSetId]: r.adSetId,
    [s.campaignId]: r.campaignId,
    [s.campaignName]: r.campaignName,
    [s.spend]: r.spend,
    [s.impressions]: r.impressions,
    [s.clicks]: r.clicks,
    [s.reach]: r.reach,
    [s.conversations]: r.conversations,
    [s.updated]: updatedIso,
    [s.adLink]: [r.adId],
    [s.dayLink]: [r.date],
    [s.monthLink]: [monthOf(r.date)],
  };
  if (r.campaignId) f[s.campaignLink] = [r.campaignId];
  return f;
}

/** Pure. Distinct ads in a pull → Anuncios Meta upsert records. */
export function adRecords(
  rows: readonly InsightRow[],
  m: AirtableMetricsMap = metricsMap(),
): Record<string, unknown>[] {
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (seen.has(r.adId)) continue;
    const f: Record<string, unknown> = {
      [m.ads.adId]: r.adId,
      [m.ads.name]: r.adName,
      [m.ads.adSet]: r.adSetName,
    };
    if (r.campaignId) f[m.ads.campaignLink] = [r.campaignId];
    seen.set(r.adId, f);
  }
  return [...seen.values()];
}

/** Pure. Distinct campaigns in a pull → Campañas Meta upsert records. */
export function campaignRecords(
  rows: readonly InsightRow[],
  m: AirtableMetricsMap = metricsMap(),
): Record<string, unknown>[] {
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (!r.campaignId || seen.has(r.campaignId)) continue;
    seen.set(r.campaignId, {
      [m.campaigns.campaignId]: r.campaignId,
      [m.campaigns.name]: r.campaignName,
    });
  }
  return [...seen.values()];
}

interface BatchResponse extends AirtableErrorBody {
  records?: MetricsRecord[];
  createdRecords?: string[];
  updatedRecords?: string[];
}

async function batchWrite(
  env: Env,
  table: string,
  body: Record<string, unknown>,
  stats: UpsertStats,
): Promise<void> {
  const res = await airtableFetch(env, baseUrl(env, table), {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as BatchResponse;
  if (res.ok) {
    stats.created += data.createdRecords?.length ?? 0;
    stats.updated +=
      data.updatedRecords?.length ??
      (data.createdRecords ? 0 : (data.records?.length ?? 0));
    return;
  }
  const err = parseAirtableError(res.status, data);
  if (err.unknownField) throw new MetricsSchemaError(`${table}: ${err.detail}`, table);
  stats.errors.push(`${table}: HTTP ${res.status} ${err.detail}`);
}

/**
 * Airtable-native batch upsert (PATCH + performUpsert), 10 records per call,
 * typecast on. One failing batch is recorded in `errors` and the rest continue;
 * an unknown-field 422 aborts with MetricsSchemaError (the base drifted).
 */
export async function batchUpsert(
  env: Env,
  table: string,
  mergeOn: string[],
  records: readonly Record<string, unknown>[],
  opts: { paceMs?: number } = {},
): Promise<UpsertStats> {
  const stats: UpsertStats = { created: 0, updated: 0, errors: [] };
  const groups = chunk(records);
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) await sleep(opts.paceMs ?? PACE_MS);
    await batchWrite(
      env,
      table,
      {
        performUpsert: { fieldsToMergeOn: mergeOn },
        records: groups[i]!.map((fields) => ({ fields })),
        typecast: true,
      },
      stats,
    );
  }
  return stats;
}

/** Batch PATCH by record id (10 per call, typecast on). Same error semantics. */
export async function batchPatch(
  env: Env,
  table: string,
  records: readonly { id: string; fields: Record<string, unknown> }[],
  opts: { paceMs?: number } = {},
): Promise<UpsertStats> {
  const stats: UpsertStats = { created: 0, updated: 0, errors: [] };
  const groups = chunk(records);
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) await sleep(opts.paceMs ?? PACE_MS);
    await batchWrite(env, table, { records: groups[i], typecast: true }, stats);
  }
  return stats;
}

/** Paginated GET (offset loop), optional formula/fields/maxRecords. */
export async function listRecords(
  env: Env,
  table: string,
  o: {
    filterByFormula?: string;
    fields?: string[];
    maxRecords?: number;
    pageSize?: number;
    sort?: { field: string; direction: "asc" | "desc" };
  } = {},
): Promise<MetricsRecord[]> {
  const out: MetricsRecord[] = [];
  let offset: string | undefined;
  do {
    const qs = new URLSearchParams();
    if (o.filterByFormula) qs.set("filterByFormula", o.filterByFormula);
    for (const f of o.fields ?? []) qs.append("fields[]", f);
    if (o.sort) {
      qs.set("sort[0][field]", o.sort.field);
      qs.set("sort[0][direction]", o.sort.direction);
    }
    qs.set("pageSize", String(Math.min(o.pageSize ?? 100, o.maxRecords ?? 100)));
    if (o.maxRecords) qs.set("maxRecords", String(o.maxRecords));
    if (offset) qs.set("offset", offset);
    const res = await airtableFetch(env, `${baseUrl(env, table)}?${qs.toString()}`, {
      method: "GET",
    });
    const data = (await res.json().catch(() => ({}))) as AirtableErrorBody & {
      records?: MetricsRecord[];
      offset?: string;
    };
    if (!res.ok) {
      const err = parseAirtableError(res.status, data);
      if (err.unknownField || err.invalidFormula) {
        throw new MetricsSchemaError(`${table}: ${err.detail}`, table);
      }
      throw new Error(`airtable list ${table} failed: HTTP ${res.status} ${err.detail}`);
    }
    out.push(...(data.records ?? []));
    offset = data.offset;
    if (o.maxRecords && out.length >= o.maxRecords) break;
  } while (offset);
  return out;
}

/** Count matching records (capped) — Airtable has no count endpoint. */
export async function countRecords(
  env: Env,
  table: string,
  filterByFormula: string,
  field: string,
  cap = 2000,
): Promise<number> {
  const rows = await listRecords(env, table, {
    filterByFormula,
    fields: [field],
    maxRecords: cap,
  });
  return rows.length;
}

/** Upsert the campaigns + ads a pull mentions (campaigns first: no nameless auto-rows). */
export async function upsertAdsMeta(
  env: Env,
  rows: readonly InsightRow[],
  m: AirtableMetricsMap = metricsMap(),
): Promise<UpsertStats> {
  const c = await batchUpsert(env, m.tables.campaigns, [m.campaigns.campaignId], campaignRecords(rows, m));
  await sleep(PACE_MS);
  const a = await batchUpsert(env, m.tables.ads, [m.ads.adId], adRecords(rows, m));
  return { created: c.created + a.created, updated: c.updated + a.updated, errors: [...c.errors, ...a.errors] };
}

/** Upsert spend rows (rows with no spend and no delivery are skipped). */
export async function upsertAdSpendRows(
  env: Env,
  rows: readonly InsightRow[],
  account: string,
  updatedIso: string,
  m: AirtableMetricsMap = metricsMap(),
): Promise<UpsertStats> {
  const live = rows.filter((r) => r.spend > 0 || r.impressions > 0);
  return batchUpsert(
    env,
    m.tables.spend,
    [m.spend.key],
    live.map((r) => spendRowFields(r, account, updatedIso, m)),
  );
}

/**
 * Ads that exist only because a lead linked to them (no spend in any pulled
 * window) have an empty name — fill it from the Graph ad lookup (kv-cached).
 */
export async function fillNamelessAds(
  env: Env,
  m: AirtableMetricsMap = metricsMap(),
  limit = 10,
): Promise<{ filled: number; misses: number }> {
  const rows = await listRecords(env, m.tables.ads, {
    filterByFormula: `{${m.ads.name}} = ''`,
    fields: [m.ads.adId],
    maxRecords: limit,
  });
  const patches: { id: string; fields: Record<string, unknown> }[] = [];
  const campaigns: Record<string, unknown>[] = [];
  let misses = 0;
  for (const r of rows) {
    const adId = typeof r.fields[m.ads.adId] === "string" ? (r.fields[m.ads.adId] as string) : "";
    const meta = adId ? await lookupAdMeta(env, adId) : null;
    if (!meta?.name) {
      misses++;
      continue;
    }
    const fields: Record<string, unknown> = { [m.ads.name]: meta.name };
    if (meta.campaignId) {
      fields[m.ads.campaignLink] = [meta.campaignId];
      campaigns.push({
        [m.campaigns.campaignId]: meta.campaignId,
        [m.campaigns.name]: meta.campaignName ?? "",
      });
    }
    patches.push({ id: r.id, fields });
  }
  if (campaigns.length) await batchUpsert(env, m.tables.campaigns, [m.campaigns.campaignId], campaigns);
  if (patches.length) await batchPatch(env, m.tables.ads, patches);
  return { filled: patches.length, misses };
}

// ---- lead ↔ day/month/ad links ----

/** Leads still missing their Día link, created on/after `sinceIso` (UTC ISO). */
export function unlinkedLeadsFormula(sinceIso: string, m: AirtableMetricsMap = metricsMap()): string {
  const l = m.leads;
  return `AND({${l.dayLink}} = '', {${l.dayText}} != '', IS_AFTER(CREATED_TIME(), '${fq(sinceIso)}'))`;
}

function textField(fields: Record<string, unknown>, name: string): string {
  const v = fields[name];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

/** Pure. Link patch for one lead from its formula cells; null when Día Lead is blank. */
export function leadLinkPatch(
  fields: Record<string, unknown>,
  m: AirtableMetricsMap = metricsMap(),
): Record<string, unknown> | null {
  const l = m.leads;
  const day = textField(fields, l.dayText);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const month = textField(fields, l.monthText) || monthOf(day);
  const adId = textField(fields, l.adId);
  const patch: Record<string, unknown> = { [l.dayLink]: [day], [l.monthLink]: [month] };
  if (/^\d{10,}$/.test(adId)) patch[l.adLink] = [adId];
  return patch;
}

export interface SweepStats {
  scanned: number;
  linked: number;
  errors: string[];
}

/** Link up to `limit` unlinked leads to their Día/Mes/Anuncio rows. */
export async function linkLeadsSweep(
  env: Env,
  o: { limit: number; sinceIso: string },
  m: AirtableMetricsMap = metricsMap(),
): Promise<SweepStats> {
  const l = m.leads;
  const rows = await listRecords(env, env.AIRTABLE_TRIALS_TABLE, {
    filterByFormula: unlinkedLeadsFormula(o.sinceIso, m),
    fields: [l.dayText, l.monthText, l.adId],
    maxRecords: o.limit,
  });
  const patches: { id: string; fields: Record<string, unknown> }[] = [];
  for (const r of rows) {
    const p = leadLinkPatch(r.fields, m);
    if (p) patches.push({ id: r.id, fields: p });
  }
  const st = patches.length
    ? await batchPatch(env, env.AIRTABLE_TRIALS_TABLE, patches)
    : { created: 0, updated: 0, errors: [] };
  return { scanned: rows.length, linked: st.updated, errors: st.errors };
}

// ---- student ↔ lead links ----

/** Alumnos with a phone but no Lead Original, created on/after `sinceIso`. */
export function unlinkedStudentsFormula(sinceIso: string, m: AirtableMetricsMap = metricsMap()): string {
  const s = m.students;
  return `AND({${s.leadLink}} = '', {${s.phone}} != '', IS_AFTER(CREATED_TIME(), '${fq(sinceIso)}'))`;
}

/** Up to `max` Leads rows whose phone ends in the same 10 digits. */
export async function findLeadsByPhone(
  env: Env,
  phone: string,
  max = 2,
): Promise<MetricsRecord[]> {
  const digits = normalizeMxPhone(phone).replace(/\D/g, "");
  if (digits.length < 10) return [];
  const lm = leadsMap();
  return listRecords(env, env.AIRTABLE_TRIALS_TABLE, {
    filterByFormula: phoneMatchFormula(lm.phone, digits.slice(-10)),
    fields: [lm.phone],
    maxRecords: max,
  });
}

/**
 * Pure decision: link a student to a lead only when EXACTLY one lead matches
 * and it predates the student. Anything else stays for the exceptions view.
 */
export function studentLinkDecision(
  studentCreated: string | undefined,
  leads: readonly MetricsRecord[],
): { leadId: string } | { reason: "none" | "ambiguous" | "lead_after_student" } {
  if (leads.length === 0) return { reason: "none" };
  if (leads.length > 1) return { reason: "ambiguous" };
  const lead = leads[0]!;
  if (lead.createdTime && studentCreated && Date.parse(lead.createdTime) > Date.parse(studentCreated)) {
    return { reason: "lead_after_student" };
  }
  return { leadId: lead.id };
}

export interface StudentSweepStats extends SweepStats {
  ambiguous: number;
  none: number;
}

/** Link manually created students to their lead by phone (exactly-one rule). */
export async function linkStudentsSweep(
  env: Env,
  o: { limit: number; sinceIso: string; paceMs?: number },
  m: AirtableMetricsMap = metricsMap(),
): Promise<StudentSweepStats> {
  const s = m.students;
  // Newest first: a handful of students with no matching lead stay in this filter
  // forever, and a fixed-order scan of `limit` rows would never reach new ones.
  const rows = await listRecords(env, m.tables.students, {
    filterByFormula: unlinkedStudentsFormula(o.sinceIso, m),
    fields: [s.phone, s.name],
    maxRecords: o.limit,
    sort: { field: s.created, direction: "desc" },
  });
  const patches: { id: string; fields: Record<string, unknown> }[] = [];
  let ambiguous = 0;
  let none = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await sleep(o.paceMs ?? PACE_MS);
    const r = rows[i]!;
    const phone = textField(r.fields, s.phone);
    if (!phone) {
      none++;
      continue;
    }
    const leads = await findLeadsByPhone(env, phone, 2);
    const d = studentLinkDecision(r.createdTime, leads);
    if ("leadId" in d) patches.push({ id: r.id, fields: { [s.leadLink]: [d.leadId] } });
    else if (d.reason === "ambiguous") ambiguous++;
    else none++;
  }
  const st = patches.length
    ? await batchPatch(env, m.tables.students, patches)
    : { created: 0, updated: 0, errors: [] };
  return { scanned: rows.length, linked: st.updated, errors: st.errors, ambiguous, none };
}

// ---- duplicate students (payment-automation race) ----

export interface StudentRow {
  id: string;
  name: string;
  createdTime: string;
  leadId: string | null;
}

export interface DuplicateCandidate {
  dupId: string;
  twinId: string;
  leadId: string;
  name: string;
  secondsApart: number;
}

function normName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Pure. Phone-less, unlinked, paid students whose same-named twin (linked to a
 * lead) was created within `windowSec` — the "Auto create payment" race.
 */
export function duplicateStudentCandidates(
  unlinked: readonly StudentRow[],
  linked: readonly StudentRow[],
  windowSec = 120,
): DuplicateCandidate[] {
  const byName = new Map<string, StudentRow[]>();
  for (const l of linked) {
    if (!l.leadId) continue;
    const k = normName(l.name);
    if (!k) continue;
    const arr = byName.get(k) ?? [];
    arr.push(l);
    byName.set(k, arr);
  }
  const out: DuplicateCandidate[] = [];
  for (const d of unlinked) {
    const twins = byName.get(normName(d.name)) ?? [];
    let best: { twin: StudentRow; apart: number } | null = null;
    for (const t of twins) {
      const apart = Math.abs(Date.parse(t.createdTime) - Date.parse(d.createdTime)) / 1000;
      if (apart <= windowSec && (!best || apart < best.apart)) best = { twin: t, apart };
    }
    if (best) {
      out.push({
        dupId: d.id,
        twinId: best.twin.id,
        leadId: best.twin.leadId!,
        name: d.name,
        secondsApart: Math.round(best.apart),
      });
    }
  }
  return out;
}

function toStudentRow(r: MetricsRecord, m: AirtableMetricsMap): StudentRow {
  const link = r.fields[m.students.leadLink];
  let leadId: string | null = null;
  if (Array.isArray(link) && link.length) {
    const first = link[0] as unknown;
    leadId = typeof first === "string" ? first : ((first as { id?: string })?.id ?? null);
  }
  return {
    id: r.id,
    name: textField(r.fields, m.students.name),
    createdTime: r.createdTime ?? "",
    leadId,
  };
}

/** Find (and optionally relink) the duplicate students. Non-destructive. */
export async function relinkDuplicateStudents(
  env: Env,
  o: { dryRun: boolean; sinceIso: string },
  m: AirtableMetricsMap = metricsMap(),
): Promise<{ candidates: DuplicateCandidate[]; relinked: number; errors: string[] }> {
  const s = m.students;
  const since = fq(o.sinceIso);
  const unlinked = await listRecords(env, m.tables.students, {
    filterByFormula: `AND({${s.leadLink}} = '', {${s.phone}} = '', {${s.totalPaid}} > 0, IS_AFTER(CREATED_TIME(), '${since}'))`,
    fields: [s.name, s.leadLink],
    maxRecords: 500,
  });
  const linked = await listRecords(env, m.tables.students, {
    filterByFormula: `AND({${s.leadLink}} != '', IS_AFTER(CREATED_TIME(), '${since}'))`,
    fields: [s.name, s.leadLink],
    maxRecords: 2000,
  });
  const candidates = duplicateStudentCandidates(
    unlinked.map((r) => toStudentRow(r, m)),
    linked.map((r) => toStudentRow(r, m)),
  );
  if (o.dryRun || candidates.length === 0) return { candidates, relinked: 0, errors: [] };
  const st = await batchPatch(
    env,
    m.tables.students,
    candidates.map((c) => ({ id: c.dupId, fields: { [s.leadLink]: [c.leadId] } })),
  );
  return { candidates, relinked: st.updated, errors: st.errors };
}

// ---- reads for the brief ----

/** Airtable formula cells come back as numbers, numeric strings, or error objects. */
export function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
  }
  return null; // {specialValue:"NaN"|"Infinity"}, {error:"#ERROR!"}, null, arrays
}

/** The Días/Meses row whose primary field equals `key`, or null. */
export async function getPeriodRow(
  env: Env,
  table: string,
  primaryField: string,
  key: string,
  fields: string[],
): Promise<Record<string, unknown> | null> {
  const rows = await listRecords(env, table, {
    filterByFormula: `{${primaryField}} = '${fq(key)}'`,
    fields,
    maxRecords: 1,
  });
  return rows[0]?.fields ?? null;
}

/** Exceptions are counted by paging (Airtable has no count endpoint); each one
 *  stops at this cap (3 pages) so the brief stays within the subrequest budget. */
export const EXCEPTION_CAP = 300;

export interface ExceptionCounts {
  pendingAttendance: number;
  unlinkedPaidStudents: number;
  incomeWithoutStudent: number;
  incomeWithoutConcept: number;
  /** Leads that closed (paid) but have no origin evidence — ROAS can't credit them. */
  closedUnknownOrigin: number;
}

/** The four operational exceptions the brief surfaces (since `sinceIso`). */
export async function exceptionCounts(
  env: Env,
  sinceIso: string,
  m: AirtableMetricsMap = metricsMap(),
): Promise<ExceptionCounts> {
  const since = fq(sinceIso);
  const sinceDate = sinceIso.slice(0, 10);
  const mv = m.movements;
  const pendingAttendance = await countRecords(
    env,
    env.AIRTABLE_TRIALS_TABLE,
    `AND({${m.leads.pendingAttendance}} = 1, IS_AFTER(CREATED_TIME(), '${since}'))`,
    m.leads.dayText,
    EXCEPTION_CAP,
  );
  const unlinkedPaidStudents = await countRecords(
    env,
    m.tables.students,
    `AND({${m.students.leadLink}} = '', {${m.students.eligibleIncome}} > 0, IS_AFTER(CREATED_TIME(), '${since}'))`,
    m.students.name,
    EXCEPTION_CAP,
  );
  const incomeBase = `{${mv.type}} = '${fq(mv.typeIncome)}', IS_AFTER({${mv.date}}, DATEADD('${sinceDate}', -1, 'days'))`;
  const incomeWithoutStudent = await countRecords(
    env,
    m.tables.movements,
    `AND(${incomeBase}, {${mv.concept}} != '${fq(mv.conceptSurplus)}', {${mv.studentLink}} = '')`,
    mv.date,
    EXCEPTION_CAP,
  );
  const incomeWithoutConcept = await countRecords(
    env,
    m.tables.movements,
    `AND(${incomeBase}, {${mv.concept}} = '')`,
    mv.date,
    EXCEPTION_CAP,
  );
  const closedUnknownOrigin = await countRecords(
    env,
    env.AIRTABLE_TRIALS_TABLE,
    `AND({${m.leads.closed}} = 1, {${m.leads.origin}} = '${fq(m.leads.originUnknown)}', IS_AFTER(CREATED_TIME(), '${since}'))`,
    m.leads.dayText,
    EXCEPTION_CAP,
  );
  return { pendingAttendance, unlinkedPaidStudents, incomeWithoutStudent, incomeWithoutConcept, closedUnknownOrigin };
}
