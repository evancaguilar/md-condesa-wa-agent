// Turn runner scheduling core (src/pipeline/turn-queue-core.ts): the Durable
// Object's queue must reproduce the inline debounce exactly — each message due
// 8 s after it passed the gates, and only the phone's newest inbound runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueTurn,
  nextAlarmAt,
  pickTurn,
  splitDue,
  MAX_PENDING_TURNS,
  TURN_DEBOUNCE_MS,
  type PendingEntry,
} from "../src/pipeline/turn-queue-core.js";

const T0 = 1_760_000_000_000;

test("a queued turn is due one debounce later and sets the alarm", () => {
  const q = enqueueTurn([], "w1", { n: 1 }, T0);
  assert.equal(q.length, 1);
  assert.equal(q[0]!.dueAt, T0 + TURN_DEBOUNCE_MS);
  assert.equal(nextAlarmAt(q), T0 + TURN_DEBOUNCE_MS);
  assert.equal(nextAlarmAt([]), null);
});

test("a burst keeps per-message due times; the alarm follows the earliest", () => {
  let q: PendingEntry<{ n: number }>[] = [];
  q = enqueueTurn(q, "w1", { n: 1 }, T0);
  q = enqueueTurn(q, "w2", { n: 2 }, T0 + 3000);
  assert.equal(nextAlarmAt(q), T0 + TURN_DEBOUNCE_MS);
  const first = splitDue(q, T0 + TURN_DEBOUNCE_MS);
  assert.deepEqual(first.due.map((e) => e.wamid), ["w1"]);
  assert.deepEqual(first.keep.map((e) => e.wamid), ["w2"]);
  assert.equal(nextAlarmAt(first.keep), T0 + 3000 + TURN_DEBOUNCE_MS);
});

test("only the newest inbound runs (inline newest-wamid check)", () => {
  const q = enqueueTurn(enqueueTurn([], "w1", { n: 1 }, T0), "w2", { n: 2 }, T0 + 1000);
  const { due } = splitDue(q, T0 + 60_000);
  assert.equal(pickTurn(due, "w2")?.turn.n, 2);
  // w1 came due while w2 (newer) is the lead's latest message: w1 is dropped
  assert.equal(pickTurn(splitDue(q, T0 + TURN_DEBOUNCE_MS).due, "w2"), null);
  // a newer message that ended at a gate (never queued) supersedes them all
  assert.equal(pickTurn(due, "w3"), null);
  assert.equal(pickTurn(due, null), null);
});

test("re-enqueueing the same wamid keeps its original due time", () => {
  const q1 = enqueueTurn([], "w1", { n: 1 }, T0);
  const q2 = enqueueTurn(q1, "w1", { n: 1 }, T0 + 5000);
  assert.equal(q2.length, 1);
  assert.equal(q2[0]!.dueAt, T0 + TURN_DEBOUNCE_MS);
});

test("the queue is capped, oldest entries dropped", () => {
  let q: PendingEntry<{ n: number }>[] = [];
  for (let i = 0; i < MAX_PENDING_TURNS + 5; i++) q = enqueueTurn(q, `w${i}`, { n: i }, T0 + i);
  assert.equal(q.length, MAX_PENDING_TURNS);
  assert.equal(q[0]!.wamid, "w5");
  assert.equal(q[q.length - 1]!.wamid, `w${MAX_PENDING_TURNS + 4}`);
});

test("an early alarm with nothing due keeps every entry", () => {
  const q = enqueueTurn([], "w1", { n: 1 }, T0);
  const { due, keep } = splitDue(q, T0 + TURN_DEBOUNCE_MS - 1);
  assert.equal(due.length, 0);
  assert.equal(keep.length, 1);
});
