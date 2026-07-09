// Raw-fetch Airtable REST client (PAT bearer auth). Zero deps. Base + table
// come from env. Tolerant of schema drift (unknown-field 422 → minimal retry)
// and of the Students table not existing yet (404 → []).

import type { Env, BookTrialInput, RuleAction } from "../types.js";
import type { AirtableLeadsMap } from "../client-config.js";
import { CLIENT } from "../client.gen.js";
import { cdmxIso } from "../cron/time.js";
import { kvGet, kvSet } from "../db/queries.js";

const API = "https://api.airtable.com/v0";
const MAX_429_RETRIES = 4;

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface BookingRecord {
  id: string;
  phone: string | null;
  name: string | null;
  trialDateTimeIso: string | null;
  /** Value of the trial-outcome field (env.AIRTABLE_RESULT_FIELD), if present. */
  result: string | null;
}

/** Default name of the Airtable trial-outcome field (env-overridable). */
export const DEFAULT_RESULT_FIELD = "Resultado clase prueba";

/**
 * Legacy English column names — the fallback when a client doesn't declare
 * `airtableLeads` in its client.mjs. md-condesa maps these onto its real
 * Spanish CRM columns (# de Teléfono, Nombre de Lead, Fecha Clase Prueba…).
 */
export const DEFAULT_LEADS_MAP: AirtableLeadsMap = {
  phone: "Phone E164",
  name: "Name",
  source: "Source",
  sourceValue: "WhatsApp",
  ad: "Ad",
  campaign: "Campaña",
  trialDateTime: "Trial DateTime",
  discipline: "Discipline",
  disciplineIsMulti: false,
  audience: "Audience",
  result: DEFAULT_RESULT_FIELD,
  disciplineValues: {},
  audienceValues: {},
};

/** The active client's Leads-table map (client overrides merged over defaults). */
export function leadsMap(): AirtableLeadsMap {
  return { ...DEFAULT_LEADS_MAP, ...(CLIENT.airtableLeads ?? {}) };
}

/** The configured result field name: env override > client map > default. */
export function resultFieldName(env: Env): string {
  return env.AIRTABLE_RESULT_FIELD || leadsMap().result;
}

/**
 * Normalize a result value for matching: lowercase, NFD-decompose, strip accents,
 * collapse whitespace. So "No asistió", "no asistio", "  NO   ASISTIÓ " all
 * normalize to "no asistio". Pure.
 */
export function normalizeResult(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Classify a normalized result value into an action bucket. */
export function classifyResult(
  raw: string | null | undefined,
): "no_show" | "enrolled" | null {
  const n = normalizeResult(raw);
  if (!n) return null;
  // Enrollment wins when a multi-select holds both (no-show → later enrolled).
  if (n.includes("se inscribio")) return "enrolled";
  if (n.includes("no asistio")) return "no_show";
  return null;
}

export interface StudentRecord {
  name: string | null;
  phone: string | null;
}

/**
 * Normalize a phone to Mexican E.164 digits. WhatsApp/Meta gives us digits like
 * 5215512345678 (52 + 1 mobile marker + 10). We ensure the "521…" mobile shape:
 * strip non-digits, drop a leading +/00, and for a bare 52 + 10-digit number
 * insert the 1. Idempotent for already-normalized input.
 */
export function normalizeMxPhone(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10) return `521${d}`; // bare local mobile
  if (d.startsWith("52")) {
    const rest = d.slice(2);
    if (rest.length === 10) return `521${rest}`; // 52 + 10 → add mobile 1
    return d; // 521 + 10 (already correct) or other lengths untouched
  }
  return d;
}

