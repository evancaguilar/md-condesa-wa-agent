// AI-written day-1 follow-ups (owner request 2026-11-11, features.aiFollowups).
// The brain writes nudge_1h / nudge_8h for ENGAGED leads (nudgePolicy class)
// as a continuation of the open thread; silent leads, guard trips and brain
// failures send the existing fixed copy. Real in-memory SQLite behind the D1
// surface, fake CDMX clock, fake brain (no network, no key).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  AI_OPEN_QUESTION_GUARD_SECONDS,
  OPEN_QUESTION_GUARD_SECONDS,
  openQuestionGuardSeconds,
  processNudge,
  textMentionsSlot,
} from "../src/cron/nudges.js";
import { time12h } from "../src/cron/next-slot.js";
import { PREVIEW_SQL, parsePreviewBody, runAiFollowupPreview } from "../src/services/ai-followup-preview.js";
import { runDueFollowups } from "../src/cron/followups.js";
import {
  AI_FOLLOWUP_DEFER_SECONDS,
  aiFollowupNote,
  buildFollowupInstruction,
  composeAiFollowup,
  disallowedUrls,
  newAiFollowupTick,
  unquotedPrices,
  validateAiFollowup,
  type AiFollowupBrief,
} from "../src/cron/ai-followup.js";
import { parseFollowupResponse } from "../src/brain/claude.js";
import { buildContextBlock } from "../src/brain/prompt.js";
import { detectDeferral } from "../src/pipeline/decline.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import { CLIENT } from "../src/client.gen.js";
import type { Contact, ConvoContext, Env, FollowupWrite } from "../src/types.js";

const H = 3600;
const PHONE = "5215512345678";
/** Tue 2026-11-03 10:00 CDMX: the lead's last message. */
const L = cdmxToEpoch(2026, 11, 3, 10, 0, 0);

// ---- harness ------------------------------------------------------------------

function sqliteDb(): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(":memory:");
  const text = readFileSync("src/db/schema.sql", "utf8")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  for (const stmt of text.split(";").map((s) => s.trim()).filter(Boolean)) {
    try {
      raw.exec(stmt);
    } catch {
      /* ALTERs re-adding a column already in the CREATE */
    }
  }
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (raw.prepare(sql).get(...(binds as never[])) ?? null) as T | null;
      },
      async run() {
        const r = raw.prepare(sql).run(...(binds as never[]));
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(binds as never[])) as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  return { raw, db: { prepare: make } as unknown as D1Database };
}

function envWith(db: D1Database): Env {
  return { DB: db, AIRTABLE_BASE_ID: "appTest", AIRTABLE_TRIALS_TABLE: "Trials" } as unknown as Env;
}

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: PHONE,
    name: "Ana",
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: L,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function insertContact(raw: DatabaseSync, c: Contact): void {
  raw
    .prepare(
      `INSERT INTO contacts(phone, name, lang, status, qualification, human_override_until, last_inbound_at, campaign_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(c.phone, c.name, c.lang, c.status, c.qualification, c.human_override_until, c.last_inbound_at, c.campaign_id);
}

let seq = 0;
function msg(raw: DatabaseSync, direction: string, body: string, ts: number): void {
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts, meta) VALUES(?, ?, ?, ?, ?, NULL)`).run(`w${++seq}`, PHONE, direction, body, ts);
}

const BOT_THREAD = "Tenemos Muay Thai entre semana en la mañana y en la tarde. ¿Qué horario te queda mejor?";

/** The ad prefill, our welcome, a REAL reply ("sí me interesa muay thai"), our offer. */
function engagedConvo(raw: DatabaseSync, lastIn = "sí me interesa muay thai"): void {
  msg(raw, "in", "Hola, quiero más información", L - 600);
  msg(raw, "out_bot", "¡Hola! Gracias por escribir a MD Condesa. ¿Qué disciplina te interesa?", L - 590);
  msg(raw, "in", lastIn, L);
  msg(raw, "out_bot", BOT_THREAD, L + 60);
}

/** Only the ad prefill and our welcome. */
function silentConvo(raw: DatabaseSync): void {
  msg(raw, "in", "Hola, quiero más información", L);
  msg(raw, "out_bot", "¡Hola! Gracias por escribir a MD Condesa. ¿Qué disciplina te interesa?", L + 10);
}

