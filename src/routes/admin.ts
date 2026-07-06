import type { Env } from "../types.js";
import { isBotEnabled } from "../db/queries.js";

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
    kbVersion: "stub", // workstream B fills this from the compiled KB
  });
}
