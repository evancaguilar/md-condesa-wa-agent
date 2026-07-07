// GET /admin — serves the dashboard SPA shell.
//
// TODO(W3): replace this body. W3 serves src/ui/admin.html (text module) with
// `content-type: text/html; charset=utf-8` and `cache-control: no-store`. This
// placeholder only exists so W1's index.ts routing typechecks before W3 lands.

import type { Env } from "../types.js";

export async function handleAdminUi(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return new Response("admin UI not implemented", { status: 501 });
}