async function withClock(now: number, fn: () => Promise<void>): Promise<void> {
  const real = Date.now;
  Date.now = () => now * 1000;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

async function withFlag(on: boolean | undefined, fn: () => Promise<void>): Promise<void> {
  const flags = CLIENT.features as { aiFollowups?: boolean };
  const prev = flags.aiFollowups;
  if (on === undefined) delete flags.aiFollowups;
  else flags.aiFollowups = on;
  try {
    await fn();
  } finally {
    flags.aiFollowups = prev;
  }
}

interface Sent {
  body: string;
  meta?: Record<string, unknown>;
}

const AI_TEXT = "¿Qué te acomoda más para tu primera clase de Muay Thai, la mañana o la tarde? 🙂";

function deps(sent: Sent[], writer: { calls: string[]; reply: (instruction: string) => Promise<FollowupWrite> }) {
  return {
    async sendText(_e: Env, _p: string, body: string, opts?: { metaExtra?: Record<string, unknown> }) {
      sent.push({ body, ...(opts?.metaExtra ? { meta: opts.metaExtra } : {}) });
      return "wamid";
    },
    isWindowClosed: () => false,
    async writeFollowup(_e: Env, _p: string, instruction: string) {
      writer.calls.push(instruction);
      return writer.reply(instruction);
    },
  };
}

function writerReturning(text: string) {
  return { calls: [] as string[], reply: async (): Promise<FollowupWrite> => ({ ok: true, text }) };
}

// ---- 1. engaged lead → AI text --------------------------------------------------

test("engaged lead: nudge_1h is the brain's text, marked aiFollowup", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = writerReturning(AI_TEXT);
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w)), "sent");
    }),
  );
  assert.equal(w.calls.length, 1);
  assert.deepEqual(sent, [{ body: AI_TEXT, meta: { aiFollowup: true } }]);
  // The open thread and the slot constraints ride in the instruction.
  assert.match(w.calls[0]!, /<seguimiento>/);
  assert.match(w.calls[0]!, /dejó de contestar hace ~1 h/);
  assert.ok(w.calls[0]!.includes(BOT_THREAD));
  assert.match(w.calls[0]!, /Disciplina que eligió: Muay Thai/);
});

// ---- 2. silent lead → fixed copy, no brain call ---------------------------------

test("silent lead (only the ad prefill): fixed copy, no brain call, no AI mark", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = writerReturning(AI_TEXT);
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      silentConvo(raw);
      assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w)), "sent");
    }),
  );
  assert.equal(w.calls.length, 0);
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0]!.body, AI_TEXT);
  assert.equal(sent[0]!.meta, undefined);
});

// ---- 3. guard trip → fixed copy with the reason ----------------------------------

test("guard trip (Muay Thai at an hour it never runs): fixed copy, aiFollowupFallback slot_claim", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = writerReturning("¿Te late venir a Muay Thai a las 3:00 am?");
  const tick = newAiFollowupTick();
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", { ...deps(sent, w), aiTick: tick }), "sent");
    }),
  );
  assert.equal(w.calls.length, 1);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0]!.body, /3:00 am/);
  assert.deepEqual(sent[0]!.meta, { aiFollowupFallback: "slot_claim" });
  assert.equal(tick.fallbacks.get("slot_claim"), 1);
  assert.match(aiFollowupNote(tick) ?? "", /0 escrito\(s\) por la IA, 1 con copy fijo \(slot_claim 1\)/);
});

// ---- 4. brain throws / times out → fixed copy -----------------------------------

test("brain throws: fixed copy goes out, aiFollowupFallback brain_error; the nudge is never dropped", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = {
    calls: [] as string[],
    reply: async (): Promise<FollowupWrite> => {
      throw new Error("anthropic HTTP 529");
    },
  };
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w)), "sent");
    }),
  );
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.meta, { aiFollowupFallback: "brain_error" });
});

test("brain hangs past the deadline: fixed copy, aiFollowupFallback timeout", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = { calls: [] as string[], reply: () => new Promise<FollowupWrite>(() => {}) };
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", { ...deps(sent, w), aiTimeoutMs: 20 }), "sent");
    }),
  );
  assert.deepEqual(sent[0]!.meta, { aiFollowupFallback: "timeout" });
});

test("brain refusal (e.g. it tried to book) carries its reason through to the fixed copy", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = { calls: [] as string[], reply: async (): Promise<FollowupWrite> => ({ ok: false, reason: "other_tool:book_trial" }) };
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w));
    }),
  );
  assert.deepEqual(sent[0]!.meta, { aiFollowupFallback: "other_tool:book_trial" });
});

// ---- 5. nudge_8h sees what nudge_1h said ----------------------------------------

test("nudge_8h: the request carries the 1 h follow-up text and asks for a DIFFERENT angle", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = writerReturning("Si te preocupa venir sin experiencia, la clase de prueba es para principiantes. ¿Te animas esta semana?");
  await withFlag(true, () =>
    withClock(L + 8 * H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      msg(raw, "out_bot", AI_TEXT, L + H); // what nudge_1h sent
      assert.equal(await processNudge(envWith(db), PHONE, "nudge_8h", deps(sent, w)), "sent");
    }),
  );
  assert.equal(w.calls.length, 1);
  const req = w.calls[0]!;
  assert.ok(req.includes(AI_TEXT), "the 1h text is in the 8h request");
  assert.ok(req.includes(BOT_THREAD));
  assert.match(req, /ángulo DIFERENTE/);
  assert.match(req, /el 2º y último de hoy/);
  assert.match(req, /hace ~8 h/);
  assert.deepEqual(sent[0]!.meta, { aiFollowup: true });
});

