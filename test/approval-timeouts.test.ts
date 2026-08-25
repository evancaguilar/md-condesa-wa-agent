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

// The only real DB access left in runApprovalTimeouts is the kv side-channel
// lookups (awaiting-reply, sureness, guarded) plus getContact inside the card
// helpers. `kv` seeds the kv rows; everything else finds nothing.
function fakeDb(kv: Record<string, string> = {}): D1Database {
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first() {
        if (sql.includes("FROM kv")) {
          const v = kv[String(binds[0])];
          return v === undefined ? null : ({ value: v } as never);
        }
        return null;
      },
      async run() {
        return { results: [], meta: { changes: 1 } };
      },
      async all() {
        return { results: [], meta: {} };
      },
    };
    return stmt;
  };
  return { prepare: make };
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
    optedOut?: boolean;
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
        ...(over.optedOut ? { status: "opted_out" } : {}),
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

// ---- best-bet branch (1h with no review) ----

import { surenessKey, guardedApprovalKey } from "../src/services/approvals.js";

/** Pending for 61 minutes, holding line already sent. */
const stale = (over: Partial<PendingApproval> = {}): PendingApproval =>
  approval({
    created_at: NOW - 61 * 60,
    holding_sent: 1,
    slack_ts: "1700000000.000001",
    ...over,
  });

const withSureness = (n: number, extra: Record<string, string> = {}) =>
  fakeDb({ [surenessKey(42)]: String(n), ...extra });

test("runApprovalTimeouts: 61min + sureness 30 ⇒ claims auto_sent and sends the draft", async () => {
  slackCalls.length = 0;
  const row = stale();
  const { queries, log } = makeQueries([row]);
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(withSureness(30)), queries, deps);

  assert.deepEqual(log.resolved, [{ id: 42, status: "auto_sent" }]);
  assert.equal(sendLog.sends.length, 1);
  assert.equal(sendLog.sends[0]!.body, row.draft, "the draft goes out verbatim");
  assert.equal(sendLog.sends[0]!.phone, row.phone);
  // Card swapped in place, saying who sent it and how sure the model was.
  assert.equal(slackCalls.length, 1);
  assert.equal(slackCalls[0]!.method, "chat.update");
  const text = slackCalls[0]!.body.text!;
  assert.ok(text.includes("Enviada automáticamente"), text);
  assert.ok(text.includes("seguridad 30%"), text);
});

test("runApprovalTimeouts: 59min ⇒ nothing sent yet", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale({ created_at: NOW - 59 * 60 })]);
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(withSureness(30)), queries, deps);

  assert.deepEqual(log.resolved, []);
  assert.equal(sendLog.sends.length, 0);
  assert.equal(slackCalls.length, 0);
});

test("runApprovalTimeouts: sureness 20 never auto-sends — it expires at 12h", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale()]);
  const { deps, log: sendLog } = makeDeps();
  await runApprovalTimeouts(envWith(withSureness(20)), queries, deps);
  assert.deepEqual(log.resolved, []);
  assert.equal(sendLog.sends.length, 0);

  // …and 13h later the normal expiry path takes it.
  slackCalls.length = 0;
  const old = makeQueries([stale({ created_at: NOW - 13 * 3600 })]);
  const { deps: deps2, log: sendLog2 } = makeDeps();
  await runApprovalTimeouts(envWith(withSureness(20)), old.queries, deps2);
  assert.deepEqual(old.log.resolved, [{ id: 42, status: "expired" }]);
  assert.equal(sendLog2.sends.length, 0);
});

test("runApprovalTimeouts: a guarded draft is never auto-sent", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale()]);
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(
    envWith(withSureness(90, { [guardedApprovalKey(42)]: "1" })),
    queries,
    deps,
  );

  assert.deepEqual(log.resolved, []);
  assert.equal(sendLog.sends.length, 0);
  assert.equal(slackCalls.length, 0);
});

test("runApprovalTimeouts: no sureness marker (legacy row) ⇒ no auto-send", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale()]);
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);

  assert.deepEqual(log.resolved, []);
  assert.equal(sendLog.sends.length, 0);
});

test("runApprovalTimeouts: losing the auto_sent claim sends NOTHING", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale()], { claimApproval: false });
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(withSureness(60)), queries, deps);

  assert.deepEqual(log.resolved, [{ id: 42, status: "auto_sent" }]); // attempted
  assert.equal(sendLog.sends.length, 0, "a human resolved it in the gap");
  assert.equal(slackCalls.length, 0);
});

test("runApprovalTimeouts: a window that closed in the gap downgrades to expired", async () => {
  slackCalls.length = 0;
  const { queries } = makeQueries([stale()]);
  const { deps } = makeDeps({ throws: new WindowClosedError("5215512345678") });

  await runApprovalTimeouts(envWith(withSureness(60)), queries, deps);

  // The claim happened, the send failed: the card swaps to "ventana cerrada".
  assert.equal(slackCalls.length, 1);
  assert.equal(slackCalls[0]!.method, "chat.update");
  assert.ok(slackCalls[0]!.body.text!.includes("Ventana cerrada"), slackCalls[0]!.body.text);
});

test("runApprovalTimeouts: a transient failure on the best-bet send never stops the loop", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale(), stale({ id: 42 })]);
  const { deps } = makeDeps({ throws: new Error("graph 500") });

  await runApprovalTimeouts(envWith(withSureness(60)), queries, deps);

  assert.equal(log.resolved.length, 2, "both rows were attempted");
  assert.equal(slackCalls.length, 0);
});

test("runApprovalTimeouts: an opted-out lead is never best-bet — the draft is discarded", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale()], { optedOut: true });
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(withSureness(90)), queries, deps);

  assert.deepEqual(log.resolved, [{ id: 42, status: "discarded" }]);
  assert.equal(sendLog.sends.length, 0);
  assert.equal(slackCalls.length, 1);
  assert.ok(slackCalls[0]!.body.text!.includes("Descartada"), slackCalls[0]!.body.text);
});
