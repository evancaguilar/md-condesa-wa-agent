// Local dependency interfaces the cron engine codes against. Workstream C owns
// the concrete implementations (Slack attendance card, approval timeouts, control
// panel). Until C lands, index.ts (E) injects these; see docs/notes-d.md for the
// exact wiring E must apply.

import type { PendingApproval } from "../types.js";

/** Slack surface the cron needs (superset of SlackPort.postNote). */
export interface CronSlackDeps {
  /** Plain informational note to #wa-leads (budget report, sync FYIs). */
  postNote(text: string): Promise<void>;
  /** Post the "¿Llegó {name}?" Sí/No attendance card (C owns the buttons). */
  postAttendanceCheck(args: {
    phone: string;
    name: string;
    recordId: string;
  }): Promise<void>;
}

/** C's approval-timeout routine (holding line + expiry). */
export type RunApprovalTimeouts = (
  env: import("../types.js").Env,
  approvals: PendingApproval[],
) => Promise<void>;

/** C's idempotent control-panel ensure (pinned pause/resume card). */
export type EnsureControlPanel = (
  env: import("../types.js").Env,
) => Promise<void>;

/** Everything the dispatcher needs beyond queries/airtable. */
export interface CronDeps {
  slack: CronSlackDeps;
  runApprovalTimeouts: RunApprovalTimeouts;
  ensureControlPanel: EnsureControlPanel;
}