test("nudge_8h that repeats the 1 h text verbatim → fixed copy (duplicate)", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = writerReturning(AI_TEXT);
  await withFlag(true, () =>
    withClock(L + 8 * H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      msg(raw, "out_bot", AI_TEXT, L + H);
      await processNudge(envWith(db), PHONE, "nudge_8h", deps(sent, w));
    }),
  );
  assert.deepEqual(sent[0]!.meta, { aiFollowupFallback: "duplicate" });
});

// ---- 6. per-tick cap ------------------------------------------------------------

test("per-tick cap: the 4th AI follow-up of a tick is DEFERRED a few minutes, not downgraded", async () => {
  const tick = newAiFollowupTick();
  const now = L + H;
  const outcomes: unknown[] = [];
  const allSent: Sent[] = [];
  let calls = 0;
  for (let i = 0; i < 4; i++) {
    const { raw, db } = sqliteDb();
    const sent: Sent[] = [];
    const w = writerReturning(AI_TEXT);
    await withFlag(true, () =>
      withClock(now, async () => {
        insertContact(raw, contact());
        engagedConvo(raw);
        outcomes.push(await processNudge(envWith(db), PHONE, "nudge_1h", { ...deps(sent, w), aiTick: tick }));
      }),
    );
    calls += w.calls.length;
    allSent.push(...sent);
  }
  assert.deepEqual(outcomes.slice(0, 3), ["sent", "sent", "sent"]);
  assert.deepEqual(outcomes[3], { outcome: "deferred", retryAt: now + AI_FOLLOWUP_DEFER_SECONDS });
  assert.equal(calls, 3);
  assert.equal(allSent.length, 3);
  assert.ok(allSent.every((s) => s.body === AI_TEXT));
  assert.equal(tick.written, 3);
  assert.equal(tick.deferred, 1);
  assert.equal(aiFollowupNote(tick), "✍️ Seguimientos día 1 con IA: 3 escrito(s) por la IA, 1 pospuesto(s) por el tope de 3/tick.");
});

// ---- 7. flag off / absent → no brain call ---------------------------------------

for (const flag of [false, undefined] as const) {
  test(`features.aiFollowups ${String(flag)}: no brain call, fixed copy, no mark (today's behaviour)`, async () => {
    const { raw, db } = sqliteDb();
    const sent: Sent[] = [];
    const w = writerReturning(AI_TEXT);
    await withFlag(flag, () =>
      withClock(L + H, async () => {
        insertContact(raw, contact());
        engagedConvo(raw);
        assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w)), "sent");
      }),
    );
    assert.equal(w.calls.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.meta, undefined);
  });
}

test("the shipped client config keeps the flag OFF (ships dark) and compile-kb whitelists it", () => {
  assert.equal((CLIENT.features as { aiFollowups?: boolean }).aiFollowups, false);
  assert.match(readFileSync("tools/compile-kb.mjs", "utf8"), /aiFollowups: !!cfg\.features\?\.aiFollowups/);
});

// ---- 8. every pre-existing stop runs BEFORE the brain call -----------------------

interface StopCase {
  name: string;
  setup: (raw: DatabaseSync) => void;
  over?: Partial<Contact>;
  expect: (res: unknown) => void;
}

const isCancelled = (res: unknown) => assert.equal(res, "cancelled");

const STOPS: StopCase[] = [
  { name: "opt-out", setup: () => {}, over: { status: "opted_out" }, expect: (r) => assert.equal(r, "skipped_optout") },
  { name: "student", setup: () => {}, over: { status: "student" }, expect: isCancelled },
  { name: "human override", setup: () => {}, over: { human_override_until: L + 10 * H }, expect: isCancelled },
  {
    name: "pending approval",
    setup: (raw) =>
      raw.prepare(`INSERT INTO pending_approvals(phone, draft, status, created_at) VALUES(?, 'x', 'pending', ?)`).run(PHONE, L + 30),
    expect: (r) => assert.equal((r as { outcome?: string }).outcome, "deferred"),
  },
  {
    name: "nudge cap",
    setup: (raw) =>
      raw
        .prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`)
        .run(`nudge_count:${PHONE}`, JSON.stringify({ sends: [L - 3 * H, L - 2 * H, L - H] })),
    expect: isCancelled,
  },
  {
    name: "booking already scheduled",
    setup: (raw) =>
      raw.prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id) VALUES(?, 'day_before', ?, 'scheduled', 'rec1')`).run(PHONE, L + 30 * H),
    expect: isCancelled,
  },
];

