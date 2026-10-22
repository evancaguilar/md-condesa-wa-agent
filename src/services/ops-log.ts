// ops_log: the bot's own log, in D1 (2026-10-22, replaces the #bot-ops Slack
// channel). Everything mechanical — sync FYIs, template seeding, reports,
// debug, non-blocking failures — lands here instead of in Slack, and the
// owner-only "Logs" tab in /admin reads it. Slack keeps only what a human must
// see: #wa-leads (team tasks) and #evan-alerts (Evan). docs/slack-routing.md.
//
// Pure helpers (level inference, query builder, critical-alert dedupe) are
// unit-tested; the IO below FAILS SOFT: a missing table (migration not pasted
// yet) or any D1 error falls back to console so a log write can never break
// the caller. Slack posting for level=critical lives in services/slack.ts
// (postNote), which keeps this module free of a Slack import cycle.

import { cdmxToEpoch, DAY } from "../cron/time.js";

export const OPS_LEVELS = ["debug", "info", "warn", "error", "critical"] as const;
export type OpsLevel = (typeof OPS_LEVELS)[number];

/** Known kinds (the Logs tab's filter list). Free-form strings still work. */
export const OPS_KINDS = [
  "approvals",
  "audiences",
  "audit",
  "autosend",
  "blast",
  "booking",
  "brain",
  "budget",
  "campaign",
  "capi",
  "cuestionario",
  "followup",
  "infra",
  "lead_sync",
  "metrics",
  "misc",
  "optout",
  "panel",
  "post_trial",
  "redrive",
  "reto",
  "sales_audio",
  "seed",
  "student_kit",
  "template",
  "tuner",
  "webhook",
] as const;

export interface OpsEvent {
  level: OpsLevel;
  kind: string;
  message: string;
  meta?: Record<string, unknown> | null;
}

export interface OpsLogRow {
  id: number;
  ts: number;
  level: OpsLevel;
  kind: string;
  message: string;
  meta: string | null;
}

/** Rows older than this are pruned (daily, from the cron). */
export const OPS_LOG_RETENTION_DAYS = 30;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_META_CHARS = 8_000;

