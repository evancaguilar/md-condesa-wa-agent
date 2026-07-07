import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSetCookie,
  decideLoginRateLimit,
  parseCookies,
  recordFailedLogin,
  RL_MAX_FAILS,
  signAdminCookie,
  timingSafeEqual,
  verifyAdminCookie,
} from "../src/routes/admin-auth.js";

const SECRET = "test_admin_secret";
const NOW = 1_700_000_000; // fixed clock (seconds)

function cookieHeader(value: string): string {
  return `md_admin=${value}`;
}

// ---- cookie sign / verify round-trip ----

test("signAdminCookie / verifyAdminCookie round-trip a valid, unexpired cookie", async () => {
  const exp = NOW + 3600;
  const value = await signAdminCookie(SECRET, exp);
  assert.ok(/^\d+\.[0-9a-f]{64}$/.test(value), "value is <exp>.<hexhmac>");
  assert.equal(await verifyAdminCookie(SECRET, cookieHeader(value), NOW), true);
});

test("verifyAdminCookie rejects a tampered signature", async () => {
  const exp = NOW + 3600;
  const value = await signAdminCookie(SECRET, exp);
  const [expPart, mac] = value.split(".");
  // Flip the last hex nibble of the MAC.
  const lastChar = mac!.slice(-1);
  const flipped = lastChar === "0" ? "1" : "0";
  const tampered = `${expPart}.${mac!.slice(0, -1)}${flipped}`;
  assert.equal(await verifyAdminCookie(SECRET, cookieHeader(tampered), NOW), false);
});

test("verifyAdminCookie rejects a tampered expiry (exp not covered by sig)", async () => {
  const exp = NOW + 3600;
  const value = await signAdminCookie(SECRET, exp);
  const [, mac] = value.split(".");
  // Keep a valid-looking MAC but swap in a far-future exp; sig won't match.
  const forged = `${NOW + 999999}.${mac}`;
  assert.equal(await verifyAdminCookie(SECRET, cookieHeader(forged), NOW), false);
});

test("verifyAdminCookie rejects an expired cookie", async () => {
  const exp = NOW - 10; // already expired
  const value = await signAdminCookie(SECRET, exp);
  // Signature is valid but exp <= now ⇒ reject.
  assert.equal(await verifyAdminCookie(SECRET, cookieHeader(value), NOW), false);
});

test("verifyAdminCookie rejects a cookie signed with the wrong secret", async () => {
  const exp = NOW + 3600;
  const value = await signAdminCookie("other_secret", exp);
  assert.equal(await verifyAdminCookie(SECRET, cookieHeader(value), NOW), false);
});

test("verifyAdminCookie rejects missing / malformed cookies", async () => {
  assert.equal(await verifyAdminCookie(SECRET, null, NOW), false);
  assert.equal(await verifyAdminCookie(SECRET, "", NOW), false);
  assert.equal(await verifyAdminCookie(SECRET, "other=1", NOW), false);
  assert.equal(await verifyAdminCookie(SECRET, "md_admin=garbage", NOW), false);
  assert.equal(await verifyAdminCookie(SECRET, "md_admin=123", NOW), false);
  assert.equal(await verifyAdminCookie(SECRET, "md_admin=.abc", NOW), false);
});

// ---- parseCookies ----

test("parseCookies parses a multi-cookie header, trimming whitespace", () => {
  const parsed = parseCookies("a=1; md_admin=exp.sig ;  b=hello");
  assert.equal(parsed.a, "1");
  assert.equal(parsed.md_admin, "exp.sig");
  assert.equal(parsed.b, "hello");
});

test("parseCookies handles null / empty / junk gracefully", () => {
  assert.deepEqual(parseCookies(null), {});
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("noequalshere"), {});
  // Values may contain '=' (base64/hmac) — only the first '=' splits.
  assert.equal(parseCookies("x=a=b=c").x, "a=b=c");
});

// ---- buildSetCookie ----

test("buildSetCookie sets HttpOnly, Secure, SameSite=Lax, Path=/admin", () => {
  const c = buildSetCookie("val123", 3600);
  assert.ok(c.startsWith("md_admin=val123; "));
  assert.ok(c.includes("Max-Age=3600"));
  assert.ok(c.includes("Path=/admin"));
  assert.ok(c.includes("HttpOnly"));
  assert.ok(c.includes("Secure"));
  assert.ok(c.includes("SameSite=Lax"));
});

test("buildSetCookie with maxAge 0 expires the cookie (logout)", () => {
  assert.ok(buildSetCookie("", 0).includes("Max-Age=0"));
});

// ---- login rate limit: 5 fails / 15 min sliding window ----

test("decideLoginRateLimit allows a fresh IP with no prior fails", () => {
  const d = decideLoginRateLimit(null, NOW);
  assert.equal(d.blocked, false);
  assert.equal(d.remaining, RL_MAX_FAILS);
});

test("decideLoginRateLimit blocks after 5 failures inside the window", () => {
  // Simulate 5 consecutive failed logins, threading the state.
  let state: string | null = null;
  for (let i = 0; i < RL_MAX_FAILS; i++) {
    const before = decideLoginRateLimit(state, NOW);
    assert.equal(before.blocked, false, `attempt ${i + 1} should not be blocked yet`);
    state = recordFailedLogin(state, NOW);
  }
  const after = decideLoginRateLimit(state, NOW);
  assert.equal(after.blocked, true);
  assert.equal(after.remaining, 0);
});

test("decideLoginRateLimit prunes failures older than the 15-min window", () => {
  // 5 fails 20 minutes ago (outside the window) ⇒ not blocked now.
  let state: string | null = null;
  const old = NOW - 20 * 60;
  for (let i = 0; i < RL_MAX_FAILS; i++) state = recordFailedLogin(state, old);
  const d = decideLoginRateLimit(state, NOW);
  assert.equal(d.blocked, false);
  assert.equal(d.remaining, RL_MAX_FAILS);
});

test("decideLoginRateLimit counts only in-window failures when mixed old/new", () => {
  let state: string | null = null;
  const old = NOW - 20 * 60; // pruned
  for (let i = 0; i < 4; i++) state = recordFailedLogin(state, old);
  // 4 recent fails ⇒ still one attempt left.
  for (let i = 0; i < 4; i++) state = recordFailedLogin(state, NOW);
  const d = decideLoginRateLimit(state, NOW);
  assert.equal(d.blocked, false);
  assert.equal(d.remaining, 1);
  const blocked = decideLoginRateLimit(recordFailedLogin(state, NOW), NOW);
  assert.equal(blocked.blocked, true);
});

test("decideLoginRateLimit tolerates corrupt state json", () => {
  const d = decideLoginRateLimit("{not valid json", NOW);
  assert.equal(d.blocked, false);
  assert.equal(d.remaining, RL_MAX_FAILS);
});

// ---- constant-time compare ----

test("timingSafeEqual basic behavior", () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});
