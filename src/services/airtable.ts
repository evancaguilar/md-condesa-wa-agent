// Raw-fetch Airtable REST client (PAT bearer auth). Zero deps. Base + table
// come from env. Tolerant of schema drift (unknown-field 422 → minimal retry)
// and of the Students table not existing yet (404 → []).

import type { Env, BookTrialInput } from "../types.js";
import { cdmxIso } from "../cron/time.js";

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
 * Create a trial record. Maps BookTrialInput → the manually-added Phase-0
 * fields. On a 422 unknown-field error, retries once with only the core fields
 * (schema-drift tolerance) and logs a warning.
 */
export async function bookTrial(
  env: Env,
  input: BookTrialInput,
): Promise<string> {
  const phone = normalizeMxPhone(input.phone);
  const trialDateTime = cdmxIso(input.trialDate, input.trialTime);
  const full: Record<string, unknown> = {
    Name: input.name,
    "Phone E164": phone,
    Discipline: input.discipline,
    Audience: input.audience,
    "Trial DateTime": trialDateTime,
    Source: "WhatsApp",
  };

  const first = await createRecord(env, env.AIRTABLE_TRIALS_TABLE, full);
  if (first.ok) return first.id;

  if (first.unknownField) {
    console.warn(
      `[airtable] bookTrial unknown-field 422 (${first.detail}); retrying with core fields only`,
    );
    const minimal: Record<string, unknown> = {
      Name: input.name,
      "Phone E164": phone,
      "Trial DateTime": trialDateTime,
      Source: "WhatsApp",
    };
    const retry = await createRecord(env, env.AIRTABLE_TRIALS_TABLE, minimal);
    if (retry.ok) return retry.id;
    throw new Error(`airtable bookTrial failed after retry: ${retry.detail}`);
  }
  throw new Error(`airtable bookTrial failed: ${first.detail}`);
}

interface CreateResult {
  ok: boolean;
  id: string;
  unknownField: boolean;
  detail: string;
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
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { type?: string; message?: string } | string;
  };
  if (res.ok && data.id) {
    return { ok: true, id: data.id, unknownField: false, detail: "" };
  }
  const errObj = typeof data.error === "object" ? data.error : undefined;
  const detail =
    errObj?.message ??
    (typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
  const unknownField =
    res.status === 422 &&
    (errObj?.type === "UNKNOWN_FIELD_NAME" ||
      /unknown field name/i.test(detail));
  return { ok: false, id: "", unknownField, detail };
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
    for (const r of data.records ?? []) out.push(toBookingRecord(r));
    offset = data.offset;
  } while (offset);
  return out;
}

function toBookingRecord(r: AirtableRecord): BookingRecord {
  const f = r.fields;
  return {
    id: r.id,
    phone: asString(f["Phone E164"] ?? f["Phone"]),
    name: asString(f["Name"]),
    trialDateTimeIso: asString(f["Trial DateTime"]),
  };
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
