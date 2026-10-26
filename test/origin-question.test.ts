// "¿Cómo nos encontraste?" (owner, 2026-10-21): asked once, minutes AFTER the
// booking confirmation, only to leads with no ad / Google click / campaign; the
// answer lands in Leads.Canal (+ raw text) for the Origen formula.
// Pure rules first; then the arm → send → capture flow on real in-memory
// SQLite (production schema) with fetch stubbed for Graph and Airtable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  ORIGIN_ANSWER_WINDOW_SEC,
  ORIGIN_MAX_DEFERS,
  canalWritable,
  classifyOriginAnswer,
  leadAlreadyAttributed,
  originArmedKey,
  originAwaitingAnswer,
  originQuestionCopy,
  originSendGate,
  originStateKey,
  parseOriginState,
  recentOriginAnswer,
  shouldAskOrigin,
  type GateMessage,
} from "../src/services/origin-question-core.js";
import { armOriginQuestion, captureOriginAnswer, sendOriginQuestion } from "../src/services/origin-question.js";
import { buildContextBlock } from "../src/brain/prompt.js";
import { INDEX_SQL } from "../src/db/indexes.js";
import { CLIENT } from "../src/client.gen.js";
import type { Contact, ConvoContext, Env, Followup } from "../src/types.js";

// ---- classifier ----

const CASES: Array<[string, string | null]> = [
  ["1", "Anuncio"],
  ["1️⃣", "Anuncio"],
  ["el 2", "Post orgánico"],
  ["3.", "Google Maps"],
  ["Opción 4", "Google"],
  ["5", "Referido"],
  ["6!", "Local"],
  ["Por un anuncio en Instagram", "Anuncio"],
  ["vi su publicidad en face", "Anuncio"],
  ["I saw your ad on Instagram", "Anuncio"],
  ["En instagram pero no fue anuncio, una publicación", "Post orgánico"],
  ["vi un reel", "Post orgánico"],
  ["Google maps", "Google Maps"],
  ["en el mapa", "Google Maps"],
  ["Busqué en Google", "Google"],
  ["por internet", "Google"],
  ["Me recomendó una amiga", "Referido"],
  ["un amigo", "Referido"],
  ["mi hermana entrena con ustedes", "Referido"],
  ["A friend recommended you", "Referido"],
  ["Pasé por la academia caminando", "Local"],
  ["vivo cerca", "Local"],
  ["vi la lona", "Local"],
  ["I walked by", "Local"],
  ["Instagram", null],
  ["por redes sociales", null],
];

test("classifyOriginAnswer: numbers, keycaps and keywords map to the Canal options", () => {
  for (const [text, canal] of CASES) {
    const r = classifyOriginAnswer(text);
    assert.ok(r, `expected an answer for ${JSON.stringify(text)}`);
    assert.equal(r!.canal, canal, text);
  }
});

test("classifyOriginAnswer: unrelated messages, questions and times are not answers", () => {
  for (const t of [
    "Gracias!",
    "ok 👍",
    "ahí estaré",
    "a las 5 pm",
    "¿tienen estacionamiento?",
    "¿La ubicación en Google Maps?",
    "voy a ir con un amigo",
    "mi esposo también quiere ir",
    "7",
    "10",
    "",
  ]) {
    assert.equal(classifyOriginAnswer(t), null, t);
  }
});

// ---- eligibility / Canal guards ----

const LEAD: Pick<Contact, "status" | "ad_ref" | "campaign_id"> = { status: "lead", ad_ref: null, campaign_id: null };

test("shouldAskOrigin: only plain leads with no ad, campaign or Google click", () => {
  assert.equal(shouldAskOrigin({ contact: LEAD, hasGoogleClick: false }), true);
  assert.equal(shouldAskOrigin({ contact: { ...LEAD, ad_ref: '{"sourceId":"1"}' }, hasGoogleClick: false }), false);
  assert.equal(shouldAskOrigin({ contact: { ...LEAD, campaign_id: 3 }, hasGoogleClick: false }), false);
  assert.equal(shouldAskOrigin({ contact: LEAD, hasGoogleClick: true }), false);
  assert.equal(shouldAskOrigin({ contact: { ...LEAD, status: "student" }, hasGoogleClick: false }), false);
  assert.equal(shouldAskOrigin({ contact: { ...LEAD, status: "opted_out" }, hasGoogleClick: false }), false);
  assert.equal(shouldAskOrigin({ contact: null, hasGoogleClick: false }), false);
});

