// GET /admin — serves the dashboard SPA shell (src/ui/admin.html) as a bundled
// text module. W4 owns admin.html; this handler just wraps it with the right
// headers. `cache-control: no-store` keeps the shell fresh across deploys (the
// SPA fetches all data from /admin/api/*).

import type { Env } from "../types.js";
import adminHtml from "../ui/admin.html";

export async function handleAdminUi(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return new Response(adminHtml, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
