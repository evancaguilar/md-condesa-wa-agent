import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeNoShowRebook,
  computePostTrialSequence,
  postTrialCopy,
  postTrialTemplateName,
  processPostTrial,
  POST_TRIAL_KINDS,
} from "../src/cron/post-trial.js";
import { classifyResult, isLostResult } from "../src/services/airtable.js";
import { capiEventsForResult } from "../src/services/meta-capi.js";
import { runDueFollowups, syncBookings } from "../src/cron/followups.js";
import { noShowCopy } from "../src/cron/nudges.js";
import { cdmxToEpoch, cdmxParts, DAY } from "../src/cron/time.js";
import type { Contact, Env } from "../src/types.js";

// ---- tiny scriptable fake D1 (mirrors cron.test.ts / nudges.test.ts) ----

type Handler = (sql: string, binds: unknown[]) => {
  first?: unknown;
  all?: unknown[];
  changes?: number;
};

function fakeDb(handler: Handler): {
  db: D1Database;
  calls: { sql: string; binds: unknown[] }[];
} {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
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
        return { results: (handler(sql, binds).all ?? []) as T[], meta: {} };
      },
    };
    return stmt;
  };
  return { db: { prepare: make }, calls };
}

function envWith(db: D1Database): Env {
  return {
    DB: db,
    AIRTABLE_BASE_ID: "appTest",
    AIRTABLE_TRIALS_TABLE: "Trials",
  } as unknown as Env;
}

function contact(over: Partial<Contact>): Contact {
  return {
    phone: "5215512345678",
    name: "Ana",
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: null,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

/** Stub the WA HTTP layer so sendText/sendTemplate succeed without real network. */
function stubFetchOk(): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { messages: [{ id: `wamid.${Math.random()}` }] };
    },
    async text() {
      return "";
    },
  });
}

// A trial on a Wednesday evening: 2026-09-16 19:00 CDMX.
const WED_TRIAL = cdmxToEpoch(2026, 9, 16, 19, 0, 0);

// ---- classification -------------------------------------------------------

test("classifyResult: bare 'Asistió' is attended, every accent/case variant", () => {
  assert.equal(classifyResult("Asistió"), "attended");
  assert.equal(classifyResult("asistio"), "attended");
  assert.equal(classifyResult("ASISTIÓ"), "attended");
  assert.equal(classifyResult("  Asistió  "), "attended");
});

test("classifyResult: 'No asistió' is never mistaken for attended", () => {
  assert.equal(classifyResult("No asistió"), "no_show");
  assert.equal(classifyResult("no asistio"), "no_show");
  assert.equal(classifyResult("NO   ASISTIÓ"), "no_show");
});

test("classifyResult: enrollment still wins over both", () => {
  assert.equal(classifyResult("Se inscribió"), "enrolled");
  assert.equal(classifyResult("Asistió, Se inscribió"), "enrolled");
  assert.equal(classifyResult("No asistió, Se inscribió"), "enrolled");
});

test("classifyResult: a multi-select join with a BARE asistio reads attended", () => {
  // Someone ticked both — the touch that assumes they came is the safe one.
  assert.equal(classifyResult("Asistió, No asistió"), "attended");
  assert.equal(classifyResult("No asistió, Asistió"), "attended");
});

test("classifyResult: unrelated values and empties stay null", () => {
  assert.equal(classifyResult("Reprogramó"), null);
  assert.equal(classifyResult("Pendiente"), null);
  assert.equal(classifyResult("Perdido"), null);
  assert.equal(classifyResult(""), null);
  assert.equal(classifyResult(null), null);
  assert.equal(classifyResult(undefined), null);
});

test("classifyResult: 'Dijo que se va a inscribir' is an INTENTION, never enrolled", () => {
  // One letter apart after normalization: "se inscribio" vs "…a inscribir".
  assert.equal(classifyResult("Dijo que se va a inscribir"), null);
  assert.equal(classifyResult("dijo que se va a inscribir"), null);
  // Next to "Asistió" it is the hottest lead there is — and still `attended`.
  assert.equal(classifyResult("Asistió, Dijo que se va a inscribir"), "attended");
  assert.equal(classifyResult("Dijo que se va a inscribir, Asistió"), "attended");
});

