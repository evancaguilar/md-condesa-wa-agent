// The #wa-leads scoreboard (docs/slack-channels-review.md, Evan 2026-10-06):
// ONE message near the top of the task channel, edited in place every cron
// tick, instead of a "⏳ lleva rato pendiente" ping per ageing card. It pings
// <!here> once when the oldest open item crosses PING_AFTER_SECONDS, and not
// again for PING_COOLDOWN_SECONDS. Pure text + decision here; Slack and kv
// plumbing in services/slack.ts (ensureStatusLine).

import type { PendingApproval } from "../types.js";
import { cdmxParts } from "../cron/time.js";

export const PING_AFTER_SECONDS = 30 * 60;
export const PING_COOLDOWN_SECONDS = 60 * 60;
export const KV_STATUS_LINE_TS = "status_line_ts";
export const KV_STATUS_LINE_PING_AT = "status_line_ping_at";

export interface QueueSummary {
  drafts: number;
  escalations: number;
  oldestAgeSec: number | null;
}

/** Escalations are the draft-less rows (pipeline/inbound.queueEscalation). */
export function summarizeQueue(pending: PendingApproval[], nowSec: number): QueueSummary {
  let drafts = 0;
  let escalations = 0;
  let oldest: number | null = null;
  for (const a of pending) {
    if (a.status !== "pending") continue;
    if (a.draft && a.draft.trim()) drafts++;
    else escalations++;
    const age = nowSec - a.created_at;
    if (oldest === null || age > oldest) oldest = age;
  }
  return { drafts, escalations, oldestAgeSec: oldest };
}

function hhmm(nowSec: number): string {
  const p = cdmxParts(nowSec);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function minutes(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

/** The one-line scoreboard. */
export function buildStatusLine(q: QueueSummary, nowSec: number): string {
  const stamp = `actualizado ${hhmm(nowSec)}`;
  if (q.drafts + q.escalations === 0) {
    return `📋 *Cola de #wa-leads* — vacía ✅ · ${stamp}`;
  }
  const parts: string[] = [];
  if (q.drafts) parts.push(`${q.drafts} respuesta${q.drafts === 1 ? "" : "s"} por aprobar`);
  if (q.escalations) parts.push(`${q.escalations} escalaci${q.escalations === 1 ? "ón" : "ones"} sin atender`);
  if (q.oldestAgeSec !== null) {
    const late = q.oldestAgeSec >= PING_AFTER_SECONDS ? " ⚠️" : "";
    parts.push(`la más antigua lleva ${minutes(q.oldestAgeSec)}${late}`);
  }
  return `📋 *Cola de #wa-leads* — ${parts.join(" · ")} · ${stamp}`;
}

/** <!here> once per cooldown while something has waited past the threshold. */
export function shouldPing(q: QueueSummary, lastPingSec: number | null, nowSec: number): boolean {
  if (q.oldestAgeSec === null || q.oldestAgeSec < PING_AFTER_SECONDS) return false;
  if (lastPingSec !== null && nowSec - lastPingSec < PING_COOLDOWN_SECONDS) return false;
  return true;
}

export function buildPingText(q: QueueSummary): string {
  const n = q.drafts + q.escalations;
  const oldest = q.oldestAgeSec === null ? "" : ` — la más antigua lleva ${minutes(q.oldestAgeSec)}`;
  return `<!here> ⏳ ${n} pendiente${n === 1 ? "" : "s"} en Aprobar sin revisar${oldest}. ¿Las revisamos?`;
}
