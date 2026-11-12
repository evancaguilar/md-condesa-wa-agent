import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeCandidates,
  isOwed,
  OWED_MAX_AGE_SEC,
  owedDoneKey,
  owedWindow,
  selectOwed,
  waMeLink,
  type OwedCandidate,
  type OwedFacts,
} from "../src/services/owed-approvals.js";
import { approveAndSend, editAndSend } from "../src/services/approvals.js";
import type { Contact, Env, PendingApproval } from "../src/types.js";

// Fixed CDMX afternoon: 2026-11-11 15:00 America/Mexico_City (21:00Z).
const NOW = Date.parse("2026-11-11T21:00:00Z") / 1000;
const H = 3600;

const cand = (over: Partial<OwedCandidate> = {}): OwedCandidate => ({
  id: 100,
  phone: "5215512345678",
  createdAt: NOW - 13 * H, // just past the 12 h expiry
  expiredAt: NOW - 1 * H,
  ...over,
});
const facts = (over: Partial<OwedFacts> = {}): OwedFacts => ({
  latestIdForPhone: 100,
  humanReplyAfter: false,
  handled: false,
  optedOut: false,
  lastInboundAt: NOW - 13 * H,
  ...over,
});

// ---- isOwed ----------------------------------------------------------------

test("isOwed: a fresh expired row with nothing else going on stays visible", () => {
  assert.equal(isOwed(cand(), facts(), NOW), true);
});

test("isOwed: «Ya lo atendí» / Slack template marker drops it", () => {
  assert.equal(isOwed(cand(), facts({ handled: true }), NOW), false);
});

test("isOwed: a human reply after the draft was queued drops it", () => {
  assert.equal(isOwed(cand(), facts({ humanReplyAfter: true }), NOW), false);
});

test("isOwed: a newer approval for the same phone supersedes it", () => {
  assert.equal(isOwed(cand(), facts({ latestIdForPhone: 101 }), NOW), false);
});

test("isOwed: opted-out lead never shows", () => {
  assert.equal(isOwed(cand(), facts({ optedOut: true }), NOW), false);
});

test("isOwed: older than a week falls off; exactly a week still shows", () => {
  assert.equal(isOwed(cand({ createdAt: NOW - OWED_MAX_AGE_SEC - 1 }), facts(), NOW), false);
  assert.equal(isOwed(cand({ createdAt: NOW - OWED_MAX_AGE_SEC }), facts(), NOW), true);
});

test("isOwed: unknown latest id (no rows?) does not hide it", () => {
  assert.equal(isOwed(cand(), facts({ latestIdForPhone: null }), NOW), true);
});

// ---- window ----------------------------------------------------------------

test("owedWindow: 13 h since the last inbound ⇒ open, 11 h left", () => {
  assert.deepEqual(owedWindow(NOW - 13 * H, NOW), { windowOpen: true, windowHoursLeft: 11 });
});

test("owedWindow: partial hour rounds up; exactly 24 h is closed", () => {
  assert.deepEqual(owedWindow(NOW - 23 * H - 1800, NOW), { windowOpen: true, windowHoursLeft: 1 });
  assert.deepEqual(owedWindow(NOW - 24 * H, NOW), { windowOpen: false, windowHoursLeft: 0 });
});

test("owedWindow: no inbound on record ⇒ closed", () => {
  assert.deepEqual(owedWindow(null, NOW), { windowOpen: false, windowHoursLeft: 0 });
});

// ---- dedupe / select -------------------------------------------------------

test("dedupeCandidates: newest row per phone, newest first", () => {
  const rows = [
    cand({ id: 1, phone: "521A", createdAt: NOW - 50 * H }),
    cand({ id: 5, phone: "521A", createdAt: NOW - 20 * H }),
    cand({ id: 3, phone: "521B", createdAt: NOW - 14 * H }),
  ];
  assert.deepEqual(
    dedupeCandidates(rows).map((r) => r.id),
    [3, 5],
  );
});

test("selectOwed: filters, attaches window state, sorts newest first", () => {
  const out = selectOwed(
    [
      { row: cand({ id: 10, phone: "521A", createdAt: NOW - 30 * H }), facts: facts({ latestIdForPhone: 10, lastInboundAt: NOW - 30 * H }) },
      { row: cand({ id: 11, phone: "521B", createdAt: NOW - 13 * H }), facts: facts({ latestIdForPhone: 11 }) },
      { row: cand({ id: 12, phone: "521C" }), facts: facts({ latestIdForPhone: 12, handled: true }) },
    ],
    NOW,
  );
  assert.deepEqual(
    out.map((o) => [o.id, o.windowOpen, o.windowHoursLeft]),
    [
      [11, true, 11],
      [10, false, 0],
    ],
  );
});

