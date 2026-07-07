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
import { cdmxParts, cdmxDateStr } from "./time.js";
import type { CronDeps } from "./deps.js";
import { kvGet, kvSet } from "../db/queries.js";

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

  // Every tick: due followups + approval timeouts. Isolate failures so one
  // subsystem can't starve the others.
  await safe("runDueFollowups", () => runDueFollowups(env, cronDeps));
  await safe("runApprovalTimeouts", async () => {
    const pending = await getPendingApprovals(env.DB);
    await cronDeps.runApprovalTimeouts(env, pending);
  });

  // Every ~15 min (minute % 15 < 5): booking sync + result watcher.
  if (p.minute % 15 < 5) {
    await safe("syncBookings", () =>
      syncBookings(env, undefined, { slack: cronDeps.slack }),
    );
  }

  // Once daily at 10:00 CDMX (guarded by a kv date mark).
  if (p.hour === 10) {
    const today = cdmxDateStr(nowEpoch);
    if ((await kvGet(env.DB, "daily_cron_mark")) !== today) {
      await kvSet(env.DB, "daily_cron_mark", today);
      await safe("syncStudents", () => syncStudents(env));
      await safe("budgetReport", () => runBudgetReport(env, cronDeps, nowEpoch));
      await safe("ensureControlPanel", () => cronDeps.ensureControlPanel(env));
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
