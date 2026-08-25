import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runApprovalTimeouts,
  type TimeoutDeps,
  type TimeoutQueries,
} from "../src/services/slack.js";
import { HOLDING_LINE } from "../src/services/slack-timeouts.js";
import { WindowClosedError } from "../src/services/send.js";
import type { ApprovalStatus, Contact, Env, PendingApproval } from "../src/types.js";

// ---- fakes ----

// The only real DB access left in runApprovalTimeouts is the awaiting-reply kv
// lookup (and getContact inside the card helpers): a SELECT that finds nothing.
function fakeDb(): D1Database {
  const stmt: D1PreparedStatement = {
    bind: () => stmt,
    async first() {
      return null;
    },
    async run() {
      return { results: [], meta: { changes: 1 } };
    },
    async all() {
      return { results: [], meta: {} };
    },
  };
  return { prepare: () => stmt };
}

// Slack calls go out through raw fetch; capture them instead of hitting the API.
interface SlackCall {
  method: string;
  body: { text?: string; ts?: string };
}
const slackCalls: SlackCall[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (
  url: string,
  init?: { body?: string },
): Promise<unknown> => {
  slackCalls.push({
    method: url.slice(url.lastIndexOf("/") + 1),
    body: init?.body ? JSON.parse(init.body) : {},
  });
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, ts: "1700000000.000100" };
    },
    async text() {
      return "";
    },
  };
};

const NOW = Date.parse("2026-08-25T16:00:00Z") / 1000; // 10:00 CDMX (business hours)

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 42,
    phone: "5215512345678",
    draft: "Claro, la clase de prueba es gratis 🙌",
    context: null,
    confidence: "low",
    slack_ts: null,
    status: "pending",
    holding_sent: 0,
    created_at: NOW - 11 * 60, // >10min ⇒ hold
    resolved_at: null,
    final_text: null,
    ...over,
  };
}

interface QueryLog {
  claims: number[];
  releases: number[];
  resolved: { id: number; status: ApprovalStatus }[];
  statusReads: number;
}

function makeQueries(
  rows: PendingApproval[],
  over: {
    claimHoldingSend?: boolean;
    claimApproval?: boolean;
    /** What the row's status reads as in the claim→send gap. */
    statusAfterClaim?: ApprovalStatus;
  } = {},
): { queries: TimeoutQueries; log: QueryLog } {
  const log: QueryLog = { claims: [], releases: [], resolved: [], statusReads: 0 };
  const queries: TimeoutQueries = {
    async getPendingApprovals() {
      return rows;
    },
    async getContact(_db, phone) {
      return {
        phone,
        name: "Joshua",
        last_inbound_at: NOW - 60, // window open
      } as Contact;
    },
    async claimHoldingSend(_db, id) {
      log.claims.push(id);
      return over.claimHoldingSend ?? true;
    },
    async releaseHoldingClaim(_db, id) {
      log.releases.push(id);
    },
    async claimApproval(_db, id, status) {
      log.resolved.push({ id, status });
      return over.claimApproval ?? true;
    },
    async getApprovalStatus() {
      log.statusReads++;
      return over.statusAfterClaim ?? "pending";
    },
  };
  return { queries, log };
}

interface SendLog {
  sends: { phone: string; body: string; opts: unknown }[];
}

function makeDeps(over: { throws?: Error } = {}): { deps: TimeoutDeps; log: SendLog } {
  const log: SendLog = { sends: [] };
  const deps: TimeoutDeps = {
    async sendText(_env, phone, body, opts) {
      log.sends.push({ phone, body, opts });
      if (over.throws) throw over.throws;
      return "wamid.HOLD1";
    },
    now: NOW,
  };
  return { deps, log };
}

function envWith(db: D1Database): Env {
  return {
    DB: db,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL_ID: "C123",
  } as unknown as Env;
}

// ---- hold branch ----

test("runApprovalTimeouts: losing the holding claim sends nothing and pings nobody", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([approval()], { claimHoldingSend: false });
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.claims, [42]); // it tried…
  assert.equal(sendLog.sends.length, 0); // …and then stayed quiet
  assert.equal(slackCalls.length, 0);
  assert.equal(log.releases.length, 0);
});

test("runApprovalTimeouts: winning the claim sends ONE holding line (meta holding:1) + pings", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([approval()]);
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.claims, [42]);
  assert.equal(sendLog.sends.length, 1);
  assert.equal(sendLog.sends[0]!.body, HOLDING_LINE);
  assert.equal(sendLog.sends[0]!.phone, "5215512345678");
  const opts = sendLog.sends[0]!.opts as { metaExtra: { holding: number } };
  assert.equal(opts.metaExtra.holding, 1);
  assert.equal(log.releases.length, 0);

  // Re-ping posted to Slack, identifying the approval.
  assert.equal(slackCalls.length, 1);
  assert.equal(slackCalls[0]!.method, "chat.postMessage");
  assert.ok(slackCalls[0]!.body.text!.includes("#42"));
});

test("runApprovalTimeouts: a draft resolved between claim and send is NOT interrupted", async () => {
  slackCalls.length = 0;
  // The human hit Aprobar in the milliseconds after claimHoldingSend won: the
  // lead is already getting the real answer, so the holding line must not go
  // out. The claim stays (holding_sent=1 on a resolved row is harmless).
  const { queries, log } = makeQueries([approval()], { statusAfterClaim: "approved" });
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.claims, [42]);
  assert.equal(log.statusReads, 1);
  assert.equal(sendLog.sends.length, 0);
  assert.equal(slackCalls.length, 0);
  assert.equal(log.releases.length, 0, "the claim is kept, not released");
});

test("runApprovalTimeouts: WindowClosedError keeps the claim (no release, no ping)", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([approval()]);
  const { deps } = makeDeps({ throws: new WindowClosedError("5215512345678") });

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.claims, [42]);
  assert.equal(log.releases.length, 0, "an undeliverable holding line must not be retried");
  assert.equal(slackCalls.length, 0);
});

test("runApprovalTimeouts: a transient send failure releases the claim for the next pass", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([approval()]);
  const { deps } = makeDeps({ throws: new Error("graph 500") });

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.claims, [42]);
  assert.deepEqual(log.releases, [42]);
  assert.equal(slackCalls.length, 0);
});

test("runApprovalTimeouts: one bad approval never stops the loop", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([approval(), approval({ id: 43 })]);
  const { deps } = makeDeps({ throws: new Error("graph 500") });

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.claims, [42, 43]);
  assert.deepEqual(log.releases, [42, 43]);
});

// ---- expire branch ----

const expired = (over: Partial<PendingApproval> = {}): PendingApproval =>
  approval({ created_at: NOW - 13 * 3600, slack_ts: "1700000000.000001", ...over });

test("runApprovalTimeouts: expiry claims 'expired' atomically and swaps the card", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([expired()]);
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.resolved, [{ id: 42, status: "expired" }]);
  assert.equal(sendLog.sends.length, 0);
  assert.equal(slackCalls.length, 1);
  assert.equal(slackCalls[0]!.method, "chat.update");
});

test("runApprovalTimeouts: losing the expiry claim leaves the resolved card alone", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([expired()], { claimApproval: false });
  const { deps } = makeDeps();

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.resolved, [{ id: 42, status: "expired" }]); // attempted
  assert.equal(slackCalls.length, 0, "a human-resolved card must not be stamped ⌛");
});
