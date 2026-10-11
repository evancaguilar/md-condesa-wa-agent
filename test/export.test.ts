import { test } from "node:test";
import assert from "node:assert/strict";
import { clampExportWindow, EXPORT_MAX_SPAN_SECONDS } from "../src/db/export.js";
import { chunkForSlack } from "../src/cron/nightly-audit.js";

const NOW = 1_800_000_000;

test("clampExportWindow: since required, until defaults to now, span capped at 7 days", () => {
  assert.equal(clampExportWindow(null, null, NOW), null);
  assert.equal(clampExportWindow("abc", null, NOW), null);
  assert.deepEqual(clampExportWindow(String(NOW - 3600), null, NOW), {
    since: NOW - 3600,
    until: NOW,
  });
  // 30 days back → only the last 7 are returned.
  const w = clampExportWindow(String(NOW - 30 * 86400), null, NOW)!;
  assert.equal(w.until - w.since, EXPORT_MAX_SPAN_SECONDS);
  // explicit until wins when after since
  assert.deepEqual(clampExportWindow("100", "200", NOW), { since: 100, until: 200 });
  // until before since is ignored (falls back to now)
  assert.deepEqual(clampExportWindow(String(NOW - 300), String(NOW - 400), NOW), {
    since: NOW - 300,
    until: NOW,
  });
});

test("nightly audit chunks stay under Slack's 3,000-char section limit", () => {
  const line = "x".repeat(199) + "\n";
  const chunks = chunkForSlack(line.repeat(60));
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.length < 3000, `chunk of ${c.length} chars`);
});