for (const s of STOPS) {
  test(`stop before the brain (processNudge): ${s.name}`, async () => {
    const { raw, db } = sqliteDb();
    const sent: Sent[] = [];
    const w = writerReturning(AI_TEXT);
    await withFlag(true, () =>
      withClock(L + H, async () => {
        insertContact(raw, contact(s.over));
        engagedConvo(raw);
        s.setup(raw);
        s.expect(await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w)));
      }),
    );
    assert.equal(w.calls.length, 0, `${s.name}: no brain call`);
    assert.equal(sent.length, 0);
  });
}

test("stop before the brain (processNudge): buy intent", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = writerReturning(AI_TEXT);
  let handed = 0;
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw, "quiero inscribirme ya, ¿cómo pago?");
      const res = await processNudge(envWith(db), PHONE, "nudge_1h", {
        ...deps(sent, w),
        onBuyIntent: async () => {
          handed++;
        },
      });
      assert.equal(res, "cancelled");
    }),
  );
  assert.equal(handed, 1);
  assert.equal(w.calls.length, 0);
});

test("stop before the brain (processNudge): deferral ('les aviso')", async () => {
  assert.equal(detectDeferral("ok, luego les aviso"), true);
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  const w = writerReturning(AI_TEXT);
  await withFlag(true, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw, "ok, luego les aviso");
      assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w)), "cancelled");
    }),
  );
  assert.equal(w.calls.length, 0);
});

// Stops that live in the cron row processor (followups.ts processOne), end to end.

