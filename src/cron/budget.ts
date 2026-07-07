// Daily budget telemetry. Sums usage_log for the current CDMX month and posts a
// Slack note; one-shot alerts when MTD crosses $30 and $50 (marks in kv). NEVER
// degrades service — alerts only (Evan's explicit call).

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import type { CronSlackDeps } from "./deps.js";
import { cdmxMonthStr, cdmxDateStr, DAY } from "./time.js";
import { CLIENT } from "../client.gen.js";

const THRESHOLDS = [30, 50] as const;

interface MonthTotals {
  costUsd: number;
  convoCount: number; // proxy: rows in usage_log for the month
}

/** Sum cost_usd (and day-rows) for the current CDMX month from usage_log. */
async function monthToDate(env: Env, month: string): Promise<MonthTotals> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS days
     FROM usage_log WHERE day LIKE ?1`,
  )
    .bind(`${month}-%`)
    .first<{ cost: number; days: number }>();
  return { costUsd: row?.cost ?? 0, convoCount: row?.days ?? 0 };
}

/** Yesterday's (CDMX) conversation count + cost, for the daily note. */
async function yesterday(env: Env, nowEpoch: number): Promise<{
  day: string;
  cost: number;
  input: number;
  output: number;
}> {
  const day = cdmxDateStr(nowEpoch - DAY);
  const row = await env.DB.prepare(
    `SELECT cost_usd AS cost, input_tokens AS input, output_tokens AS output
     FROM usage_log WHERE day = ?1`,
  )
    .bind(day)
    .first<{ cost: number; input: number; output: number }>();
  return {
    day,
    cost: row?.cost ?? 0,
    input: row?.input ?? 0,
    output: row?.output ?? 0,
  };
}

/**
 * Post the daily 10:00 CDMX budget note and fire threshold alerts once each per
 * month. Never changes runtime behavior.
 */
export async function runBudgetReport(
  env: Env,
  deps: { slack: CronSlackDeps },
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const month = cdmxMonthStr(nowEpoch);
  const mtd = await monthToDate(env, month);
  const y = await yesterday(env, nowEpoch);

  await deps.slack.postNote(
    `📊 ${CLIENT.shortName} bot — gasto\n` +
      `Ayer (${y.day}): ~$${y.cost.toFixed(2)} USD · ${y.input + y.output} tokens\n` +
      `Mes ${month} a la fecha: ~$${mtd.costUsd.toFixed(2)} USD`,
  );

  for (const t of THRESHOLDS) {
    if (mtd.costUsd < t) continue;
    const markKey = `budget_alert_${t}:${month}`;
    if ((await kvGet(env.DB, markKey)) === "1") continue;
    await kvSet(env.DB, markKey, "1");
    await deps.slack.postNote(
      `⚠️ El gasto del bot cruzó $${t} USD este mes (${month}): ~$${mtd.costUsd.toFixed(2)}. ` +
        `Solo aviso — el bot sigue operando normal.`,
    );
  }
}