test("canalWritable / leadAlreadyAttributed: only empty or bot-written Canal is replaced", () => {
  for (const v of [undefined, null, "", "WA", "IG", "FB", { name: "WA" }]) assert.equal(canalWritable(v), true, String(v));
  for (const v of ["Referido", "Google Maps", "Anuncio", { name: "Local" }]) assert.equal(canalWritable(v), false, String(v));
  assert.equal(leadAlreadyAttributed({ Canal: "WA" }, "Canal"), false);
  assert.equal(leadAlreadyAttributed({ Canal: "Referido" }, "Canal"), true);
  assert.equal(leadAlreadyAttributed({ Canal: "WA", "Adquisición": "Orgánico" }, "Canal"), true);
  assert.equal(leadAlreadyAttributed({ Canal: "WA", "Vio anuncio": ["Sí, vio anuncio en Facebook/Instagram"] }, "Canal"), true);
  assert.equal(leadAlreadyAttributed({ Canal: "WA", "Vio anuncio": ["No respondió"] }, "Canal"), false);
});

test("originQuestionCopy: client copy per language; the numbered options follow ORIGIN_OPTIONS", () => {
  const es = originQuestionCopy("es", CLIENT.copy)!;
  const en = originQuestionCopy("en", CLIENT.copy)!;
  assert.match(es, /1️⃣ Un anuncio[\s\S]*2️⃣ Una publicación[\s\S]*3️⃣ Google Maps[\s\S]*4️⃣ Google\n[\s\S]*5️⃣ Me recomendaron[\s\S]*6️⃣ Pasé por la academia/);
  assert.match(en, /How did you find us/);
  assert.equal(originQuestionCopy("es", {}), null);
});

// ---- send gate / state ----

const NOW = 1_800_000_000;

test("originSendGate: never talks over a live exchange", () => {
  const m = (direction: GateMessage["direction"], body: string, ago: number): GateMessage => ({ direction, body, ts: NOW - ago });
  assert.equal(originSendGate([], NOW), "send");
  assert.equal(originSendGate([m("out_bot", "[video]", 200), m("out_bot", "¡Listo! Te esperamos 🙏", 210)], NOW), "send");
  // Lead just wrote → a brain turn / approval may still answer.
  assert.equal(originSendGate([m("in", "gracias", 120)], NOW), "defer");
  // An old unanswered "gracias" is a closed exchange.
  assert.equal(originSendGate([m("in", "gracias", 20 * 60)], NOW), "send");
  // The confirmation asked something < 2h ago (video came after it).
  assert.equal(originSendGate([m("out_bot", "[video]", 200), m("out_bot", "¿Vienes solo o acompañado?", 210)], NOW), "defer");
  assert.equal(originSendGate([m("out_bot", "¿Vienes solo o acompañado? 😊", 3 * 3600)], NOW), "send");
  // Staff spoke < 60 min ago.
  assert.equal(originSendGate([m("out_human", "Te esperamos!", 600)], NOW), "defer");
  // Oldest-first, as recentMessages() returns it (…1122, 2026-10-22): the lead's
  // names 8 min ago are the NEWEST message → defer.
  const asc = [
    m("out_bot", "Listo Lorena, ya tienes tu lugar! 🙌🔥", 1184),
    m("out_bot", "[video]", 1183),
    m("in", "Iríamos 3, mi hija de 13 y mi esposo por favor", 1176),
    m("in", "[reaccionó ❤️]", 1138),
    m("out_bot", "¿me confirmas sus nombres y la edad de tu hija?", 551),
    m("in", "Juan Carlos Martinez\nDaniela Martinez 13 años", 482),
  ];
  assert.equal(originSendGate(asc, NOW), "defer");
});

test("origin state: awaiting until answered, two misses, or 48h", () => {
  const s = parseOriginState(JSON.stringify({ askedAt: NOW }))!;
  assert.equal(originAwaitingAnswer(s, NOW + 60), true);
  assert.equal(originAwaitingAnswer(s, NOW + ORIGIN_ANSWER_WINDOW_SEC + 1), false);
  assert.equal(originAwaitingAnswer({ ...s, misses: 2 }, NOW + 60), false);
  assert.equal(originAwaitingAnswer({ ...s, answeredAt: NOW + 30 }, NOW + 60), false);
  assert.equal(parseOriginState("nope"), null);
  assert.deepEqual(recentOriginAnswer({ askedAt: NOW, answeredAt: NOW + 10, canal: "Referido" }, NOW + 60), { canal: "Referido" });
  assert.equal(recentOriginAnswer({ askedAt: NOW, answeredAt: NOW + 10, canal: "Referido" }, NOW + 3600), null);
});

test("prompt: the <origen> hint names the answer and forbids asking again", () => {
  const ctx = {
    phone: "5215500000000",
    contact: { phone: "5215500000000", name: null, lang: "es", status: "lead", qualification: null, human_override_until: null, last_inbound_at: null, campaign_id: null, ad_ref: null, airtable_lead_id: null, created_at: 0, updated_at: 0 },
    history: [],
    nowCdmx: "2026-10-21T12:00:00-06:00",
    weekday: "miércoles",
    windowOpen: true,
    trainingWheels: true,
    originAnswer: { canal: "Referido" },
  } as unknown as ConvoContext;
  const block = buildContextBlock(ctx);
  assert.match(block, /<origen>[\s\S]*\(Referido\)[\s\S]*Nunca vuelvas a preguntar[\s\S]*<\/origen>/);
});

