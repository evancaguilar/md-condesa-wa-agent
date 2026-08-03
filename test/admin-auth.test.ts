import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authenticateLogin,
  buildSetCookie,
  decideLoginRateLimit,
  hashPassword,
  isValidUsername,
  newSaltHex,
  parseCookies,
  recordFailedLogin,
  RL_MAX_FAILS,
  signAdminCookieV2,
  timingSafeEqual,
  verifyAdminCookieV2,
  verifyPassword,
  type AdminUserRow,
} from "../src/routes/admin-auth.js";

const SECRET = "test_admin_secret";
const NOW = 1_700_000_000; // fixed clock (seconds)

function cookieHeader(value: string): string {
  return `md_admin=${value}`;
}

// ---- v2 cookie sign / verify round-trip ----

test("signAdminCookieV2 / verifyAdminCookieV2 round-trip a valid cookie", async () => {
  const value = await signAdminCookieV2(SECRET, "fer", NOW + 3600);
  assert.ok(
    /^v2\.fer\.\d+\.[0-9a-f]{64}$/.test(value),
    "value is v2.<user>.<exp>.<hexhmac>",
  );
  const session = await verifyAdminCookieV2(SECRET, cookieHeader(value), NOW);
  assert.deepEqual(session, { user: "fer" });
});

test("verifyAdminCookieV2 rejects a tampered username segment", async () => {
  const value = await signAdminCookieV2(SECRET, "fer", NOW + 3600);
  const forged = value.replace(".fer.", ".evan.");
  assert.equal(await verifyAdminCookieV2(SECRET, cookieHeader(forged), NOW), null);
});

test("verifyAdminCookieV2 rejects a tampered signature", async () => {
  const value = await signAdminCookieV2(SECRET, "vale", NOW + 3600);
  const last = value.slice(-1);
  const tampered = value.slice(0, -1) + (last === "0" ? "1" : "0");
  assert.equal(await verifyAdminCookieV2(SECRET, cookieHeader(tampered), NOW), null);
});

test("verifyAdminCookieV2 rejects a tampered expiry", async () => {
  const value = await signAdminCookieV2(SECRET, "evan", NOW + 3600);
  const parts = value.split(".");
  parts[2] = String(NOW + 999_999);
  assert.equal(
    await verifyAdminCookieV2(SECRET, cookieHeader(parts.join(".")), NOW),
    null,
  );
});

test("verifyAdminCookieV2 rejects an expired cookie", async () => {
  const value = await signAdminCookieV2(SECRET, "evan", NOW - 10);
  assert.equal(await verifyAdminCookieV2(SECRET, cookieHeader(value), NOW), null);
});

test("verifyAdminCookieV2 rejects the wrong secret", async () => {
  const value = await signAdminCookieV2("other_secret", "evan", NOW + 3600);
  assert.equal(await verifyAdminCookieV2(SECRET, cookieHeader(value), NOW), null);
});

test("verifyAdminCookieV2 rejects legacy v1 and malformed values", async () => {
  // Legacy v1 format: <exp>.<mac>
  assert.equal(
    await verifyAdminCookieV2(SECRET, cookieHeader(`${NOW + 3600}.deadbeef`), NOW),
    null,
  );
  assert.equal(await verifyAdminCookieV2(SECRET, null, NOW), null);
  assert.equal(await verifyAdminCookieV2(SECRET, "", NOW), null);
  assert.equal(await verifyAdminCookieV2(SECRET, "md_admin=garbage", NOW), null);
  assert.equal(
    await verifyAdminCookieV2(SECRET, "md_admin=v2.evan.123", NOW),
    null,
  );
  assert.equal(
    await verifyAdminCookieV2(SECRET, "md_admin=v3.evan.123.abc", NOW),
    null,
  );
  // Invalid username charset (dot split makes this structurally off anyway).
  assert.equal(
    await verifyAdminCookieV2(SECRET, "md_admin=v2.EVAN.123.abc", NOW),
    null,
  );
});

// ---- usernames ----

