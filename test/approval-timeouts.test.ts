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
        // INSERT OR IGNORE INTO kv (kvSetIfAbsent): real "once" semantics, so
        // the escalation dedupe is observable across passes.
        if (sql.includes("ON CONFLICT(key) DO UPDATE")) {
          // kvClaimIfAbsentOrOlder(key, now, minAge)
          const k = String(binds[0]);
          const prev = kv[k];
          if (prev !== undefined && Number(prev) > Number(binds[1]) - Number(binds[2])) {
            return { results: [], meta: { changes: 0 } };
          }
          kv[k] = String(binds[1]);
          return { results: [], meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO kv")) {
          const k = String(binds[0]);
          if (k in kv) return { results: [], meta: { changes: 0 } };
          kv[k] = String(binds[1]);
        }
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
    /** Default: 30 s before the oldest row (the lead wrote, then the draft). */
    lastInboundAt?: number;
    lang?: string;
    staffReplied?: boolean;
  } = {},
): { queries: TimeoutQueries; log: QueryLog } {
  const lastInbound = over.lastInboundAt ?? Math.min(...rows.map((r) => r.created_at)) - 30;
  const log: QueryLog = { claims: [], releases: [], resolved: [], statusReads: 0 };
  const queries: TimeoutQueries = {
    async getPendingApprovals() {
      return rows;
    },
    async getContact(_db, phone) {
      return {
        phone,
        name: "Joshua",
        last_inbound_at: lastInbound, // window open
        lang: over.lang ?? "es",
        ...(over.optedOut ? { status: "opted_out" } : {}),
      } as Contact;
    },
    async staffRepliedSince() {
      return over.staffReplied ?? false;
    },
    async newestInbound(_db, phone) {
      return { wamid: "wamid.IN1", phone, body: "¿y mañana?", ts: lastInbound };
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

test("runApprovalTimeouts: winning the claim sends ONE holding line (meta holding:1), no Slack re-ping", async () => {
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

  // No per-card re-ping any more (2026-10-06): the #wa-leads scoreboard
  // (services/status-line.ts) carries the ageing + one <!here> per hour.
  assert.equal(slackCalls.length, 0);
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
  // Different phones: the per-phone holding-line claim (45 min) is real in the fake.
  const { queries, log } = makeQueries([approval(), approval({ id: 43, phone: "5215587654321" })]);
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
  assert.equal(slackCalls[0]!.method, "chat.update");
  // Nobody was paged before the expiry ⇒ it never dies silently: one task.
  const posts = slackCalls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 1, "task in #wa-leads (no alerts channel configured ⇒ ops_log)");
  assert.ok(posts[0]!.body.text!.includes("expiró sin respuesta"), posts[0]!.body.text);
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

test("runApprovalTimeouts: 14min ⇒ nothing sent yet", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale({ created_at: NOW - 14 * 60 })]);
  const { deps, log: sendLog } = makeDeps();

  await runApprovalTimeouts(envWith(withSureness(30)), queries, deps);

  assert.deepEqual(log.resolved, []);
  assert.equal(sendLog.sends.length, 0);
  assert.equal(slackCalls.length, 0);
});

test("runApprovalTimeouts: sureness 20 never auto-sends — it escalates ONCE, then expires", async () => {
  slackCalls.length = 0;
  const db = withSureness(20);
  const { queries, log } = makeQueries([stale()]);
  const { deps, log: sendLog } = makeDeps();
  await runApprovalTimeouts(envWith(db), queries, deps);
  assert.deepEqual(log.resolved, []);
  assert.equal(sendLog.sends.length, 0);
  const posts = slackCalls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 1);
  assert.ok(posts[0]!.body.text!.startsWith("<!here> ⏰ Un lead espera"), posts[0]!.body.text);
  assert.ok(posts[0]!.body.text!.includes("seguridad 20%"), posts[0]!.body.text);

  // Next tick: already paged ⇒ silence.
  slackCalls.length = 0;
  await runApprovalTimeouts(envWith(db), queries, deps);
  assert.equal(slackCalls.length, 0);

  // …and 13h later the expiry takes it (already paged ⇒ no second task).
  slackCalls.length = 0;
  const old = makeQueries([stale({ created_at: NOW - 13 * 3600 })]);
  const { deps: deps2, log: sendLog2 } = makeDeps();
  await runApprovalTimeouts(envWith(db), old.queries, deps2);
  assert.deepEqual(old.log.resolved, [{ id: 42, status: "expired" }]);
  assert.equal(sendLog2.sends.length, 0);
  assert.equal(slackCalls.filter((c) => c.method === "chat.postMessage").length, 0);
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
  // Not sent ⇒ a human is paged with the reason.
  const posts = slackCalls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 1);
  assert.ok(posts[0]!.body.text!.includes("horario/agendado por verificar"), posts[0]!.body.text);
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

// ---- 2026-11-11 policy: stale dates, regeneration, aggregation ----

import { timeoutEscalatedKey } from "../src/services/slack.js";

// Fri 2026-11-06 21:40 CDMX (after the send window) → Sat 08:05 CDMX.
const FRI_7PM = Date.parse("2026-11-07T03:40:00Z") / 1000;
const SAT_805 = Date.parse("2026-11-07T14:05:00Z") / 1000;

test("runApprovalTimeouts: an overnight 'mañana sábado' draft is regenerated at 08:00, never sent as-is", async () => {
  slackCalls.length = 0;
  const row = approval({
    created_at: FRI_7PM,
    slack_ts: "1700000000.000001",
    draft: "Mañana sábado tenemos Muay Thai a las 10 am 🥊 ¿Te late?",
  });
  const { queries, log } = makeQueries([row]);
  const regens: { wamid: string; nowSec: number }[] = [];
  const deps: TimeoutDeps = {
    async sendText() {
      throw new Error("must not send");
    },
    now: SAT_805,
    async regenerate(msg, nowSec) {
      regens.push({ wamid: msg.wamid, nowSec });
    },
  };
  await runApprovalTimeouts(envWith(withSureness(70)), queries, deps);
  assert.deepEqual(log.resolved, [{ id: 42, status: "superseded" }]);
  assert.deepEqual(regens, [{ wamid: "wamid.IN1", nowSec: SAT_805 }]);
  const update = slackCalls.find((c) => c.method === "chat.update");
  assert.ok(update?.body.text?.includes("Reemplazada"), update?.body.text);
});

test("runApprovalTimeouts: a stale draft with no regenerate wiring escalates instead", async () => {
  slackCalls.length = 0;
  const row = approval({ created_at: FRI_7PM, draft: "Mañana sábado a las 10 am 🥊" });
  const { queries, log } = makeQueries([row]);
  const { deps, log: sendLog } = makeDeps();
  await runApprovalTimeouts(envWith(withSureness(70)), queries, { ...deps, now: SAT_805 });
  assert.equal(sendLog.sends.length, 0);
  assert.deepEqual(log.resolved, []);
  const task = slackCalls.find((c) => c.method === "chat.postMessage");
  assert.ok(task?.body.text?.includes("«mañana»"), task?.body.text);
});

test("runApprovalTimeouts: the same overnight draft WITHOUT relative dates sends at 08:00", async () => {
  slackCalls.length = 0;
  const row = approval({ created_at: FRI_7PM, slack_ts: "1700000000.000001", draft: "Estamos en Av. México 49, 1er piso, Condesa 📍" });
  const { queries, log } = makeQueries([row]);
  const { deps, log: sendLog } = makeDeps();
  await runApprovalTimeouts(envWith(withSureness(70)), queries, { ...deps, now: SAT_805 });
  assert.deepEqual(log.resolved, [{ id: 42, status: "auto_sent" }]);
  assert.equal(sendLog.sends[0]!.body, row.draft);
  assert.ok(slackCalls[0]!.body.text!.includes("min sin revisión"), slackCalls[0]!.body.text);
});

test("runApprovalTimeouts: a CONFIDENT overnight draft (≥ 75 %) sends 15 min later, not at 08:00 (owner 2026-11-11)", async () => {
  slackCalls.length = 0;
  const row = approval({ created_at: FRI_7PM, slack_ts: "1700000000.000001", draft: "Estamos en Av. México 49, 1er piso, Condesa 📍" });
  const at = FRI_7PM + 16 * 60; // 21:56 CDMX
  {
    const { queries, log } = makeQueries([row], { lastInboundAt: FRI_7PM - 30 });
    const { deps, log: sendLog } = makeDeps();
    await runApprovalTimeouts(envWith(withSureness(80)), queries, { ...deps, now: at });
    assert.deepEqual(log.resolved, [{ id: 42, status: "auto_sent" }]);
    assert.equal(sendLog.sends[0]!.body, row.draft);
  }
  // 70 % is safe by day but not confident enough for the night: it waits.
  {
    const { queries, log } = makeQueries([row], { lastInboundAt: FRI_7PM - 30 });
    const { deps, log: sendLog } = makeDeps();
    await runApprovalTimeouts(envWith(withSureness(70)), queries, { ...deps, now: at });
    assert.deepEqual(log.resolved, []);
    assert.equal(sendLog.sends.length, 0);
  }
});

test("runApprovalTimeouts: the lead wrote again after the draft ⇒ fresh brain turn, old card superseded", async () => {
  slackCalls.length = 0;
  const row = stale({ created_at: NOW - 30 * 60 });
  const { queries, log } = makeQueries([row], { lastInboundAt: NOW - 10 * 60 });
  let regenerated = 0;
  await runApprovalTimeouts(envWith(withSureness(60)), queries, {
    async sendText() {
      throw new Error("must not send");
    },
    now: NOW,
    async regenerate() {
      regenerated++;
    },
  });
  assert.equal(regenerated, 1);
  assert.deepEqual(log.resolved, [{ id: 42, status: "superseded" }]);
});

test("runApprovalTimeouts: one regeneration per phone per 3 h — the second moot draft escalates", async () => {
  slackCalls.length = 0;
  const db = withSureness(60, { "regen:5215512345678": String(NOW - 600) });
  const { queries, log } = makeQueries([stale({ created_at: NOW - 30 * 60 })], { lastInboundAt: NOW - 10 * 60 });
  let regenerated = 0;
  await runApprovalTimeouts(envWith(db), queries, {
    sendText: async () => "x",
    now: NOW,
    async regenerate() {
      regenerated++;
    },
  });
  assert.equal(regenerated, 0);
  assert.deepEqual(log.resolved, []);
  assert.equal(slackCalls.filter((c) => c.method === "chat.postMessage").length, 1);
});

test("runApprovalTimeouts: staff already answered after the draft ⇒ superseded, nothing sent", async () => {
  slackCalls.length = 0;
  const { queries, log } = makeQueries([stale()], { staffReplied: true });
  const { deps, log: sendLog } = makeDeps();
  await runApprovalTimeouts(envWith(withSureness(60)), queries, deps);
  assert.deepEqual(log.resolved, [{ id: 42, status: "superseded" }]);
  assert.equal(sendLog.sends.length, 0);
});

test("runApprovalTimeouts: kill switch ⇒ nothing automated goes out; a human is paged", async () => {
  slackCalls.length = 0;
  const { queries } = makeQueries([stale()]);
  const { deps, log: sendLog } = makeDeps();
  await runApprovalTimeouts(envWith(withSureness(90, { bot_enabled: "false" })), queries, deps);
  assert.equal(sendLog.sends.length, 0);
  const task = slackCalls.find((c) => c.method === "chat.postMessage");
  assert.ok(task?.body.text?.includes("bot apagado"), task?.body.text);
});

test("runApprovalTimeouts: several unsafe rows ⇒ ONE task listing all of them", async () => {
  slackCalls.length = 0;
  const db = withSureness(10, { [surenessKey(43)]: "10" });
  const rows = [
    stale({ context: "👤 ¿Qué horarios tienen?" }),
    stale({ id: 43, phone: "5215599999999", context: "👤 tuve una operación" }),
  ];
  const { queries } = makeQueries(rows);
  const { deps } = makeDeps();
  await runApprovalTimeouts(envWith(db), queries, deps);
  const posts = slackCalls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 1);
  const text = posts[0]!.body.text!;
  assert.ok(text.includes("2 leads") && text.includes("«¿Qué horarios tienen?»") && text.includes("5215599999999"), text);
  assert.ok(timeoutEscalatedKey(43).startsWith("tmo_esc:"));
});

test("runApprovalTimeouts: the holding line follows the lead's language", async () => {
  slackCalls.length = 0;
  const { queries } = makeQueries([approval()], { lang: "en" });
  const { deps, log: sendLog } = makeDeps();
  await runApprovalTimeouts(envWith(fakeDb()), queries, deps);
  assert.equal(sendLog.sends.length, 1);
  assert.ok(sendLog.sends[0]!.body.startsWith("Thanks for your message!"), sendLog.sends[0]!.body);
});