// ---- flow on real SQLite ----

function schemaStatements(): string[] {
  const text = readFileSync("src/db/schema.sql", "utf8")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function openDb(): { raw: DatabaseSync; env: Env } {
  const raw = new DatabaseSync(":memory:");
  for (const stmt of schemaStatements()) raw.exec(stmt);
  for (const sql of INDEX_SQL) raw.exec(sql);
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        return (raw.prepare(sql).get(...binds) ?? null) as T | null;
      },
      async run() {
        const r = raw.prepare(sql).run(...binds);
        return { results: [], meta: { changes: Number(r.changes) } };
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...binds) as T[], meta: {} };
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  };
  const db = { prepare: make } as unknown as D1Database;
  return {
    raw,
    env: {
      DB: db,
      AIRTABLE_BASE_ID: "appTEST",
      AIRTABLE_PAT: "pat",
      AIRTABLE_TRIALS_TABLE: "Leads",
      WA_ACCESS_TOKEN: "t",
      WA_PHONE_NUMBER_ID: "1",
    } as unknown as Env,
  };
}

const PHONE = "5215511112222";

interface Stub {
  sent: string[];
  patches: Array<Record<string, unknown>>;
  restore(): void;
}

/** Graph send → wamid; Airtable list → one lead; PATCH → captured. */
function stubFetch(leadFields: Record<string, unknown>): Stub {
  const real = globalThis.fetch;
  const sent: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("graph.facebook.com")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: { body?: string } };
      sent.push(body.text?.body ?? "");
      return json({ messages: [{ id: `wamid.${sent.length}` }] });
    }
    if (url.includes("api.airtable.com")) {
      if (init?.method === "PATCH") {
        const b = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
        patches.push(b.fields);
        return json({ id: "recLEAD", fields: { ...leadFields, ...b.fields } });
      }
      return json({ records: [{ id: "recLEAD", fields: { "# de Teléfono": PHONE, ...leadFields } }] });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { sent, patches, restore: () => void (globalThis.fetch = real) };
}

