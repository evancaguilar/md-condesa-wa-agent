import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalHistorySql,
  parseApprovalHistoryParams,
  type ApprovalHistoryQuery,
} from "../src/db/approvals-history.js";

const NOW = Date.parse("2026-08-25T16:00:00Z") / 1000;
const DAY = 86400;

const baseQuery = (over: Partial<ApprovalHistoryQuery> = {}): ApprovalHistoryQuery => ({
  since: NOW - 15 * DAY,
  limit: 100,
  offset: 0,
  ...over,
});

/** Distinct ?N placeholders actually referenced by the statement. */
function placeholderCount(sql: string): number {
  const refs = new Set(sql.match(/\?\d+/g) ?? []);
  return refs.size;
}

// ---- param parsing ----

test("parseApprovalHistoryParams: defaults to a 15-day window, limit 100, offset 0", () => {
  const r = parseApprovalHistoryParams(new URLSearchParams(""), NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.query.since, NOW - 15 * DAY);
  assert.equal(r.query.until, undefined);
  assert.equal(r.query.status, undefined);
  assert.equal(r.query.phone, undefined);
  assert.equal(r.query.limit, 100);
  assert.equal(r.query.offset, 0);
});

test("parseApprovalHistoryParams: explicit since wins over the default window", () => {
  const r = parseApprovalHistoryParams(new URLSearchParams("since=1700000000"), NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.query.since, 1_700_000_000);
});

test("parseApprovalHistoryParams: unparseable since ⇒ bad_since (no silent full scan)", () => {
  assert.deepEqual(parseApprovalHistoryParams(new URLSearchParams("since=ayer"), NOW), {
    ok: false,
    error: "bad_since",
  });
  assert.deepEqual(parseApprovalHistoryParams(new URLSearchParams("since=-5"), NOW), {
    ok: false,
    error: "bad_since",
  });
});

test("parseApprovalHistoryParams: status omitted or 'all' ⇒ no status filter", () => {
  for (const qs of ["", "status=", "status=all"]) {
    const r = parseApprovalHistoryParams(new URLSearchParams(qs), NOW);
    assert.equal(r.ok, true, qs);
    if (!r.ok) return;
    assert.equal(r.query.status, undefined, qs);
    assert.ok(!buildApprovalHistorySql(r.query).sql.includes("status ="), qs);
  }
});

test("parseApprovalHistoryParams: unknown status ⇒ bad_status", () => {
  assert.deepEqual(parseApprovalHistoryParams(new URLSearchParams("status=sent"), NOW), {
    ok: false,
    error: "bad_status",
  });
  // Injection attempt through the status filter never reaches the builder.
  assert.deepEqual(
    parseApprovalHistoryParams(new URLSearchParams("status=pending' OR 1=1--"), NOW),
    { ok: false, error: "bad_status" },
  );
});

test("parseApprovalHistoryParams: every ApprovalStatus member is accepted", () => {
  for (const s of [
    "pending",
    "approved",
    "edited",
    "taken_over",
    "expired",
    "discarded",
    "superseded",
  ]) {
    const r = parseApprovalHistoryParams(new URLSearchParams(`status=${s}`), NOW);
    assert.equal(r.ok, true, s);
    if (!r.ok) return;
    assert.equal(r.query.status, s);
  }
});

test("parseApprovalHistoryParams: limit clamps to 200, junk falls back to defaults", () => {
  const big = parseApprovalHistoryParams(new URLSearchParams("limit=9999&offset=40"), NOW);
  assert.equal(big.ok, true);
  if (!big.ok) return;
  assert.equal(big.query.limit, 200);
  assert.equal(big.query.offset, 40);

  const junk = parseApprovalHistoryParams(new URLSearchParams("limit=abc&offset=-3"), NOW);
  assert.equal(junk.ok, true);
  if (!junk.ok) return;
  assert.equal(junk.query.limit, 100);
  assert.equal(junk.query.offset, 0);
});

// ---- SQL building ----

test("buildApprovalHistorySql: window-only query is one bind + limit/offset", () => {
  const { sql, binds } = buildApprovalHistorySql(baseQuery());
  assert.ok(sql.includes("FROM pending_approvals"));
  assert.ok(sql.includes("created_at >= ?1"));
  assert.ok(!sql.includes("status ="));
  assert.ok(!sql.includes("phone ="));
  assert.deepEqual(binds, [NOW - 15 * DAY, 100, 0]);
});

test("buildApprovalHistorySql: status=edited emits the clause and the bind", () => {
  const { sql, binds } = buildApprovalHistorySql(baseQuery({ status: "edited" }));
  assert.ok(/status = \?\d+/.test(sql));
  assert.ok(!sql.includes("'edited'"), "status must never be interpolated");
  assert.ok(binds.includes("edited"));
});

test("buildApprovalHistorySql: phone filter is an exact-match bind", () => {
  const { sql, binds } = buildApprovalHistorySql(baseQuery({ phone: "5215512345678" }));
  assert.ok(/phone = \?\d+/.test(sql));
  assert.ok(!sql.includes("5215512345678"));
  assert.ok(binds.includes("5215512345678"));
});

test("buildApprovalHistorySql: until adds an exclusive upper bound", () => {
  const { sql, binds } = buildApprovalHistorySql(baseQuery({ until: NOW }));
  assert.ok(/created_at < \?\d+/.test(sql));
  assert.deepEqual(binds, [NOW - 15 * DAY, NOW, 100, 0]);
});

test("buildApprovalHistorySql: newest first (created_at DESC, id DESC tiebreak)", () => {
  const { sql } = buildApprovalHistorySql(baseQuery());
  assert.ok(sql.includes("ORDER BY created_at DESC, id DESC"));
});

test("buildApprovalHistorySql: limit/offset are binds, never interpolated", () => {
  const { sql, binds } = buildApprovalHistorySql(baseQuery({ limit: 37, offset: 74 }));
  assert.ok(/LIMIT \?\d+ OFFSET \?\d+/.test(sql));
  assert.ok(!sql.includes("37") && !sql.includes("74"));
  assert.equal(binds[binds.length - 2], 37);
  assert.equal(binds[binds.length - 1], 74);
});

test("buildApprovalHistorySql: placeholder count matches bind count in every combo", () => {
  const combos: ApprovalHistoryQuery[] = [
    baseQuery(),
    baseQuery({ status: "approved" }),
    baseQuery({ phone: "5215500000000" }),
    baseQuery({ until: NOW }),
    baseQuery({ until: NOW, status: "expired", phone: "5215500000000", offset: 10 }),
  ];
  for (const q of combos) {
    const { sql, binds } = buildApprovalHistorySql(q);
    assert.equal(placeholderCount(sql), binds.length, sql);
  }
});

test("buildApprovalHistorySql: a phone carrying SQL stays ONE inert bind", () => {
  const nasty = "521'; DROP TABLE pending_approvals; --";
  const { sql, binds } = buildApprovalHistorySql(baseQuery({ phone: nasty }));
  assert.ok(!sql.includes("DROP"));
  assert.equal(binds.filter((b) => b === nasty).length, 1);
  assert.equal(placeholderCount(sql), binds.length);
});
