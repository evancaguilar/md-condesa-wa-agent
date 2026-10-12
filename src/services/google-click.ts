// Pure. Google Ads click ids for WhatsApp leads — no I/O, no fetch.
//
// The site's js/attribution.js (md-condesa-site) remembers the latest Google
// click (gclid / gbraid / wbraid + time) and, when a visitor opens WhatsApp
// from the site, prefills the message with
//   "Hola, vi su anuncio en Google (kw: …) [ref gclid:<id>:<unix seconds>]"
// The campaign trigger is the leading phrase; this module pulls the bracketed
// ref back out so the pipeline can (1) strip it from the stored body — the
// brain, Slack and the dashboard never see it — and (2) keep the click in kv
// `gclick:<phone>` for lead-sync to write Leads.gclid / gclid_time.
//
// The Airtable booking forms receive the same two values as prefills, in the
// same shapes (gclidColumnValue / clickTimeIso), so both paths agree.

export type GoogleClickKind = "gclid" | "gbraid" | "wbraid";

export interface GoogleClick {
  kind: GoogleClickKind;
  id: string;
  /** Click time, unix seconds (the browser's clock when the ad was clicked). */
  ts: number;
}

/** Same id pattern the site validates before it appends the ref. */
const REF_RE = /\s*\[ref\s+(gclid|gbraid|wbraid):([A-Za-z0-9_-]{4,200}):(\d{9,11})\]/i;

/** kv key holding the contact's first captured Google click (JSON GoogleClick). */
export function googleClickKey(phone: string): string {
  return `gclick:${phone}`;
}

/**
 * Finds a Google click ref in an inbound body. Returns the click (null when
 * absent or malformed) and the body with the ref removed. A malformed ref is
 * left in the text untouched — never guess at a click id.
 */
export function parseGoogleClickRef(body: string): { click: GoogleClick | null; body: string } {
  const m = REF_RE.exec(body);
  if (!m) return { click: null, body };
  const ts = Number(m[3]);
  if (!Number.isSafeInteger(ts) || ts <= 0) return { click: null, body };
  const stripped = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
  return {
    click: { kind: m[1]!.toLowerCase() as GoogleClickKind, id: m[2]!, ts },
    body: stripped,
  };
}

/** Tolerant reader for the kv value; null on junk. */
export function parseStoredGoogleClick(raw: string | null | undefined): GoogleClick | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GoogleClick>;
    if (v.kind !== "gclid" && v.kind !== "gbraid" && v.kind !== "wbraid") return null;
    if (typeof v.id !== "string" || !v.id) return null;
    if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) return null;
    return { kind: v.kind, id: v.id, ts: v.ts };
  } catch {
    return null;
  }
}

/** Leads.gclid value: the raw gclid; gbraid/wbraid carry their kind ("gbraid:<id>"). */
export function gclidColumnValue(c: GoogleClick): string {
  return c.kind === "gclid" ? c.id : `${c.kind}:${c.id}`;
}

/**
 * Leads.gclid_time value: ISO 8601 with the CDMX offset, e.g.
 * "2026-10-12T14:03:22-06:00". Mexico City is UTC-6 all year (no DST since 2022).
 */
export function clickTimeIso(tsSec: number): string {
  return new Date((tsSec - 6 * 3600) * 1000).toISOString().slice(0, 19) + "-06:00";
}

/**
 * Pure. The Airtable booking forms can't be edited from code, so the site also
 * folds the click into the hidden `Ad` answer it already sends:
 *   "google | kw: … | ag: … | camp: … | gclid: <id> | t: <ISO>"
 * (the site strips "|" from every value, so splitting on it is safe). Returns
 * the Leads.gclid / gclid_time values, or null when `Ad` has no Google click
 * id. `time` is null for rows written before the site sent `t:`.
 */
export function googleClickFromAd(ad: string | null | undefined): { gclid: string; time: string | null } | null {
  if (!ad || !/^\s*google\b/i.test(ad)) return null;
  let gclid: string | null = null;
  let time: string | null = null;
  for (const part of ad.split("|")) {
    const m = /^\s*(gclid|gbraid|wbraid|t):\s*(\S+)\s*$/i.exec(part);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!;
    if (key === "t") {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(val)) time = val;
    } else if (!gclid && /^[A-Za-z0-9_-]{4,200}$/.test(val)) {
      gclid = key === "gclid" ? val : `${key}:${val}`;
    }
  }
  return gclid ? { gclid, time } : null;
}

// ---- short code (attribution.js v8+) ----
//
// A real gclid is ~100 characters, far too long to sit in a lead's WhatsApp
// message. Since v8 the site makes a 6-character code per Google click, POSTs
// {code, kind, id, ts} to the worker's /g endpoint when the click is captured
// (page load, not WhatsApp tap), and the prefill ends with just "[K7M2QX]".
// The worker keeps the click in kv `gref:<code>` and the inbound pipeline
// swaps the code for the click.

/** Code alphabet: no 0/O, 1/I/L — readable if someone retypes it. */
export const GOOGLE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const CODE_IN_BODY_RE = /\s*\[([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6})\]/;

/** kv key holding the click a site code stands for. */
export function googleRefKey(code: string): string {
  return `gref:${code}`;
}

/** Finds a "[K7M2QX]" code in an inbound body; returns it and the body without it. */
export function parseGoogleClickCode(body: string): { code: string | null; body: string } {
  const m = CODE_IN_BODY_RE.exec(body);
  if (!m) return { code: null, body };
  return { code: m[1]!, body: (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim() };
}

/** Max age of a click the beacon accepts / the cleanup keeps: Google's 90-day gclid life. */
export const GOOGLE_CLICK_TTL_SEC = 90 * 86400;

/**
 * Validates the site's beacon body: {"code","kind","id","ts"} with ts in ms
 * (Date.now()). Returns null on anything off — the endpoint is public, so
 * nothing loosely shaped is stored.
 */
export function parseGoogleClickBeacon(
  raw: string,
  nowSec: number,
): { code: string; click: GoogleClick } | null {
  if (!raw || raw.length > 1024) return null;
  let v: { code?: unknown; kind?: unknown; id?: unknown; ts?: unknown };
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  if (typeof v.code !== "string" || !CODE_RE.test(v.code)) return null;
  if (v.kind !== "gclid" && v.kind !== "gbraid" && v.kind !== "wbraid") return null;
  if (typeof v.id !== "string" || !/^[A-Za-z0-9_-]{4,200}$/.test(v.id)) return null;
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) return null;
  const ts = Math.floor(v.ts / 1000);
  if (ts > nowSec + 3600 || ts < nowSec - GOOGLE_CLICK_TTL_SEC) return null;
  return { code: v.code, click: { kind: v.kind, id: v.id, ts } };
}
