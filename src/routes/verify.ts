// Pure, dependency-free HMAC-SHA256 verification for Meta's X-Hub-Signature-256.
// Uses WebCrypto (available in Workers and Node v24), no Worker-only globals, so
// it is unit-testable under `node --test`.

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** Constant-time compare of two byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/** HMAC-SHA256 of `body` keyed by `secret`, returned as lowercase hex. */
export async function hmacSha256Hex(
  secret: string,
  body: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Verifies Meta's `X-Hub-Signature-256` header (format: `sha256=<hex>`) against
 * the raw request body. Constant-time comparison.
 */
export async function verifyMetaSignature(
  secret: string,
  header: string | null,
  body: string,
): Promise<boolean> {
  if (!header) return false;
  const [scheme, provided] = header.split("=", 2);
  if (scheme !== "sha256" || !provided) return false;
  const expected = await hmacSha256Hex(secret, body);
  return timingSafeEqual(hexToBytes(expected), hexToBytes(provided));
}