function dueRow(raw: DatabaseSync, due: number): void {
  raw.prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id) VALUES(?, 'nudge_1h', ?, 'scheduled', ?)`).run(PHONE, due, `d1:${L}`);
}

function rowStatus(raw: DatabaseSync): { status: string; due_at: number } {
  return raw.prepare(`SELECT status, due_at FROM followups WHERE kind = 'nudge_1h'`).get() as { status: string; due_at: number };
}

const CRON_STOPS: { name: string; at: number; setup: (raw: DatabaseSync) => void; over?: Partial<Contact>; status: string }[] = [
  {
    name: "declined stop",
    at: L + H,
    setup: (raw) => raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run(`declined:${PHONE}`, JSON.stringify({ ts: L, source: "not_interested" })),
    status: "cancelled",
  },
  {
    name: "send ceiling",
    at: L + H,
    setup: (raw) => {
      for (const [i, k] of ["nudge_d2", "nudge_d4", "post_trial_d2"].entries()) {
        raw.prepare(`INSERT INTO followups(phone, kind, due_at, status, airtable_record_id) VALUES(?, ?, ?, 'sent', ?)`).run(PHONE, k, L + 60 + i, `x${i}`);
      }
    },
    status: "cancelled",
  },
  { name: "quiet hours", at: cdmxToEpoch(2026, 11, 3, 23, 0, 0), setup: () => {}, status: "scheduled" },
  { name: "opt-out", at: L + H, setup: () => {}, over: { status: "opted_out" }, status: "skipped_optout" },
];

for (const s of CRON_STOPS) {
  test(`stop before the brain (cron tick): ${s.name}`, async () => {
    const { raw, db } = sqliteDb();
    const calls: string[] = [];
    const notes: string[] = [];
    await withFlag(true, () =>
      withClock(s.at, async () => {
        insertContact(raw, contact(s.over));
        engagedConvo(raw);
        s.setup(raw);
        dueRow(raw, s.at - 60);
        await runDueFollowups(envWith(db), {
          slack: {
            async postNote(t: string) {
              notes.push(t);
            },
            async postAttendanceCheck() {},
          },
          aiFollowup: async (_e, _p, instruction) => {
            calls.push(instruction);
            return { ok: true, text: AI_TEXT };
          },
        });
      }),
    );
    assert.equal(calls.length, 0, `${s.name}: no brain call`);
    assert.equal(rowStatus(raw).status, s.status);
    assert.ok(!notes.some((n) => n.includes("Seguimientos día 1 con IA")));
  });
}

// ---- 9. pure pieces --------------------------------------------------------------

const brief = (over: Partial<AiFollowupBrief> = {}): AiFollowupBrief => ({
  kind: "nudge_1h",
  lang: "es",
  hoursSilent: 1,
  sentSinceLastInbound: [BOT_THREAD],
  band: "adults",
  discipline: "muay",
  declinedWeekdays: [5],
  preferredWeekdays: null,
  timeRanges: [[0, 12 * 60]],
  excludeDates: [],
  proposedSlots: ["2026-11-04 07:00"],
  cta: "slot",
  nextSlot: { weekday: 3, date: "2026-11-05", time: "07:00", discipline: "muay", label: "el jueves a las 7:00 am" },
  now: L + H,
  ...over,
});

test("instruction: slot constraints planNudgeCopy computed, ES/EN by contact language", () => {
  const es = buildFollowupInstruction(brief());
  assert.match(es, /Días que NO puede \(nunca los propongas\): sábado/);
  assert.match(es, /entre 12:00 am y 12:00 pm/);
  assert.match(es, /ya le propusimos \(no las repitas\): 2026-11-04 07:00/);
  assert.match(es, /Siguiente clase REAL .*Muay Thai el jueves a las 7:00 am \(2026-11-05 07:00\)/);
  assert.match(es, /UNA sola pregunta o UNA propuesta concreta\. Máximo 2 frases cortas y 280 caracteres/);
  const en = buildFollowupInstruction(brief({ lang: "en", kind: "nudge_8h" }));
  assert.match(en, /automatic FOLLOW-UP \(the 2nd and last one today\)/);
  assert.match(en, /Days they CANNOT do \(never offer them\): Saturday/);
  assert.match(en, /DIFFERENT angle/);
  const ask = buildFollowupInstruction(brief({ band: "kids", cta: "ask_age", nextSlot: null, discipline: null }));
  assert.match(ask, /NO sabemos su edad: no propongas día ni hora/);
  // 2026-11-12 preview defects: invented selling claims + building on a vague promise
  assert.match(es, /NO agregues beneficios, características ni afirmaciones/);
  assert.match(es, /pregunta SOLO la edad: no nombres ningún día ni hora/);
  assert.match(en, /Do NOT add benefits, features or claims/);
  assert.match(en, /ask ONLY for the age: name no day or time/);
});

test("the instruction rides LAST in the per-turn <context> block, never in system", () => {
  const ctx: ConvoContext = {
    phone: PHONE,
    contact: contact(),
    history: [],
    nowCdmx: "2026-11-03T11:00",
    weekday: "martes",
    windowOpen: true,
    trainingWheels: true,
  };
  const block = buildContextBlock({ ...ctx, followupInstruction: "<seguimiento>\nX\n</seguimiento>" });
  assert.ok(block.endsWith("<seguimiento>\nX\n</seguimiento>"));
  assert.ok(!buildContextBlock(ctx).includes("<seguimiento>"));
});

test("parseFollowupResponse: only send_reply is accepted", () => {
  const tu = (name: string, input: Record<string, unknown>) => ({ type: "tool_use" as const, id: "t", name, input });
  assert.deepEqual(parseFollowupResponse({ content: [tu("send_reply", { message: " Hola\\n¿va? " })], stop_reason: "tool_use" }), {
    ok: true,
    text: "Hola\n¿va?",
  });
  assert.deepEqual(
    parseFollowupResponse({ content: [tu("book_trial", {}), tu("send_reply", { message: "x" })], stop_reason: "tool_use" }),
    { ok: false, reason: "other_tool:book_trial" },
  );
  assert.deepEqual(parseFollowupResponse({ content: [tu("escalate_to_human", {})], stop_reason: "tool_use" }), {
    ok: false,
    reason: "other_tool:escalate_to_human",
  });
  assert.deepEqual(parseFollowupResponse({ content: [{ type: "text", text: "hola" }], stop_reason: "end_turn" }), {
    ok: false,
    reason: "no_send_reply",
  });
  assert.deepEqual(
    parseFollowupResponse({ content: [tu("send_reply", { message: "x", escalation_reason: "price negotiation" })], stop_reason: "tool_use" }),
    { ok: false, reason: "escalation" },
  );
  assert.deepEqual(parseFollowupResponse({ content: [tu("send_reply", { message: "<sin_respuesta>" })], stop_reason: "tool_use" }), {
    ok: false,
    reason: "no_reply_sentinel",
  });
  assert.deepEqual(parseFollowupResponse({ content: [tu("send_reply", { message: "  " })], stop_reason: "tool_use" }), {
    ok: false,
    reason: "empty",
  });
});

test("validateAiFollowup: each guard names its fallback reason", () => {
  const ctx = {
    nowCdmx: "2026-11-03T11:00",
    now: L + H,
    contact: contact(),
    campaignName: null,
    lang: "es" as const,
    recentOutbound: [{ body: "La mensualidad es de $1,996 cada 4 semanas.", ts: L + 30 }],
  };
  const reason = (t: string) => {
    const r = validateAiFollowup(t, ctx);
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(reason(AI_TEXT), "ok");
  assert.equal(reason(""), "empty");
  assert.equal(reason("a".repeat(400)), "too_long");
  assert.equal(reason("Mira aquí: https://evil.example.com/x ¿te late?"), "url_not_allowed");
  assert.equal(reason(`Aparta aquí: ${CLIENT.links.booking} 🙂`), "ok");
  assert.equal(reason("Recordatorio: el lead pidió info de Muay Thai"), "internal_note");
  assert.equal(reason("Ya quedó agendada tu clase, ¡te esperamos!"), "booking_claim");
  assert.equal(reason("¿Te late Muay Thai a las 3:00 am?"), "slot_claim");
  assert.equal(reason("Todavía hay lugares para tu clase de prueba, ¿te animas?"), "fact_claim");
  assert.equal(reason("Tenemos grupos chicos, ¿te late probar una clase?"), "unbacked_claim");
  assert.equal(reason("We run small groups, want to try a class?"), "unbacked_claim");
  assert.equal(reason("Hay limited spots this week, ¿te late?"), "unbacked_claim");
  assert.equal(reason("Cupo limitado esta semana, ¿te animas?"), "fact_claim");
  assert.equal(reason("El plan cuesta $1,500 al mes, ¿te late?"), "price");
  assert.equal(reason("Como te comenté, son $1,996 cada 4 semanas. ¿Te late probar primero?"), "ok");
  assert.equal(reason("<sin_respuesta>"), "markup");
  assert.deepEqual(disallowedUrls("ve a mdcondesa.com/#horarios"), []);
  assert.deepEqual(unquotedPrices("$999 y $1,996", ["inscripción $999"]), ["$1,996"]);
});

test("composeAiFollowup never throws and never waits past the deadline", async () => {
  const ok = (text: string) => ({ ok: true as const, text });
  assert.deepEqual(await composeAiFollowup({ write: async () => ({ ok: true, text: "hola" }), check: ok }), {
    ok: true,
    text: "hola",
    draft: "hola",
  });
  assert.deepEqual(
    await composeAiFollowup({
      write: async () => {
        throw new Error("boom");
      },
      check: ok,
    }),
    { ok: false, reason: "brain_error" },
  );
  assert.deepEqual(await composeAiFollowup({ write: () => new Promise(() => {}), check: ok, timeoutMs: 10 }), {
    ok: false,
    reason: "timeout",
  });
});

test("aiFollowupNote: one line per tick, null when nothing happened", () => {
  const t = newAiFollowupTick();
  assert.equal(aiFollowupNote(t), null);
  t.written = 2;
  t.fallbacks.set("timeout", 1).set("price", 2);
  t.deferred = 1;
  assert.equal(
    aiFollowupNote(t),
    "✍️ Seguimientos día 1 con IA: 2 escrito(s) por la IA, 3 con copy fijo (price 2, timeout 1), 1 pospuesto(s) por el tope de 3/tick.",
  );
});

// ---- 10. end to end through the cron tick (Graph stubbed) -------------------------

test("cron tick end to end: AI text goes out, the message row's meta says aiFollowup, one ops note", async () => {
  const { raw, db } = sqliteDb();
  const calls: string[] = [];
  const notes: { text: string; meta?: unknown }[] = [];
  const g = globalThis as unknown as { fetch: unknown };
  const realFetch = g.fetch;
  let posted = 0;
  g.fetch = async () => {
    posted++;
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.ai${posted}` }] }), text: async () => "" };
  };
  try {
    const at = L + 3 * H; // past the 2 h open-question guard
    await withFlag(true, () =>
      withClock(at, async () => {
        insertContact(raw, contact());
        engagedConvo(raw);
        dueRow(raw, at - 60);
        await runDueFollowups(envWith(db), {
          slack: {
            async postNote(text: string, opts?: { meta?: unknown }) {
              notes.push({ text, ...(opts?.meta ? { meta: opts.meta } : {}) });
            },
            async postAttendanceCheck() {},
          },
          aiFollowup: async (_e, _p, instruction) => {
            calls.push(instruction);
            return { ok: true, text: AI_TEXT };
          },
        });
      }),
    );
  } finally {
    g.fetch = realFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(posted, 1);
  assert.equal(rowStatus(raw).status, "sent");
  const out = raw.prepare(`SELECT body, meta FROM messages WHERE wamid = 'wamid.ai1'`).get() as { body: string; meta: string };
  assert.equal(out.body, AI_TEXT);
  assert.deepEqual(JSON.parse(out.meta), { type: "text", aiFollowup: true });
  const ai = notes.filter((n) => n.text.startsWith("✍️"));
  assert.equal(ai.length, 1);
  assert.deepEqual(ai[0]!.meta, { written: 1, deferred: 0, fallbacks: {} });
});