test("isLostResult reads 'Perdido' out of any join, and nothing else", () => {
  assert.equal(isLostResult("Perdido"), true);
  assert.equal(isLostResult("Asistió, Perdido"), true);
  assert.equal(isLostResult("No asistió, Perdido"), true);
  assert.equal(isLostResult("perdido"), true);
  assert.equal(isLostResult("Asistió"), false);
  assert.equal(isLostResult("Reprogramó"), false);
  assert.equal(isLostResult(null), false);
  // "Perdido" never changes what the outcome itself says.
  assert.equal(classifyResult("Asistió, Perdido"), "attended");
  assert.equal(classifyResult("No asistió, Perdido"), "no_show");
  assert.equal(classifyResult("Se inscribió, Perdido"), "enrolled");
});

// ---- post-trial timing (pure) --------------------------------------------

test("computePostTrialSequence: evening trial → same-day d0, then 11:00 d2/d5", () => {
  const marked = WED_TRIAL + 30 * 60; // marked half an hour after class
  const steps = computePostTrialSequence(WED_TRIAL, marked);
  const by = Object.fromEntries(steps.map((s) => [s.kind, s.dueAt]));
  // 19:00 + 3h = 22:00, past the 21:00 close → 09:30 the next morning.
  assert.equal(by["post_trial_d0"], cdmxToEpoch(2026, 9, 17, 9, 30, 0));
  assert.equal(by["post_trial_d2"], cdmxToEpoch(2026, 9, 18, 11, 0, 0));
  assert.equal(by["post_trial_d5"], cdmxToEpoch(2026, 9, 21, 11, 0, 0));
  assert.deepEqual(
    steps.map((s) => s.kind),
    [...POST_TRIAL_KINDS],
  );
});

test("computePostTrialSequence: a morning class gets its d0 the same afternoon", () => {
  const trial = cdmxToEpoch(2026, 9, 16, 11, 0, 0);
  const steps = computePostTrialSequence(trial, trial + 3600);
  const d0 = steps.find((s) => s.kind === "post_trial_d0")!;
  assert.equal(d0.dueAt, cdmxToEpoch(2026, 9, 16, 14, 0, 0)); // 11:00 + 3h, in-window
});

test("computePostTrialSequence: a 7:00 am class never writes before 09:30", () => {
  const trial = cdmxToEpoch(2026, 9, 16, 7, 0, 0); // +3h = 10:00, fine
  const early = cdmxToEpoch(2026, 9, 16, 5, 30, 0); // a 5:30 am class: +3h = 08:30
  assert.equal(
    computePostTrialSequence(trial, trial)[0]!.dueAt,
    cdmxToEpoch(2026, 9, 16, 10, 0, 0),
  );
  assert.equal(
    computePostTrialSequence(early, early)[0]!.dueAt,
    cdmxToEpoch(2026, 9, 16, 9, 30, 0),
  );
});

test("computePostTrialSequence: late-evening Saturday trial rolls d0 into Sunday", () => {
  const sat = cdmxToEpoch(2026, 9, 19, 20, 0, 0); // Saturday 8pm
  const steps = computePostTrialSequence(sat, sat + 600);
  const by = Object.fromEntries(steps.map((s) => [s.kind, s.dueAt]));
  assert.equal(by["post_trial_d0"], cdmxToEpoch(2026, 9, 20, 9, 30, 0)); // Sunday
  assert.equal(by["post_trial_d2"], cdmxToEpoch(2026, 9, 21, 11, 0, 0)); // Monday
  assert.equal(by["post_trial_d5"], cdmxToEpoch(2026, 9, 24, 11, 0, 0)); // Thursday
});