function baseUrl(env: Env, table: string): string {
  return `${API}/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}

async function airtableFetch(
  env: Env,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers = {
    Authorization: `Bearer ${env.AIRTABLE_PAT}`,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res;
    attempt++;
    // Airtable rate limit is 5 rps; back off exponentially from ~300ms.
    await sleep(300 * 2 ** (attempt - 1));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Book a trial. Upserts the Leads row BY PHONE (structurally killing duplicate
 * rows from bot vs web-form vs lead-sync) and returns the record id — contract
 * unchanged. Trial details (Discipline/Audience/Trial DateTime) are always
 * written; Name/Source/Ad are fill-if-empty so manual Airtable edits survive.
 * createWithDriftRetry inside upsertLead tolerates unknown fields.
 */
export async function bookTrial(
  env: Env,
  input: BookTrialInput,
): Promise<string> {
  const m = leadsMap();
  const phone = normalizeMxPhone(input.phone);
  const trialDateTime = cdmxIso(input.trialDate, input.trialTime);
  const current = await findLeadByPhone(env, phone);
  const cur = current?.fields ?? null;

  // Map the service key (jiu/muay/…) to the table's real select option,
  // preferring a kid-specific variant ("jiu:kid" → "BJJ Kids") when present.
  const discKey = input.discipline;
  const discOpt =
    (input.audience === "kid" ? m.disciplineValues[`${discKey}:kid`] : undefined) ??
    m.disciplineValues[discKey] ??
    input.discipline;
  const audKey = discKey === "baby" ? "baby" : input.audience;
  const audOpt = m.audienceValues[audKey] ?? input.audience;

  const fields: Record<string, unknown> = {
    [m.phone]: storedPhone(phone),
    [m.audience]: audOpt,
    [m.trialDateTime]: trialDateTime,
  };
  // multipleSelects PATCH replaces the whole array — union with current values.
  fields[m.discipline] = m.disciplineIsMulti
    ? [...new Set([...toStringArray(cur?.[m.discipline]), discOpt])]
    : discOpt;
  if (input.name && isEmpty(cur?.[m.name])) fields[m.name] = input.name;
  if (isEmpty(cur?.[m.source])) fields[m.source] = m.sourceValue;
  if (input.ad && isEmpty(cur?.[m.ad])) fields[m.ad] = input.ad;

  const res = await upsertLead(env, phone, fields, fields, current);
  return res.id;
}

/**
 * Phone value written on NEW rows: "+<normalized digits>" (e.g. +5215534260813).
 * Reads never rely on this exact shape — findLeadByPhone matches the last 10
 * digits, so legacy rows in any format ("(556) 979-4387", "55 4019 4997") match.
 */
function storedPhone(normalized: string): string {
  return `+${normalized}`;
}

interface CreateResult {
  ok: boolean;
  id: string;
  fields: Record<string, unknown>;
  unknownField: boolean;
  detail: string;
}

/** Shape of an Airtable JSON error body (or a bare string in odd cases). */
type AirtableErrorBody = {
  error?: { type?: string; message?: string } | string;
};

interface ParsedAirtableError {
  detail: string;
  unknownField: boolean; // 422 UNKNOWN_FIELD_NAME
  invalidFormula: boolean; // 422 INVALID_FILTER_BY_FORMULA
}

/** Shared error extractor for createRecord/updateRecord/findLeadByPhone. */
function parseAirtableError(status: number, data: AirtableErrorBody): ParsedAirtableError {
  const errObj = typeof data.error === "object" ? data.error : undefined;
  const detail =
    errObj?.message ??
    (typeof data.error === "string" ? data.error : `HTTP ${status}`);
  const type = errObj?.type;
  const unknownField =
    status === 422 &&
    (type === "UNKNOWN_FIELD_NAME" || /unknown field name/i.test(detail));
  const invalidFormula =
    status === 422 &&
    (type === "INVALID_FILTER_BY_FORMULA" || /invalid.*formula/i.test(detail));
  return { detail, unknownField, invalidFormula };
}

/** Thrown by updateRecord on a non-ok PATCH; carries the unknown-field flag. */
export class AirtableWriteError extends Error {
  constructor(
    message: string,
    readonly unknownField: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "AirtableWriteError";
  }
}

/**
 * Pull the offending field name out of an UNKNOWN_FIELD_NAME detail string
 * (e.g. `Unknown field name: "Actividad"`), or null if not parseable. Lets the
 * caller drop just that field and retry (schema-drift tolerance).
 */
export function extractUnknownFieldName(detail: string): string | null {
  const m = detail.match(/unknown field name[s]?:?\s*"?([^"]+?)"?\s*$/i);
  return m ? m[1]!.trim() : null;
}

/** True when an Airtable field value is absent/blank (fill-if-empty guard). */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

async function createRecord(
  env: Env,
  table: string,
  fields: Record<string, unknown>,
): Promise<CreateResult> {
  const res = await airtableFetch(env, baseUrl(env, table), {
    method: "POST",
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = (await res.json().catch(() => ({}))) as AirtableErrorBody & {
    id?: string;
    fields?: Record<string, unknown>;
  };
  if (res.ok && data.id) {
    return {
      ok: true,
      id: data.id,
      fields: data.fields ?? fields,
      unknownField: false,
      detail: "",
    };
  }
  const err = parseAirtableError(res.status, data);
  return { ok: false, id: "", fields: {}, unknownField: err.unknownField, detail: err.detail };
}

/**
 * PATCH an existing record (typecast:true so new select options are created).
 * Returns the full updated record. Throws AirtableWriteError on any non-ok
 * response so callers can inspect `unknownField` and drop/attribute the field.
 */
export async function updateRecord(
  env: Env,
  table: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  const res = await airtableFetch(env, `${baseUrl(env, table)}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = (await res.json().catch(() => ({}))) as AirtableErrorBody & {
    id?: string;
    fields?: Record<string, unknown>;
  };
  if (res.ok && data.id) return { id: data.id, fields: data.fields ?? {} };
  const err = parseAirtableError(res.status, data);
  throw new AirtableWriteError(err.detail, err.unknownField, res.status);
}

