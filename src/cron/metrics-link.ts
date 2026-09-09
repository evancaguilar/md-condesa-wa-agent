// Link sweeps for the marketing metrics (every 15 min, same slot as
// syncBookings): Leads → Día/Mes/Anuncio, and manually created Alumnos → their
// Lead by phone. No cursors: linked rows drop out of the filters, so a failed
// tick simply retries. A schema drift (unknown field) stops the sweep, marks kv
// and posts ONE Slack note per day instead of re-selecting the same rows forever.

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { cdmxDateStr, cdmxToEpoch } from "./time.js";
import {
  MetricsSchemaError,
  linkLeadsSweep,
  linkStudentsSweep,
  type StudentSweepStats,
  type SweepStats,
} from "../services/metrics-airtable.js";

// Cloudflare caps SUBREQUESTS per invocation (50 on the free plan) and every
// Airtable/Graph call is one. A lead sweep costs 1 list + 1 PATCH per 10 leads;
// a student sweep costs 1 list + 1 lookup per student + 1 PATCH per 10. These
// caps keep both under ~12 requests so they coexist with the rest of the tick.
export const LEAD_SWEEP_PER_TICK = 40;
export const STUDENT_SWEEP_PER_TICK = 5;
export const KV_LINK_ERROR = "metrics_link_error";
export const KV_LINK_LAST_OK = "metrics_link_last_ok";

export interface NoteDeps {
  postNote?: (text: string) => Promise<void>;
}

/** METRICS_SINCE ("YYYY-MM-DD", CDMX midnight) as a UTC ISO string for formulas. */
export function metricsSinceIso(env: Pick<Env, "METRICS_SINCE">): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(env.METRICS_SINCE ?? "");
  if (!m) return null;
  const epoch = cdmxToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0);
  return new Date(epoch * 1000).toISOString();
}

async function noteSchemaError(
  env: Env,
  deps: NoteDeps,
  job: string,
  err: unknown,
): Promise<void> {
  if (!(err instanceof MetricsSchemaError)) return;
  const now = Math.floor(Date.now() / 1000);
  await kvSet(env.DB, KV_LINK_ERROR, `${new Date(now * 1000).toISOString()} ${job}: ${err.message}`).catch(
    () => {},
  );
  const dayKey = `metrics_link_note:${cdmxDateStr(now)}`;
  if (await kvGet(env.DB, dayKey)) return;
  await kvSet(env.DB, dayKey, "1");
  await deps.postNote?.(
    `⚠️ Metrics link sweep (${job}) stopped: Airtable field missing (${err.message}). Fix the base or the airtableMetrics map; the sweep resumes on its own.`,
  );
}

/** Link up to `limit` leads created since METRICS_SINCE to Día/Mes/Anuncio. */
export async function runLeadLinkSweep(
  env: Env,
  deps: NoteDeps = {},
  o: { limit?: number } = {},
): Promise<SweepStats> {
  const sinceIso = metricsSinceIso(env);
  if (!sinceIso) return { scanned: 0, linked: 0, errors: ["METRICS_SINCE unset"] };
  try {
    const r = await linkLeadsSweep(env, { limit: o.limit ?? LEAD_SWEEP_PER_TICK, sinceIso });
    if (r.linked > 0) await kvSet(env.DB, KV_LINK_LAST_OK, new Date().toISOString());
    return r;
  } catch (err) {
    await noteSchemaError(env, deps, "leads", err);
    throw err;
  }
}

/** Link up to `limit` phone-bearing students without a lead (exactly-one match). */
export async function runStudentLinkSweep(
  env: Env,
  deps: NoteDeps = {},
  o: { limit?: number } = {},
): Promise<StudentSweepStats> {
  const sinceIso = metricsSinceIso(env);
  if (!sinceIso) {
    return { scanned: 0, linked: 0, errors: ["METRICS_SINCE unset"], ambiguous: 0, none: 0 };
  }
  try {
    return await linkStudentsSweep(env, { limit: o.limit ?? STUDENT_SWEEP_PER_TICK, sinceIso });
  } catch (err) {
    await noteSchemaError(env, deps, "students", err);
    throw err;
  }
}
