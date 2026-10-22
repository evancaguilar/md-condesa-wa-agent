import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpsLogQuery, parseOpsLogParams } from "../src/services/ops-log.js";
import { cdmxToEpoch, DAY } from "../src/cron/time.js";

const NOW = cdmxToEpoch(2026, 10, 22, 12, 0, 0);
const getter = (q: Record<string, string>) => (k: string): string | null => (k in q ? q[k]! : null);

test("ops-log params: defaults = last 7 days, limit 200, no level/kind/to/before", () => {
  const f = parseOpsLogParams(getter({}), NOW);
  assert.deepEqual(f, { from: NOW - 7 * DAY, limit: 200 });
});

test("ops-log params: valid level kept, invalid level ignored", () => {
  assert.equal(parseOpsLogParams(getter({ level: "warn" }), NOW).minLevel, "warn");
  assert.equal(parseOpsLogParams(getter({ level: "loud" }), NOW).minLevel, undefined);
  assert.equal(parseOpsLogParams(getter({ level: "" }), NOW).minLevel, undefined);
});

test("ops-log params: kind trimmed; empty kind dropped", () => {
  assert.equal(parseOpsLogParams(getter({ kind: " blast " }), NOW).kind, "blast");
  assert.equal(parseOpsLogParams(getter({ kind: "  " }), NOW).kind, undefined);
});

test("ops-log params: CDMX dates — from = local midnight, to = end of that day (exclusive)", () => {
  const f = parseOpsLogParams(getter({ from: "2026-10-01", to: "2026-10-03" }), NOW);
  assert.equal(f.from, cdmxToEpoch(2026, 10, 1, 0, 0, 0));
  assert.equal(f.to, cdmxToEpoch(2026, 10, 4, 0, 0, 0));
  // 2026-10-01 00:00 CDMX = 06:00 UTC
  assert.equal(new Date(f.from! * 1000).toISOString(), "2026-10-01T06:00:00.000Z");
});

test("ops-log params: unix seconds accepted as-is; garbage falls back to default", () => {
  const f = parseOpsLogParams(getter({ from: "1790000000", to: "1790086400" }), NOW);
  assert.equal(f.from, 1790000000);
  assert.equal(f.to, 1790086400);
  const g = parseOpsLogParams(getter({ from: "ayer", to: "2026-13-01" }), NOW);
  assert.equal(g.from, NOW - 7 * DAY);
  assert.equal(g.to, undefined);
});

test("ops-log params: before cursor must be a positive integer", () => {
  assert.equal(parseOpsLogParams(getter({ before: "1234" }), NOW).before, 1234);
  assert.equal(parseOpsLogParams(getter({ before: "0" }), NOW).before, undefined);
  assert.equal(parseOpsLogParams(getter({ before: "12.5" }), NOW).before, undefined);
  assert.equal(parseOpsLogParams(getter({ before: "x" }), NOW).before, undefined);
});

test("ops-log params: limit clamps to 1..500, default 200", () => {
  assert.equal(parseOpsLogParams(getter({ limit: "50" }), NOW).limit, 50);
  assert.equal(parseOpsLogParams(getter({ limit: "9999" }), NOW).limit, 500);
  assert.equal(parseOpsLogParams(getter({ limit: "0" }), NOW).limit, 200);
  assert.equal(parseOpsLogParams(getter({ limit: "nope" }), NOW).limit, 200);
});

test("ops-log params → query: full filter binds ts range, kind, levels, cursor", () => {
  const f = parseOpsLogParams(
    getter({ level: "error", kind: "blast", from: "2026-10-20", to: "2026-10-21", before: "99", limit: "10" }),
    NOW,
  );
  const { sql, params } = buildOpsLogQuery(f, NOW);
  assert.match(sql, /ts >= \?1 AND ts < \?2 AND kind = \?3 AND level IN \(\?4, \?5\) AND id < \?6/);
  assert.match(sql, /ORDER BY id DESC LIMIT 10$/);
  assert.deepEqual(params, [
    cdmxToEpoch(2026, 10, 20),
    cdmxToEpoch(2026, 10, 22),
    "blast",
    "error",
    "critical",
    99,
  ]);
});
