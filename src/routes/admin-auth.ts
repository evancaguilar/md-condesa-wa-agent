// Pure, dependency-free auth primitives for the /admin dashboard: a signed
// session cookie (HMAC-SHA256 over `admin:<exp>`), cookie parsing/building, and
// a sliding-window login rate limiter. WebCrypto + plain arithmetic only, no
// Worker-only globals, so it is unit-testable under `node --test`.
//
// The constant-time compare mirrors timingSafeEqual from routes/verify.ts.

const COOKIE_NAME = "md_admin";

// ---- constant-time compare (same convention as routes/verify.ts) ----

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
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

// ---- signed session cookie ----

/**
 * Signs a session cookie value. The payload is the expiry epoch (seconds); the
 * signature is HMAC-SHA256 over `admin:<exp>`. Value format: `<exp>.<hexhmac>`.
 */
export async function signAdminCookie(
  secret: string,
  expEpoch: number,
): Promise<string> {
  const exp = String(Math.floor(expEpoch));
  const mac = await hmacSha256Hex(secret, `admin:${exp}`);
  return `${exp}.${mac}`;
}

/**
 * Verifies the `md_admin` cookie from a Cookie header. Returns true only when
 * the signature is valid (constant-time) AND the expiry is still in the future
 * relative to `now` (seconds). Any parse/format problem ⇒ false.
 */
export async function verifyAdminCookie(
  secret: string,
  cookieHeader: string | null,
  now: number,
): Promise<boolean> {
  const cookies = parseCookies(cookieHeader);
  const value = cookies[COOKIE_NAME];
  if (!value) return false;

  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expStr = value.slice(0, dot);
  const providedMac = value.slice(dot + 1);
  if (!/^\d+$/.test(expStr) || !providedMac) return false;

  const exp = parseInt(expStr, 10);
  const expectedMac = await hmacSha256Hex(secret, `admin:${expStr}`);
  // Constant-time compare of the signatures first (don't leak validity via the
  // expiry short-circuit), then the freshness check.
  const macOk = timingSafeEqual(hexToBytes(expectedMac), hexToBytes(providedMac));
  if (!macOk) return false;
  return exp > now;
}

/** Parses a Cookie header into a name→value map. Tolerant of stray whitespace. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name) out[name] = val;
  }
  return out;
}

/**
 * Builds a Set-Cookie header for the admin session. HttpOnly + Secure +
 * SameSite=Lax, scoped to Path=/admin. `maxAge` is seconds; pass 0 to expire
 * the cookie immediately (logout).
 */
export function buildSetCookie(value: string, maxAge: number): string {
  return (
    `${COOKIE_NAME}=${value}; Max-Age=${Math.floor(maxAge)}; ` +
    `Path=/admin; HttpOnly; Secure; SameSite=Lax`
  );
}

// ---- login rate limiting (5 fails / 15 min sliding window) ----

export const RL_MAX_FAILS = 5;
export const RL_WINDOW_SECONDS = 15 * 60;

interface RateLimitState {
  fails: number[]; // epoch-second timestamps of recent failed attempts
}

export interface RateLimitDecision {
  /** true ⇒ block this login attempt (429). */
  blocked: boolean;
  /** Serialized state to persist back to kv (`admin_rl:<ip>`). */
  stateJson: string;
  /** Failures remaining before block (informational). */
  remaining: number;
}

function parseState(stateJson: string | null): RateLimitState {
  if (!stateJson) return { fails: [] };
  try {
    const parsed = JSON.parse(stateJson) as Partial<RateLimitState>;
    const fails = Array.isArray(parsed.fails)
      ? parsed.fails.filter((n): n is number => typeof n === "number")
      : [];
    return { fails };
  } catch {
    return { fails: [] };
  }
}

/**
 * Decides whether a login attempt is rate-limited. Prunes attempts older than
 * the 15-minute window, then blocks when ≥5 remain. This is called BEFORE a
 * login attempt; the route records a new failure timestamp (see recordFailure)
 * only when the password is wrong. `decideLoginRateLimit` itself is read-only
 * on the fail list — it just prunes and reports.
 */
export function decideLoginRateLimit(
  stateJson: string | null,
  now: number,
): RateLimitDecision {
  const cutoff = now - RL_WINDOW_SECONDS;
  const state = parseState(stateJson);
  const fails = state.fails.filter((t) => t > cutoff);
  const blocked = fails.length >= RL_MAX_FAILS;
  return {
    blocked,
    stateJson: JSON.stringify({ fails }),
    remaining: Math.max(0, RL_MAX_FAILS - fails.length),
  };
}

/**
 * Records a failed login at `now` and returns the pruned+appended state to
 * persist. Kept separate from the decision so the route can: check → attempt →
 * on failure, record.
 */
export function recordFailedLogin(stateJson: string | null, now: number): string {
  const cutoff = now - RL_WINDOW_SECONDS;
  const state = parseState(stateJson);
  const fails = state.fails.filter((t) => t > cutoff);
  fails.push(now);
  return JSON.stringify({ fails });
}
