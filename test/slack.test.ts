import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideTimeout,
  hmacSha256Hex,
  isBusinessHours,
  parseInteractionPayload,
  timingSafeEqual,
  verifySlackSignature,
  windowHoursLeft,
  type TimeoutApprovalView,
} from "../src/services/slack-timeouts.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

// ---- signature verification ----

test("verifySlackSignature accepts a correctly-signed request (known-good HMAC)", async () => {
  const ts = "1531420618";
  const body = "token=xyz&team_id=T1";
  const digest = await hmacSha256Hex(SIGNING_SECRET, `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body,
    nowSec: parseInt(ts, 10), // clock at request time → within window
  });
  assert.equal(ok, true);
});

test("verifySlackSignature rejects a tampered body", async () => {
  const ts = "1531420618";
  const body = "token=xyz";
  const digest = await hmacSha256Hex(SIGNING_SECRET, `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body + "&tamper=1",
    nowSec: parseInt(ts, 10),
  });
  assert.equal(ok, false);
});

test("verifySlackSignature rejects wrong secret", async () => {
  const ts = "1531420618";
  const body = "token=xyz";
  const digest = await hmacSha256Hex("other-secret", `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body,
    nowSec: parseInt(ts, 10),
  });
  assert.equal(ok, false);
});

test("verifySlackSignature rejects a stale timestamp (replay window)", async () => {
  const ts = "1531420618";
  const body = "token=xyz";
  const digest = await hmacSha256Hex(SIGNING_SECRET, `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body,
    nowSec: parseInt(ts, 10) + 301, // just outside the 300s window
  });
  assert.equal(ok, false);
});

test("verifySlackSignature rejects missing / malformed headers", async () => {
  assert.equal(
    await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: null,
      timestamp: "1531420618",
      rawBody: "x",
    }),
    false,
  );
  assert.equal(
    await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: "v1=abc",
      timestamp: "1531420618",
      rawBody: "x",
      nowSec: 1531420618,
    }),
    false,
  );
});

test("timingSafeEqual basic behavior", () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});

// ---- payload parsing ----

test("parseInteractionPayload: block_actions approve button", () => {
  const payload = {
    type: "block_actions",
    trigger_id: "trg123",
    actions: [{ action_id: "approve|42", value: "approve|42" }],
  };
  const parsed = parseInteractionPayload(
    "payload=" + encodeURIComponent(JSON.stringify(payload)),
  );
  assert.equal(parsed.kind, "block_actions");
  assert.equal(parsed.triggerId, "trg123");
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].verb, "approve");
  assert.equal(parsed.actions[0].arg, "42");
});

test("parseInteractionPayload: overflow menu resolves selected_option.value", () => {
  const payload = {
    type: "block_actions",
    trigger_id: "trg1",
    actions: [
      {
        action_id: "overflow|7",
        selected_option: { value: "mark_student|7" },
      },
    ],
  };
  const parsed = parseInteractionPayload(JSON.stringify(payload));
  assert.equal(parsed.actions[0].verb, "mark_student");
  assert.equal(parsed.actions[0].arg, "7");
});

test("parseInteractionPayload: view_submission extracts input + private_metadata", () => {
  const payload = {
    type: "view_submission",
    view: {
      private_metadata: "42",
      state: {
        values: {
          edit_block: { edit_input: { value: "texto editado" } },
        },
      },
    },
  };
  const parsed = parseInteractionPayload(JSON.stringify(payload));
  assert.equal(parsed.kind, "view_submission");
  assert.equal(parsed.privateMetadata, "42");
  assert.equal(parsed.firstInputValue, "texto editado");
  assert.equal(parsed.viewValues.edit_block.edit_input, "texto editado");
});

test("parseInteractionPayload: form-encoded '+' decodes to spaces (edited replies)", () => {
  const payload = {
    type: "view_submission",
    view: {
      private_metadata: "42",
      state: {
        values: {
          edit_block: { edit_input: { value: "hola, nos vemos mañana a las 7 + calentamiento" } },
        },
      },
    },
  };
  // Slack sends application/x-www-form-urlencoded: spaces become "+",
  // literal "+" becomes %2B (encodeURIComponent already does the latter).
  const body =
    "payload=" +
    encodeURIComponent(JSON.stringify(payload)).replace(/%20/g, "+");
  const parsed = parseInteractionPayload(body);
  assert.equal(parsed.firstInputValue, "hola, nos vemos mañana a las 7 + calentamiento");
});

