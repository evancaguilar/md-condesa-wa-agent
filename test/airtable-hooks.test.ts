// "Se inscribió" push hook — src/routes/airtable-hooks.ts (handler against
// injected fakes) and its two cron-side guards in src/cron/followups.ts:
// runStudentKitNow's claim on the kit row and processResult's enrolment lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_RATE_PER_MIN,
  handleEnrolledHook,
  hookKeyOk,
  hookRateKey,
  type EnrolledHookDeps,
} from "../src/routes/airtable-hooks.js";
import {
  KIT_CLAIM_LEASE_SEC,
  processResult,
  runStudentKitNow,
} from "../src/cron/followups.js";
import type { BookingRecord } from "../src/services/airtable.js";
import type { Env, Followup } from "../src/types.js";

const KEY = "test-hook-key";
const REC = "recAbCdEfGhIjKlMn";
const PHONE_RAW = "+52 55 1234 5678";
const PHONE = "5215512345678";

function lead(result: string | null, phone: string | null = PHONE_RAW): BookingRecord {
  return {
    id: REC,
    phone,
    name: "Ana López",
    trialDateTimeIso: "2026-10-12T18:00:00-06:00",
    result,
    initialPayment: 1500,
    leadIncome: null,
  };
}

interface Calls {
  processResult: { rec: BookingRecord; phone: string }[];
  runKit: { phone: string; recordId: string }[];
  notes: string[];
  order: string[];
}

function fakeDeps(over: Partial<EnrolledHookDeps> = {}, record: BookingRecord | null = lead("Asistió, Se inscribió")) {
  const calls: Calls = { processResult: [], runKit: [], notes: [], order: [] };
  let count = 0;
  const deps: EnrolledHookDeps = {
    hookKey: KEY,
    nowMs: () => 1_760_000_000_000,
    async rateLimit() {
      count++;
      return count <= HOOK_RATE_PER_MIN;
    },
    async getRecord() {
      return record;
    },
    async processResult(rec, phone) {
      calls.processResult.push({ rec, phone });
      calls.order.push("welcome");
      return "sent";
    },
    async runKit(phone, recordId) {
      calls.runKit.push({ phone, recordId });
      calls.order.push("kit");
      return "sent";
    },
    async postNote(t) {
      calls.notes.push(t);
    },
    waitUntil() {},
    ...over,
  };
  return { deps, calls };
}

function req(body: unknown, key: string | null = KEY, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["X-Hook-Key"] = key;
  return new Request("https://w.example/hooks/airtable/enrolled", {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

// ---- auth ----

test("hook: missing or wrong X-Hook-Key → 401, nothing read or sent", async () => {
  for (const k of [null, "", "wrong-key", KEY + "x"]) {
    const { deps, calls } = fakeDeps({
      async getRecord() {
        throw new Error("must not read");
      },
    });
    const res = await handleEnrolledHook(req({ recordId: REC }, k), deps);
    assert.equal(res.status, 401, String(k));
    assert.equal(calls.processResult.length + calls.runKit.length, 0);
  }
});

test("hook: unset AIRTABLE_HOOK_KEY refuses everything", async () => {
  const { deps } = fakeDeps({ hookKey: undefined });
  assert.equal((await handleEnrolledHook(req({ recordId: REC }, ""), deps)).status, 401);
  assert.equal(hookKeyOk(undefined, "anything"), false);
  assert.equal(hookKeyOk("", ""), false);
  assert.equal(hookKeyOk(KEY, KEY), true);
});

test("hook: GET → 405; bad recordId → 400", async () => {
  const { deps } = fakeDeps();
  assert.equal((await handleEnrolledHook(req(null, KEY, "GET"), deps)).status, 405);
  for (const b of [{}, { recordId: "rec123" }, { recordId: 5 }, { recordId: "xyzAbCdEfGhIjKlMn" }]) {
    assert.equal((await handleEnrolledHook(req(b), deps)).status, 400, JSON.stringify(b));
  }
});

// ---- trust: only Airtable's own value counts ----

test("hook: record not marked Se inscribió → 200 not_enrolled, no sends", async () => {
  for (const result of [null, "Asistió", "No asistió", "Dijo que se va a inscribir", "Asistió, Perdido"]) {
    const { deps, calls } = fakeDeps({}, lead(result));
    const res = await handleEnrolledHook(req({ recordId: REC }), deps);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: boolean; welcome: string; kit: string };
    assert.equal(j.ok, true);
    assert.equal(j.welcome, "not_enrolled", String(result));
    assert.equal(j.kit, "skipped");
    assert.equal(calls.processResult.length + calls.runKit.length, 0);
    assert.equal(calls.notes.length, 0);
  }
});

test("hook: unknown record / no phone → no sends", async () => {
  let r = fakeDeps({}, null);
  let j = (await (await handleEnrolledHook(req({ recordId: REC }), r.deps)).json()) as { welcome: string };
  assert.equal(j.welcome, "not_found");
  assert.equal(r.calls.processResult.length, 0);
  r = fakeDeps({}, lead("Se inscribió", null));
  j = (await (await handleEnrolledHook(req({ recordId: REC }), r.deps)).json()) as { welcome: string };
  assert.equal(j.welcome, "no_phone");
  assert.equal(r.calls.processResult.length + r.calls.runKit.length, 0);
});

// ---- the happy path ----

test("hook: enrolled → processResult with the mapped record, THEN the kit; no Slack note", async () => {
  const { deps, calls } = fakeDeps();
  const res = await handleEnrolledHook(req({ recordId: ` ${REC} ` }), deps);
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean; welcome: string; kit: string; ms: number };
  assert.deepEqual({ ok: j.ok, welcome: j.welcome, kit: j.kit }, { ok: true, welcome: "sent", kit: "sent" });
  assert.equal(typeof j.ms, "number");
  assert.deepEqual(calls.order, ["welcome", "kit"]);
  assert.equal(calls.processResult[0]?.phone, PHONE);
  assert.equal(calls.processResult[0]?.rec.id, REC);
  assert.deepEqual(calls.runKit, [{ phone: PHONE, recordId: REC }]);
  assert.equal(calls.notes.length, 0);
});

test("hook: welcome already handled by the cron → still runs the pending kit now", async () => {
  const { deps, calls } = fakeDeps({
    async processResult() {
      return "already";
    },
    async runKit() {
      calls.order.push("kit");
      return "scheduled";
    },
  });
  const j = (await (await handleEnrolledHook(req({ recordId: REC }), deps)).json()) as { welcome: string; kit: string };
  assert.deepEqual([j.welcome, j.kit], ["already", "scheduled"]);
});

test("hook: cron holds the enrolment claim (busy) → kit left to the cron", async () => {
  const { deps, calls } = fakeDeps({
    async processResult() {
      return "busy";
    },
  });
  const j = (await (await handleEnrolledHook(req({ recordId: REC }), deps)).json()) as { welcome: string; kit: string };
  assert.deepEqual([j.welcome, j.kit], ["busy", "cron"]);
  assert.equal(calls.runKit.length, 0);
});

test("hook: a kit failure never fails the welcome or the response; ONE Slack note", async () => {
  const { deps, calls } = fakeDeps({
    async runKit() {
      throw new Error("graph down");
    },
  });
  const res = await handleEnrolledHook(req({ recordId: REC }), deps);
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean; welcome: string; kit: string };
  assert.deepEqual([j.ok, j.welcome, j.kit], [true, "sent", "error"]);
  assert.equal(calls.notes.length, 1);
  assert.match(calls.notes[0] ?? "", /kit/);
});

