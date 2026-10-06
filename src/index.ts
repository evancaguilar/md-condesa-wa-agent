import type { Env, Ports } from "./types.js";
import { handleVerify, handleWebhook } from "./routes/whatsapp.js";
import { handleHealth } from "./routes/admin.js";
import { handleSlackInteractive } from "./routes/slack.js";
import { handleAdminUi } from "./routes/admin-ui.js";
import { handleAdminApi } from "./routes/admin-api.js";
import { runCron, setCronDeps } from "./cron/dispatcher.js";
import { runBrainTurn } from "./pipeline/inbound.js";
import { staleReplyFor } from "./cron/redrive.js";
import { createBrainWithKb, makeOverlayLoader } from "./brain/index.js";
import { accrueUsage, kvClaimIfAbsentOrOlder } from "./db/queries.js";
import { reportInfraError } from "./services/infra-alert.js";
import { makeAirtablePort } from "./services/airtable.js";
import { makeBookingFailureNotifier } from "./services/booking-alerts.js";
import {
  makeSlackPort,
  postNote,
  postAttendanceCheck,
  postPostTrialCard,
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
    loadOverlay: makeOverlayLoader(env.DB),
    onBookingFailure: makeBookingFailureNotifier(env),
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
        postPostTrialCard: (a) => postPostTrialCard(env, a).then(() => {}),
      },
      // slack's runApprovalTimeouts re-fetches pending approvals itself, so we
      // ignore the list the dispatcher passes and just bind env.
      runApprovalTimeouts: (e) => runApprovalTimeouts(e),
      ensureControlPanel: (e) => ensureControlPanel(e).then(() => {}),
      redriveTurn: (row, nowSec) =>
        runBrainTurn(
          env,
          cachedPorts!,
          { wamid: row.wamid, phone: row.phone, body: row.body, ts: row.ts },
          nowSec,
          undefined,
          { forceReview: true, stale: staleReplyFor(row, nowSec) },
        ),
    });
    cronDepsInstalled = true;
  }

  return cachedPorts;
}

/**
 * Re-throws after reporting an INFRA failure (D1 saturated, etc.) to Slack,
 * throttled (src/services/infra-alert.ts). The dashboard polls every 5 s, so
 * it is usually the first thing to hit a D1 outage — well before a lead does.
 */
async function withInfraAlert(
  env: Env,
  ctx: ExecutionContext,
  scope: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    ctx.waitUntil(
      reportInfraError(
        {
          postNote: (t) => postNote(env, t),
          kvClaim: (k, n, a) => kvClaimIfAbsentOrOlder(env.DB, k, n, a),
        },
        scope,
        err,
      ),
    );
    throw err;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // /webhook/meta is an alias for the Messenger/Instagram products (same
    // Meta app → same verify token + signature; the parser dispatches on the
    // payload's `object` field, so one handler serves all three channels).
    if (pathname === "/webhook/whatsapp" || pathname === "/webhook/meta") {
      if (req.method === "GET") return handleVerify(req, env);
      if (req.method === "POST")
        return handleWebhook(req, env, ctx, makePorts(env));
      return new Response("method not allowed", { status: 405 });
    }

    // Slack interactivity endpoint (Block Kit actions + modal submits).
    if (pathname === "/slack/interactive" && req.method === "POST") {
      // Ensure cron deps are installed even if this is the first request.
      makePorts(env);
      return withInfraAlert(env, ctx, "slack", () => handleSlackInteractive(req, env, ctx));
    }

    if (pathname === "/health") return handleHealth(env);

    // Admin dashboard: SPA shell + JSON API (W3 owns the handler bodies).
    if (pathname === "/admin" && req.method === "GET") {
      return handleAdminUi(req, env, ctx);
    }
    if (pathname.startsWith("/admin/api/")) {
      return withInfraAlert(env, ctx, "admin", () => handleAdminApi(req, env, ctx, makePorts(env)));
    }

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
