import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyInfraError,
  reportInfraError,
  resetInfraAlertMemoryForTests,
  INFRA_ALERT_THROTTLE_SECONDS,
} from "../src/services/infra-alert.js";


// The exact text D1 returned on 2026-10-06 (Workers Observability).
const D1_OVERLOADED = new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");

test("classify: D1 overload, D1 generic, Anthropic, Meta 5xx; ordinary bugs are null", () => {
  assert.equal(classifyInfraError(D1_OVERLOADED)?.kind, "d1_overloaded");
  assert.equal(classifyInfraError(new Error("D1_ERROR: no such table: foo"))?.kind, "d1_error");
  assert.equal(
    classifyInfraError(new Error("anthropic HTTP 400: credit balance is too low"))?.kind,
    "anthropic",
  );
  assert.equal(classifyInfraError(new Error("anthropic HTTP 529: overloaded"))?.kind, "anthropic");
  assert.equal(
    classifyInfraError(new Error("WA send failed (503) [0]: Service Unavailable"))?.kind,
    "meta_api",
  );
  // A Meta 400 (bad parameter) is a data bug on one send, not an outage.
  assert.equal(
    classifyInfraError(new Error("WA send failed (400) [131009]: Parameter value is not valid")),
    null,
  );
  assert.equal(classifyInfraError(new TypeError("Cannot read properties of undefined")), null);
  assert.equal(classifyInfraError("string error"), null);
  assert.equal(classifyInfraError(undefined), null);
});

test("classify: detail is single-line and capped", () => {
  const c = classifyInfraError(new Error("D1_ERROR:   D1 DB is overloaded.\n\n" + "x".repeat(500)));
  assert.ok(c);
  assert.ok(!c!.detail.includes("\n"));
  assert.ok(c!.detail.length <= 180);
});

test("report: posts once per kind per window via the kv claim, quiet in between", async () => {
  resetInfraAlertMemoryForTests();
  const posts: string[] = [];
  const claims: Array<[string, number, number]> = [];
  let won = true;
  const deps = {
    postNote: async (t: string) => {
      posts.push(t);
    },
    kvClaim: async (k: string, n: number, a: number) => {
      claims.push([k, n, a]);
      return won;
    },
  };
  assert.equal(await reportInfraError(deps, "webhook inbound", D1_OVERLOADED, 1000), "d1_overloaded");
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /<!here> 🛑 \*La base de datos \(D1\) está saturada\*/);
  assert.match(posts[0]!, /webhook inbound/);
  assert.match(posts[0]!, /Requests queued for too long/);
  assert.match(posts[0]!, /Query insights/);
  assert.doesNotMatch(posts[0]!, /puede repetirse/);
  assert.deepEqual(claims[0], ["infra_alert:d1_overloaded", 1000, INFRA_ALERT_THROTTLE_SECONDS]);

  // Same kind inside the window: memory gate, no kv round-trip, no post.
  assert.equal(await reportInfraError(deps, "cron runDueFollowups", D1_OVERLOADED, 1000 + 60), null);
  assert.equal(claims.length, 1);
  assert.equal(posts.length, 1);

  // Window elapsed, but another isolate already won the kv slot: stay quiet.
  won = false;
  assert.equal(
    await reportInfraError(deps, "webhook inbound", D1_OVERLOADED, 1000 + INFRA_ALERT_THROTTLE_SECONDS),
    null,
  );
  assert.equal(claims.length, 2);
  assert.equal(posts.length, 1);

  // A different kind is its own throttle.
  won = true;
  assert.equal(
    await reportInfraError(deps, "cron x", new Error("anthropic HTTP 500: boom"), 1000 + 60),
    "anthropic",
  );
  assert.equal(posts.length, 2);
});

test("report: when kv (D1) itself throws, the alarm still goes out on the memory gate", async () => {
  resetInfraAlertMemoryForTests();
  const posts: string[] = [];
  const deps = {
    postNote: async (t: string) => {
      posts.push(t);
    },
    kvClaim: async () => {
      throw D1_OVERLOADED;
    },
  };
  assert.equal(await reportInfraError(deps, "webhook inbound", D1_OVERLOADED, 5000), "d1_overloaded");
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /puede repetirse/);
  // Still throttled per isolate.
  assert.equal(await reportInfraError(deps, "webhook inbound", D1_OVERLOADED, 5000 + 120), null);
  assert.equal(posts.length, 1);
  // ...and fires again after the window.
  assert.equal(
    await reportInfraError(deps, "webhook inbound", D1_OVERLOADED, 5000 + INFRA_ALERT_THROTTLE_SECONDS),
    "d1_overloaded",
  );
  assert.equal(posts.length, 2);
});

test("report: ordinary errors never post, never claim; a Slack failure never throws", async () => {
  resetInfraAlertMemoryForTests();
  let claimed = 0;
  const deps = {
    postNote: async () => {
      throw new Error("slack down");
    },
    kvClaim: async () => {
      claimed++;
      return true;
    },
  };
  assert.equal(await reportInfraError(deps, "cron x", new Error("TypeError: oops"), 1), null);
  assert.equal(claimed, 0);
  // Infra error + Slack down: swallowed, reports null.
  assert.equal(await reportInfraError(deps, "cron x", D1_OVERLOADED, 1), null);
  assert.equal(claimed, 1);
});

test("report: works without a kv claim (no deps.kvClaim) on the memory gate alone", async () => {
  resetInfraAlertMemoryForTests();
  const posts: string[] = [];
  const deps = { postNote: async (t: string) => void posts.push(t) };
  assert.equal(await reportInfraError(deps, "admin", D1_OVERLOADED, 10), "d1_overloaded");
  assert.equal(await reportInfraError(deps, "admin", D1_OVERLOADED, 20), null);
  assert.equal(posts.length, 1);
});

test("report: when kv throws, the colo-wide Cache API gate coordinates isolates", async () => {
  resetInfraAlertMemoryForTests();
  const posts: string[] = [];
  const stored = new Map<string, number>();
  const fakeCache = {
    async match(key: string) {
      return stored.has(key) ? "hit" : undefined;
    },
    async put(key: string, res: unknown) {
      const headers = (res as { headers: { get(n: string): string | null } }).headers;
      stored.set(key, Number(/max-age=(\d+)/.exec(headers.get("Cache-Control") ?? "")?.[1]));
    },
  };
  (globalThis as { caches?: unknown }).caches = { default: fakeCache };
  try {
    const deps = {
      postNote: async (t: string) => void posts.push(t),
      kvClaim: async () => {
        throw D1_OVERLOADED;
      },
    };
    // Isolate 1 wins the cache window and posts (no "puede repetirse" caveat).
    assert.equal(await reportInfraError(deps, "webhook inbound", D1_OVERLOADED, 100), "d1_overloaded");
    assert.equal(posts.length, 1);
    assert.doesNotMatch(posts[0]!, /puede repetirse/);
    assert.equal(stored.get("https://infra-alert.internal/d1_overloaded"), INFRA_ALERT_THROTTLE_SECONDS);
    // Isolate 2 (fresh memory) sees the cache entry and stays quiet.
    resetInfraAlertMemoryForTests();
    assert.equal(await reportInfraError(deps, "admin", D1_OVERLOADED, 200), null);
    assert.equal(posts.length, 1);
    // A different kind has its own cache key.
    assert.equal(await reportInfraError(deps, "cron x", new Error("anthropic HTTP 529: x"), 200), "anthropic");
    assert.equal(posts.length, 2);
  } finally {
    delete (globalThis as { caches?: unknown }).caches;
  }
});
