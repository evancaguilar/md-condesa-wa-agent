// Single */5 cron entry point (owned by workstream D). Every tick runs due
// followups + approval timeouts; hourly triggers the Airtable booking sync;
// once daily at 10:00 CDMX runs the student sync, budget report, and control-
// panel ensure.
//
// runCron's signature (env, ports) is fixed by workstream A. The cron also needs
// C's helpers (attendance card, approval timeouts, control panel) which are not
// on the Ports interface, so they're injected via setCronDeps(). Until C lands,
// safe no-op defaults keep this typechecking and running. E wires the real ones
// in index.ts — see docs/notes-d.md.

import type { Env, Ports } from "../types.js";
import { getPendingApprovals } from "../db/queries.js";
import { makeAirtablePort } from "../services/airtable.js";
import { runDueFollowups, syncBookings, syncStudents } from "./followups.js";
import { runBudgetReport } from "./budget.js";
import { maybeRunEditTuning } from "../services/edit-tuner.js";
import { runBookingRecon } from "./booking-recon.js";
import { runNightlyAudit } from "./nightly-audit.js";
import { KB } from "../kb.js";
import { cdmxParts, cdmxDateStr } from "./time.js";
import type { CronDeps } from "./deps.js";
import { kvGet, kvSet } from "../db/queries.js";
import { CLIENT } from "../client.gen.js";
import { runAdSpendBackfillStep, runDailyAdSpend, shouldRunDailyPull } from "./ad-spend.js";
import { runLeadLinkSweep, runStudentLinkSweep } from "./metrics-link.js";
import { runMetricsBrief } from "./metrics-brief.js";

// Injected by E at integration; default is a safe no-op set. postNote falls back
// to console so budget reports aren't silently dropped pre-integration.
let cronDeps: CronDeps = {
  slack: {
    async postNote(text: string): Promise<void> {
      console.log(`[cron/slack stub] ${text}`);
    },
    async postAttendanceCheck(a): Promise<void> {
      console.log(`[cron/slack stub] attendance check ${a.name} (${a.phone})`);
    },
  },
  async runApprovalTimeouts(): Promise<void> {
    /* C not wired yet */
  },
  async ensureControlPanel(): Promise<void> {
    /* C not wired yet */
  },
};

export function setCronDeps(deps: CronDeps): void {
  cronDeps = deps;
}

