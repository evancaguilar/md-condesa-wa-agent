import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attendedCardText,
  cdmxDayOffset,
  computeNoShowRebook,
  computePostTrialSequence,
  CONVERSATION_GRACE,
  decideClaim,
  decodeChainNote,
  encodeChainNote,
  firstTouchWhen,
  parsePostTrialClaim,
  POST_TRIAL_CLAIM_VERB,
  POST_TRIAL_ALL_KINDS,
  POST_TRIAL_MAX_AGE,
  postTrialCopy,
  postTrialTemplateName,
  processPostTrial,
  POST_TRIAL_KINDS,
} from "../src/cron/post-trial.js";
import { classifyResult, isLostResult } from "../src/services/airtable.js";
import { capiEventsForResult } from "../src/services/meta-capi.js";
import { parseInteractionPayload } from "../src/services/slack-timeouts.js";
import { claimPendingFollowup } from "../src/db/queries-admin.js";
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

test("computePostTrialSequence: evening trial → next-morning d0, then the +2/+4/+7/+14/+30 arc", () => {
  const marked = WED_TRIAL + 30 * 60; // marked half an hour after class
  const steps = computePostTrialSequence(WED_TRIAL, marked);
  const by = Object.fromEntries(steps.map((s) => [s.kind, s.dueAt]));
  // 19:00 + 3h = 22:00, past the 21:00 close → 09:30 the next morning (it
  // will say "ayer" — see the send-time tests).
  assert.equal(by["post_trial_d0"], cdmxToEpoch(2026, 9, 17, 9, 30, 0));
  assert.equal(by["post_trial_d2"], cdmxToEpoch(2026, 9, 18, 11, 0, 0));
  assert.equal(by["post_trial_d4"], cdmxToEpoch(2026, 9, 20, 18, 0, 0));
  assert.equal(by["post_trial_d7"], cdmxToEpoch(2026, 9, 23, 11, 0, 0)); // same weekday
  assert.equal(by["post_trial_d14"], cdmxToEpoch(2026, 9, 30, 18, 0, 0));
  assert.equal(by["post_trial_d30"], cdmxToEpoch(2026, 10, 16, 11, 0, 0));
  assert.deepEqual(
    steps.map((s) => s.kind),
    [...POST_TRIAL_KINDS],
  );
  // The retired d5 slot is never armed any more.
  assert.equal(by["post_trial_d5"], undefined);
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
  assert.equal(by["post_trial_d7"], cdmxToEpoch(2026, 9, 26, 11, 0, 0)); // next Saturday
});

test("computePostTrialSequence: a Sunday trial crosses the month boundary cleanly", () => {
  const sun = cdmxToEpoch(2026, 9, 27, 10, 0, 0); // Sunday 2026-09-27
  const by = Object.fromEntries(
    computePostTrialSequence(sun, sun + 60).map((s) => [s.kind, s.dueAt]),
  );
  assert.equal(by["post_trial_d2"], cdmxToEpoch(2026, 9, 29, 11, 0, 0));
  assert.equal(by["post_trial_d4"], cdmxToEpoch(2026, 10, 1, 18, 0, 0));
  assert.equal(cdmxParts(by["post_trial_d4"]!).month, 10);
  assert.equal(by["post_trial_d30"], cdmxToEpoch(2026, 10, 27, 11, 0, 0));
});

test("computePostTrialSequence: marked 3 days late keeps only what is still ahead", () => {
  const marked = WED_TRIAL + 3 * DAY; // Saturday evening
  const kinds = computePostTrialSequence(WED_TRIAL, marked).map((s) => s.kind);
  // d0 stale, d2 (Friday 11:00) past; d4 is Sunday 18:00, still ahead.
  assert.deepEqual(kinds, ["post_trial_d4", "post_trial_d7", "post_trial_d14", "post_trial_d30"]);
});

