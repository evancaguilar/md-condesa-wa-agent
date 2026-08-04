import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoModeActive,
  autoModeEndLabel,
  nextAutoModeEnd,
} from "../src/services/auto-mode.js";
import { cdmxParts, cdmxToEpoch } from "../src/cron/time.js";

test("nextAutoModeEnd: arming at 22:00 CDMX ends tomorrow 07:00", () => {
  const now = cdmxToEpoch(2026, 8, 4, 22, 0, 0);
  const end = nextAutoModeEnd(now);
  const p = cdmxParts(end);
  assert.deepEqual([p.day, p.hour, p.minute], [5, 7, 0]);
});

test("nextAutoModeEnd: arming at 06:30 CDMX ends today 07:00", () => {
  const now = cdmxToEpoch(2026, 8, 4, 6, 30, 0);
  const p = cdmxParts(nextAutoModeEnd(now));
  assert.deepEqual([p.day, p.hour], [4, 7]);
});

test("nextAutoModeEnd: arming exactly at 07:00 rolls to tomorrow (never a zero-length window)", () => {
  const now = cdmxToEpoch(2026, 8, 4, 7, 0, 0);
  const p = cdmxParts(nextAutoModeEnd(now));
  assert.deepEqual([p.day, p.hour], [5, 7]);
});

test("nextAutoModeEnd: month rollover (Aug 31 22:00 → Sep 1 07:00)", () => {
  const now = cdmxToEpoch(2026, 8, 31, 22, 0, 0);
  const p = cdmxParts(nextAutoModeEnd(now));
  assert.deepEqual([p.month, p.day, p.hour], [9, 1, 7]);
});

test("autoModeActive: active before the stored epoch, lapsed at/after it", () => {
  assert.equal(autoModeActive("1000", 999), true);
  assert.equal(autoModeActive("1000", 1000), false);
  assert.equal(autoModeActive("1000", 1001), false);
});

test("autoModeActive: null/garbage kv values are inert", () => {
  assert.equal(autoModeActive(null, 0), false);
  assert.equal(autoModeActive("", 0), false);
  assert.equal(autoModeActive("mañana", 0), false);
});

test("autoModeEndLabel renders CDMX HH:MM", () => {
  const end = cdmxToEpoch(2026, 8, 5, 7, 0, 0);
  assert.equal(autoModeEndLabel(end), "07:00");
});