test("computePostTrialSequence: a Sunday trial crosses the month boundary cleanly", () => {
  const sun = cdmxToEpoch(2026, 9, 27, 10, 0, 0); // Sunday 2026-09-27
  const by = Object.fromEntries(
    computePostTrialSequence(sun, sun + 60).map((s) => [s.kind, s.dueAt]),
  );
  assert.equal(by["post_trial_d2"], cdmxToEpoch(2026, 9, 29, 11, 0, 0));
  assert.equal(by["post_trial_d5"], cdmxToEpoch(2026, 10, 2, 11, 0, 0));
  assert.equal(cdmxParts(by["post_trial_d5"]!).month, 10);
});

test("computePostTrialSequence: marked 3 days late keeps only what is still ahead", () => {
  const marked = WED_TRIAL + 3 * DAY; // Saturday evening
  const kinds = computePostTrialSequence(WED_TRIAL, marked).map((s) => s.kind);
  assert.deepEqual(kinds, ["post_trial_d5"]); // d0 stale, d2 (Friday 11:00) past
});

test("computePostTrialSequence: the 48h cutoff is what drops d0, not the clock alone", () => {
  const marked = WED_TRIAL + 2 * DAY + 3600; // Friday 20:00, d2 was Friday 11:00
  const late = WED_TRIAL + 2 * DAY - 12 * 3600; // Thursday ~07:00: past 48h? no
  assert.deepEqual(
    computePostTrialSequence(WED_TRIAL, late).map((s) => s.kind),
    ["post_trial_d0", "post_trial_d2", "post_trial_d5"],
  );
  assert.deepEqual(
    computePostTrialSequence(WED_TRIAL, marked).map((s) => s.kind),
    ["post_trial_d5"],
  );
});

test("computePostTrialSequence: a trial older than 5 days arms nothing", () => {
  assert.deepEqual(computePostTrialSequence(WED_TRIAL, WED_TRIAL + 6 * DAY), []);
  // …and neither does a nonsense record dated far in the future.
  assert.deepEqual(computePostTrialSequence(WED_TRIAL, WED_TRIAL - 3 * DAY), []);
  assert.deepEqual(computePostTrialSequence(NaN, WED_TRIAL), []);
});

test("every computed post-trial time sits inside 09:00–21:00 CDMX", () => {
  for (let h = 0; h < 24; h++) {
    const trial = cdmxToEpoch(2026, 9, 16, h, 0, 0);
    for (const step of computePostTrialSequence(trial, trial)) {
      const p = cdmxParts(step.dueAt);
      const minute = p.hour * 60 + p.minute;
      assert.ok(minute >= 9 * 60 && minute < 21 * 60, `${step.kind} @ ${p.hour}:${p.minute}`);
    }
  }
});

// ---- no-show rebook timing (pure) ----------------------------------------

test("computeNoShowRebook: 11:00 CDMX three days after the missed class", () => {
  const r = computeNoShowRebook(WED_TRIAL, WED_TRIAL + 12 * 3600);
  assert.equal(r?.kind, "no_show_d3");
  assert.equal(r?.dueAt, cdmxToEpoch(2026, 9, 19, 11, 0, 0));
});

test("computeNoShowRebook: nothing left to schedule when the moment has passed", () => {
  assert.equal(computeNoShowRebook(WED_TRIAL, WED_TRIAL + 4 * DAY), null);
  assert.equal(computeNoShowRebook(WED_TRIAL, WED_TRIAL + 9 * DAY), null);
  assert.equal(computeNoShowRebook(NaN, WED_TRIAL), null);
});

// ---- copy -----------------------------------------------------------------