test("computePostTrialSequence: the first touch is dropped once it could only say 'anteayer'", () => {
  // Thursday 07:00, 12h after the Wednesday-evening class: the row is past due
  // (09:30 Thursday is ahead, fine) and fires the day after the class → "ayer".
  const nextMorning = WED_TRIAL + 12 * 3600;
  assert.deepEqual(
    computePostTrialSequence(WED_TRIAL, nextMorning).map((s) => s.kind),
    [...POST_TRIAL_KINDS],
  );
  // Friday 08:00 (37h later): still under the 48h cap, but a touch firing now
  // would be TWO calendar days after the class. d2 covers it — d0 is dropped.
  const twoDaysLater = cdmxToEpoch(2026, 9, 18, 8, 0, 0);
  assert.deepEqual(
    computePostTrialSequence(WED_TRIAL, twoDaysLater).map((s) => s.kind),
    ["post_trial_d2", "post_trial_d4", "post_trial_d7", "post_trial_d14", "post_trial_d30"],
  );
});

test("computePostTrialSequence: a late mark still gets the tail, a cold trial nothing", () => {
  // 10 days late: d14 and d30 are still ahead — the chain runs a month.
  assert.deepEqual(
    computePostTrialSequence(WED_TRIAL, WED_TRIAL + 10 * DAY).map((s) => s.kind),
    ["post_trial_d14", "post_trial_d30"],
  );
  assert.deepEqual(computePostTrialSequence(WED_TRIAL, WED_TRIAL + POST_TRIAL_MAX_AGE + 3600), []);
  // …and neither does a nonsense record dated far in the future.
  assert.deepEqual(computePostTrialSequence(WED_TRIAL, WED_TRIAL - 3 * DAY), []);
  assert.deepEqual(computePostTrialSequence(NaN, WED_TRIAL), []);
});

test("cdmxDayOffset counts CDMX calendar days, not 24h blocks", () => {
  const lateEvening = cdmxToEpoch(2026, 9, 16, 23, 30, 0);
  const earlyMorning = cdmxToEpoch(2026, 9, 17, 0, 30, 0); // one hour later
  assert.equal(cdmxDayOffset(lateEvening, earlyMorning), 1);
  assert.equal(cdmxDayOffset(WED_TRIAL, WED_TRIAL + 3600), 0);
  assert.equal(cdmxDayOffset(WED_TRIAL, cdmxToEpoch(2026, 9, 17, 9, 30, 0)), 1);
  assert.equal(cdmxDayOffset(WED_TRIAL, cdmxToEpoch(2026, 9, 18, 9, 30, 0)), 2);
  assert.equal(cdmxDayOffset(WED_TRIAL, WED_TRIAL - DAY), -1);
});