/**
 * POST a new record, tolerating schema drift: on an UNKNOWN_FIELD_NAME 422 we
 * drop the named field and retry (a few times) rather than failing outright.
 * Returns the created record's id + fields.
 */
async function createWithDriftRetry(
  env: Env,
  table: string,
  fields: Record<string, unknown>,
): Promise<{ id: string; fields: Record<string, unknown> }> {
  const attempt: Record<string, unknown> = { ...fields };
  for (let i = 0; i < 4; i++) {
    const r = await createRecord(env, table, attempt);
    if (r.ok) return { id: r.id, fields: r.fields };
    if (r.unknownField) {
      const bad = extractUnknownFieldName(r.detail);
      if (bad && bad in attempt) {
        console.warn(
          `[airtable] create dropping unknown field "${bad}" (${r.detail})`,
        );
        delete attempt[bad];
        continue;
      }
    }
    throw new Error(`airtable create failed: ${r.detail}`);
  }
  throw new Error("airtable create failed after drift retries");
}

/**
 * Airtable formula that strips " ", "-", "(", ")", "+" from the phone column —
 * the CRM holds every historical format ("+525513805999", "(556) 979-4387",
 * "55 4019 4997"), so lookups compare the LAST 10 DIGITS of the cleaned value.
 * Pure + exported for tests.
 */
export function phoneMatchFormula(fieldName: string, last10: string): string {
  const cleaned =
    `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(` +
    `{${fieldName}}&""` +
    `," ",""),"-",""),"(",""),")",""),"+","")`;
  return `RIGHT(${cleaned},10)="${last10}"`;
}

/**
 * Find a Leads row by phone, matching the last 10 digits of the mapped phone
 * column regardless of stored format. Digits-only interpolation (guards against
 * formula injection). On a 422 INVALID_FILTER_BY_FORMULA (field renamed/removed)
 * we warn and return null so the caller degrades to create rather than throwing.
 */
export async function findLeadByPhone(
  env: Env,
  phone: string,
): Promise<AirtableRecord | null> {
  const digits = normalizeMxPhone(phone).replace(/\D/g, "");
  if (!digits) return null;
  const m = leadsMap();
  const formula =
    digits.length >= 10
      ? phoneMatchFormula(m.phone, digits.slice(-10))
      : `{${m.phone}}&""="${digits}"`;
  const url = new URL(baseUrl(env, env.AIRTABLE_TRIALS_TABLE));
  url.searchParams.set("filterByFormula", formula);
  url.searchParams.set("pageSize", "1");
  const res = await airtableFetch(env, url.toString(), { method: "GET" });
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { records?: AirtableRecord[] };
    return data.records?.[0] ?? null;
  }
  const data = (await res.json().catch(() => ({}))) as AirtableErrorBody;
  const err = parseAirtableError(res.status, data);
  if (err.invalidFormula) {
    console.warn(`[airtable] findLeadByPhone invalid formula (${err.detail}); returning null`);
    return null;
  }
  throw new Error(`airtable findLeadByPhone failed: ${err.detail}`);
}

export interface UpsertLeadResult {
  id: string;
  created: boolean;
  fields: Record<string, unknown>;
}

/**
 * Upsert a Leads row by phone: find → PATCH patchFields, else POST createFields
 * (with drift retry). Pass `current` (from a prior findLeadByPhone) to skip the
 * internal find. Returns the record id, whether it was created, and its fields
 * (authoritative post-write values, for downstream multi-select unions).
 */
