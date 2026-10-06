import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeQueue,
  buildStatusLine,
  shouldPing,
  buildPingText,
  PING_AFTER_SECONDS,
  PING_COOLDOWN_SECONDS,
} from "../src/services/status-line.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import type { PendingApproval } from "../src/types.js";

const NOW = cdmxToEpoch(2026, 10, 6, 15, 40, 0);
function row(id: number, ageSec: number, draft = "hola", status: PendingApproval["status"] = "pending"): PendingApproval {
  return {
    id,
    phone: `52155${id}`,
    draft,
    context: null,
    confidence: "low",
    slack_ts: null,
    status,
    holding_sent: 0,
    created_at: NOW - ageSec,
    resolved_at: null,
    final_text: null,
  };
}

test("summarizeQueue: drafts vs draft-less escalations, oldest age, pending only", () => {
  const q = summarizeQueue(
    [row(1, 120), row(2, 2700, ""), row(3, 60, "x", "approved"), row(4, 900)],
    NOW,
  );
  assert.deepEqual(q, { drafts: 2, escalations: 1, oldestAgeSec: 2700 });
  assert.deepEqual(summarizeQueue([], NOW), { drafts: 0, escalations: 0, oldestAgeSec: null });
});

test("buildStatusLine: empty, singular/plural, ⚠️ past 30 min, CDMX stamp", () => {
  assert.equal(
    buildStatusLine({ drafts: 0, escalations: 0, oldestAgeSec: null }, NOW),
    "📋 *Cola de #wa-leads* — vacía ✅ · actualizado 15:40",
  );
  assert.equal(
    buildStatusLine({ drafts: 1, escalations: 0, oldestAgeSec: 5 * 60 }, NOW),
    "📋 *Cola de #wa-leads* — 1 respuesta por aprobar · la más antigua lleva 5 min · actualizado 15:40",
  );
  assert.equal(
    buildStatusLine({ drafts: 3, escalations: 2, oldestAgeSec: 95 * 60 }, NOW),
    "📋 *Cola de #wa-leads* — 3 respuestas por aprobar · 2 escalaciones sin atender · la más antigua lleva 1 h 35 min ⚠️ · actualizado 15:40",
  );
});

test("shouldPing: only past the threshold, once per cooldown", () => {
  const young = { drafts: 2, escalations: 0, oldestAgeSec: PING_AFTER_SECONDS - 1 };
  const old = { drafts: 2, escalations: 0, oldestAgeSec: PING_AFTER_SECONDS };
  assert.equal(shouldPing(young, null, NOW), false);
  assert.equal(shouldPing(old, null, NOW), true);
  assert.equal(shouldPing(old, NOW - PING_COOLDOWN_SECONDS + 1, NOW), false);
  assert.equal(shouldPing(old, NOW - PING_COOLDOWN_SECONDS, NOW), true);
  assert.equal(shouldPing({ drafts: 0, escalations: 0, oldestAgeSec: null }, null, NOW), false);
  assert.match(buildPingText(old), /^<!here> ⏳ 2 pendientes en Aprobar sin revisar — la más antigua lleva 30 min/);
  assert.match(buildPingText({ drafts: 1, escalations: 0, oldestAgeSec: 1800 }), /1 pendiente en/);
});

test("channelFor: ops falls back to the task channel until SLACK_CHANNEL_OPS_ID is set", async () => {
  const { channelFor } = await import("../src/services/slack.js");
  assert.equal(channelFor({ SLACK_CHANNEL_ID: "CTASK" }, "task"), "CTASK");
  assert.equal(channelFor({ SLACK_CHANNEL_ID: "CTASK" }, "ops"), "CTASK");
  assert.equal(channelFor({ SLACK_CHANNEL_ID: "CTASK", SLACK_CHANNEL_OPS_ID: "COPS" }, "ops"), "COPS");
  assert.equal(channelFor({ SLACK_CHANNEL_ID: "CTASK", SLACK_CHANNEL_OPS_ID: "COPS" }, "task"), "CTASK");
});