test("chain note round-trips the trial epoch and tolerates junk", () => {
  assert.equal(decodeChainNote(encodeChainNote(WED_TRIAL)), WED_TRIAL);
  assert.equal(encodeChainNote(NaN), null);
  assert.equal(decodeChainNote(null), null);
  assert.equal(decodeChainNote("{not json"), null);
  assert.equal(decodeChainNote(JSON.stringify({ name: "Ana" })), null); // a card note
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

test("post-trial copy: each touch has its own angle, only d14 and the goodbye carry a link", () => {
  const c = contact({ name: "Ana" });
  const d0 = postTrialCopy(c, "post_trial_d0");
  assert.ok(d0.startsWith("¡Hola Ana!"), d0);
  assert.ok(/¿Qué te pareció la experiencia\?/.test(d0), d0);
  assert.ok(/inscripción/.test(d0), d0); // d0 closes on enrollment, not another trial
  const d2 = postTrialCopy(c, "post_trial_d2");
  assert.ok(/¿Qué te falta saber/.test(d2), d2);
  const d4 = postTrialCopy(c, "post_trial_d4");
  assert.ok(/qué es lo que te frena/.test(d4), d4); // objection discovery
  const d7 = postTrialCopy(c, "post_trial_d7");
  assert.ok(/una semana/.test(d7), d7);
  const d14 = postTrialCopy(c, "post_trial_d14");
  assert.ok(/https?:\/\//.test(d14), d14);
  const d30 = postTrialCopy(c, "post_trial_d30");
  assert.ok(/último mensaje/.test(d30), d30);
  assert.ok(/https?:\/\//.test(d30), d30); // the goodbye links to the schedule
  assert.equal(postTrialCopy(c, "post_trial_d5"), d30); // the retired slot = the goodbye
  // Six different bodies — no touch repeats another.
  const bodies = POST_TRIAL_KINDS.map((k) => postTrialCopy(c, k));
  assert.equal(new Set(bodies).size, bodies.length);
  for (const body of bodies) assert.ok(!/\{(who|when|link|cta)\}/.test(body), body);
});

test("post-trial copy: the first touch says 'hoy' the same day and 'ayer' the morning after", () => {
  const c = contact({ name: "Ana" });
  assert.ok(postTrialCopy(c, "post_trial_d0", null, 0).includes("verte hoy en la academia"));
  assert.ok(postTrialCopy(c, "post_trial_d0", null, 1).includes("verte ayer en la academia"));
  const en = contact({ name: "Mike", lang: "en" });
  assert.ok(postTrialCopy(en, "post_trial_d0", null, 0).includes("at the academy today"));
  assert.ok(postTrialCopy(en, "post_trial_d0", null, 1).includes("at the academy yesterday"));
  assert.equal(firstTouchWhen(0, "es"), "hoy");
  assert.equal(firstTouchWhen(1, "es"), "ayer");
  assert.equal(firstTouchWhen(1, "en"), "yesterday");
  // The day word only lives in the first touch — the others never mention it.
  assert.equal(postTrialCopy(c, "post_trial_d2", null, 1), postTrialCopy(c, "post_trial_d2", null, 0));
});

test("post-trial copy names NO price, discount or deadline, in either language", () => {
  // The inscription discount is SAME-DAY-ONLY at the academy (owner,
  // 2026-09-21): a follow-up that holds it open for 48h is a promise the gym
  // cannot keep. These messages open a conversation; humans quote the numbers.
  const bodies = [
    ...POST_TRIAL_KINDS.map((k) => postTrialCopy(contact({ name: "Ana" }), k)),
    ...POST_TRIAL_KINDS.map((k) => postTrialCopy(contact({ lang: "en" }), k)),
  ];
  for (const body of bodies) {
    assert.equal(/\$\s*[\d,]+/.test(body), false, `price in: ${body}`);
    assert.equal(/\d+\s*(horas|hours|hrs)\b/i.test(body), false, `deadline in: ${body}`);
    assert.equal(
      /descuento|sin costo|gratis|free|discount|vence|plazo|deadline/i.test(body),
      false,
      `offer language in: ${body}`,
    );
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

test("postTrialTemplateName: d0 splits into hoy/ayer, the goodbye reuses post_trial_d5, no_show_d3 the no-show one", () => {
  assert.equal(postTrialTemplateName("post_trial_d0"), "post_trial_d0");
  assert.equal(postTrialTemplateName("post_trial_d0", 0), "post_trial_d0");
  assert.equal(postTrialTemplateName("post_trial_d0", 1), "post_trial_d1");
  assert.equal(postTrialTemplateName("post_trial_d2"), "post_trial_d2");
  assert.equal(postTrialTemplateName("post_trial_d4"), "post_trial_d4");
  assert.equal(postTrialTemplateName("post_trial_d7"), "post_trial_d7");
  assert.equal(postTrialTemplateName("post_trial_d14"), "post_trial_d14");
  assert.equal(postTrialTemplateName("post_trial_d30"), "post_trial_d5"); // already approved body
  assert.equal(postTrialTemplateName("post_trial_d5"), "post_trial_d5");
  assert.equal(postTrialTemplateName("no_show_d3"), "no_show_followup");
});

// ---- send-time stop conditions -------------------------------------------

function sendDeps(
  sent: string[],
  opts: { windowClosed?: boolean; templateError?: string } = {},
) {
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
        if (opts.templateError) throw new Error(opts.templateError);
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

/** A d0 row armed right after the Wednesday class (note = the class date). */
const ROW = {
  phone: "5215512345678",
  kind: "post_trial_d0" as const,
  created_at: WED_TRIAL + 600,
  note: encodeChainNote(WED_TRIAL),
};
/** When the send-time tests run: the same evening, 3h after the class. */
const SEND_AT = WED_TRIAL + 3 * 3600;

test("processPostTrial: happy path sends the free-form body", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.deepEqual(res, { outcome: "sent" });
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes("¿Qué te pareció la experiencia?"), sent[0]);
});

test("processPostTrial: an opted-out lead gets silence", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ status: "opted_out" }));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.deepEqual(res, { outcome: "skipped_optout" });
  assert.equal(sent.length, 0);
});

test("processPostTrial: a lead who enrolled meanwhile stops the whole chain", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ status: "student" }));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.deepEqual(res, { outcome: "cancelled", stopChain: true });
  assert.equal(sent.length, 0);
});

