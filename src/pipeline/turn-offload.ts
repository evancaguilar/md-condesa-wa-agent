// Hands a gated inbound turn to the per-phone Durable Object (turn-runner.ts)
// so the debounce + brain call run in a DO alarm (15 min wall time) instead of
// the webhook's ctx.waitUntil, which Cloudflare cuts 30 s after the 200
// (docs/turn-runner.md). Fail-soft: no binding, the switch off, or an enqueue
// error ⇒ false, and processInbound runs today's inline path.

import type { Env } from "../types.js";
import type { PendingTurn } from "./inbound.js";

/** Both the binding (wrangler.jsonc durable_objects) and the var must be set. */
export function turnRunnerEnabled(env: Env): boolean {
  return env.TURN_RUNNER === "1" && env.TURNS !== undefined;
}

/** True only when the DO acknowledged the turn; it now owns the reply. */
export async function offloadTurn(env: Env, turn: PendingTurn): Promise<boolean> {
  if (!turnRunnerEnabled(env)) return false;
  const phone = turn.msg.phone;
  try {
    const ns = env.TURNS!;
    const stub = ns.get(ns.idFromName(phone));
    // Media riders are not needed after the gates (the stored row has the
    // transcript / placeholder) and only make the payload bigger.
    const payload: PendingTurn = { ...turn, msg: { ...turn.msg, media: undefined } };
    const res = await stub.fetch("https://turn-runner/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return true;
    console.error(`[turn-runner] enqueue refused (${res.status}) for ${phone}; running inline`);
  } catch (err) {
    console.error(`[turn-runner] enqueue failed for ${phone}; running inline`, err);
  }
  return false;
}