test("post-trial copy: d0 asks how it felt, d2 closes the 48h hold, d5 links the schedule", () => {
  const c = contact({ name: "Ana" });
  const d0 = postTrialCopy(c, "post_trial_d0");
  assert.ok(d0.startsWith("¡Hola Ana!"), d0);
  assert.ok(/\?$/.test(d0.trim()), d0); // every touch ends on a question…
  const d2 = postTrialCopy(c, "post_trial_d2");
  assert.ok(/hoy/i.test(d2), d2);
  const d5 = postTrialCopy(c, "post_trial_d5");
  assert.ok(/https?:\/\//.test(d5), d5); // …except the goodbye, which links out
  // No invented pricing: the only number allowed is the KB's inscription fee.
  for (const body of [d0, d2, d5]) {
    for (const m of body.matchAll(/\$([\d,]+)/g)) assert.equal(m[1], "999");
  }
});

test("post-trial copy: an unknown push name leaves the greeting clean", () => {
  const body = postTrialCopy(contact({ name: "ana@gmail.com" }), "post_trial_d0");
  assert.ok(body.startsWith("¡Hola!"), body);
  assert.ok(!body.includes("gmail"), body);
});

test("post-trial copy: English contacts get the English variants", () => {
  const body = postTrialCopy(contact({ lang: "en", name: "Mike" }), "post_trial_d0");
  assert.ok(body.startsWith("Hi Mike!"), body);
});

test("no-show copy: the two touches differ and both close with a CTA + link", () => {
  const c = contact({});
  const now = cdmxToEpoch(2026, 9, 16, 12, 0, 0);
  const first = noShowCopy(c, "adults", "first", " Ana", "https://x.test/b", now);
  const d3 = noShowCopy(c, "adults", "d3", " Ana", "https://x.test/b", now);
  assert.notEqual(first, d3);
  for (const body of [first, d3]) {
    assert.ok(body.includes("https://x.test/b"), body);
    assert.ok(!body.includes("{cta}"), body);
  }
});

test("postTrialTemplateName: post-trial kinds are their own base, no_show_d3 reuses the existing one", () => {
  assert.equal(postTrialTemplateName("post_trial_d0"), "post_trial_d0");
  assert.equal(postTrialTemplateName("post_trial_d5"), "post_trial_d5");
  assert.equal(postTrialTemplateName("no_show_d3"), "no_show_followup");
});

// ---- send-time stop conditions -------------------------------------------

function sendDeps(sent: string[], opts: { windowClosed?: boolean; templateOk?: boolean } = {}) {
  class Closed extends Error {}
  return {
    sent,
    deps: {
      async sendText(_e: Env, _p: string, body: string) {
        if (opts.windowClosed) throw new Closed();
        sent.push(body);
        return "wamid.1";
      },
      async sendTemplate(_e: Env, _p: string, name: string) {
        if (opts.templateOk === false) throw new Error("template not found");
        sent.push(`[template:${name}]`);
        return "wamid.2";
      },
      templateName: (base: string, lang: string) =>
        lang === "en" ? `${base}_en` : `${base}_es`,
      isWindowClosed: (err: unknown) => err instanceof Closed,
    },
  };
}

/** A fake D1 that answers getContact with `c` and reports no booking rows. */
function contactDb(c: Contact | null, booking = false) {
  return fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts")) return { first: c };
    if (sql.includes("SELECT 1 AS n FROM followups")) return { first: booking ? { n: 1 } : null };
    return {};
  });
}

const ROW = { phone: "5215512345678", kind: "post_trial_d0" as const, created_at: 1000 };

test("processPostTrial: happy path sends the free-form body", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "sent" });
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes("¿Cómo te sentiste"), sent[0]);
});

test("processPostTrial: an opted-out lead gets silence", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ status: "opted_out" }));
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "skipped_optout" });
  assert.equal(sent.length, 0);
});

test("processPostTrial: a lead who enrolled meanwhile stops the whole chain", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ status: "student" }));
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "cancelled", stopChain: true });
  assert.equal(sent.length, 0);
});

test("processPostTrial: a reply since the row was armed stops the chain", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ last_inbound_at: ROW.created_at + 1 }));
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "cancelled", stopChain: true });
  assert.equal(sent.length, 0);
  // An inbound from BEFORE the arming is not a reason to stop.
  const fresh = sendDeps([]);
  const { db: db2 } = contactDb(contact({ last_inbound_at: ROW.created_at - 1 }));
  assert.deepEqual(
    await processPostTrial(envWith(db2), ROW, fresh.deps, WED_TRIAL),
    { outcome: "sent" },
  );
});

