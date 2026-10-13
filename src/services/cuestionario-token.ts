// Signed links for the pre-trial questionnaire (docs/cuestionario.md).
//
// Token: `v1.<payloadB64>.<sigB64>` where
//   payloadB64 = base64url(JSON {r: <Airtable record id>, v: <version>, e: <unix exp sec>})
//   sigB64     = base64url(first 16 bytes of HMAC-SHA256(secret, payloadB64))
//
// The site page (md-condesa-site /cuestionario/) never decodes it — it only
// forwards `?t=` to this Worker — so the format is ours to evolve under a new
// "v2." prefix. Pure (WebCrypto + a caller-supplied clock): unit-tested with a
// fixed secret and a fixed `now`.

import { timingSafeEqual } from "../routes/admin-auth.js";

export type CuestionarioVersion = "adultos" | "kids" | "bfc";

export const CUESTIONARIO_VERSIONS: readonly CuestionarioVersion[] = ["adultos", "kids", "bfc"];

/** Links stay valid this long after they are issued. */
export const TOKEN_TTL_SEC = 14 * 86400;

const SIG_BYTES = 16;

export interface TokenClaims {
  recordId: string;
  version: CuestionarioVersion;
  /** Unix seconds. */
  exp: number;
}

export type VerifyResult = TokenClaims | { error: "invalid" | "expired" };

export function isCuestionarioVersion(v: unknown): v is CuestionarioVersion {
  return typeof v === "string" && (CUESTIONARIO_VERSIONS as readonly string[]).includes(v);
}

// ---- base64url over bytes (no btoa/atob: keeps the test build shim-free) ----

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

/** null on any character outside the url-safe alphabet or an impossible length. */
export function b64urlDecode(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** ASCII-only string ↔ bytes. The payload is ASCII by construction (rec ids,
 *  version words, digits); anything else fails verification. */
function asciiBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToAscii(b: Uint8Array): string | null {
  let s = "";
  for (const x of b) {
    if (x > 0x7e) return null;
    s += String.fromCharCode(x);
  }
  return s;
}

async function signPart(secret: string, payloadB64: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    asciiBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, asciiBytes(payloadB64)));
  return mac.slice(0, SIG_BYTES);
}

/** Issue a token for a Leads record. `nowSec` defaults to the wall clock. */
export async function signToken(
  secret: string,
  claims: { recordId: string; version: CuestionarioVersion },
  nowSec: number = Math.floor(Date.now() / 1000),
  ttlSec: number = TOKEN_TTL_SEC,
): Promise<string> {
  const payload = JSON.stringify({ r: claims.recordId, v: claims.version, e: nowSec + ttlSec });
  const payloadB64 = b64urlEncode(asciiBytes(payload));
  const sig = b64urlEncode(await signPart(secret, payloadB64));
  return `v1.${payloadB64}.${sig}`;
}

/**
 * Check a token. Signature first (constant-time), then shape, then expiry —
 * so a forged token always reads "invalid", never leaks "expired".
 */
export async function verifyToken(
  secret: string,
  token: string | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const invalid = { error: "invalid" as const };
  if (!secret || typeof token !== "string" || token.length > 512) return invalid;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return invalid;
  const payloadB64 = parts[1]!;
  const got = b64urlDecode(parts[2]!);
  if (!payloadB64 || !got) return invalid;
  // Canonical encoding only: the last base64url char carries spare bits, so
  // several strings decode to the same 16 bytes. Accepting only the one we
  // issue keeps tokenId() (the rate-limit key) one-per-token.
  if (b64urlEncode(got) !== parts[2]) return invalid;
  const want = await signPart(secret, payloadB64);
  if (!timingSafeEqual(got, want)) return invalid;

  const raw = b64urlDecode(payloadB64);
  const json = raw ? bytesToAscii(raw) : null;
  if (!json) return invalid;
  let p: { r?: unknown; v?: unknown; e?: unknown };
  try {
    p = JSON.parse(json) as typeof p;
  } catch {
    return invalid;
  }
  if (!p || typeof p !== "object") return invalid;
  if (typeof p.r !== "string" || !/^rec[A-Za-z0-9]{14}$/.test(p.r)) return invalid;
  if (!isCuestionarioVersion(p.v)) return invalid;
  if (typeof p.e !== "number" || !Number.isFinite(p.e)) return invalid;
  if (p.e <= nowSec) return { error: "expired" };
  return { recordId: p.r, version: p.v, exp: p.e };
}

/** The signature part — a stable per-token id for rate-limit keys (never the
 *  secret). Canonical by construction once verifyToken accepted the token. */
export function tokenId(token: string): string {
  return token.split(".")[2] ?? "";
}