// ---- 11. 1 h means 1 h for AI follow-ups (open-question guard) -------------------

function stubGraph(): { restore: () => void; posted: () => number } {
  const g = globalThis as unknown as { fetch: unknown };
  const real = g.fetch;
  let n = 0;
  g.fetch = async () => {
    n++;
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.g${n}` }] }), text: async () => "" };
  };
  return { restore: () => (g.fetch = real), posted: () => n };
}

test("openQuestionGuardSeconds: 1 h only for nudge_1h with the flag on and an engaged lead", () => {
  assert.equal(openQuestionGuardSeconds("nudge_1h", true, true), H);
  assert.equal(openQuestionGuardSeconds("nudge_1h", true, false), 2 * H);
  assert.equal(openQuestionGuardSeconds("nudge_1h", false, true), 2 * H);
  assert.equal(openQuestionGuardSeconds("nudge_8h", true, true), 2 * H);
  assert.equal(OPEN_QUESTION_GUARD_SECONDS, 2 * H);
  assert.equal(AI_OPEN_QUESTION_GUARD_SECONDS, H);
});

for (const c of [
  { name: "flag on + engaged → sends at 1 h (brain called)", flag: true, engaged: true, sends: true },
  { name: "flag on + silent → still waits for the 2 h guard", flag: true, engaged: false, sends: false },
  { name: "flag off + engaged → still waits for the 2 h guard", flag: false, engaged: true, sends: false },
]) {
  test(`open-question guard, cron tick: ${c.name}`, async () => {
    const { raw, db } = sqliteDb();
    const calls: string[] = [];
    const graph = stubGraph();
    const at = L + 60 + H + 60; // 1 h 1 min after the bot's question (L + 60)
    try {
      await withFlag(c.flag, () =>
        withClock(at, async () => {
          insertContact(raw, contact());
          if (c.engaged) engagedConvo(raw);
          else {
            msg(raw, "in", "Hola, quiero más información", L);
            msg(raw, "out_bot", BOT_THREAD, L + 60);
          }
          dueRow(raw, at - 60);
          await runDueFollowups(envWith(db), {
            slack: { async postNote() {}, async postAttendanceCheck() {} },
            aiFollowup: async (_e, _p, instruction) => {
              calls.push(instruction);
              return { ok: true, text: AI_TEXT };
            },
          });
        }),
      );
    } finally {
      graph.restore();
    }
    const row = rowStatus(raw);
    if (c.sends) {
      assert.equal(row.status, "sent");
      assert.equal(calls.length, 1);
      assert.equal(graph.posted(), 1);
    } else {
      assert.equal(row.status, "scheduled");
      assert.equal(row.due_at, L + 60 + 2 * H);
      assert.equal(calls.length, 0);
      assert.equal(graph.posted(), 0);
    }
  });
}

// ---- 12. proposed-slot memory only when the sent text names the slot -------------

for (const names of [true, false]) {
  test(`proposed-slot memory: AI text ${names ? "naming" : "not naming"} the plan's slot time → ${names ? "recorded" : "not recorded"}`, async () => {
    const { raw, db } = sqliteDb();
    const sent: Sent[] = [];
    let slotTime = "";
    const w = {
      calls: [] as string[],
      reply: async (instruction: string): Promise<FollowupWrite> => {
        const m = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\)/.exec(instruction);
        assert.ok(m, "the instruction carries the next valid slot");
        slotTime = m![2]!;
        return { ok: true, text: names ? `¿Te late tu primera clase de Muay Thai a las ${time12h(slotTime)}?` : AI_TEXT };
      },
    };
    await withFlag(true, () =>
      withClock(L + H, async () => {
        insertContact(raw, contact());
        engagedConvo(raw);
        assert.equal(await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, w)), "sent");
      }),
    );
    assert.deepEqual(sent[0]!.meta, { aiFollowup: true });
    const kv = raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(`nudge_slots:${PHONE}`) as { value: string } | undefined;
    if (names) {
      assert.ok(kv, "recorded");
      assert.match(kv!.value, new RegExp(slotTime));
    } else {
      assert.equal(kv, undefined);
    }
  });
}