test("processPostTrial: a recent reply pauses this touch — it does NOT stop the chain", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ last_inbound_at: ROW.created_at + 1 }));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.deepEqual(res, { outcome: "cancelled" }); // no stopChain: the later touches re-check
  assert.equal(sent.length, 0);
  // An inbound from BEFORE the arming is not a reason to pause.
  const fresh = sendDeps([]);
  const { db: db2 } = contactDb(contact({ last_inbound_at: ROW.created_at - 1 }));
  assert.deepEqual(
    await processPostTrial(envWith(db2), ROW, fresh.deps, SEND_AT),
    { outcome: "sent" },
  );
});

/** contactDb plus a scripted "last message in the thread" (direction). */
function threadDb(c: Contact, lastDirection: "in" | "out_bot" | "out_human_echo" | null) {
  return fakeDb((sql) => {
    if (sql.includes("SELECT * FROM contacts")) return { first: c };
    if (sql.includes("SELECT 1 AS n FROM followups")) return { first: null };
    if (sql.includes("FROM messages"))
      return {
        all: lastDirection
          ? [{ wamid: "w", phone: c.phone, direction: lastDirection, body: "x", ts: 1, meta: null }]
          : [],
      };
    return {};
  });
}

test("processPostTrial: replied, got answered, went quiet ≥3 days → the chain resumes", async () => {
  // Paola's case: asks about the basic membership after d0, gets the numbers
  // from a human, then silence. d7 must still go out.
  const d7 = { ...ROW, kind: "post_trial_d7" as const };
  const now = WED_TRIAL + 7 * DAY;
  const repliedAt = now - CONVERSATION_GRACE - 3600; // quiet for just over the grace
  const { sent, deps } = sendDeps([]);
  const { db } = threadDb(contact({ last_inbound_at: repliedAt }), "out_human_echo");
  assert.deepEqual(await processPostTrial(envWith(db), d7, deps, now), { outcome: "sent" });
  assert.ok(sent[0]!.includes("una semana"), sent[0]);
  // Same, answered by the bot.
  const bot = sendDeps([]);
  const { db: db2 } = threadDb(contact({ last_inbound_at: repliedAt }), "out_bot");
  assert.deepEqual(await processPostTrial(envWith(db2), d7, bot.deps, now), { outcome: "sent" });
});

test("processPostTrial: a lead still inside the conversation grace is left alone", async () => {
  const d7 = { ...ROW, kind: "post_trial_d7" as const };
  const now = WED_TRIAL + 7 * DAY;
  const { sent, deps } = sendDeps([]);
  const { db, calls } = threadDb(contact({ last_inbound_at: now - CONVERSATION_GRACE + 3600 }), "out_bot");
  assert.deepEqual(await processPostTrial(envWith(db), d7, deps, now), { outcome: "cancelled" });
  assert.equal(sent.length, 0);
  // Cheap path: the thread is not even read while the grace holds.
  assert.ok(!calls.some((c) => c.sql.includes("FROM messages")));
});