test("isValidUsername charset and length rules", () => {
  assert.equal(isValidUsername("evan"), true);
  assert.equal(isValidUsername("fer-2"), true);
  assert.equal(isValidUsername("vale_g"), true);
  assert.equal(isValidUsername(""), false);
  assert.equal(isValidUsername("Evan"), false); // uppercase
  assert.equal(isValidUsername("with.dot"), false); // dots break the cookie format
  assert.equal(isValidUsername("con espacio"), false);
  assert.equal(isValidUsername("a".repeat(33)), false);
});

// ---- password hashing ----

test("hashPassword is deterministic per salt and differs across salts", async () => {
  const h1 = await hashPassword("hunter22", "aabbccdd", 1000);
  const h2 = await hashPassword("hunter22", "aabbccdd", 1000);
  const h3 = await hashPassword("hunter22", "ddccbbaa", 1000);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.ok(/^[0-9a-f]{64}$/.test(h1), "32-byte hex output");
});

test("verifyPassword accepts the right password and rejects the wrong one", async () => {
  const salt = newSaltHex();
  assert.ok(/^[0-9a-f]{32}$/.test(salt), "16-byte hex salt");
  const hash = await hashPassword("segura123", salt);
  assert.equal(await verifyPassword("segura123", salt, hash), true);
  assert.equal(await verifyPassword("segura124", salt, hash), false);
});

test("newSaltHex produces distinct salts", () => {
  assert.notEqual(newSaltHex(), newSaltHex());
});

// ---- authenticateLogin decision matrix ----

async function makeRow(
  username: string,
  password: string,
  over: Partial<AdminUserRow> = {},
): Promise<AdminUserRow> {
  const salt = newSaltHex();
  return {
    username,
    display_name: username,
    pass_salt: salt,
    pass_hash: await hashPassword(password, salt),
    role: "staff",
    disabled: 0,
    ...over,
  };
}

test("authenticateLogin: enabled row + right password wins", async () => {
  const row = await makeRow("fer", "pw-de-fer1");
  const d = await authenticateLogin({
    username: "fer",
    password: "pw-de-fer1",
    userRow: row,
    masterMatches: false,
  });
  assert.deepEqual(d, { ok: true, user: "fer", role: "staff" });
});

test("authenticateLogin: wrong password fails", async () => {
  const row = await makeRow("fer", "pw-de-fer1");
  const d = await authenticateLogin({
    username: "fer",
    password: "nope",
    userRow: row,
    masterMatches: false,
  });
  assert.deepEqual(d, { ok: false });
});

test("authenticateLogin: disabled row fails even with master password", async () => {
  const row = await makeRow("fer", "pw-de-fer1", { disabled: 1 });
  const d = await authenticateLogin({
    username: "fer",
    password: "whatever",
    userRow: row,
    masterMatches: true, // master pw provided — must NOT grant fer
  });
  assert.deepEqual(d, { ok: false });
});

test("authenticateLogin: master + empty username → evan/owner (break-glass)", async () => {
  const d = await authenticateLogin({
    username: "",
    password: "the-master",
    userRow: null,
    masterMatches: true,
  });
  assert.deepEqual(d, { ok: true, user: "evan", role: "owner" });
});

test("authenticateLogin: master + username evan → evan/owner even if row pw wrong", async () => {
  const row = await makeRow("evan", "evans-own-pw", { role: "owner" });
  const d = await authenticateLogin({
    username: "evan",
    password: "the-master", // not evan's row password
    userRow: row,
    masterMatches: true,
  });
  assert.deepEqual(d, { ok: true, user: "evan", role: "owner" });
});

test("authenticateLogin: master CANNOT impersonate other staff", async () => {
  const d = await authenticateLogin({
    username: "fer",
    password: "the-master",
    userRow: null, // fer row missing (pre-migration)
    masterMatches: true,
  });
  assert.deepEqual(d, { ok: false });
});

test("authenticateLogin: unknown username without master fails", async () => {
  const d = await authenticateLogin({
    username: "mallory",
    password: "x",
    userRow: null,
    masterMatches: false,
  });
  assert.deepEqual(d, { ok: false });
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