export const OPS_LOG_INDEX_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_ops_log_ts ON ops_log(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_ops_log_kind_ts ON ops_log(kind, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_ops_log_level_ts ON ops_log(level, ts)`,
];

// ---- pure ------------------------------------------------------------------

export function isOpsLevel(v: unknown): v is OpsLevel {
  return typeof v === "string" && (OPS_LEVELS as readonly string[]).includes(v);
}

/**
 * Default level from the note's leading emoji, for call sites that don't pass
 * one: ❌/🛑/🚨 → error, ⚠️ → warn, anything else → info. Never "critical" —
 * that posts to #evan-alerts, so it must be chosen explicitly.
 */
export function inferLevel(text: string): OpsLevel {
  const head = text.trimStart().slice(0, 4);
  if (/^(❌|🛑|🚨)/u.test(head)) return "error";
  if (/^⚠/u.test(head)) return "warn";
  return "info";
}

/** Levels at or above `min` (the Logs tab filters by minimum level). */
export function levelsAtLeast(min: OpsLevel): OpsLevel[] {
  return OPS_LEVELS.slice(OPS_LEVELS.indexOf(min));
}

export function clampMessage(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

export function serializeMeta(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta || !Object.keys(meta).length) return null;
  try {
    const s = JSON.stringify(meta);
    return s.length > MAX_META_CHARS ? JSON.stringify({ truncated: s.slice(0, MAX_META_CHARS) }) : s;
  } catch {
    return null;
  }
}

/**
 * The one line a level=critical event posts to #evan-alerts: first non-empty
 * line of the message, Slack mrkdwn kept, capped at ~300 chars.
 */
export function criticalAlertLine(kind: string, message: string): string {
  const first = message.split("\n").map((l) => l.trim()).find(Boolean) ?? "(sin mensaje)";
  const body = first.length > 300 ? `${first.slice(0, 299)}…` : first;
  return `🚨 *${kind}* — ${body}`;
}

/** kv key + value for the critical-alert dedupe (same kind+line within the window ⇒ one post). */
export const CRITICAL_DEDUPE_SECONDS = 30 * 60;
export function criticalDedupeKey(kind: string): string {
  return `ops_crit:${kind}`;
}
export function shouldPostCritical(
  prev: string | null,
  line: string,
  nowSec: number,
  windowSec: number = CRITICAL_DEDUPE_SECONDS,
): boolean {
  if (!prev) return true;
  const bar = prev.indexOf("|");
  const at = Number(prev.slice(0, bar));
  const prevLine = prev.slice(bar + 1);
  if (prevLine !== line) return true;
  return !Number.isFinite(at) || nowSec - at >= windowSec;
}

export interface OpsLogFilter {
  /** Minimum level (inclusive). */
  minLevel?: OpsLevel;
  kind?: string;
  /** Unix seconds, inclusive. */
  from?: number;
  /** Unix seconds, exclusive. */
  to?: number;
  /** Page cursor: only rows with id < before. */
  before?: number;
  limit?: number;
}

/**
 * SELECT for the Logs tab. Always bounded by a ts range (default last 7 days)
 * and a LIMIT so a poll can never full-scan the table (D1 rows-read budget,
 * docs/STATUS.md 2026-09 incidents); idx_ops_log_ts / _kind_ts / _level_ts
 * cover each filter shape.
 */
export function buildOpsLogQuery(
  f: OpsLogFilter,
  nowSec: number,
): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (clause: string, v: string | number): void => {
    params.push(v);
    where.push(clause.replace("?", `?${params.length}`));
  };
  add("ts >= ?", f.from ?? nowSec - 7 * 86400);
  if (f.to !== undefined) add("ts < ?", f.to);
  if (f.kind) add("kind = ?", f.kind);
  if (f.minLevel && f.minLevel !== "debug") {
    const lv = levelsAtLeast(f.minLevel);
    const start = params.length;
    params.push(...lv);
    where.push(`level IN (${lv.map((_, i) => `?${start + i + 1}`).join(", ")})`);
  }
  if (f.before !== undefined) add("id < ?", f.before);
  const limit = Math.max(1, Math.min(500, Math.floor(f.limit ?? 200)));
  return {
    sql: `SELECT id, ts, level, kind, message, meta FROM ops_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`,
    params,
  };
}

/**
 * `GET /admin/api/ops-log` query → filter. `from`/`to` take a CDMX date
 * ("YYYY-MM-DD"; `to` is inclusive of that whole day) or unix seconds; an
 * invalid `level` is ignored (= todos); `limit` defaults to 200, max 500.
 * `get` is URLSearchParams.get (kept as a function so this stays pure).
 */
export function parseOpsLogParams(get: (k: string) => string | null, nowSec: number): OpsLogFilter {
  const f: OpsLogFilter = {};
  const level = get("level");
  if (isOpsLevel(level)) f.minLevel = level;
  const kind = (get("kind") ?? "").trim().slice(0, 64);
  if (kind) f.kind = kind;
  const from = parseOpsTime(get("from"), false);
  f.from = from ?? nowSec - 7 * 86400;
  const to = parseOpsTime(get("to"), true);
  if (to !== null) f.to = to;
  const before = Number(get("before"));
  if (Number.isInteger(before) && before > 0) f.before = before;
  const limit = Number(get("limit"));
  f.limit = Number.isFinite(limit) && limit >= 1 ? Math.min(500, Math.floor(limit)) : 200;
  return f;
}

/** "YYYY-MM-DD" (CDMX midnight; endOfDay ⇒ next midnight) or unix seconds; else null. */
function parseOpsTime(raw: string | null, endOfDay: boolean): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return cdmxToEpoch(y, mo, d) + (endOfDay ? DAY : 0);
  }
  if (/^\d{1,11}$/.test(s)) return Number(s);
  return null;
}

function isMissingTable(err: unknown): boolean {
  return /no such table/i.test(String(err));
}

// ---- IO (fail soft) ----------------------------------------------------------

/** Insert one row. Never throws: on any D1 error the event goes to console. */
export async function writeOpsLog(
  db: D1Database,
  e: OpsEvent,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const message = clampMessage(e.message);
  const meta = serializeMeta(e.meta);
  try {
    await db
      .prepare(`INSERT INTO ops_log(ts, level, kind, message, meta) VALUES(?1, ?2, ?3, ?4, ?5)`)
      .bind(nowSec, e.level, e.kind, message, meta)
      .run();
    return true;
  } catch (err) {
    const line = JSON.stringify({ ops_log: e.level, kind: e.kind, message: message.slice(0, 2000), meta });
    if (isMissingTable(err)) console.log("[ops_log:pre-migration]", line);
    else console.error("[ops_log] write failed", String(err), line);
    return false;
  }
}

/** Logs tab read. Pre-migration ⇒ `{ rows: [], migrated: false }`. */
export async function listOpsLog(
  db: D1Database,
  f: OpsLogFilter,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ rows: OpsLogRow[]; migrated: boolean }> {
  const { sql, params } = buildOpsLogQuery(f, nowSec);
  try {
    const { results } = await db.prepare(sql).bind(...params).all<OpsLogRow>();
    return { rows: results, migrated: true };
  } catch (err) {
    if (isMissingTable(err)) return { rows: [], migrated: false };
    throw err;
  }
}

/**
 * Daily prune (> OPS_LOG_RETENTION_DAYS) + idempotent index ensure. The
 * indexes are created here, from the worker, because a console-pasted index
 * is not proof it exists in prod (2026-09-17). Pre-migration ⇒ no-op.
 */
export async function pruneOpsLog(
  db: D1Database,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  try {
    for (const sql of OPS_LOG_INDEX_SQL) await db.prepare(sql).run();
    const res = await db
      .prepare(`DELETE FROM ops_log WHERE ts < ?1`)
      .bind(nowSec - OPS_LOG_RETENTION_DAYS * 86400)
      .run();
    return Number(res.meta?.changes ?? 0);
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
