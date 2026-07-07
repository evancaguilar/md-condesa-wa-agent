// /admin/api/* — JSON API for the dashboard (login/logout/me, overview, bot +
// training-wheels toggles, conversations, approvals, KB overlay CRUD + chat,
// campaigns, edits, sandbox). All signed-cookie authed except login + UI.
//
// TODO(W3): replace this body with the real router (spec §5). It receives the
// Ports bundle so the sandbox route can build a per-request brain. This
// placeholder only exists so W1's index.ts routing typechecks before W3 lands.

import type { Env, Ports } from "../types.js";

export async function handleAdminApi(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
  _ports: Ports,
): Promise<Response> {
  return new Response(JSON.stringify({ error: "not_implemented" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}