test("processPostTrial: never stacks a nudge on a lead nobody answered", async () => {
  // Their message is the last one in the thread: a human owes the reply, and
  // an automated "¿qué te frena?" on top of an unanswered question is the
  // worst thing we could send. Skip this touch; the chain itself survives.
  const d4 = { ...ROW, kind: "post_trial_d4" as const };
  const now = WED_TRIAL + 4 * DAY + 18 * 3600;
  const { sent, deps } = sendDeps([]);
  const { db } = threadDb(contact({ last_inbound_at: now - CONVERSATION_GRACE - DAY }), "in");
  assert.deepEqual(await processPostTrial(envWith(db), d4, deps, now), { outcome: "cancelled" });
  assert.equal(sent.length, 0);
});

test("processPostTrial: the first touch says 'ayer' when it fires the morning after", async () => {
  // Wednesday 19:00 class → the row lands at 09:30 Thursday.
  const thursday = cdmxToEpoch(2026, 9, 17, 9, 30, 0);
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ name: "Paola" }));
  assert.deepEqual(await processPostTrial(envWith(db), ROW, deps, thursday), { outcome: "sent" });
  assert.ok(sent[0]!.includes("Qué gusto verte ayer en la academia"), sent[0]);
  // …and the closed-window fallback picks the "ayer" template, not the "hoy" one.
  const closed = sendDeps([], { windowClosed: true });
  const { db: db2 } = contactDb(contact({ name: "Paola" }));
  assert.deepEqual(await processPostTrial(envWith(db2), ROW, closed.deps, thursday), { outcome: "sent" });
  assert.deepEqual(closed.sent, ["[template:post_trial_d1_es]"]);
});

test("processPostTrial: the first touch two days after the class is dropped, not sent stale", async () => {
  // The desk marked "Asistió" on Friday for a Wednesday class: d0 was armed
  // past due and fires now. "¿Qué te pareció la experiencia?" two days late
  // reads like a bot — d2 covers it without naming the day.
  const friday = cdmxToEpoch(2026, 9, 18, 10, 0, 0);
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({}));
  assert.deepEqual(await processPostTrial(envWith(db), ROW, deps, friday), { outcome: "cancelled" });
  assert.equal(sent.length, 0);
  // Only the FIRST touch is day-sensitive.
  const later = sendDeps([]);
  const { db: db2 } = contactDb(contact({}));
  assert.deepEqual(
    await processPostTrial(envWith(db2), { ...ROW, kind: "post_trial_d2" }, later.deps, friday),
    { outcome: "sent" },
  );
});

test("processPostTrial: a row armed before the note existed falls back to its arming time", async () => {
  // Legacy rows (before 2026-09-30) carry no trial epoch. The arming moment is
  // the best stand-in: armed Wednesday evening, fired Thursday morning → "ayer".
  const legacy = { ...ROW, note: null };
  const thursday = cdmxToEpoch(2026, 9, 17, 9, 30, 0);
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({}));
  assert.deepEqual(await processPostTrial(envWith(db), legacy, deps, thursday), { outcome: "sent" });
  assert.ok(sent[0]!.includes("verte ayer"), sent[0]);
});

test("processPostTrial: a human takeover skips this touch only", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({ human_override_until: SEND_AT + 3600 }));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.deepEqual(res, { outcome: "cancelled" }); // no stopChain
  assert.equal(sent.length, 0);
});

test("processPostTrial: a new future booking stops the chain", async () => {
  const { sent, deps } = sendDeps([]);
  const { db } = contactDb(contact({}), true);
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.deepEqual(res, { outcome: "cancelled", stopChain: true });
  assert.equal(sent.length, 0);
});

test("processPostTrial: a closed window falls back to the per-kind template", async () => {
  const { sent, deps } = sendDeps([], { windowClosed: true });
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
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
    SEND_AT,
  );
  assert.deepEqual(res, { outcome: "sent" });
  assert.deepEqual(sent, ["[template:no_show_followup_es]"]);
});

test("processPostTrial: an unapproved template is reported as approval-pending", async () => {
  const { sent, deps } = sendDeps([], {
    windowClosed: true,
    templateError: "WA send failed (400) [132001]: template name does not exist",
  });
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.equal(res.outcome, "template_missing");
  assert.equal(res.outcome === "template_missing" && res.template, "post_trial_d0_es");
  assert.equal(res.outcome === "template_missing" && res.missing, true);
  assert.equal(sent.length, 0);
});

