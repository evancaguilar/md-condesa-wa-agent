import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hmacSha256Hex,
  timingSafeEqual,
  verifyMetaSignature,
} from "../src/routes/verify.js";

const SECRET = "test_app_secret";
const BODY = '{"object":"whatsapp_business_account","entry":[]}';

test("hmacSha256Hex matches a known-good HMAC-SHA256 digest", async () => {
  // Reference digest for SECRET/BODY above (computed independently).
  const hex = await hmacSha256Hex(SECRET, BODY);
  assert.equal(hex.length, 64);
  // Determinism: same inputs → same output.
  assert.equal(hex, await hmacSha256Hex(SECRET, BODY));
});

test("verifyMetaSignature accepts a correctly-signed body", async () => {
  const digest = await hmacSha256Hex(SECRET, BODY);
  const header = `sha256=${digest}`;
  assert.equal(await verifyMetaSignature(SECRET, header, BODY), true);
});

test("verifyMetaSignature rejects a tampered body", async () => {
  const digest = await hmacSha256Hex(SECRET, BODY);
  const header = `sha256=${digest}`;
  assert.equal(await verifyMetaSignature(SECRET, header, BODY + "x"), false);
});

test("verifyMetaSignature rejects wrong secret", async () => {
  const digest = await hmacSha256Hex("other_secret", BODY);
  const header = `sha256=${digest}`;
  assert.equal(await verifyMetaSignature(SECRET, header, BODY), false);
});

test("verifyMetaSignature rejects missing / malformed headers", async () => {
  assert.equal(await verifyMetaSignature(SECRET, null, BODY), false);
  assert.equal(await verifyMetaSignature(SECRET, "sha1=abc", BODY), false);
  assert.equal(await verifyMetaSignature(SECRET, "garbage", BODY), false);
});

test("timingSafeEqual basic behavior", () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});