export async function runCron(env: Env, _ports: Ports): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const p = cdmxParts(nowEpoch);

  // One-time (kv-guarded, retried until it succeeds): additive index from
  // schema.sql, applied from the worker at Evan's explicit request
  // (2026-08-25) since local wrangler is on the wrong account — plus an
  // immediate control-panel refresh so the new auto-send toggle appears
  // without waiting for the daily 10:00 block. Idempotent by construction.
  if (!(await kvGet(env.DB, "migr_idx_pending_approvals_created"))) {
    await safe("ensureIndexes", async () => {
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_pending_approvals_created ON pending_approvals(created_at)`,
      ).run();
      await cronDeps.ensureControlPanel(env);
      await kvSet(env.DB, "migr_idx_pending_approvals_created", "1");
    });
  }

  // Every tick: due followups + approval timeouts. Isolate failures so one
  // subsystem can't starve the others.
  await safe("runDueFollowups", () => runDueFollowups(env, cronDeps));
  await safe("runApprovalTimeouts", async () => {
    const pending = await getPendingApprovals(env.DB);
    await cronDeps.runApprovalTimeouts(env, pending);
  });

  // Marketing metrics feeder (docs/marketing-metrics.md): gated by the client
  // feature flag AND the ad-account var, so other clients / a bare deploy skip it.
  // Cloudflare caps subrequests per invocation (50 on the free plan; every
  // Airtable/Graph/Slack call is one), so the metrics work runs on the ticks the
  // Airtable booking sync does NOT use (minute % 15 >= 5) and each job is sized
  // to ~10–15 requests. Order: sweeps → daily pull (05:30 window, kv mark) →
  // otherwise one 2-day backfill chunk; the pull and the backfill never share a tick.
  const metrics = CLIENT.features.marketingMetrics === true && !!env.META_AD_ACCOUNT_ID;
  const metricsSlot = metrics && p.minute % 15 >= 5;
  const metricsNote = (t: string): Promise<void> => cronDeps.slack.postNote(t);
  if (metricsSlot) {
    await safe("leadLinkSweep", () => runLeadLinkSweep(env, { postNote: metricsNote }));
    await safe("studentLinkSweep", () => runStudentLinkSweep(env, { postNote: metricsNote }));
    let pulledToday = false;
    if (shouldRunDailyPull(p)) {
      const today = cdmxDateStr(nowEpoch);
      if ((await kvGet(env.DB, "ad_spend_mark")) !== today) {
        await kvSet(env.DB, "ad_spend_mark", today);
        pulledToday = true;
        await safe("adSpendDaily", () =>
          runDailyAdSpend(env, nowEpoch, { slack: cronDeps.slack }),
        );
      }
    }
    if (!pulledToday) {
      await safe("adSpendBackfill", () =>
        runAdSpendBackfillStep(env, nowEpoch, { slack: cronDeps.slack }),
      );
    }
  }

  // Every ~15 min (minute % 15 < 5): booking sync + result watcher.
  // Feature-gated: clients without an Airtable pipeline skip the syncs entirely.
  if (CLIENT.features.airtableSync && p.minute % 15 < 5) {
    await safe("syncBookings", () =>
      syncBookings(env, undefined, { slack: cronDeps.slack }),
    );
  }

  // Once daily at 05:00 CDMX (kv date mark): the OPUS nightly audit of the
  // last 24h of conversations, posted to Slack before the team wakes up.
  // Report-only — it never touches leads, campaigns, or code.
  if (p.hour === 5) {
    const today = cdmxDateStr(nowEpoch);
    if ((await kvGet(env.DB, "nightly_audit_mark")) !== today) {
      await kvSet(env.DB, "nightly_audit_mark", today);
      await safe("nightlyAudit", () =>
        runNightlyAudit(env, {
          postNote: async (_env, text) => cronDeps.slack.postNote(text),
          kb: KB,
          now: nowEpoch,
        }),
      );
    }
  }

  // Marketing metrics: 08:00 CDMX Slack brief (yesterday + month to date).
  if (metrics && p.hour === 8) {
    const today = cdmxDateStr(nowEpoch);
    if ((await kvGet(env.DB, "metrics_brief_mark")) !== today) {
      await kvSet(env.DB, "metrics_brief_mark", today);
      await safe("metricsBrief", () =>
        runMetricsBrief(env, nowEpoch, { postNote: metricsNote }),
      );
    }
  }

  // Once daily at 10:00 CDMX (guarded by a kv date mark).
  if (p.hour === 10) {
    const today = cdmxDateStr(nowEpoch);
    if ((await kvGet(env.DB, "daily_cron_mark")) !== today) {
      await kvSet(env.DB, "daily_cron_mark", today);
      if (CLIENT.features.airtableSync) {
        await safe("syncStudents", () => syncStudents(env));
      }
      await safe("budgetReport", () => runBudgetReport(env, cronDeps, nowEpoch));
      await safe("ensureControlPanel", () => cronDeps.ensureControlPanel(env));
      // Edit tuner: self-gated to ~weekly + ≥5 new edits since its watermark.
      await safe("editTuning", () => maybeRunEditTuning(env, cronDeps, nowEpoch));
      // Booking-reconciliation backstop: flag outbound "ya quedó agendado"
      // claims Airtable has no trial datetime for. Posts only when it finds one.
      await safe("bookingRecon", () =>
        runBookingRecon(env, { slack: cronDeps.slack }, nowEpoch),
      );
    }
  }
}

async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[cron] ${label} failed: ${String(err)}`);
  }
}

// Kept for the index.ts wiring convenience (E may prefer this over stubs).
export { makeAirtablePort };