test("processPostTrial: a param-count failure is NOT filed as 'not approved yet'", async () => {
  // 132000 is our bug, not Evan's. Reporting it as a missing template is how a
  // whole afternoon gets spent staring at an approved template in WA Manager.
  const { deps } = sendDeps([], {
    windowClosed: true,
    templateError: "WA send failed (400) [132000]: number of parameters does not match",
  });
  const { db } = contactDb(contact({}));
  const res = await processPostTrial(envWith(db), ROW, deps, SEND_AT);
  assert.equal(res.outcome === "template_missing" && res.missing, false);
  assert.ok(
    res.outcome === "template_missing" && /132000/.test(res.error),
    "the Graph error text must survive into the Slack note",
  );
});

test("processPostTrial: the template carries exactly ONE body param — the first name", async () => {
  const calls: unknown[][] = [];
  const { deps } = sendDeps([], { windowClosed: true });
  const spied = {
    ...deps,
    async sendTemplate(_e: Env, _p: string, name: string, lang: string, comps?: unknown[]) {
      calls.push([name, lang, comps]);
      return "wamid.x";
    },
  };
  const { db } = contactDb(contact({ name: "Ana Pérez" }));
  await processPostTrial(envWith(db), ROW, spied, SEND_AT);
  assert.deepEqual(calls[0], [
    "post_trial_d0_es",
    "es",
    [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
  ]);
});

test("processPostTrial: a nameless lead still gets a legal, readable param", async () => {
  const calls: unknown[][] = [];
  const { deps } = sendDeps([], { windowClosed: true });
  const spied = {
    ...deps,
    async sendTemplate(_e: Env, _p: string, _n: string, _l: string, comps?: unknown[]) {
      calls.push([comps]);
      return "wamid.x";
    },
  };
  // A push name greetingName() rejects ⇒ no name at all. Meta rejects "" (131008).
  const { db } = contactDb(contact({ name: "ana@gmail.com" }));
  await processPostTrial(envWith(db), ROW, spied, SEND_AT);
  assert.deepEqual(calls[0], [
    [{ type: "body", parameters: [{ type: "text", text: "qué tal" }] }],
  ]);
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
        return {
          all: [
            dueRow("post_trial_d0", {
              note: encodeChainNote(cdmxToEpoch(2026, 9, 21, 9, 0, 0)), // this morning's class
            }),
          ],
        };
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
    assert.deepEqual(cancelledKinds, [...POST_TRIAL_ALL_KINDS]);
    assert.ok(POST_TRIAL_ALL_KINDS.includes("post_trial_d5")); // the retired slot is still retired
    assert.ok(POST_TRIAL_ALL_KINDS.includes("post_trial_d30"));
  });
});

// ---- the result watcher end to end (through syncBookings) -----------------

