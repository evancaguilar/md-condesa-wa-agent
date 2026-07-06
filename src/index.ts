import type { Env, Ports } from "./types.js";
import { handleVerify, handleWebhook } from "./routes/whatsapp.js";
import { handleHealth } from "./routes/admin.js";
import { handleSlackInteractive } from "./routes/slack.js";
import { runCron, setCronDeps } from "./cron/dispatcher.js";
import { createBrainWithKb } from "./brain/index.js";
import { accrueUsage } from "./db/queries.js";
import { makeAirtablePort } from "./services/airtable.js";
import {
  makeSlackPort,
  postNote,
  postAttendanceCheck,
  ensureControlPanel,
  runApprovalTimeouts,
} from "./services/slack.js";

// Ports are built per request via a lazy, per-isolate factory: real `env` is
// only available inside fetch()/scheduled(), and makeSlackPort/makeAirtablePort/
// the brain all need it. We memoize by env identity so a warm isolate reuses the
// same bundle across requests (these are cheap object constructions anyway).
let cachedEnv: Env | null = null;
let cachedPorts: Ports | null = null;
let cronDepsInstalled = false;

function makePorts(env: Env): Ports {
  if (cachedPorts && cachedEnv === env) return cachedPorts;

  const airtable = makeAirtablePort(env);
  const brain = createBrainWithKb({
    apiKey: env.ANTHROPIC_API_KEY,
    airtable,
    accrueUsage: (day, inTok, cachedTok, outTok, cost) =>
      accrueUsage(env.DB, day, inTok, cachedTok, outTok, cost),
  });
  const slack = makeSlackPort(env);

  cachedEnv = env;
  cachedPorts = { brain, slack, airtable };

  // Cron needs three things beyond the Ports interface (C's Slack helpers).
  // Their raw signatures differ from CronDeps, so adapt them here. Install once
  // per isolate.
  if (!cronDepsInstalled) {
    setCronDeps({
      slack: {
        postNote: (text) => postNote(env, text),
        postAttendanceCheck: (a) =>
          postAttendanceCheck(env, a.name, a.phone, a.recordId).then(() => {}),
      },
      // slack's runApprovalTimeouts re-fetches pending approvals itself, so we
      // ignore the list the dispatcher passes and just bind env.
      runApprovalTimeouts: (e) => runApprovalTimeouts(e),
      ensureControlPanel: (e) => ensureControlPanel(e).then(() => {}),
    });
    cronDepsInstalled = true;
  }

  return cachedPorts;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/webhook/whatsapp") {
      if (req.method === "GET") return handleVerify(req, env);
      if (req.method === "POST")
        return handleWebhook(req, env, ctx, makePorts(env));
      return new Response("method not allowed", { status: 405 });
    }

    // Slack interactivity endpoint (Block Kit actions + modal submits).
    if (pathname === "/slack/interactive" && req.method === "POST") {
      // Ensure cron deps are installed even if this is the first request.
      makePorts(env);
      return handleSlackInteractive(req, env, ctx);
    }

    if (pathname === "/health") return handleHealth(env);

    return new Response("not found", { status: 404 });
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCron(env, makePorts(env)));
  },
} satisfies ExportedHandler<Env>;