// ---- links / keys ----------------------------------------------------------

test("waMeLink: digits phone + draft ⇒ prefilled, URL-encoded", () => {
  assert.equal(
    waMeLink("5215512345678", "¡Hola! ¿Te late el martes 7 pm?"),
    "https://wa.me/5215512345678?text=" + encodeURIComponent("¡Hola! ¿Te late el martes 7 pm?"),
  );
});

test("waMeLink: no draft ⇒ bare link; IG/FB ids ⇒ null", () => {
  assert.equal(waMeLink("5215512345678", null), "https://wa.me/5215512345678");
  assert.equal(waMeLink("5215512345678", "   "), "https://wa.me/5215512345678");
  assert.equal(waMeLink("ig:1234567890", "hola"), null);
  assert.equal(waMeLink("", "hola"), null);
});

test("waMeLink: very long draft is capped", () => {
  const link = waMeLink("5215512345678", "a".repeat(5000))!;
  assert.equal(link.length, "https://wa.me/5215512345678?text=".length + 1500);
});

test("owedDoneKey shape", () => {
  assert.equal(owedDoneKey(42), "owed_done:42");
});

// ---- approve/edit on an expired row (panel-only allowExpired) --------------

type Handler = (sql: string, binds: unknown[]) => { first?: unknown; changes?: number };
function fakeDb(handler: Handler): D1Database {
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (handler(sql, binds).first ?? null) as T | null;
      },
      async run() {
        return { results: [], meta: { changes: handler(sql, binds).changes ?? 1 } };
      },
      async all<T>() {
        return { results: [] as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { prepare: make } as unknown as D1Database;
}
const envWith = (db: D1Database): Env =>
  ({ DB: db, WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t" }) as unknown as Env;

const expiredRow = (): PendingApproval => ({
  id: 77,
  phone: "5215512345678",
  draft: "¿Te late el martes?",
  context: null,
  confidence: "low",
  status: "expired",
  slack_ts: null,
  final_text: null,
  holding_sent: 0,
  created_at: NOW - 13 * H,
  resolved_at: NOW - H,
});
const optedOut = (): Contact =>
  ({
    phone: "5215512345678",
    name: "Ana",
    lang: "es",
    status: "opted_out",
    qualification: null,
    human_override_until: null,
    last_inbound_at: NOW - 13 * H,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
  }) as Contact;

/** Records each claim UPDATE's (new status, from status); refuses a claim from the wrong status like D1 would. */
function claimRecorder(row: PendingApproval) {
  const claims: Array<{ to: unknown; from: unknown }> = [];
  const db = fakeDb((sql, binds) => {
    if (sql.includes("SELECT * FROM pending_approvals")) return { first: row };
    if (sql.includes("SELECT * FROM contacts")) return { first: optedOut() };
    if (sql.includes("UPDATE pending_approvals") && sql.includes("status = ?5")) {
      claims.push({ to: binds[1], from: binds[4] });
      return { changes: binds[4] === row.status ? 1 : 0 };
    }
    return {};
  });
  return { db, claims };
}

test("approveAndSend: expired row WITHOUT allowExpired (Slack) claims from pending ⇒ not_pending", async () => {
  const { db, claims } = claimRecorder(expiredRow());
  const res = await approveAndSend(envWith(db), 77);
  assert.deepEqual(res, { ok: false, reason: "not_pending" });
  assert.deepEqual(claims, [{ to: "discarded", from: "pending" }]);
});

test("approveAndSend: expired row WITH allowExpired (panel) claims from expired", async () => {
  const { db, claims } = claimRecorder(expiredRow());
  // Opted-out contact short-circuits before any Graph call — proves the claim
  // targets the expired row without needing a send stub.
  const res = await approveAndSend(envWith(db), 77, { allowExpired: true });
  assert.deepEqual(res, { ok: false, reason: "opted_out" });
  assert.deepEqual(claims, [{ to: "discarded", from: "expired" }]);
});

test("editAndSend: allowExpired on a PENDING row still claims from pending", async () => {
  const { db, claims } = claimRecorder({ ...expiredRow(), status: "pending" });
  const res = await editAndSend(envWith(db), 77, "Hola", { allowExpired: true });
  assert.deepEqual(res, { ok: false, reason: "opted_out" });
  assert.deepEqual(claims, [{ to: "discarded", from: "pending" }]);
});
