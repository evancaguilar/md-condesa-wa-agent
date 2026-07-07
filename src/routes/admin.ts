import type { Env } from "../types.js";
import { isBotEnabled } from "../db/queries.js";
import { KB } from "../kb.js";

// Parsed once per isolate from the compiled KB's header comment. Lets /health
// prove WHICH knowledge base a deploy is actually serving (deploys have failed
// silently before; probing content beats probing liveness).
const KB_VERSION: string =
  /version:\s*(\S+)/.exec(KB.slice(0, 300))?.[1] ?? "unknown";

export async function handleHealth(env: Env): Promise<Response> {
  let dbOk = false;
  let botEnabled = true;
  try {
    await env.DB.prepare("SELECT 1").first();
    dbOk = true;
    botEnabled = await isBotEnabled(env.DB);
  } catch {
    dbOk = false;
  }
  return Response.json({
    ok: dbOk,
    dbOk,
    botEnabled,
    kbVersion: KB_VERSION,
  });
}