test("hook: welcome throws → kit still attempted, 200 with ok:false + one note", async () => {
  const { deps, calls } = fakeDeps({
    async processResult() {
      throw new Error("send failed");
    },
  });
  const res = await handleEnrolledHook(req({ recordId: REC }), deps);
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean; welcome: string; kit: string };
  assert.deepEqual([j.ok, j.welcome, j.kit], [false, "error", "sent"]);
  assert.equal(calls.runKit.length, 1);
  assert.equal(calls.notes.length, 1);
});

test("hook: Airtable read fails → 200 ok:false, one note, no sends", async () => {
  const { deps, calls } = fakeDeps({
    async getRecord() {
      throw new Error("HTTP 503");
    },
  });
  const j = (await (await handleEnrolledHook(req({ recordId: REC }), deps)).json()) as { ok: boolean; welcome: string };
  assert.deepEqual([j.ok, j.welcome], [false, "error"]);
  assert.equal(calls.processResult.length, 0);
  assert.equal(calls.notes.length, 1);
});

test("hook: replies 'pending' within the budget; the work keeps running via waitUntil", async () => {
  const kept: Promise<unknown>[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { deps } = fakeDeps({
    budgetMs: 20,
    async processResult() {
      await gate;
      return "sent";
    },
    waitUntil(p) {
      kept.push(p);
    },
  });
  const j = (await (await handleEnrolledHook(req({ recordId: REC }), deps)).json()) as { welcome: string; kit: string };
  assert.deepEqual([j.welcome, j.kit], ["pending", "pending"]);
  assert.equal(kept.length, 1);
  release();
  const finished = (await kept[0]) as { welcome: string; kit: string };
  assert.deepEqual([finished.welcome, finished.kit], ["sent", "sent"]);
});

// ---- rate limit ----

test("hook: 60/min per key, then 429 (counter error fails open)", async () => {
  const { deps, calls } = fakeDeps();
  for (let i = 0; i < HOOK_RATE_PER_MIN; i++) {
    assert.equal((await handleEnrolledHook(req({ recordId: REC }), deps)).status, 200);
  }
  const res = await handleEnrolledHook(req({ recordId: REC }), deps);
  assert.equal(res.status, 429);
  assert.equal(calls.processResult.length, HOOK_RATE_PER_MIN);

  const broken = fakeDeps({
    async rateLimit() {
      throw new Error("d1 busy");
    },
  });
  assert.equal((await handleEnrolledHook(req({ recordId: REC }), broken.deps)).status, 200);
  assert.equal(hookRateKey(120_000), "ahk_rl:2");
});

// ---- cron-side guards (fake D1) ----

type Handler = (sql: string, binds: unknown[]) => { first?: unknown; changes?: number };

function fakeDb(handler: Handler) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        calls.push({ sql, binds });
        return (handler(sql, binds).first ?? null) as T | null;
      },
      async run() {
        calls.push({ sql, binds });
        return { results: [], meta: { changes: handler(sql, binds).changes ?? 1 } };
      },
      async all<T>() {
        calls.push({ sql, binds });
        return { results: [] as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { env: { DB: { prepare: make } as unknown as D1Database } as unknown as Env, calls };
}

const slack = {
  async postNote() {},
  async postAttendanceCheck() {},
};

function kitRow(dueAt: number): Followup {
  return {
    id: 42,
    phone: PHONE,
    kind: "student_kit",
    due_at: dueAt,
    status: "scheduled",
    airtable_record_id: REC,
    note: null,
    created_at: 0,
  } as Followup;
}

const nowS = () => Math.floor(Date.now() / 1000);

test("runStudentKitNow: claims a not-yet-due row (CAS on due_at) and runs it through processOne", async () => {
  const due = nowS() + 90;
  let status = "scheduled";
  const { env, calls } = fakeDb((sql, binds) => {
    if (/SELECT \* FROM followups/.test(sql)) return { first: kitRow(due) };
    if (/UPDATE followups SET due_at = \?2/.test(sql)) return { changes: 1 };
    // Baja keeps processOne offline: it marks the row and returns.
    if (/FROM contacts/.test(sql)) return { first: { phone: PHONE, status: "opted_out", lang: "es" } };
    if (/UPDATE followups SET status = \?2/.test(sql)) {
      status = String(binds[1]);
      return { changes: 1 };
    }
    if (/SELECT status FROM followups/.test(sql)) return { first: { status } };
    return {};
  });
  const out = await runStudentKitNow(env, { slack }, PHONE, REC);
  assert.equal(out, "cancelled");
  assert.equal(status, "skipped_optout");
  const claim = calls.find((c) => /UPDATE followups SET due_at = \?2/.test(c.sql));
  if (!claim) throw new Error("not claimed");
  assert.equal(claim.binds[0], 42);
  assert.ok((claim.binds[1] as number) >= nowS() + KIT_CLAIM_LEASE_SEC - 2, "leased out of the cron's reach");
  assert.equal(claim.binds[2], due, "compare-and-set on the old due_at");
});

test("runStudentKitNow: a row already due is left to the cron (no claim, no run)", async () => {
  const { env, calls } = fakeDb((sql) => {
    if (/SELECT \* FROM followups/.test(sql)) return { first: kitRow(nowS() - 5) };
    return {};
  });
  assert.equal(await runStudentKitNow(env, { slack }, PHONE, REC), "cron");
  assert.ok(!calls.some((c) => /UPDATE|contacts/.test(c.sql)));
});

test("runStudentKitNow: losing the claim (a concurrent caller won) → no run", async () => {
  const { env, calls } = fakeDb((sql) => {
    if (/SELECT \* FROM followups/.test(sql)) return { first: kitRow(nowS() + 90) };
    if (/UPDATE followups SET due_at = \?2/.test(sql)) return { changes: 0 };
    return {};
  });
  assert.equal(await runStudentKitNow(env, { slack }, PHONE, REC), "cron");
  assert.ok(!calls.some((c) => /contacts/.test(c.sql)));
});

test("runStudentKitNow: no scheduled row → none", async () => {
  const { env } = fakeDb(() => ({}));
  assert.equal(await runStudentKitNow(env, { slack }, PHONE, REC), "none");
});

test("processResult: enrolment claim held by another caller → busy, nothing touched", async () => {
  const { env, calls } = fakeDb((sql) => {
    if (/ON CONFLICT\(key\) DO UPDATE SET value = excluded.value/.test(sql)) return { changes: 0 };
    return {};
  });
  const out = await processResult(env, { slack }, REC, PHONE, "Se inscribió", "Ana", "2026-10-12T18:00:00-06:00");
  assert.equal(out, "busy");
  assert.ok(!calls.some((c) => /contacts|UPDATE followups|resultado:/.test(c.sql) && !/SELECT value FROM kv/.test(c.sql)));
  assert.ok(!calls.some((c) => c.binds[0] === `resultado:${REC}` && /INSERT/.test(c.sql)), "no marker written");
});

test("processResult: marker already set → already, no lock taken", async () => {
  const { env, calls } = fakeDb((sql, binds) => {
    if (/SELECT value FROM kv/.test(sql) && binds[0] === `resultado:${REC}`) return { first: { value: "enrolled" } };
    return {};
  });
  assert.equal(await processResult(env, { slack }, REC, PHONE, "Se inscribió", "Ana", null), "already");
  assert.ok(!calls.some((c) => c.binds[0] === `resultado_lock:${REC}`));
});