interface WatcherRun {
  scheduled: { kind: string; dueAt: number; recordId: unknown; note: string | null }[];
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
        note: binds[4] == null ? null : String(binds[4]),
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

test("result watcher: 'Asistió' arms the six post-trial rows and pings Slack", async () => {
  const trial = recentTrial();
  const run = await runWatcher("Asistió", trial);
  assert.deepEqual(
    run.scheduled.map((s) => s.kind),
    [...POST_TRIAL_KINDS],
  );
  assert.ok(run.scheduled.every((s) => s.recordId === "recA"));
  // Every chain row carries the CLASS date, so the first touch can say hoy/ayer.
  assert.ok(run.scheduled.every((s) => decodeChainNote(s.note) === trial));
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
  assert.equal(first.scheduled.length, POST_TRIAL_KINDS.length);
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

test("result watcher: an attendance marked 6 days late arms the tail but posts no card", async () => {
  // The Slack "escríbele hoy" card is stale after 5 days; the chain is not —
  // d7 / d14 / d30 are still ahead and worth sending.
  const run = await runWatcher("Asistió", Math.floor(Date.now() / 1000) - 6 * DAY);
  assert.deepEqual(
    run.scheduled.map((s) => s.kind),
    ["post_trial_d7", "post_trial_d14", "post_trial_d30"],
  );
  assert.deepEqual(run.notes, []);
  assert.equal(run.kv.get("resultado:recA"), "attended");
});

test("result watcher: an attendance marked 3 weeks late arms nothing and stays quiet", async () => {
  const run = await runWatcher("Asistió", Math.floor(Date.now() / 1000) - 21 * DAY);
  assert.deepEqual(run.scheduled, []);
  assert.deepEqual(run.notes, []);
  assert.equal(run.kv.get("resultado:recA"), "attended");
});

test("result watcher: 'Asistió' → 'Asistió, Perdido' is a NEW value and retires the chain", async () => {
  const trial = recentTrial();
  const kv = new Map<string, string>();
  const armed = await runWatcher("Asistió", trial, { kv });
  assert.equal(armed.scheduled.length, POST_TRIAL_KINDS.length);
  assert.equal(kv.get("resultado:recA"), "attended");

  const lost = await runWatcher("Asistió, Perdido", trial, { kv });
  // Without the "+lost" suffix on the marker this run would have been skipped
  // as "already acted on this value" and the three rows would have survived.
  assert.equal(kv.get("resultado:recA"), "attended+lost");
  assert.deepEqual(lost.scheduled, []);
  assert.deepEqual(lost.notes, []);
  const cancelled = lost.cancelledKinds.flat();
  for (const kind of [...POST_TRIAL_KINDS, "post_trial_d5", "no_show_d3"]) {
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

// ---- "🙋 Yo le escribo" claim ---------------------------------------------

const CLAIM_BASE = {
  name: "Ana",
  phone: "5215512345678",
  user: "evan",
  existing: null,
};

test("the claim button rides the normal action-id plumbing", () => {
  const payload = {
    type: "block_actions",
    trigger_id: "trg9",
    user: { username: "evan" },
    actions: [{ action_id: `${POST_TRIAL_CLAIM_VERB}|5215512345678` }],
  };
  const parsed = parseInteractionPayload(
    "payload=" + encodeURIComponent(JSON.stringify(payload)),
  );
  assert.equal(parsed.kind, "block_actions");
  assert.equal(parsed.user, "evan");
  assert.equal(parsed.actions[0]!.verb, POST_TRIAL_CLAIM_VERB);
  assert.equal(parsed.actions[0]!.arg, "5215512345678");
});

test("decideClaim: a fresh claim records and stops today's message only", () => {
  const d = decideClaim({ ...CLAIM_BASE, d0: { state: "pending" } });
  assert.equal(d.record, true);
  assert.ok(d.text.includes("evan le escribe hoy a Ana (5215512345678)"), d.text);
  assert.ok(d.text.includes("el bot NO manda el mensaje de hoy"), d.text);
  assert.ok(d.text.includes("(+2d … +30d) sigue"), d.text);
});

test("decideClaim: a second click reports who got there first, records nothing", () => {
  const at = cdmxToEpoch(2026, 9, 21, 18, 5, 0);
  const d = decideClaim({
    ...CLAIM_BASE,
    user: "karla",
    existing: { user: "evan", ts: at },
    d0: { state: "gone" },
  });
  assert.equal(d.record, false);
  assert.ok(d.text.includes("evan ya se lo había apartado (18:05)"), d.text);
  assert.ok(!d.text.includes("karla"), d.text);
});

test("decideClaim: d0 already sent → still recorded, card says when it went out", () => {
  const d = decideClaim({
    ...CLAIM_BASE,
    d0: { state: "sent", at: cdmxToEpoch(2026, 9, 21, 9, 30, 0) },
  });
  assert.equal(d.record, true);
  assert.ok(d.text.includes("ya había salido a las 09:30"), d.text);
  assert.ok(!d.text.includes("NO manda"), d.text);
});

test("decideClaim: an anonymous click still reads as a person", () => {
  const d = decideClaim({ ...CLAIM_BASE, user: "", d0: { state: "pending" } });
  assert.ok(d.text.startsWith("🙋 Alguien del equipo le escribe hoy"), d.text);
});

test("parsePostTrialClaim survives junk", () => {
  assert.deepEqual(parsePostTrialClaim('{"user":"evan","ts":7}'), { user: "evan", ts: 7 });
  assert.equal(parsePostTrialClaim('{"user":"evan"}'), null);
  assert.equal(parsePostTrialClaim("{oops"), null);
  assert.equal(parsePostTrialClaim(null), null);
});

test("claimPendingFollowup cancels ONLY the d0 row and reports who won", async () => {
  const writes: { sql: string; binds: unknown[] }[] = [];
  const { db } = fakeDb((sql, binds) => {
    if (sql.startsWith("UPDATE followups SET status = 'cancelled'")) {
      writes.push({ sql, binds });
      return { changes: 1 };
    }
    return {};
  });
  const res = await claimPendingFollowup(db, "5215512345678", "post_trial_d0");
  assert.deepEqual(res, { cancelled: true, sentAt: null });
  assert.equal(writes.length, 1);
  // Exactly one kind, exactly one phone — d2/d5 are not in the statement.
  assert.deepEqual(writes[0]!.binds, ["5215512345678", "post_trial_d0"]);
  assert.ok(writes[0]!.sql.includes("status = 'scheduled'"), writes[0]!.sql);
});

test("claimPendingFollowup: nothing to cancel → reports the sent time instead", async () => {
  const { db } = fakeDb((sql) => {
    if (sql.startsWith("UPDATE followups SET status = 'cancelled'")) return { changes: 0 };
    if (sql.includes("SELECT status, due_at FROM followups"))
      return { first: { status: "sent", due_at: 1_700_000_000 } };
    return {};
  });
  assert.deepEqual(await claimPendingFollowup(db, "p", "post_trial_d0"), {
    cancelled: false,
    sentAt: 1_700_000_000,
  });
});

test("claimPendingFollowup: a cancelled/absent row reports no send time", async () => {
  const { db } = fakeDb((sql) => {
    if (sql.startsWith("UPDATE followups SET status = 'cancelled'")) return { changes: 0 };
    if (sql.includes("SELECT status, due_at FROM followups"))
      return { first: { status: "cancelled", due_at: 1_700_000_000 } };
    return {};
  });
  assert.deepEqual(await claimPendingFollowup(db, "p", "post_trial_d0"), {
    cancelled: false,
    sentAt: null,
  });
});

test("attendedCardText is the 🔥 line the card leads with", () => {
  const t = attendedCardText("Ana", "5215512345678");
  assert.ok(t.startsWith("🔥 Ana (5215512345678) asistió y no se inscribió"), t);
  assert.ok(t.includes("hoy, +2d, +4d, +7d, +14d, +30d"), t);
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

// ---- delayed attended card (2026-09-21) ----

import {
  CARD_DELAY_AFTER_END,
  CLASS_LENGTH,
  computePostTrialCardAt,
  decodeCardNote,
  encodeCardNote,
  POST_TRIAL_CARD_KIND,
} from "../src/cron/post-trial.js";

test("computePostTrialCardAt: class start + 1h + 30min; null once that moment passed", () => {
  const start = cdmxToEpoch(2026, 9, 21, 18, 0, 0);
  assert.equal(computePostTrialCardAt(start, start + 300), start + CLASS_LENGTH + CARD_DELAY_AFTER_END);
  assert.equal(computePostTrialCardAt(start, start + 2 * 3600), null, "marked late → post now");
  assert.equal(computePostTrialCardAt(NaN, start), null);
});

test("post_trial_card is part of the cancellation surface and its note round-trips", () => {
  assert.ok((POST_TRIAL_ALL_KINDS as readonly string[]).includes(POST_TRIAL_CARD_KIND));
  assert.equal(decodeCardNote(encodeCardNote("Mara")), "Mara");
  assert.equal(decodeCardNote(null), null);
  assert.equal(decodeCardNote("garbage"), null);
});
