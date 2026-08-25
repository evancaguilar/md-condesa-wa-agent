// Token/cost accrual for the NON-brain Anthropic calls (Editor chat, edit
// tuner, guided rewrite, booking-guard's field extractor). Same pricing table
// as the brain — computeCost lives in brain/claude.ts.
//
// Deliberately its own module: it used to live in services/kb-editor.ts, which
// imports the compiled KB text, so every caller dragged the whole knowledge base
// in behind it. Callers that only need to log a few hundred tokens shouldn't.

import type { Env } from "../types.js";
import { computeCost, type ApiUsage } from "../brain/claude.js";
import { accrueUsage } from "../db/queries.js";
import { cdmxDateStr } from "../cron/time.js";

export function accrueChatUsage(env: Env, u: ApiUsage | undefined): Promise<void> {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  const cost = computeCost({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  });
  return accrueUsage(
    env.DB,
    cdmxDateStr(Math.floor(Date.now() / 1000)),
    input,
    cacheRead,
    output,
    cost,
  );
}