test("parseInteractionPayload: bot_pause action has null arg", () => {
  const payload = { type: "block_actions", actions: [{ action_id: "bot_pause" }] };
  const parsed = parseInteractionPayload(JSON.stringify(payload));
  assert.equal(parsed.actions[0].verb, "bot_pause");
  assert.equal(parsed.actions[0].arg, null);
});

test("parseInteractionPayload: garbage → unknown", () => {
  assert.equal(parseInteractionPayload("not json").kind, "unknown");
});

// ---- business hours ----

test("isBusinessHours: 09:00 open, 21:00 closed (CDMX)", () => {
  // 2026-07-06 is UTC-6 (no DST in Mexico). 15:00Z == 09:00 CDMX.
  const nineAm = Date.parse("2026-07-06T15:00:00Z") / 1000; // 09:00 CDMX
  const eightAm = Date.parse("2026-07-06T14:00:00Z") / 1000; // 08:00 CDMX
  const ninePm = Date.parse("2026-07-07T03:00:00Z") / 1000; // 21:00 CDMX
  const eightPm = Date.parse("2026-07-07T02:00:00Z") / 1000; // 20:00 CDMX
  assert.equal(isBusinessHours(nineAm), true);
  assert.equal(isBusinessHours(eightAm), false);
  assert.equal(isBusinessHours(ninePm), false); // 21:00 exclusive
  assert.equal(isBusinessHours(eightPm), true);
});

// ---- timeout decision logic ----

const baseView = (over: Partial<TimeoutApprovalView>): TimeoutApprovalView => ({
  id: 1,
  phone: "5215500000000",
  createdAt: 0,
  holdingSent: false,
  lastInboundAt: 0,
  ...over,
});

test("decideTimeout: >10min in business hours & window open ⇒ hold", () => {
  const now = Date.parse("2026-07-06T16:00:00Z") / 1000; // 10:00 CDMX
  const view = baseView({ createdAt: now - 11 * 60, lastInboundAt: now - 60 });
  const d = decideTimeout(view, now);
  assert.equal(d.kind, "hold");
});

test("decideTimeout: holding already sent ⇒ none", () => {
  const now = Date.parse("2026-07-06T16:00:00Z") / 1000;
  const view = baseView({
    createdAt: now - 11 * 60,
    lastInboundAt: now - 60,
    holdingSent: true,
  });
  assert.equal(decideTimeout(view, now).kind, "none");
});

test("decideTimeout: outside business hours ⇒ none (not yet expired)", () => {
  const now = Date.parse("2026-07-06T08:00:00Z") / 1000; // 02:00 CDMX
  const view = baseView({ createdAt: now - 30 * 60, lastInboundAt: now - 60 });
  assert.equal(decideTimeout(view, now).kind, "none");
});

test("decideTimeout: window closed ⇒ no hold", () => {
  const now = Date.parse("2026-07-06T16:00:00Z") / 1000;
  const view = baseView({
    createdAt: now - 11 * 60,
    lastInboundAt: now - 25 * 3600, // window closed
  });
  assert.equal(decideTimeout(view, now).kind, "none");
});

test("decideTimeout: >12h ⇒ expire, windowClosed reflects window state", () => {
  const now = Date.parse("2026-07-06T16:00:00Z") / 1000;
  const open = baseView({ createdAt: now - 13 * 3600, lastInboundAt: now - 60 });
  const d1 = decideTimeout(open, now);
  assert.equal(d1.kind, "expire");
  assert.equal(d1.kind === "expire" && d1.windowClosed, false);

  const closed = baseView({
    createdAt: now - 13 * 3600,
    lastInboundAt: now - 25 * 3600,
  });
  const d2 = decideTimeout(closed, now);
  assert.equal(d2.kind, "expire");
  assert.equal(d2.kind === "expire" && d2.windowClosed, true);
});

test("windowHoursLeft: rounds up, floors at 0", () => {
  const now = 1_000_000;
  assert.equal(windowHoursLeft(now - 1 * 3600, now), 23);
  assert.equal(windowHoursLeft(now - 23.2 * 3600, now), 1);
  assert.equal(windowHoursLeft(now - 25 * 3600, now), 0);
  assert.equal(windowHoursLeft(null, now), 0);
});