export async function upsertLead(
  env: Env,
  phone: string,
  patchFields: Record<string, unknown>,
  createFields: Record<string, unknown>,
  current?: AirtableRecord | null,
): Promise<UpsertLeadResult> {
  const existing = current !== undefined ? current : await findLeadByPhone(env, phone);
  if (existing) {
    const updated = await updateRecord(
      env,
      env.AIRTABLE_TRIALS_TABLE,
      existing.id,
      patchFields,
    );
    return { id: updated.id, created: false, fields: updated.fields };
  }
  const made = await createWithDriftRetry(env, env.AIRTABLE_TRIALS_TABLE, createFields);
  return { id: made.id, created: true, fields: made.fields };
}

/** Input to buildLeadFields — the base CRM columns every lead-sync writes. */
export interface LeadFieldsInput {
  phone: string;
  name?: string | null;
  campaignName?: string | null;
  ad?: string | null; // "headline (id)" attribution label
}

/**
 * Pure. Builds the base Leads field map for an upsert. Name/Ad/Source are
 * fill-if-empty against the CURRENT record so manual Airtable edits are never
 * clobbered; Campaña is set whenever known (the campaign a lead arrived through).
 */
export function buildLeadFields(
  current: Record<string, unknown> | null,
  input: LeadFieldsInput,
  map: AirtableLeadsMap = leadsMap(),
): Record<string, unknown> {
  const f: Record<string, unknown> = { [map.phone]: `+${input.phone}` };
  if (isEmpty(current?.[map.source])) f[map.source] = map.sourceValue;
  const name = (input.name ?? "").trim();
  if (name && isEmpty(current?.[map.name])) f[map.name] = name;
  const ad = (input.ad ?? "").trim();
  if (ad && isEmpty(current?.[map.ad])) f[map.ad] = ad;
  const camp = (input.campaignName ?? "").trim();
  if (camp) f[map.campaign] = camp;
  return f;
}

/** Coerce an Airtable field value to a string[] for multi-select unions. */
function toStringArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v === "" ? [] : [v];
  return [];
}

/**
 * Pure. Turns a list of RuleActions into an Airtable PATCH field map, resolved
 * against the record's CURRENT fields:
 * - set:   overwrite with value
 * - add:   union into the multi-select (read-modify-write; dedupes; coerces a
 *          scalar current value to a single-element array)
 * - clear: null (empties the field)
 * Later actions on the same field build on earlier ones within the same batch.
 */
export function buildPatchFields(
  current: Record<string, unknown>,
  actions: RuleAction[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const a of actions) {
    if (a.op === "clear") {
      patch[a.field] = null;
    } else if (a.op === "set") {
      patch[a.field] = a.value;
    } else {
      // add: union
      const base = a.field in patch ? patch[a.field] : current[a.field];
      const arr = toStringArray(base);
      if (!arr.includes(a.value)) arr.push(a.value);
      patch[a.field] = arr;
    }
  }
  return patch;
}

// ---- base schema (metadata API) ----

export interface SchemaField {
  name: string;
  type: string;
  /** Option names for select-type fields (single/multiple select). */
  choices?: string[];
}

export interface BaseSchema {
  table: string;
  fields: SchemaField[];
}

const SCHEMA_KV_KEY = "airtable_schema";
const SCHEMA_TTL_MS = 3600_000; // 1h

interface RawMetaField {
  name?: string;
  type?: string;
  options?: { choices?: { name?: string }[] };
}
interface RawMetaTable {
  name?: string;
  fields?: RawMetaField[];
}

function compactTable(table: RawMetaTable, tableName: string): BaseSchema {
  const fields: SchemaField[] = [];
  for (const f of table.fields ?? []) {
    const name = f.name ?? "";
    if (!name) continue;
    const field: SchemaField = { name, type: f.type ?? "unknown" };
    const choices = f.options?.choices;
    if (Array.isArray(choices)) {
      const names = choices
        .map((c) => c.name ?? "")
        .filter((n) => n !== "");
      if (names.length > 0) field.choices = names;
    }
    fields.push(field);
  }
  return { table: tableName, fields };
}

/**
 * The Leads table schema via the metadata API, cached in kv ('airtable_schema')
 * for 1h. On any fetch failure (or the table not being found) we return the last
 * cached schema if present — stale-on-failure so the Editor chat keeps working.
 */
