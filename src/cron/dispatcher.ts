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
import {
  NIGHTLY_AUDIT_HOUR,
  NIGHTLY_AUDIT_MARK_KEY,
  NIGHTLY_AUDIT_TRY_KEY,
  nightlyAuditGiveUpNote,
  nightlyAuditStep,
  parseNightlyAuditTry,
  runNightlyAudit,
  type NightlyAuditTry,
} from "./nightly-audit.js";
import { KB } from "../kb.js";
import { cdmxParts, cdmxDateStr } from "./time.js";
import { alertNote, type CronDeps } from "./deps.js";
import { kvGet, kvSet, kvClaimIfAbsentOrOlder } from "../db/queries.js";
import { reportInfraError } from "../services/infra-alert.js";
import { ensureIndexes } from "../db/indexes.js";
import { pruneOpsLog } from "../services/ops-log.js";
import { CLIENT } from "../client.gen.js";
import { runAdSpendBackfillStep, runDailyAdSpend, shouldRunDailyPull } from "./ad-spend.js";
import {
  runGclidFromAdSweep,
  runLeadLinkSweep,
  runStudentLinkSweep,
  runTwinAttributionSweep,
} from "./metrics-link.js";
import { runMetricsBrief } from "./metrics-brief.js";
import { runBlastBatch } from "./blasts.js";
import { runSalesAudio } from "./sales-audio.js";
import { runCapiDrain } from "./capi.js";
import { runCapiFunnelSweep } from "./capi-sweep.js";
import { runAudienceSync } from "./audiences.js";
import { syncPostTrialD0Templates } from "./template-sync.js";
import { applyCampaignTriggerUpdates, seedCampaigns } from "./seed-campaigns.js";
import { seedStudentKitTemplates } from "./template-seed-student.js";
import { seedChainTemplates } from "./template-seed-chains.js";
import { seedConfirmTemplates, seedCuestionarioTemplates } from "./template-seed-cuestionario.js";
import { seedNivel0Templates } from "./template-seed-nivel0.js";
import { runRedrive } from "./redrive.js";
import { gcGoogleRefs } from "../routes/google-click.js";
import { gcCuestionarioRate } from "../services/cuestionario.js";
import { copyStep, startCursor, type CopyCursor, type DbLike } from "../services/d1-copy.js";

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
    async postPostTrialCard(a): Promise<void> {
      console.log(`[cron/slack stub] post-trial card ${a.name} (${a.phone})`);
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

/** The installed cron deps (index.ts makePorts installs the real Slack wiring),
 *  for request-time callers that must behave exactly like a tick — the
 *  "Se inscribió" push hook (src/routes/airtable-hooks.ts). */
export function getCronDeps(): CronDeps {
  return cronDeps;
}

export async function runCron(env: Env, _ports: Ports): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const safe = (label: string, fn: () => Promise<unknown>): Promise<void> =>
    safeWith(env, label, fn);
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

  // Additive indexes (src/db/indexes.ts): kv-guarded + per-isolate memo, so
  // after the first successful tick this is one kv read per warm isolate.
  await safe("ensureIndexes", () => ensureIndexes(env.DB));
  // ops_log (services/ops-log.ts): once a day at 04:00 CDMX, ensure its
  // indexes and drop rows older than 30 days. No-op until the table exists.
  if (p.hour === 4 && (await kvGet(env.DB, "ops_log_prune_mark")) !== cdmxDateStr(nowEpoch)) {
    await safe("pruneOpsLog", async () => {
      await pruneOpsLog(env.DB, nowEpoch);
      await kvSet(env.DB, "ops_log_prune_mark", cdmxDateStr(nowEpoch));
    });
  }
  // One-shot template copy sync (src/cron/template-sync.ts, kv-guarded).
  await safe("syncPostTrialD0Templates", () =>
    syncPostTrialD0Templates(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "template" }) }),
  );
  // One-shot campaign seeds (src/cron/seed-campaigns.ts, kv-guarded).
  await safe("seedCampaigns", () =>
    seedCampaigns(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "seed" }) }),
  );
  await safe("applyCampaignTriggerUpdates", () =>
    applyCampaignTriggerUpdates(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "seed" }) }),
  );
  // One-shot submission of the student-kit templates (QR + responsiva +
  // welcome) to Meta (src/cron/template-seed-student.ts, kv-guarded).
  await safe("seedStudentKitTemplates", () =>
    seedStudentKitTemplates(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "template" }) }),
  );
  // One-shot submission of the post-trial / no-show chain templates, per
  // program (adults / _kids / _baby; src/cron/template-seed-chains.ts).
  await safe("seedChainTemplates", () =>
    seedChainTemplates(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "template" }) }),
  );
  // One-shot submission of the questionnaire-invite templates (closed-window
  // fallback of sendCuestionario; src/cron/template-seed-cuestionario.ts).
  await safe("seedCuestionarioTemplates", () =>
    seedCuestionarioTemplates(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "template" }) }),
  );
  // …and the primera_clase* booking confirmations (closed-window twin of the
  // one-message confirmation with the first-class link).
  await safe("seedConfirmTemplates", () =>
    seedConfirmTemplates(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "template" }) }),
  );
  // One-shot submission of the Baby Fight Club Nivel 0 announcement template
  // (Marketing; the blast to the 6–12-month parents, src/cron/template-seed-nivel0.ts).
  await safe("seedNivel0Templates", () =>
    seedNivel0Templates(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "template" }) }),
  );

  // One-shot post-switch delta (2026-10-06 D1 migration): DB_TARGET is the OLD
  // database after the switch; copy anything written there after the first
  // copy into DB (INSERT OR IGNORE ⇒ idempotent), ~15 s per tick until done.
  // kv-guarded in the NEW database. Remove with the DB_TARGET binding.
  if (env.DB_TARGET) {
    await safe("postSwitchDelta", async () => {
      const KEY = "post_switch_delta:2026-10-06";
      const raw = await kvGet(env.DB, KEY);
      if (raw === "done") return;
      // Casts: the node test shim for D1Database lacks batch(); the real binding has it.
      const target = env.DB_TARGET as unknown as DbLike;
      const dest = env.DB as unknown as DbLike;
      const cursor: CopyCursor = raw ? (JSON.parse(raw) as CopyCursor) : await startCursor(target);
      const r = await copyStep(target, dest, cursor, 15_000);
      await kvSet(env.DB, KEY, r.done ? "done" : JSON.stringify(r.cursor));
      if (r.done) {
        await cronDeps.slack.postNote(
          `✅ Migración D1: delta de la base vieja copiado (${r.cursor.copied} filas revisadas, solo se añadieron las que faltaban). El bot corre en wa-agent-db-2.`,
          { kind: "infra", level: "info" },
        );
      }
    });
  }

  // Every tick: due followups + approval timeouts. Isolate failures so one
  // subsystem can't starve the others.
  await safe("runDueFollowups", () => runDueFollowups(env, cronDeps));
  // One-shot outage redrive (src/cron/redrive.ts, kv-guarded): leads whose
  // last message went unanswered during the 2026-10-06 D1 outage get a brain
  // draft in Aprobar, a few per tick, review-only.
  if (cronDeps.redriveTurn) {
    const turn = cronDeps.redriveTurn;
    await safe("redrive", () =>
      runRedrive(
        env,
        { turn: (row, now) => turn(row, now), postNote: (t) => cronDeps.slack.postNote(t, { kind: "redrive" }) },
        nowEpoch,
      ),
    );
  }
  // Human override v2: lead wrote after a staff reply, nobody answered in 60 min.
  if (cronDeps.overrideChecks) {
    const run = cronDeps.overrideChecks;
    await safe("overrideChecks", () => run(nowEpoch).then(() => {}));
  }
  // Template blasts (docs/blasts.md): a few paced sends per tick, 09:00–21:00
  // CDMX, under the run's daily cap; auto-pauses on template/account errors.
  await safe("runBlastBatch", () => runBlastBatch(env, { slack: cronDeps.slack }, nowEpoch));
  await safe("runApprovalTimeouts", async () => {
    const pending = await getPendingApprovals(env.DB);
    await cronDeps.runApprovalTimeouts(env, pending);
  });
  // #wa-leads scoreboard (services/status-line.ts): re-read AFTER the
  // timeouts so best-bets/expiries this tick are already out of the count.
  if (cronDeps.ensureStatusLine) {
    const ensure = cronDeps.ensureStatusLine;
    await safe("statusLine", async () => {
      await ensure(env, await getPendingApprovals(env.DB), nowEpoch);
    });
  }

  // Marketing metrics feeder (docs/marketing-metrics.md): gated by the client
  // feature flag AND the ad-account var, so other clients / a bare deploy skip it.
  // Cloudflare caps subrequests per invocation (50 on the free plan; every
  // Airtable/Graph/Slack call is one), so the metrics work runs on the ticks the
  // Airtable booking sync does NOT use (minute % 15 >= 5) and each job is sized
  // to ~10–15 requests. Order: sweeps → daily pull (05:30 window, kv mark) →
  // otherwise one 2-day backfill chunk; the pull and the backfill never share a tick.
  const metrics = CLIENT.features.marketingMetrics === true && !!env.META_AD_ACCOUNT_ID;
  const metricsSlot = metrics && p.minute % 15 >= 5;
  const metricsNote = (t: string): Promise<void> => cronDeps.slack.postNote(t, { kind: "metrics" });
  const capiNote = (t: string): Promise<void> => cronDeps.slack.postNote(t, { kind: "capi" });
  if (metricsSlot) {
    await safe("leadLinkSweep", () => runLeadLinkSweep(env, { postNote: metricsNote }));
    await safe("studentLinkSweep", () => runStudentLinkSweep(env, { postNote: metricsNote }));
    await safe("twinAttributionSweep", () => runTwinAttributionSweep(env, { postNote: metricsNote }));
    await safe("gclidFromAdSweep", () => runGclidFromAdSweep(env, { postNote: metricsNote }));
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

  // Conversions API funnel sweep (docs/meta-capi.md): ONE Airtable list per
  // 15 min on the metrics-slot ticks, after the student-link sweep above so a
  // fresh Alumno link already shows as {Cerró}=1. No-op while the feature is off.
  if (CLIENT.features.airtableSync && p.minute % 15 >= 5) {
    await safe("capiSweep", () => runCapiFunnelSweep(env, nowEpoch, { postNote: capiNote }));
  }

  // Meta Conversions API drain (docs/meta-capi.md): ≤5 events = ≤5 subrequests,
  // and zero D1 reads while the feature is off or the queue is empty. Runs
  // every tick so a booking reaches Meta within minutes, as the docs ask.
  await safe("capiDrain", () =>
    runCapiDrain(env, nowEpoch, { postNote: capiNote }),
  );

  // Every ~15 min (minute % 15 < 5): booking sync + result watcher.
  // Feature-gated: clients without an Airtable pipeline skip the syncs entirely.
  if (CLIENT.features.airtableSync && p.minute % 15 < 5) {
    await safe("syncBookings", () =>
      syncBookings(env, undefined, { slack: cronDeps.slack }),
    );
  }

  // Once daily at 05:00 CDMX: the OPUS nightly audit of the last 24h of
  // conversations (full report → ops_log, one summary → #evan-alerts) before
  // the team wakes up. Report-only — it never touches leads, campaigns, or code. The day mark is written only
  // AFTER a successful run; a thrown/killed run is retried (≤3 attempts in the
  // 05:00 hour, 15-min lease) and a day with no report gets one #evan-alerts note
  // (nightlyAuditStep; 2026-10-20 had no report and nobody knew).
  if (p.hour === NIGHTLY_AUDIT_HOUR || p.hour === NIGHTLY_AUDIT_HOUR + 1) {
    const today = cdmxDateStr(nowEpoch);
    const mark = await kvGet(env.DB, NIGHTLY_AUDIT_MARK_KEY);
    if (mark !== today) {
      const state = parseNightlyAuditTry(await kvGet(env.DB, NIGHTLY_AUDIT_TRY_KEY));
      const step = nightlyAuditStep({ hour: p.hour, today, now: nowEpoch, mark, state });
      if (step.action === "run") {
        const attempt: NightlyAuditTry = { date: today, n: step.attempt, startedAt: nowEpoch };
        await kvSet(env.DB, NIGHTLY_AUDIT_TRY_KEY, JSON.stringify(attempt));
        await safe("nightlyAudit", async () => {
          try {
            await runNightlyAudit(env, {
              postNote: async (_env, text) => cronDeps.slack.postNote(text, { kind: "audit", level: "info" }),
              postAlert: async (_env, text) => alertNote(cronDeps.slack, text, { kind: "audit" }),
              kb: KB,
              now: nowEpoch,
            });
          } catch (err) {
            const failed: NightlyAuditTry = { ...attempt, startedAt: 0, lastError: String(err).slice(0, 300) };
            await kvSet(env.DB, NIGHTLY_AUDIT_TRY_KEY, JSON.stringify(failed)).catch(() => {});
            throw err;
          }
          await kvSet(env.DB, NIGHTLY_AUDIT_MARK_KEY, today);
          await kvSet(env.DB, NIGHTLY_AUDIT_TRY_KEY, JSON.stringify({ ...attempt, startedAt: 0 }));
        });
      } else if (step.action === "give_up") {
        const base: NightlyAuditTry = state && state.date === today ? state : { date: today, n: 0, startedAt: 0 };
        await kvSet(env.DB, NIGHTLY_AUDIT_TRY_KEY, JSON.stringify({ ...base, noted: true }));
        await safe("nightlyAuditGiveUp", () =>
          alertNote(cronDeps.slack, nightlyAuditGiveUpNote(step, today), { kind: "audit" }),
        );
      }
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
      // Customer-list audiences (docs/meta-audiences.md): one Airtable walk +
      // a handful of Graph calls, once a day. No-op while the feature is off.
      await safe("audienceSync", () => runAudienceSync(env, nowEpoch, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "audiences" }) }));
      await safe("budgetReport", () => runBudgetReport(env, cronDeps, nowEpoch));
      await safe("ensureControlPanel", () => cronDeps.ensureControlPanel(env));
      // Expire Google click codes from the site's /g beacon (90-day gclid life).
      await safe("googleRefGc", () => gcGoogleRefs(env.DB, nowEpoch));
      // Questionnaire rate-limit counters (kv cq_rl:<hour>:<token>), > 48 h old.
      await safe("cuestionarioRateGc", () => gcCuestionarioRate(env.DB, nowEpoch));
      // Edit tuner: self-gated to ~weekly + ≥5 new edits since its watermark.
      await safe("editTuning", () =>
        maybeRunEditTuning(env, { slack: { postNote: (t) => cronDeps.slack.postNote(t, { kind: "tuner" }) } }, nowEpoch),
      );
      // Booking-reconciliation backstop: flag outbound "ya quedó agendado"
      // claims Airtable has no trial datetime for. Posts only when it finds one.
      await safe("bookingRecon", () =>
        runBookingRecon(env, { slack: cronDeps.slack }, nowEpoch),
      );
    }
  }

  // LAST on purpose: a sales-conversation recording can take minutes to
  // transcribe (one record per tick; src/cron/sales-audio.ts).
  await safe("salesAudio", () =>
    runSalesAudio(env, { postNote: (t) => cronDeps.slack.postNote(t, { kind: "sales_audio" }) }, nowEpoch),
  );
}

async function safeWith(env: Env, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[cron] ${label} failed: ${String(err)}`);
    // Infra outage (D1 saturated, Anthropic down, WA token…) ⇒ throttled
    // level=critical note (ops_log + one #evan-alerts line); an ordinary bug
    // stays a console line. Never throws.
    await reportInfraError(
      {
        postNote: (t) => cronDeps.slack.postNote(t, { kind: "infra", level: "critical" }),
        kvClaim: (k, n, a) => kvClaimIfAbsentOrOlder(env.DB, k, n, a),
      },
      `cron ${label}`,
      err,
    );
  }
}

// Kept for the index.ts wiring convenience (E may prefer this over stubs).
export { makeAirtablePort };