test("proposed-slot memory: the fixed copy still records its slot (unchanged)", async () => {
  const { raw, db } = sqliteDb();
  const sent: Sent[] = [];
  await withFlag(false, () =>
    withClock(L + H, async () => {
      insertContact(raw, contact());
      engagedConvo(raw);
      await processNudge(envWith(db), PHONE, "nudge_1h", deps(sent, writerReturning(AI_TEXT)));
    }),
  );
  const kv = raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(`nudge_slots:${PHONE}`);
  assert.ok(kv);
});

test("textMentionsSlot reads the clock time with the booking-claims parser", () => {
  assert.equal(textMentionsSlot("¿Te late el jueves a las 7:00 am?", { time: "07:00" }), true);
  assert.equal(textMentionsSlot("¿Te late el jueves a las 7 pm?", { time: "19:00" }), true);
  assert.equal(textMentionsSlot("¿Mañana o tarde?", { time: "07:00" }), false);
});

// ---- 13. no-send preview ----------------------------------------------------------

function snapshot(raw: DatabaseSync): string {
  const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
    (t) => t.name,
  );
  return JSON.stringify(tables.map((t) => [t, raw.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}

const P2 = "5215598765432";
const P3 = "5215511112222";

function seedPreview(raw: DatabaseSync): void {
  insertContact(raw, contact()); // engaged, our message last → picked
  engagedConvo(raw);
  insertContact(raw, contact({ phone: P2 })); // silent
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('s1', ?, 'in', 'Hola, info', ?)`).run(P2, L - 100);
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('s2', ?, 'out_bot', '¡Hola! ¿Qué disciplina?', ?)`).run(P2, L - 90);
  insertContact(raw, contact({ phone: P3 })); // engaged, but the LEAD wrote last → not quiet
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('t1', ?, 'in', 'Hola, info', ?)`).run(P3, L - 300);
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('t2', ?, 'out_bot', '¿Qué disciplina?', ?)`).run(P3, L - 290);
  raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('t3', ?, 'in', 'box', ?)`).run(P3, L - 200);
  raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run(`nudge_count:${PHONE}`, JSON.stringify({ sends: [] }));
}

test("preview: picks only the engaged quiet lead, runs the brain even with the flag OFF, writes NOTHING", async () => {
  const { raw, db } = sqliteDb();
  const calls: string[] = [];
  let res: Awaited<ReturnType<typeof runAiFollowupPreview>> | undefined;
  await withFlag(false, () =>
    withClock(L + 2 * H, async () => {
      seedPreview(raw);
      const before = snapshot(raw);
      const parsed = parsePreviewBody({});
      if (!parsed.ok) throw new Error(parsed.error);
      res = await runAiFollowupPreview(envWith(db), parsed.opts, L + 2 * H, {
        write: async (_e, _p, instruction) => {
          calls.push(instruction);
          return { ok: true, text: `${AI_TEXT} https://mdcondesa.com/clase-prueba-adultos/?utm_source=wa` };
        },
      });
      assert.equal(snapshot(raw), before, "no row written anywhere");
    }),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /<seguimiento>/);
  assert.equal(res!.kind, "nudge_1h");
  assert.equal(res!.leads.length, 1);
  const lead = res!.leads[0]!;
  assert.equal(lead.phone, "…5678");
  assert.equal(lead.lastLead, "sí me interesa muay thai");
  assert.equal(lead.lastOurs, BOT_THREAD);
  assert.equal(lead.hoursSilent, 2);
  assert.ok(lead.fixedCopy.length > 0);
  assert.equal(lead.ai.ok, true);
  assert.ok(!JSON.stringify(res).includes("utm_source"), "no query strings");
  assert.ok(!JSON.stringify(res).includes(PHONE) && !JSON.stringify(res).includes(P2), "no full phones");
  assert.ok(lead.cta);
});

