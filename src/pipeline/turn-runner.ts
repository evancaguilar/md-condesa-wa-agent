// Per-phone Durable Object that runs the debounced brain turn
// (docs/turn-runner.md). One instance per phone (idFromName), so:
//  - the turn runs in an alarm handler (15 min wall time), not in the
//    webhook's ctx.waitUntil (30 s, then silently cancelled);
//  - alarms never overlap within one object, so two turns of the same lead
//    can no longer think at the same time (the debounce race behind the
//    duplicate confirmations). A newer message waits for the running turn,
//    whose post-brain "superseded" check then hands the reply to it.
// Legacy class shape (no `cloudflare:workers` import) so the module stays
// plain TypeScript.

import type { Env, Ports } from "../types.js";
import { kvClaimIfAbsentOrOlder, newestInboundWamid } from "../db/queries.js";
import { reportInfraError } from "../services/infra-alert.js";
import { runPendingTurn, type PendingTurn } from "./inbound.js";
import {
  enqueueTurn,
  nextAlarmAt,
  pickTurn,
  splitDue,
  type PendingEntry,
} from "./turn-queue-core.js";

const PENDING_KEY = "pending";

function isPendingTurn(v: unknown): v is PendingTurn {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<PendingTurn>;
  const m = t.msg;
  return (
    typeof t.nowSec === "number" &&
    !!m &&
    typeof m.wamid === "string" &&
    m.wamid !== "" &&
    typeof m.phone === "string" &&
    m.phone !== "" &&
    typeof m.ts === "number"
  );
}

/** Built in index.ts with its makePorts, so the alarm gets the same ports as a webhook. */
export function turnRunnerClass(makePorts: (env: Env) => Ports) {
  return class TurnRunner implements DurableObject {
    constructor(
      private readonly state: DurableObjectState,
      private readonly env: Env,
    ) {}

    async fetch(req: Request): Promise<Response> {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      let turn: unknown;
      try {
        turn = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!isPendingTurn(turn)) return new Response("bad turn", { status: 400 });
      const storage = this.state.storage;
      const pending = (await storage.get<PendingEntry<PendingTurn>[]>(PENDING_KEY)) ?? [];
      const next = enqueueTurn(pending, turn.msg.wamid, turn, Date.now());
      await storage.put(PENDING_KEY, next);
      await storage.setAlarm(nextAlarmAt(next)!);
      return new Response("queued", { status: 202 });
    }

    async alarm(): Promise<void> {
      const storage = this.state.storage;
      const pending = (await storage.get<PendingEntry<PendingTurn>[]>(PENDING_KEY)) ?? [];
      const { due, keep } = splitDue(pending, Date.now());
      // Due entries leave storage BEFORE the brain runs: a turn cut short
      // (deploy restart, eviction) is never re-run by the alarm retry — the
      // missed-turn rescue cron owns those, as it does for the inline path.
      if (keep.length > 0) {
        await storage.put(PENDING_KEY, keep);
        await storage.setAlarm(nextAlarmAt(keep)!);
      } else {
        await storage.delete(PENDING_KEY);
      }
      if (due.length === 0) return;
      const phone = due[0]!.turn.msg.phone;
      const ports = makePorts(this.env);
      try {
        const run = pickTurn(due, await newestInboundWamid(this.env.DB, phone));
        if (!run) return;
        await runPendingTurn(this.env, ports, run.turn);
      } catch (err) {
        // Never rethrow: an alarm that throws is retried, and a retried turn
        // can send the lead the same reply twice.
        console.error("[turn-runner] turn failed", phone, err);
        await reportInfraError(
          {
            postNote: (t) => ports.slack.postNote(t, { kind: "infra", level: "critical" }),
            kvClaim: (k, n, a) => kvClaimIfAbsentOrOlder(this.env.DB, k, n, a),
          },
          "turn runner",
          err,
        ).catch(() => {});
      }
    }
  };
}