test("processPostTrial: a human takeover skips this touch only", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ human_override_until: WED_TRIAL + 3600 }));
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "cancelled" }); // no stopChain
  assert.equal(sent.length, 0);
});

test("processPostTrial: a new future booking stops the chain", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({}), true);
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "cancelled", stopChain: true });
  assert.equal(sent.length, 0);
});

test("processPostTrial: a closed window falls back to the per-kind template", async () => {
  const { sent, deps } = sendDeps([], { windowClosed: true });
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "sent" });
  assert.deepEqual(sent, ["[template:post_trial_d0_es]"]);
});

test("processPostTrial: no_show_d3 falls back to the existing no_show_followup template", async () => {
  const { sent, deps } = sendDeps([], { windowClosed: true });
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(
    envWith(db),
    { ...ROW, kind: "no_show_d3" },
    deps,
    WED_TRIAL,
  );
  assert.deepEqual(res, { outcome: "sent" });
  assert.deepEqual(sent, ["[template:no_show_followup_es]"]);
});

test("processPostTrial: an unapproved template reports template_missing, never retries blindly", async () => {
  const { sent, deps } = sendDeps([], { windowClosed: true, templateOk: false });
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(envWith(db), ROW, deps, WED_TRIAL);
  assert.deepEqual(res, { outcome: "template_missing", template: "post_trial_d0_es" });
  assert.equal(sent.length, 0);
});

// ---- the cron wiring (through runDueFollowups) ---------------------------

/**
 * Freeze the wall clock at a CDMX midday for the drain tests — runDueFollowups
 * re-checks quiet hours against Date.now(), so a suite run at 23:00 CDMX would
 * otherwise reschedule the row instead of processing it.
 */
