import type { Env, Ports } from "./types.js";
import { handleVerify, handleWebhook } from "./routes/whatsapp.js";
import { handleHealth } from "./routes/admin.js";
import { runCron } from "./cron/dispatcher.js";
import { stubAirtable, stubBrain, stubSlack } from "./stubs.js";

// Workstreams B/C/D swap their real implementations in here at integration.
const ports: Ports = {
  brain: stubBrain,
  slack: stubSlack,
  airtable: stubAirtable,
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/webhook/whatsapp") {
      if (req.method === "GET") return handleVerify(req, env);
      if (req.method === "POST") return handleWebhook(req, env, ctx, ports);
      return new Response("method not allowed", { status: 405 });
    }

    // Slack interactivity endpoint — workstream C implements the handler; ack
    // fast so Slack never times out in the meantime.
    if (pathname === "/slack/interactive" && req.method === "POST") {
      return new Response("", { status: 200 });
    }

    if (pathname === "/health") return handleHealth(env);

    return new Response("not found", { status: 404 });
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCron(env, ports));
  },
} satisfies ExportedHandler<Env>;
