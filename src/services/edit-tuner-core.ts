// Pure core of the edit tuner: gate decision, prompt formatting, kv record
// shapes, and the orchestration loop with ALL I/O injected. No Worker globals,
// no text-module imports — unit-testable under `node --test` (the Env-bound
// wiring, model call, and Slack cards live in ./edit-tuner.ts).

import type { Env } from "../types.js";
import type { EditRow } from "../db/queries-admin.js";
import type { Proposal } from "./kb-editor.js";
import { cdmxDateStr } from "../cron/time.js";

// ---- constants ------------------------------------------------------------

const DAY = 86400;
/** Minimum new edits since the watermark before an analysis is worth running. */
export const MIN_NEW_EDITS = 5;
/** Cost cap: at most this many (most recent) edits per analysis. */
export const MAX_EDITS_PER_RUN = 30;
/** Weekly-ish: 6.5 days (not 7.0) so second-scale drift can't skip a day. */
export const MIN_RUN_INTERVAL_S = Math.floor(6.5 * DAY);
/** Per-side (draft/final) truncation in the analysis prompt. */
export const EDIT_SIDE_MAX_CHARS = 600;

export const KV_WATERMARK = "edit_tuner_watermark";
export const KV_LAST_RUN = "edit_tuner_last_run";

// ---- kv records -----------------------------------------------------------

export interface TuningRecord {
  proposal: Proposal;
  status: "pending" | "applied" | "discarded";
  createdAt: number;
  /** Slack ts of this proposal's card (null until posted). */
  slackTs: string | null;
}

/** kv key for one proposal of one run. Safe as a Slack action arg (no pipes). */
export function tuningKey(runEpoch: number, n: number): string {
  return `tuning_proposal:${runEpoch}:${n}`;
}

/** The matching at-most-once apply-claim key. */
export function claimKeyFor(proposalKey: string): string {
  return proposalKey.replace(/^tuning_proposal:/, "tuning_claim:");
}

/** Tolerant parse of a stored TuningRecord; null on malformed/missing JSON. */
export function parseTuningRecord(json: string | null): TuningRecord | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as TuningRecord;
    if (!v || typeof v !== "object" || !v.proposal || typeof v.status !== "string") {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

// ---- pure gate ------------------------------------------------------------

export type TuningGate =
  | { run: true }
  | { run: false; reason: "too_soon" | "few_edits" };

/** Whether the tuner should run now: interval elapsed AND enough new edits. */
export function decideTuningRun(i: {
  nowEpoch: number;
  lastRunEpoch: number | null;
  newEditCount: number;
}): TuningGate {
  if (i.lastRunEpoch !== null && i.nowEpoch - i.lastRunEpoch < MIN_RUN_INTERVAL_S) {
    return { run: false, reason: "too_soon" };
  }
  if (i.newEditCount < MIN_NEW_EDITS) return { run: false, reason: "few_edits" };
  return { run: true };
}

// ---- prompt assembly (pure) -----------------------------------------------

/** One edit pair as prompt text. Phones deliberately excluded (irrelevant). */
export function formatEditsForAnalysis(edits: EditRow[]): string {
  return edits
    .map((e, i) => {
      const when = cdmxDateStr(e.ts);
      return [
        `### Edición ${i + 1} — ${when}`,
        "BORRADOR DEL BOT:",
        truncateSide(e.draft),
        "VERSIÓN FINAL DEL DUEÑO:",
        truncateSide(e.final),
      ].join("\n");
    })
    .join("\n\n");
}

function truncateSide(s: string): string {
  return s.length <= EDIT_SIDE_MAX_CHARS
    ? s
    : `${s.slice(0, EDIT_SIDE_MAX_CHARS - 1)}…`;
}

// ---- orchestration (I/O injected) -----------------------------------------

export interface TuningAnalysis {
  summary: string;
  proposals: Proposal[];
}

/** Everything the orchestration touches, injected (real wiring in edit-tuner.ts). */
export interface TunerIo {
  countEditsAfter(db: D1Database, afterId: number): Promise<{ count: number; maxId: number }>;
  editsAfter(db: D1Database, afterId: number, limit: number): Promise<EditRow[]>;
  kvGet(db: D1Database, key: string): Promise<string | null>;
  kvSet(db: D1Database, key: string, value: string): Promise<void>;
  analyze(env: Env, edits: EditRow[]): Promise<TuningAnalysis>;
  postSummary(env: Env, summary: string, nEdits: number, nProposals: number): Promise<string>;
  postCard(env: Env, key: string, p: Proposal): Promise<string>;
}

/**
 * The tuning run. Watermark/last-run advance ONLY after every Slack post
 * succeeded — a crash mid-run retries in full the next day (worst case: one
 * duplicated posting; apply stays claim-guarded in edit-tuner.ts).
 */
export async function maybeRunEditTuningWith(
  io: TunerIo,
  env: Env,
  deps: { slack: { postNote(text: string): Promise<void> } },
  nowEpoch: number,
): Promise<void> {
  const afterId = parseInt((await io.kvGet(env.DB, KV_WATERMARK)) ?? "0", 10) || 0;
  const lastRunRaw = await io.kvGet(env.DB, KV_LAST_RUN);
  const lastRunEpoch = lastRunRaw ? parseInt(lastRunRaw, 10) || null : null;

  const { count, maxId } = await io.countEditsAfter(env.DB, afterId);
  const gate = decideTuningRun({ nowEpoch, lastRunEpoch, newEditCount: count });
  if (!gate.run) return;

  const edits = await io.editsAfter(env.DB, afterId, MAX_EDITS_PER_RUN);
  if (edits.length === 0) return;

  const { summary, proposals } = await io.analyze(env, edits);

  if (proposals.length === 0) {
    await deps.slack.postNote(
      `🧠 Análisis de ediciones: revisé ${edits.length} ediciones y no encontré patrones nuevos que proponer.` +
        (summary ? `\n\n${summary}` : ""),
    );
  } else {
    await io.postSummary(env, summary, edits.length, proposals.length);
    for (let n = 0; n < proposals.length; n++) {
      const key = tuningKey(nowEpoch, n);
      const record: TuningRecord = {
        proposal: proposals[n]!,
        status: "pending",
        createdAt: nowEpoch,
        slackTs: null,
      };
      // kv first, card second: a button tap can never reference a missing
      // record; an orphan from a failed post is inert.
      await io.kvSet(env.DB, key, JSON.stringify(record));
      const ts = await io.postCard(env, key, proposals[n]!);
      await io.kvSet(env.DB, key, JSON.stringify({ ...record, slackTs: ts }));
    }
  }

  // All posts landed → consume the batch. MUST be the last writes.
  await io.kvSet(env.DB, KV_WATERMARK, String(maxId));
  await io.kvSet(env.DB, KV_LAST_RUN, String(nowEpoch));
}
