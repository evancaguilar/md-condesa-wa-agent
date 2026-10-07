// Customer-list custom audiences from Airtable (docs/meta-audiences.md).
//
// Two audiences on the ad account, rebuilt from `Alumnos` once a day:
//  - PAID   : everyone who ever paid (Total Pagado > 0) minus staff / seminar /
//             paid-visitor statuses → seed for lookalikes, exclusion for
//             acquisition campaigns;
//  - ACTIVE : currently active members (Vigencia por Fecha Activa = 1) → the
//             "do not show acquisition ads to current students" exclusion.
//
// SHAPE: pure normalizers + hashing + diff (unit-tested, no I/O) and a thin
// Graph client that never throws and never lets the token reach a log. The
// cron in src/cron/audiences.ts owns the orchestration.
//
// PRIVACY: Meta requires the identifiers hashed (SHA-256, lowercase hex) after
// normalization — email lowercased/trimmed, phone digits-only with country
// code. Nothing else about a student leaves the worker, and only the HASHES
// are kept in kv (the diff snapshot), never the raw values.

import type { Env } from "../types.js";
import { GRAPH } from "./ad-meta.js";
import { redactToken } from "./meta-capi.js";

// ---- normalization (pure) ----

const EMAIL_RE = /^[^\s@,;/]+@[^\s@,;/]+\.[^\s@,;/]+$/;

/**
 * Pure. One Airtable cell → zero or more valid emails: lowercase, trim, split
 * cells that hold several addresses (comma / semicolon / slash / whitespace /
 * newline), drop anything that is not shaped like an address, dedupe.
 */
export function normalizeEmails(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : "";
  const out = new Set<string>();
  for (const part of text.split(/[\s,;/]+/)) {
    const e = part.trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) out.add(e);
  }
  return [...out];
}

/**
 * Pure. Phone → Meta's expected form (digits only, with country code, no
 * leading `+`/zeros), using the academy's rules:
 *  - 10 digits                 → Mexican local number: prefix 52
 *  - 521 + 10 digits (13)      → the legacy mobile "1" is dropped: 52 + 10
 *  - anything else with ≥ 10 digits is kept as given (other country codes)
 *  - fewer than 10 digits → null (not a usable number)
 */
export function normalizePhoneForMeta(raw: unknown): string | null {
  const text = Array.isArray(raw) ? String(raw[0] ?? "") : typeof raw === "string" ? raw : "";
  let d = text.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length < 10) return null;
  if (d.length === 10) return `52${d}`;
  if (d.length === 13 && d.startsWith("521")) return `52${d.slice(3)}`;
  return d;
}

/** SHA-256 of a UTF-8 string as lowercase hex (WebCrypto, no dependencies). */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- selection (pure) ----

export interface StudentColumns {
  phone: string;
  email: string;
  totalPaid: string;
  status: string;
  activeFlag: string;
  excludedStatuses: string[];
}

/** A student reduced to what the audience needs (raw, pre-hash). */
export interface AudienceMember {
  emails: string[];
  phone: string | null;
}

function num(v: unknown): number {
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(v: unknown): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === "string" ? raw.trim() : "";
}

function member(fields: Record<string, unknown>, c: StudentColumns): AudienceMember | null {
  const m: AudienceMember = {
    emails: normalizeEmails(fields[c.email]),
    phone: normalizePhoneForMeta(fields[c.phone]),
  };
  return m.emails.length === 0 && !m.phone ? null : m;
}

/** Pure. Total Pagado > 0 and Status not in the excluded list. */
export function selectPaidStudents(
  rows: readonly { fields: Record<string, unknown> }[],
  c: StudentColumns,
): AudienceMember[] {
  const excluded = new Set(c.excludedStatuses.map((s) => s.toLowerCase()));
  const out: AudienceMember[] = [];
  for (const r of rows) {
    if (!(num(r.fields[c.totalPaid]) > 0)) continue;
    if (excluded.has(str(r.fields[c.status]).toLowerCase())) continue;
    const m = member(r.fields, c);
    if (m) out.push(m);
  }
  return out;
}

/** Pure. Vigencia por Fecha Activa = 1. */
export function selectActiveStudents(
  rows: readonly { fields: Record<string, unknown> }[],
  c: StudentColumns,
): AudienceMember[] {
  const out: AudienceMember[] = [];
  for (const r of rows) {
    if (num(r.fields[c.activeFlag]) !== 1) continue;
    const m = member(r.fields, c);
    if (m) out.push(m);
  }
  return out;
}

// ---- rows + diff ----

/** Meta multi-key schema: every row carries one value per key ("" = absent). */
export const AUDIENCE_SCHEMA = ["EMAIL", "PHONE"] as const;
/** Meta's cap per /users request. */
export const AUDIENCE_BATCH = 10_000;

