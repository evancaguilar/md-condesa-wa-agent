// Local dependency interfaces the cron engine codes against. Workstream C owns
// the concrete implementations (Slack attendance card, approval timeouts, control
// panel). Until C lands, index.ts (E) injects these; see docs/notes-d.md for the
// exact wiring E must apply.

import type { NoteOpts, PendingApproval } from "../types.js";
import type { UnansweredRow } from "./redrive.js";

/** Slack surface the cron needs (superset of SlackPort.postNote). */
export interface CronSlackDeps {
  /** Mechanical note → D1 ops_log (NOT Slack); level "critical" also posts
   *  one line to #evan-alerts. services/slack.ts postNote. */
  postNote(text: string, opts?: NoteOpts): Promise<void>;
  /** Needs Evan → #evan-alerts. Optional: callers use alertNote(). */
  postAlert?(text: string, opts?: Omit<NoteOpts, "level">): Promise<void>;
  /** Plain note to the TASK channel (#wa-leads) — a human must act. Optional:
   *  callers fall back to postNote (see taskNote()). */
  postTaskNote?(text: string): Promise<void>;
  /** Post the "¿Llegó {name}?" Sí/No attendance card (C owns the buttons). */
  postAttendanceCheck(args: {
    phone: string;
    name: string;
    recordId: string;
  }): Promise<void>;
  /**
   * "Asistió y no se inscribió" card with the 🙋 Yo le escribo button
   * (src/cron/post-trial.ts). A plain task note carries the same words but no
   * button, and the button is the whole point — so the real wiring (index.ts)
   * always provides this. OPTIONAL on purpose: the console-logging stubs and
   * the dozens of one-line fakes in test/ stay one-liners, and a caller without
   * it degrades to a plain #wa-leads note (taskNote) instead of failing to compile.
   */
  postPostTrialCard?(args: { phone: string; name: string }): Promise<void>;
}

/** What the Airtable result watcher needs from Slack. */
export type ResultSlackDeps = Pick<CronSlackDeps, "postNote" | "postPostTrialCard" | "postTaskNote">;

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
/** Task-channel note with the postNote fallback for fakes/stubs. */
export function taskNote(slack: Pick<CronSlackDeps, "postNote" | "postTaskNote">, text: string): Promise<void> {
  return slack.postTaskNote ? slack.postTaskNote(text) : slack.postNote(text);
}

/** #evan-alerts note; fakes/stubs without postAlert log a warn row instead. */
export function alertNote(
  slack: Pick<CronSlackDeps, "postNote" | "postAlert">,
  text: string,
  opts: Omit<NoteOpts, "level"> = {},
): Promise<void> {
  return slack.postAlert ? slack.postAlert(text, opts) : slack.postNote(text, { ...opts, level: "warn" });
}

export interface CronDeps {
  /** #wa-leads scoreboard, edited in place every tick (services/status-line.ts). */
  ensureStatusLine?(env: import("../types.js").Env, pending: PendingApproval[], nowSec: number): Promise<void>;
  /**
   * Outage redrive (src/cron/redrive.ts): run one forced-review brain turn for
   * a lead whose last message went unanswered. Wired in index.ts from
   * pipeline/inbound.runBrainTurn; absent ⇒ the redrive is skipped.
   */
  redriveTurn?(row: UnansweredRow, nowSec: number): Promise<void>;
  /**
   * Missed-turn rescue (src/cron/missed-turns.ts): re-run a live turn that died
   * without replying. Wired in index.ts; absent ⇒ the rescue is skipped.
   */
  rescueTurn?(row: UnansweredRow, nowSec: number): Promise<void>;
  /** Human override v2 (pipeline/inbound.runOverrideChecks); absent ⇒ skipped. */
  overrideChecks?(nowSec: number): Promise<unknown>;
  slack: CronSlackDeps;
  runApprovalTimeouts: RunApprovalTimeouts;
  ensureControlPanel: EnsureControlPanel;
}