test("preview: a guard trip reports reason + guard + the rejected text; explicit phones report stops", async () => {
  const { raw, db } = sqliteDb();
  let res: Awaited<ReturnType<typeof runAiFollowupPreview>> | undefined;
  await withClock(L + 2 * H, async () => {
    seedPreview(raw);
    raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run(`declined:${P3}`, JSON.stringify({ ts: L, source: "objection" }));
    const before = snapshot(raw);
    const parsed = parsePreviewBody({ kind: "nudge_8h", phones: [PHONE, P2, P3] });
    if (!parsed.ok) throw new Error(parsed.error);
    res = await runAiFollowupPreview(envWith(db), parsed.opts, L + 2 * H, {
      write: async () => ({ ok: true, text: "¿Te late Muay Thai a las 3:00 am?" }),
    });
    assert.equal(snapshot(raw), before);
  });
  const [a, b, c] = res!.leads;
  assert.deepEqual([a!.phone, b!.phone, c!.phone], ["…5678", "…5432", "…2222"]);
  assert.equal(a!.ai.ok, false);
  assert.equal(a!.ai.reason, "slot_claim");
  assert.match(a!.ai.guard ?? "", /NUNCA se imparte/);
  assert.equal(a!.ai.text, "¿Te late Muay Thai a las 3:00 am?");
  assert.deepEqual(b!.ai, { ok: false, reason: "stop:silent" });
  assert.deepEqual(c!.ai, { ok: false, reason: "stop:declined" });
});

test("parsePreviewBody: defaults and limits", () => {
  assert.deepEqual(parsePreviewBody(undefined), { ok: true, opts: { kind: "nudge_1h", phones: null, limit: 3, sinceHours: 48 } });
  assert.equal(parsePreviewBody({ kind: "nudge_d2" }).ok, false);
  assert.equal(parsePreviewBody({ limit: 6 }).ok, false);
  assert.equal(parsePreviewBody({ sinceHours: 169 }).ok, false);
  assert.equal(parsePreviewBody({ phones: ["1", "2", "3", "4", "5", "6"] }).ok, false);
  assert.equal(parsePreviewBody({ phones: ["+52 1 55 1234 5678"] }).ok, true);
});

test("preview SQL stays on its indexes (no table scans)", () => {
  const { raw } = sqliteDb();
  for (const sql of Object.values(PREVIEW_SQL)) {
    const n = new Set(sql.match(/\?\d/g) ?? []).size;
    const plan = JSON.stringify(raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(["x", 1].slice(0, n) as never[])));
    assert.match(plan, /USING (COVERING )?INDEX idx_messages_/);
    assert.doesNotMatch(plan, /SCAN messages(?! USING)/);
  }
});