/**
 * Hash members into upload rows. A student with several emails becomes one
 * row per email (each with the phone), so every identifier can match. Rows
 * are deduped and returned as `emailHash|phoneHash` strings — the unit the
 * diff snapshot stores and the payload builder splits again.
 */
export async function hashMembers(members: readonly AudienceMember[]): Promise<string[]> {
  const out = new Set<string>();
  for (const m of members) {
    const phoneHash = m.phone ? await sha256Hex(m.phone) : "";
    if (m.emails.length === 0) {
      out.add(`|${phoneHash}`);
      continue;
    }
    for (const e of m.emails) out.add(`${await sha256Hex(e)}|${phoneHash}`);
  }
  return [...out].sort();
}

export interface MemberDiff {
  adds: string[];
  removes: string[];
}

/** Pure. What to upload and what to delete to turn `prev` into `next`. */
export function diffMembers(prev: readonly string[], next: readonly string[]): MemberDiff {
  const p = new Set(prev);
  const n = new Set(next);
  return {
    adds: next.filter((r) => !p.has(r)),
    removes: prev.filter((r) => !n.has(r)),
  };
}

/** Pure. `emailHash|phoneHash` rows → Meta `payload` objects, ≤ AUDIENCE_BATCH each. */
export function audiencePayloads(
  rows: readonly string[],
): { schema: readonly string[]; data: string[][] }[] {
  const out: { schema: readonly string[]; data: string[][] }[] = [];
  for (let i = 0; i < rows.length; i += AUDIENCE_BATCH) {
    out.push({
      schema: AUDIENCE_SCHEMA,
      data: rows.slice(i, i + AUDIENCE_BATCH).map((r) => {
        const [e, p] = r.split("|");
        return [e ?? "", p ?? ""];
      }),
    });
  }
  return out;
}

// ---- Graph client (never throws, never leaks the token) ----

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Customer lists need the ads scopes: the CAPI system-user token, else the ads one. */
export function audienceToken(env: Env): string | null {
  return env.META_CAPI_TOKEN || env.ADS_ACCESS_TOKEN || null;
}

export interface GraphResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

async function graph<T>(
  token: string,
  url: string,
  init: RequestInit,
  doFetch: FetchLike,
): Promise<GraphResult<T>> {
  try {
    const res = await doFetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    if (!res.ok) {
      const code = json.error?.code !== undefined ? ` (code ${json.error.code})` : "";
      return {
        ok: false,
        data: null,
        error: redactToken(`${json.error?.message ?? `HTTP ${res.status}`}${code}`, token),
      };
    }
    return { ok: true, data: json, error: null };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: redactToken(err instanceof Error ? err.message : String(err), token),
    };
  }
}

function actPath(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

/** GET the account's customer-list audiences (id + name), first 200. */
export async function listCustomAudiences(
  token: string,
  accountId: string,
  doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<GraphResult<{ id: string; name: string }[]>> {
  const url = `${GRAPH}/${actPath(accountId)}/customaudiences?fields=id,name,subtype&limit=200`;
  const res = await graph<{ data?: { id: string; name: string; subtype?: string }[] }>(
    token,
    url,
    { method: "GET" },
    doFetch,
  );
  if (!res.ok) return { ok: false, data: null, error: res.error };
  return {
    ok: true,
    data: (res.data?.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    error: null,
  };
}

/** POST a new customer-list audience (subtype CUSTOM, user-provided only). */
export async function createCustomAudience(
  token: string,
  accountId: string,
  name: string,
  description: string,
  doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<GraphResult<{ id: string }>> {
  const url = `${GRAPH}/${actPath(accountId)}/customaudiences`;
  const res = await graph<{ id?: string }>(
    token,
    url,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
        subtype: "CUSTOM",
        customer_file_source: "USER_PROVIDED_ONLY",
      }),
    },
    doFetch,
  );
  if (!res.ok || !res.data?.id) {
    return { ok: false, data: null, error: res.error ?? "no id in response" };
  }
  return { ok: true, data: { id: res.data.id }, error: null };
}

export interface UsersResult {
  ok: boolean;
  received: number;
  invalid: number;
  error: string | null;
}

/** POST (add) or DELETE (remove) hashed rows on an audience, one request per batch. */
export async function sendAudienceUsers(
  token: string,
  audienceId: string,
  op: "add" | "remove",
  rows: readonly string[],
  doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<UsersResult> {
  const out: UsersResult = { ok: true, received: 0, invalid: 0, error: null };
  for (const payload of audiencePayloads(rows)) {
    const res = await graph<{ num_received?: number; num_invalid_entries?: number }>(
      token,
      `${GRAPH}/${audienceId}/users`,
      { method: op === "add" ? "POST" : "DELETE", body: JSON.stringify({ payload }) },
      doFetch,
    );
    if (!res.ok) {
      out.ok = false;
      out.error = res.error;
      break;
    }
    out.received += res.data?.num_received ?? payload.data.length;
    out.invalid += res.data?.num_invalid_entries ?? 0;
  }
  return out;
}
