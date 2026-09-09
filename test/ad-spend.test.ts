import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKFILL_CHUNK_DAYS,
  addDays,
  dailyPullWindow,
  nextBackfillChunk,
  shouldRunDailyPull,
} from "../src/cron/ad-spend.js";
import { cdmxToEpoch } from "../src/cron/time.js";

test("dailyPullWindow = [today-3, today] in CDMX (crossing UTC midnight)", () => {
  // 2026-09-09 23:30 CDMX is 2026-09-10 05:30 UTC — the window must stay on CDMX dates.
  const w = dailyPullWindow(cdmxToEpoch(2026, 9, 9, 23, 30, 0));
  assert.deepEqual(w, { since: "2026-09-06", until: "2026-09-09" });
  assert.deepEqual(dailyPullWindow(cdmxToEpoch(2026, 9, 2, 5, 40, 0), 3), { since: "2026-08-30", until: "2026-09-02" });
});

test("shouldRunDailyPull: 05:30–06:59 window only", () => {
  assert.equal(shouldRunDailyPull({ hour: 5, minute: 25 }), false);
  assert.equal(shouldRunDailyPull({ hour: 5, minute: 30 }), true);
  assert.equal(shouldRunDailyPull({ hour: 6, minute: 59 }), true);
  assert.equal(shouldRunDailyPull({ hour: 7, minute: 0 }), false);
  assert.equal(shouldRunDailyPull({ hour: 4, minute: 59 }), false);
});

test("addDays crosses month/year ends", () => {
  assert.equal(addDays("2026-08-30", 3), "2026-09-02");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
});

test("nextBackfillChunk walks 7-day windows from since to yesterday, then null", () => {
  const today = "2026-09-09";
  assert.deepEqual(nextBackfillChunk(null, "2026-07-01", today), {
    since: "2026-07-01",
    until: "2026-07-07",
    next: "2026-07-08",
  });
  assert.deepEqual(nextBackfillChunk("2026-09-03", "2026-07-01", today), {
    since: "2026-09-03",
    until: "2026-09-08",
    next: null,
  });
  // cursor already past yesterday → done
  assert.equal(nextBackfillChunk("2026-09-09", "2026-07-01", today), null);
  // a stale cursor before `since` is ignored
  assert.equal(nextBackfillChunk("2026-01-01", "2026-07-01", today)!.since, "2026-07-01");
  // since == yesterday → one single-day chunk, then done
  assert.deepEqual(nextBackfillChunk(null, "2026-09-08", today), { since: "2026-09-08", until: "2026-09-08", next: null });
  assert.equal(nextBackfillChunk(null, "2026-09-09", today), null);
  // the cron uses 2-day chunks (BACKFILL_CHUNK_DAYS)
  assert.deepEqual(nextBackfillChunk(null, "2026-07-01", today, BACKFILL_CHUNK_DAYS), {
    since: "2026-07-01",
    until: "2026-07-02",
    next: "2026-07-03",
  });
  assert.equal(BACKFILL_CHUNK_DAYS, 2);
});