function addContact(raw: DatabaseSync, over: Partial<Contact> = {}): void {
  const now = Math.floor(Date.now() / 1000);
  raw
    .prepare(
      `INSERT INTO contacts(phone, name, lang, status, campaign_id, ad_ref, last_inbound_at, created_at, updated_at)
       VALUES(?, 'Alexis', ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(PHONE, over.lang ?? "es", over.status ?? "lead", over.campaign_id ?? null, over.ad_ref ?? null, over.last_inbound_at ?? now - 600);
}

function originRows(raw: DatabaseSync): Followup[] {
  return raw.prepare(`SELECT * FROM followups WHERE phone = ? AND kind = 'origin_ask'`).all(PHONE) as unknown as Followup[];
}

test("armOriginQuestion: arms once per phone, never for ad / campaign / Google-click leads", async () => {
  const { raw, env } = openDb();
  addContact(raw);
  await armOriginQuestion(env, PHONE);
  await armOriginQuestion(env, PHONE); // second confirmation (rebook) → still one
  const rows = originRows(raw);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.due_at > Math.floor(Date.now() / 1000), "due a few minutes AFTER the confirmation");
  assert.ok(raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(originArmedKey(PHONE)));

  for (const over of [{ ad_ref: '{"sourceId":"120"}' }, { campaign_id: 2 }, { status: "student" as const }]) {
    const db = openDb();
    addContact(db.raw, over);
    await armOriginQuestion(db.env, PHONE);
    assert.equal(originRows(db.raw).length, 0, JSON.stringify(over));
  }
  const g = openDb();
  addContact(g.raw);
  g.raw.prepare(`INSERT INTO kv(key, value) VALUES(?, '{}')`).run(`gclick:${PHONE}`);
  await armOriginQuestion(g.env, PHONE);
  assert.equal(originRows(g.raw).length, 0, "Google click");
});

function dueRow(raw: DatabaseSync): Followup {
  raw.prepare(`UPDATE followups SET due_at = 0 WHERE phone = ? AND kind = 'origin_ask'`).run(PHONE);
  return originRows(raw)[0]!;
}

/** Daytime for the send path (its 21:00–08:00 CDMX quiet check is tested in quiet.ts). */
const DAY = { isQuiet: () => false };

test("sendOriginQuestion → captureOriginAnswer: asks once, writes Canal + raw answer", async () => {
  const { raw, env } = openDb();
  addContact(raw);
  await armOriginQuestion(env, PHONE);
  const stub = stubFetch({ Canal: "WA" });
  try {
    await sendOriginQuestion(env, dueRow(raw), DAY);
    assert.equal(stub.sent.length, 1);
    assert.match(stub.sent[0]!, /¿Cómo nos encontraste\?/);
    assert.equal(originRows(raw)[0]!.status, "sent");

    const now = Math.floor(Date.now() / 1000);
    // An ack is not an answer (one miss).
    assert.equal(await captureOriginAnswer(env, PHONE, "Gracias!", now), null);
    // The answer.
    assert.deepEqual(await captureOriginAnswer(env, PHONE, "5", now + 30), { canal: "Referido" });
    assert.deepEqual(stub.patches, [{ Canal: "Referido", "Cómo nos encontró": "5" }]);
    const state = parseOriginState((raw.prepare(`SELECT value FROM kv WHERE key = ?`).get(originStateKey(PHONE)) as { value: string }).value);
    assert.equal(state?.canal, "Referido");
    // Closed: later messages are never read as answers.
    assert.equal(await captureOriginAnswer(env, PHONE, "1", now + 60), null);
    assert.equal(stub.patches.length, 1);
  } finally {
    stub.restore();
  }
});

test("captureOriginAnswer: a human-set Canal is never overwritten; raw text still recorded", async () => {
  const { raw, env } = openDb();
  addContact(raw);
  const now = Math.floor(Date.now() / 1000);
  raw.prepare(`INSERT INTO kv(key, value) VALUES(?, ?)`).run(originStateKey(PHONE), JSON.stringify({ askedAt: now - 60 }));
  const stub = stubFetch({ Canal: "Local" });
  try {
    assert.deepEqual(await captureOriginAnswer(env, PHONE, "un anuncio en insta", now), { canal: "Anuncio" });
    assert.deepEqual(stub.patches, [{ "Cómo nos encontró": "un anuncio en insta" }]);
  } finally {
    stub.restore();
  }
});

test("sendOriginQuestion: staff already tagged the lead / lead still talking / gave up", async () => {
  // Tagged in Airtable → cancelled, nothing sent.
  {
    const { raw, env } = openDb();
    addContact(raw);
    await armOriginQuestion(env, PHONE);
    const stub = stubFetch({ Canal: "WA", "Adquisición": "Orgánico" });
    try {
      await sendOriginQuestion(env, dueRow(raw), DAY);
      assert.equal(stub.sent.length, 0);
      assert.equal(originRows(raw)[0]!.status, "cancelled");
    } finally {
      stub.restore();
    }
  }
  // The lead wrote 1 min ago → deferred, counter in the note.
  {
    const { raw, env } = openDb();
    addContact(raw);
    await armOriginQuestion(env, PHONE);
    const now = Math.floor(Date.now() / 1000);
    raw.prepare(`INSERT INTO messages(wamid, phone, direction, body, ts) VALUES('w1', ?, 'in', 'una duda', ?)`).run(PHONE, now - 60);
    const stub = stubFetch({ Canal: "WA" });
    try {
      await sendOriginQuestion(env, dueRow(raw), DAY);
      assert.equal(stub.sent.length, 0);
      const row = originRows(raw)[0]!;
      assert.equal(row.status, "scheduled");
      assert.equal(row.note, "defers:1");
      assert.ok(row.due_at > now);
      // Too many deferrals → dropped.
      raw.prepare(`UPDATE followups SET note = ? WHERE id = ?`).run(`defers:${ORIGIN_MAX_DEFERS}`, row.id);
      await sendOriginQuestion(env, dueRow(raw), DAY);
      assert.equal(originRows(raw)[0]!.status, "cancelled");
    } finally {
      stub.restore();
    }
  }
  // 24h window closed → cancelled quietly.
  {
    const { raw, env } = openDb();
    addContact(raw, { last_inbound_at: Math.floor(Date.now() / 1000) - 30 * 3600 });
    await armOriginQuestion(env, PHONE);
    const stub = stubFetch({ Canal: "WA" });
    try {
      await sendOriginQuestion(env, dueRow(raw), DAY);
      assert.equal(stub.sent.length, 0);
      assert.equal(originRows(raw)[0]!.status, "cancelled");
    } finally {
      stub.restore();
    }
  }
});

test("sendOriginQuestion: quiet hours push it to the next morning", async () => {
  const { raw, env } = openDb();
  addContact(raw);
  await armOriginQuestion(env, PHONE);
  const stub = stubFetch({ Canal: "WA" });
  try {
    await sendOriginQuestion(env, dueRow(raw), { isQuiet: () => true });
    assert.equal(stub.sent.length, 0);
    const row = originRows(raw)[0]!;
    assert.equal(row.status, "scheduled");
    assert.ok(row.due_at > Math.floor(Date.now() / 1000));
  } finally {
    stub.restore();
  }
});