async function atMidday(fn: () => Promise<void>): Promise<void> {
  const real = Date.now;
  Date.now = () => cdmxToEpoch(2026, 9, 21, 12, 0, 0) * 1000;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

/** Build a due followup row of `kind` for the drain tests. */
function dueRow(kind: string, over: Record<string, unknown> = {}) {
  return {
    id: 9,
    phone: "5215512345678",
    kind,
    due_at: 0,
    status: "scheduled",
    airtable_record_id: "recA",
    note: null,
    created_at: 1000,
    ...over,
  };
}

test("runDueFollowups: a post-trial row sends and is marked sent", async () => {
  await atMidday(async () => {
    stubFetchOk();
    const marks: { id: unknown; status: unknown }[] = [];
    const { db } = fakeDb((sql, binds) => {
      if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'"))
        return { all: [dueRow("post_trial_d0")] };
      if (sql.includes("SELECT * FROM contacts")) return { first: contact({}) };
      if (sql.includes("SELECT 1 AS n FROM followups")) return { first: null };
      if (sql.startsWith("UPDATE followups SET status")) {
        marks.push({ id: binds[0], status: binds[1] });
        return {};
      }
      return {};
    });
    await runDueFollowups(envWith(db), {
      slack: { async postNote() {}, async postAttendanceCheck() {} },
    });
    assert.deepEqual(marks, [{ id: 9, status: "sent" }]);
  });
});

test("runDueFollowups: a stopChain outcome cancels the rest of the chain by kind", async () => {
  await atMidday(async () => {
    stubFetchOk();
    let cancelledKinds: string[] | null = null;
    const { db } = fakeDb((sql, binds) => {
      if (sql.includes("SELECT * FROM followups WHERE status = 'scheduled'"))
        return { all: [dueRow("post_trial_d2")] };
      // Enrolled since the row was armed → stopChain.
      if (sql.includes("SELECT * FROM contacts"))
        return { first: contact({ status: "student" }) };
      if (sql.startsWith("UPDATE followups SET status") && sql.includes("kind IN")) {
        cancelledKinds = binds.slice(2).map(String);
        return {};
      }
      return {};
    });
    await runDueFollowups(envWith(db), {
      slack: { async postNote() {}, async postAttendanceCheck() {} },
    });
    assert.deepEqual(cancelledKinds, [
      "post_trial_d0",
      "post_trial_d2",
      "post_trial_d5",
      "no_show_d3",
    ]);
  });
});

// ---- the result watcher end to end (through syncBookings) -----------------

interface WatcherRun {
  scheduled: { kind: string; dueAt: number; recordId: unknown }[];
  cancelledKinds: string[][];
  cancelledAll: number;
  notes: string[];
  kv: Map<string, string>;
  statusWrites: string[];
  sent: string[];
}

/**
 * Drive processResult through syncBookings with one Airtable record. `kv`
 * carries over between runs so the record+value marker behaves as in prod.
 */
async function runWatcher(
  result: string,
  trialEpoch: number,
  over: {
    contact?: Contact | null;
    kv?: Map<string, string>;
    /** true ⇒ a live anti-no-show sequence exists (the lead rebooked). */
    rebooked?: boolean;
  } = {},
): Promise<WatcherRun> {
  stubFetchOk();
  const run: WatcherRun = {
    scheduled: [],
    cancelledKinds: [],
    cancelledAll: 0,
    notes: [],
    kv: over.kv ?? new Map(),
    statusWrites: [],
    sent: [],
  };
  const c = over.contact === undefined ? contact({}) : over.contact;
  const { db } = fakeDb((sql, binds) => {
    if (sql.includes("SELECT value FROM kv")) {
      const key = String(binds[0]);
      return { first: run.kv.has(key) ? { value: run.kv.get(key) } : null };
    }
    if (sql.startsWith("INSERT INTO kv")) {
      run.kv.set(String(binds[0]), String(binds[1]));
      return {};
    }
    if (sql.includes("SELECT * FROM contacts")) return { first: c };
    if (sql.includes("SELECT 1 AS n FROM followups"))
      return { first: over.rebooked ? { n: 1 } : null };
    if (sql.includes("INSERT OR IGNORE INTO followups")) {
      run.scheduled.push({
        kind: String(binds[1]),
        dueAt: Number(binds[2]),
        recordId: binds[3],
      });
      return {};
    }
    if (sql.startsWith("UPDATE followups SET status") && sql.includes("kind IN")) {
      run.cancelledKinds.push(binds.slice(2).map(String));
      return {};
    }
    if (sql.startsWith("UPDATE followups SET status")) {
      run.cancelledAll++;
      return {};
    }
    if (sql.startsWith("UPDATE contacts SET status")) {
      run.statusWrites.push(String(binds[1]));
      return {};
    }
    return {};
  });
  const airtable = {
    async listRecentBookings() {
      return [
        {
          id: "recA",
          phone: "5215512345678",
          name: "Ana",
          trialDateTimeIso: new Date(trialEpoch * 1000).toISOString(),
          result,
        },
      ];
    },
  };
  await syncBookings(envWith(db), airtable, {
    slack: {
      async postNote(text: string) {
        run.notes.push(text);
      },
    },
  });
  return run;
}

/** A trial a couple of hours ago — the ordinary "front desk just marked it" case. */
function recentTrial(): number {
  return Math.floor(Date.now() / 1000) - 2 * 3600;
}

test("result watcher: 'Asistió' arms the three post-trial rows and pings Slack", async () => {
  const run = await runWatcher("Asistió", recentTrial());
  assert.deepEqual(
    run.scheduled.map((s) => s.kind),
    ["post_trial_d0", "post_trial_d2", "post_trial_d5"],
  );
  assert.ok(run.scheduled.every((s) => s.recordId === "recA"));
  assert.equal(run.notes.length, 1);
  assert.ok(/asistió y no se inscribió/.test(run.notes[0]!), run.notes[0]);
  assert.ok(/Ana/.test(run.notes[0]!), run.notes[0]);
  // Status is untouched: they are still a lead, not a student.
  assert.deepEqual(run.statusWrites, []);
  // The pre-trial reminders and the lead drip are retired, nothing else.
  assert.equal(run.cancelledAll, 0);
  assert.ok(run.cancelledKinds[0]!.includes("day_before"));
  assert.ok(run.cancelledKinds[0]!.includes("nudge_d2"));
  assert.equal(run.kv.get("resultado:recA"), "attended");
});

test("result watcher: arming 'Asistió' twice is a no-op the second time", async () => {
  const trial = recentTrial();
  const kv = new Map<string, string>();
  const first = await runWatcher("Asistió", trial, { kv });
  const second = await runWatcher("Asistió", trial, { kv });
  assert.equal(first.scheduled.length, 3);
  assert.equal(second.scheduled.length, 0);
  assert.equal(second.notes.length, 0);
});

test("result watcher: 'Se inscribió' after 'Asistió' runs and cancels the chain", async () => {
  const trial = recentTrial();
  const kv = new Map<string, string>();
  await runWatcher("Asistió", trial, { kv });
  const enrolled = await runWatcher("Asistió, Se inscribió", trial, { kv });
  // The marker is per record+VALUE, so the enrolled branch is NOT skipped.
  assert.deepEqual(enrolled.statusWrites, ["student"]);
  assert.ok(enrolled.cancelledAll > 0); // cancelFollowups(all kinds) kills post_trial_*
  assert.equal(enrolled.kv.get("resultado:recA"), "enrolled");
});

test("result watcher: an opted-out attendee gets bookkeeping and nothing else", async () => {
  const run = await runWatcher("Asistió", recentTrial(), {
    contact: contact({ status: "opted_out" }),
  });
  assert.deepEqual(run.scheduled, []);
  assert.deepEqual(run.notes, []);
  assert.equal(run.kv.get("resultado:recA"), "attended");
});

test("result watcher: an attendance marked 6 days late arms nothing and stays quiet", async () => {
  const run = await runWatcher("Asistió", Math.floor(Date.now() / 1000) - 6 * DAY);
  assert.deepEqual(run.scheduled, []);
  assert.deepEqual(run.notes, []);
  assert.equal(run.kv.get("resultado:recA"), "attended");
});

test("result watcher: 'Asistió' → 'Asistió, Perdido' is a NEW value and retires the chain", async () => {
  const trial = recentTrial();
  const kv = new Map<string, string>();
  const armed = await runWatcher("Asistió", trial, { kv });
  assert.equal(armed.scheduled.length, 3);
  assert.equal(kv.get("resultado:recA"), "attended");

  const lost = await runWatcher("Asistió, Perdido", trial, { kv });
  // Without the "+lost" suffix on the marker this run would have been skipped
  // as "already acted on this value" and the three rows would have survived.
  assert.equal(kv.get("resultado:recA"), "attended+lost");
  assert.deepEqual(lost.scheduled, []);
  assert.deepEqual(lost.notes, []);
  const cancelled = lost.cancelledKinds.flat();
  for (const kind of ["post_trial_d0", "post_trial_d2", "post_trial_d5", "no_show_d3"]) {
    assert.ok(cancelled.includes(kind), `${kind} not cancelled: ${cancelled.join()}`);
  }
  // Class reminders are NOT touched — a "Perdido" must not cancel a live booking.
  for (const kind of ["trial_confirm", "day_before", "same_day"]) {
    assert.ok(!cancelled.includes(kind), `${kind} should have survived`);
  }
  assert.equal(lost.cancelledAll, 0);
});

test("result watcher: a bare 'Perdido' stops the drip silently", async () => {
  const run = await runWatcher("Perdido", recentTrial());
  assert.deepEqual(run.scheduled, []);
  assert.deepEqual(run.notes, []);
  assert.equal(run.cancelledAll, 0);
  assert.ok(run.cancelledKinds.flat().includes("nudge_d2"));
  assert.equal(run.kv.get("resultado:recA"), "none+lost");
});

test("result watcher: 'No asistió, Perdido' sends nothing and arms no second touch", async () => {
  const run = await runWatcher("No asistió, Perdido", recentTrial());
  assert.deepEqual(run.scheduled, []);
  assert.equal(run.kv.get("resultado:recA"), "no_show+lost");
});

test("result watcher: 'Se inscribió, Perdido' still enrolls them — they paid", async () => {
  const run = await runWatcher("Se inscribió, Perdido", recentTrial());
  assert.deepEqual(run.statusWrites, ["student"]);
  assert.equal(run.kv.get("resultado:recA"), "enrolled+lost");
});

test("result watcher: 'No asistió, Reprogramó' with a live booking says nothing", async () => {
  const run = await runWatcher("No asistió, Reprogramó", recentTrial(), { rebooked: true });
  assert.deepEqual(run.scheduled, []); // no no_show_d3
  assert.equal(run.cancelledAll, 0); // the NEW sequence must survive
  assert.deepEqual(run.cancelledKinds, []);
  assert.equal(run.kv.get("resultado:recA"), "no_show");
});

test("result watcher: an attendee who already rebooked keeps that sequence", async () => {
  const run = await runWatcher("Asistió", recentTrial(), { rebooked: true });
  assert.deepEqual(run.scheduled, []); // the chain would self-cancel anyway
  assert.deepEqual(run.notes, []);
  // Only the lead drip is cleared; the booking reminders stay.
  const cancelled = run.cancelledKinds.flat();
  assert.ok(cancelled.includes("nudge_d2"));
  assert.ok(!cancelled.includes("day_before"));
});

test("result watcher: 'No asistió' arms the +3d touch and proposes a real slot", async () => {
  const run = await runWatcher("No asistió", recentTrial());
  assert.deepEqual(
    run.scheduled.map((s) => s.kind),
    ["no_show_d3"],
  );
  assert.ok(run.cancelledAll > 0); // every pending row dies first
  assert.equal(run.kv.get("resultado:recA"), "no_show");
});

// ---- the two result readers stay independent but must not contradict -------

test("classifyResult and capiEventsForResult agree across the live option list", () => {
  // The CAPI hook reads the raw Airtable value itself, by design: it runs above
  // every messaging branch, claims under its own kv namespace (`capi:…`, never
  // `resultado:…`), and must keep firing for values the messaging side ignores.
  // Independent code paths are fine; disagreeing about what a value MEANS is
  // not, so pin the two together over the real multi-select options.
  const cases: [string, ReturnType<typeof classifyResult>, string[]][] = [
    ["No asistió", "no_show", []],
    ["Reprogramó", null, []],
    ["Asistió", "attended", ["attended"]],
    ["Dijo que se va a inscribir", null, []],
    ["Perdido", null, []],
    ["Se inscribió", "enrolled", ["attended", "purchase"]],
    // The joins staff actually produce.
    ["Asistió, Dijo que se va a inscribir", "attended", ["attended"]],
    ["Asistió, Se inscribió", "enrolled", ["attended", "purchase"]],
    ["No asistió, Reprogramó", "no_show", []],
    // A lead staff gave up on still ATTENDED — that signal is a fact about the
    // visit and keeps reaching Meta; only the messaging stops.
    ["Asistió, Perdido", "attended", ["attended"]],
    ["No asistió, Perdido", "no_show", []],
  ];
  for (const [raw, expected, capi] of cases) {
    assert.equal(classifyResult(raw), expected, raw);
    assert.deepEqual(capiEventsForResult(raw), capi, raw);
    // Whenever messaging says they came, Meta hears QualifiedLead, and vice versa.
    const came = expected === "attended" || expected === "enrolled";
    assert.equal(capi.includes("attended"), came, raw);
  }
});

test("an enrolment reports QualifiedLead AND Purchase, in that order", () => {
  assert.deepEqual(capiEventsForResult("Se inscribió"), ["attended", "purchase"]);
  assert.deepEqual(capiEventsForResult("Se inscribió, Perdido"), ["attended", "purchase"]);
});
