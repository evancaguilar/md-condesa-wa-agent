// Pure, dependency-free auth primitives for the /admin dashboard: a signed
// per-user session cookie (v2: HMAC-SHA256 over `admin:v2:<user>:<exp>`),
// PBKDF2 password hashing for staff accounts, cookie parsing/building, the
// pure login decision, and a sliding-window login rate limiter. WebCrypto +
// plain arithmetic only, no Worker-only globals, so it is unit-testable under
// `node --test`.
//
// The constant-time compare mirrors timingSafeEqual from routes/verify.ts.

const COOKIE_NAME = "md_admin";

/** PBKDF2 iteration count — Cloudflare Workers caps PBKDF2 at exactly 100k. */
export const PBKDF2_ITERATIONS = 100_000;

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

// ---- usernames ----

/**
 * Valid staff usernames: lowercase alphanumerics plus `_`/`-`, 1–32 chars.
 * Dots are deliberately excluded — the cookie value is dot-delimited.
 */
export function isValidUsername(u: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(u);
}

// ---- password hashing (PBKDF2-SHA256, WebCrypto only) ----

/** 16 random bytes as lowercase hex — a fresh per-user password salt. */
export function newSaltHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * PBKDF2-SHA256(password, salt, 100k) → 32-byte lowercase hex. The salt is the
 * hex string's raw bytes (encoded as UTF-8) — stable and portable across
 * Workers and Node without extra decoding.
 */
export async function hashPassword(
  password: string,
  saltHex: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(saltHex), iterations },
    key,
    256,
  );
  const bytes = new Uint8Array(bits);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time verify of a password against a stored salt+hash pair. */
export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHashHex: string,
): Promise<boolean> {
  const got = await hashPassword(password, saltHex);
  return timingSafeEqual(hexToBytes(got), hexToBytes(expectedHashHex));
}

// ---- pure login decision ----

/** Shape of an admin_users row as the login/auth paths need it. */
export interface AdminUserRow {
  username: string;
  display_name: string;
  pass_salt: string;
  pass_hash: string;
  role: string; // 'owner' | 'staff'
  disabled: number; // 0|1
}

export type LoginDecision =
  | { ok: true; user: string; role: string }
  | { ok: false };

/**
 * The whole login policy, pure. Rules:
 * - A present, enabled user row authenticates by PBKDF2 password.
 * - The master password (ADMIN_PASSWORD) authenticates ONLY the empty username
 *   or "evan" — the permanent break-glass — and yields evan/owner. It can
 *   never impersonate other staff, and a disabled non-evan row stays locked
 *   out even with the master password.
 * `masterMatches` is computed by the caller (route) so this stays sync-free of
 * env access; pass the result of the timing-safe compare.
 */
export async function authenticateLogin(input: {
  username: string; // already trimmed + lowercased; "" = legacy login
  password: string;
  userRow: AdminUserRow | null;
  masterMatches: boolean;
}): Promise<LoginDecision> {
  const { username, password, userRow, masterMatches } = input;

  if (userRow && !userRow.disabled) {
    const ok = await verifyPassword(password, userRow.pass_salt, userRow.pass_hash);
    if (ok) return { ok: true, user: userRow.username, role: userRow.role };
  }

  // Break-glass: master password logs in as evan/owner only.
  if (masterMatches && (username === "" || username === "evan")) {
    return { ok: true, user: "evan", role: "owner" };
  }

  return { ok: false };
}

// ---- signed session cookie (v2: carries the username) ----

/**
 * Signs a v2 session cookie. Value format:
 * `v2.<user>.<exp>.<hexhmac>` where the MAC is HMAC-SHA256 over
 * `admin:v2:<user>:<exp>`, keyed by ADMIN_PASSWORD. Legacy (v1) cookies are
 * rejected by the verifier — one forced re-login at rollout.
 */
export async function signAdminCookieV2(
  secret: string,
  user: string,
  expEpoch: number,
): Promise<string> {
  const exp = String(Math.floor(expEpoch));
  const mac = await hmacSha256Hex(secret, `admin:v2:${user}:${exp}`);
  return `v2.${user}.${exp}.${mac}`;
}

/**
 * Verifies the `md_admin` v2 cookie. Returns `{user}` only when the format is
 * v2, the username charset is valid, the signature matches (constant-time,
 * checked before freshness so validity isn't leaked via the expiry
 * short-circuit) AND the expiry is in the future. Anything else ⇒ null.
 */
export async function verifyAdminCookieV2(
  secret: string,
  cookieHeader: string | null,
  now: number,
): Promise<{ user: string } | null> {
  const cookies = parseCookies(cookieHeader);
  const value = cookies[COOKIE_NAME];
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [ver, user, expStr, providedMac] = parts as [string, string, string, string];
  if (ver !== "v2" || !isValidUsername(user)) return null;
  if (!/^\d+$/.test(expStr) || !providedMac) return null;

  const exp = parseInt(expStr, 10);
  const expectedMac = await hmacSha256Hex(secret, `admin:v2:${user}:${expStr}`);
  const macOk = timingSafeEqual(hexToBytes(expectedMac), hexToBytes(providedMac));
  if (!macOk) return null;
  return exp > now ? { user } : null;
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
