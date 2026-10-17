// Pure expiry rules for blast runs (src/services/blast-expiry.ts), fake CDMX clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultExpiresAt, expiredRuns, resolveExpiresAt, runExpired } from "../src/services/blast-expiry.js";
import { cdmxToEpoch } from "../src/cron/time.js";

const FRI_1625 = cdmxToEpoch(2026, 10, 16, 16, 25, 0);
const FRI_2100 = cdmxToEpoch(2026, 10, 16, 21, 0, 0);
const SAT_2100 = cdmxToEpoch(2026, 10, 17, 21, 0, 0);

test("defaultExpiresAt: 21:00 CDMX of the day the run starts sending", () => {
  assert.equal(defaultExpiresAt(FRI_1625), FRI_2100);
  // Queued at 07:30 → first send 09:00 same day → same day 21:00.
  assert.equal(defaultExpiresAt(cdmxToEpoch(2026, 10, 16, 7, 30, 0)), FRI_2100);
  // Queued at 21:30 → first send tomorrow 09:00 → tomorrow 21:00.
  assert.equal(defaultExpiresAt(cdmxToEpoch(2026, 10, 16, 21, 30, 0)), SAT_2100);
  // Scheduled for a future day → that day's 21:00.
  assert.equal(defaultExpiresAt(cdmxToEpoch(2026, 10, 17, 10, 0, 0)), SAT_2100);
});

test("resolveExpiresAt: omitted → default; null/0 → never; explicit epoch kept; past rejected", () => {
  assert.deepEqual(resolveExpiresAt(undefined, FRI_1625, FRI_1625), { ok: true, expiresAt: FRI_2100, defaulted: true });
  assert.deepEqual(resolveExpiresAt(null, FRI_1625, FRI_1625), { ok: true, expiresAt: null, defaulted: false });
  assert.deepEqual(resolveExpiresAt(0, FRI_1625, FRI_1625), { ok: true, expiresAt: null, defaulted: false });
  assert.deepEqual(resolveExpiresAt(SAT_2100, FRI_1625, FRI_1625), { ok: true, expiresAt: SAT_2100, defaulted: false });
  assert.deepEqual(resolveExpiresAt(String(SAT_2100), FRI_1625, FRI_1625), { ok: true, expiresAt: SAT_2100, defaulted: false });
  assert.equal(resolveExpiresAt(FRI_1625 - 60, FRI_1625, FRI_1625).ok, false);
  assert.equal(resolveExpiresAt("mañana", FRI_1625, FRI_1625).ok, false);
  // Must be after the scheduled start.
  const startSat = cdmxToEpoch(2026, 10, 17, 10, 0, 0);
  assert.equal(resolveExpiresAt(FRI_2100, FRI_1625, startSat).ok, false);
});

test("runExpired / expiredRuns: fires at the boundary, never for null, skips terminal runs", () => {
  assert.equal(runExpired(FRI_2100, FRI_2100 - 1), false);
  assert.equal(runExpired(FRI_2100, FRI_2100), true);
  assert.equal(runExpired(null, SAT_2100), false);
  assert.equal(runExpired(undefined, SAT_2100), false);
  const metas = [
    { id: "a", status: "active", expiresAt: FRI_2100 },
    { id: "b", status: "paused", expiresAt: FRI_2100 },
    { id: "c", status: "active", expiresAt: null },
    { id: "d", status: "done", expiresAt: FRI_2100 },
    { id: "e", status: "active", expiresAt: SAT_2100 },
  ];
  assert.deepEqual(expiredRuns(metas, FRI_2100 + 300).map((m) => m.id), ["a", "b"]);
  assert.deepEqual(expiredRuns(metas, FRI_1625).map((m) => m.id), []);
});