export async function getBaseSchema(env: Env): Promise<BaseSchema | null> {
  const cachedRaw = await kvGet(env.DB, SCHEMA_KV_KEY);
  let cached: { at: number; schema: BaseSchema } | null = null;
  if (cachedRaw) {
    try {
      cached = JSON.parse(cachedRaw) as { at: number; schema: BaseSchema };
    } catch {
      cached = null;
    }
  }
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.schema;

  try {
    const url = `${API}/meta/bases/${env.AIRTABLE_BASE_ID}/tables`;
    const res = await airtableFetch(env, url, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { tables?: RawMetaTable[] };
    const raw = (data.tables ?? []).find((t) => t.name === env.AIRTABLE_TRIALS_TABLE);
    if (!raw) return cached?.schema ?? null;
    const schema = compactTable(raw, env.AIRTABLE_TRIALS_TABLE);
    await kvSet(env.DB, SCHEMA_KV_KEY, JSON.stringify({ at: Date.now(), schema }));
    return schema;
  } catch (err) {
    console.warn(`[airtable] getBaseSchema failed (${String(err)}); serving cache`);
    return cached?.schema ?? null; // stale-on-failure
  }
}

const MAX_SUMMARY_CHOICES = 12;

/** Rough token estimate (~4 chars/token) for the pure schema summary cap. */
function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Pure. Compact human/LLM-readable summary of the Leads schema for the Editor
 * chat, hard-capped at ~maxTokens. Each select field lists its first 12 options
 * then "(+N más)"; fields are dropped once the running estimate exceeds the cap.
 */
export function schemaSummary(schema: BaseSchema, maxTokens = 600): string {
  const lines: string[] = [];
  let tokens = 0;
  for (const field of schema.fields) {
    let line = `- ${field.name} (${field.type})`;
    if (field.choices && field.choices.length > 0) {
      const shown = field.choices.slice(0, MAX_SUMMARY_CHOICES);
      const extra = field.choices.length - shown.length;
      line += `: ${shown.join(", ")}`;
      if (extra > 0) line += ` (+${extra} más)`;
    }
    const lineTokens = estTokens(line);
    if (tokens + lineTokens > maxTokens && lines.length > 0) break;
    lines.push(line);
    tokens += lineTokens;
  }
  return lines.join("\n");
}

/**
 * List records modified after `sinceIso`, paginating via offset. Used by the
 * hourly booking sync to pick up web-form trials.
 */
export async function listRecentBookings(
  env: Env,
  sinceIso: string,
): Promise<BookingRecord[]> {
  const formula = `IS_AFTER(LAST_MODIFIED_TIME(), '${sinceIso}')`;
  const out: BookingRecord[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(baseUrl(env, env.AIRTABLE_TRIALS_TABLE));
    url.searchParams.set("filterByFormula", formula);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await airtableFetch(env, url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`airtable listRecentBookings failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      records?: AirtableRecord[];
      offset?: string;
    };
    const resultField = resultFieldName(env);
    for (const r of data.records ?? []) out.push(toBookingRecord(r, resultField));
    offset = data.offset;
  } while (offset);
  return out;
}

function toBookingRecord(r: AirtableRecord, resultField: string): BookingRecord {
  const f = r.fields;
  const m = leadsMap();
  return {
    id: r.id,
    phone: asString(f[m.phone] ?? f["Phone E164"] ?? f["Phone"]),
    name: asString(f[m.name] ?? f["Name"]),
    trialDateTimeIso: asString(f[m.trialDateTime] ?? f["Trial DateTime"]),
    // multipleSelects result columns come back as arrays — join for classify.
    result: asResultString(f[resultField]),
  };
}

/** Coerce a result cell (string or multipleSelects array) to a match string. */
function asResultString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === "string");
    return parts.length ? parts.join(", ") : null;
  }
  return asString(v);
}

/**
 * Read the Students table (Name, Phone E164). Tolerates a 404 (table not
 * created yet) by returning an empty list.
 */
export async function listStudents(env: Env): Promise<StudentRecord[]> {
  const out: StudentRecord[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(baseUrl(env, "Students"));
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await airtableFetch(env, url.toString(), { method: "GET" });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`airtable listStudents failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      records?: AirtableRecord[];
      offset?: string;
    };
    for (const r of data.records ?? []) {
      out.push({
        name: asString(r.fields["Name"]),
        phone: asString(r.fields["Phone E164"] ?? r.fields["Phone"]),
      });
    }
    offset = data.offset;
  } while (offset);
  return out;
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return String(v);
}

/** AirtablePort implementation bound to an Env (for index.ts wiring by E). */
export function makeAirtablePort(env: Env): {
  bookTrial(input: BookTrialInput): Promise<string>;
} {
  return { bookTrial: (input) => bookTrial(env, input) };
}
