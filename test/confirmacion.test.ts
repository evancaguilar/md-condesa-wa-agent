// The ONE booking confirmation (owner copy 2026-10-16, docs/cuestionario.md):
// a single text with the lead's signed /tu-primera-clase/?t= link, then the
// booking video — no separate questionnaire invite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signToken, verifyToken } from "../src/services/cuestionario-token.js";
import {
  confirmationText,
  confirmTemplateBody,
  confirmTemplateComponents,
  firstClassTokenIn,
  personalizeConfirmation,
} from "../src/services/cuestionario-core.js";
import {
  afterBookingConfirmed,
  personalizeBookingConfirmation,
  sendFirstClassConfirmation,
  sentKey,
} from "../src/services/cuestionario.js";
import { confirmTemplateInputs, CONFIRM_SEED_KEY } from "../src/cron/template-seed-cuestionario.js";
import { WindowClosedError } from "../src/services/send.js";
import type { Env } from "../src/types.js";

const SECRET = "test-secret-123";
const NOW = 1792000000; // 2026-10-14
const REC = "recAbCdEfGhIjKlMn";
/** viernes 16 de octubre 2026, 7:00 PM CDMX */
const FRI_7PM = 1792198800;
/** miércoles 14 de octubre 2026, 1:00 PM CDMX */
const WED_1PM = 1792004400;
const CLOSING = "Si quieres invitar a un amigo o pariente, estaría súper 👊 Cualquier duda, aquí estoy 🙏";
const L = "https://mdcondesa.com/tu-primera-clase/?t=TOKEN";

function fakeKvDb(): { db: D1Database; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (/SELECT value FROM kv/.test(sql)) {
            const v = kv.get(String(args[0]));
            return (v === undefined ? null : { value: v }) as T | null;
          }
          // An in-window lead (the booking video needs the 24 h window).
          if (/FROM contacts/.test(sql)) {
            return { phone: String(args[0]), status: "lead", lang: "es", last_inbound_at: Math.floor(Date.now() / 1000) - 60 } as T;
          }
          return null;
        },
        async run() {
          if (/INSERT (OR IGNORE )?INTO kv|INSERT INTO kv/.test(sql)) kv.set(String(args[0]), String(args[1]));
          return { results: [], meta: { changes: 1 } };
        },
        async all() {
          return { results: [], meta: {} };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, kv };
}

const LEAD = {
  "# de Teléfono": "+5215511112222",
  "Nombre de Lead": "Ana",
  "Fecha Clase Prueba": "2026-10-17T01:00:00.000Z", // viernes 16, 7:00 PM CDMX
  Programa: "Adultos",
};

// ---- copy -------------------------------------------------------------------------

test("confirmationText: the owner's adultos / kids / bfc copy, closing with 👊", () => {
  assert.equal(
    confirmationText({ version: "adultos", lang: "es", name: "Ana", kid: null, trialEpoch: FRI_7PM, link: L }),
    `Listo Ana, ya tienes tu lugar! 🙌🔥 Te esperamos el viernes 16 de octubre a las 7:00 PM en MD Condesa para tu primera clase. Aquí está todo lo que necesitas saber, y 3 minutos de preguntas para que tu coach te reciba sabiendo qué buscas y prepare tu clase pensando en ti 💪 ${L}\n\n${CLOSING}`,
  );
  assert.equal(
    confirmationText({ version: "kids", lang: "es", name: "Ana", kid: "Mateo", trialEpoch: FRI_7PM, link: L }),
    `Listo Ana, Mateo ya tiene su lugar! 🙌🔥 Los esperamos el viernes 16 de octubre a las 7:00 PM en MD Condesa para su primera clase. Aquí está todo lo que necesitan saber, y 3 minutos de preguntas para que su coach reciba a Mateo sabiendo qué buscan ustedes 💪 ${L}\n\n${CLOSING}`,
  );
  assert.equal(
    confirmationText({ version: "bfc", lang: "es", name: "Ana", kid: "Leo", trialEpoch: WED_1PM, link: L }),
    `Listo Ana, Leo ya tiene su lugar en Baby Fight Club! 🙌 Los esperamos a los dos el miércoles 14 de octubre a la 1:00 PM en MD Condesa. Aquí está todo lo que necesitan saber para su primera clase, y 2 minutos de preguntas para que el coach los conozca antes de llegar 🥋 ${L}\n\n${CLOSING}`,
  );
});

test("confirmationText: no name → 'Listo, …'; no child → 'tu peque'; EN keeps the closing", () => {
  const a = confirmationText({ version: "adultos", lang: "es", name: "", kid: null, trialEpoch: FRI_7PM, link: L })!;
  assert.match(a, /^Listo, ya tienes tu lugar! /);
  const k = confirmationText({ version: "kids", lang: "es", name: "", kid: null, trialEpoch: FRI_7PM, link: L })!;
  assert.match(k, /^Listo, tu peque ya tiene su lugar! .* reciba a tu peque sabiendo/);
  const en = confirmationText({ version: "adultos", lang: "en", name: "Ann", kid: null, trialEpoch: FRI_7PM, link: L })!;
  assert.match(en, /^All set Ann, your spot is saved! 🙌🔥 We'll see you on Friday, October 16 at 7:00 PM at MD Condesa/);
  assert.match(en, /\n\nIf you'd like to invite a friend or family member, that'd be awesome 👊 Any questions, I'm here 🙏$/);
  for (const t of [a, k, en]) assert.doesNotMatch(t, /^[¡¿]/);
});

test("personalizeConfirmation: the brain's generic link becomes the signed one; closing ensured", () => {
  const brain =
    "Listo Ana, ya tienes tu lugar! 🙌🔥 Te esperamos el viernes a las 7:00 PM. Aquí está todo 💪 mdcondesa.com/tu-primera-clase/\n\nSi quieres invitar a un amigo o pariente, estaría súper 💪 Cualquier duda, aquí estoy 🙏";
  const out = personalizeConfirmation(brain, L, "es");
  assert.equal(out.match(/tu-primera-clase/g)?.length, 1);
  assert.ok(out.includes(`💪 ${L}\n\n`));
  assert.ok(out.endsWith(CLOSING), "old 💪 closing → 👊");
  // https, www, the wrong page, an old token: all replaced by the record's link
  for (const u of [
    "https://mdcondesa.com/tu-primera-clase-bebes/",
    "https://www.mdcondesa.com/tu-primera-clase-ninos",
    "https://mdcondesa.com/tu-primera-clase/?t=v1.old.sig",
  ]) {
    assert.equal(personalizeConfirmation(`Listo! ${u}`, L, "es"), `Listo! ${L}\n\n${CLOSING}`);
  }
  // No link written → inserted before the closing paragraph
  assert.equal(
    personalizeConfirmation(`Listo Ana, ya tienes tu lugar!\n\n${CLOSING}`, L, "es"),
    `Listo Ana, ya tienes tu lugar! ${L}\n\n${CLOSING}`,
  );
  // …or at the end when there is no closing
  assert.equal(personalizeConfirmation("Listo Ana!", L, "es"), `Listo Ana! ${L}\n\n${CLOSING}`);
  // Signing failed → the generic link stays; the closing is still ensured; "a la 1:00"
  assert.equal(
    personalizeConfirmation("Te esperamos a las 1:00 PM mdcondesa.com/tu-primera-clase-bebes/", null, "es"),
    `Te esperamos a la 1:00 PM mdcondesa.com/tu-primera-clase-bebes/\n\n${CLOSING}`,
  );
});

test("firstClassTokenIn: only a ?t= token on a first-class page", () => {
  assert.equal(firstClassTokenIn("x https://mdcondesa.com/tu-primera-clase-ninos/?t=v1.abc.def y"), "v1.abc.def");
  assert.equal(firstClassTokenIn("mdcondesa.com/tu-primera-clase/"), null);
  assert.equal(firstClassTokenIn("https://mdcondesa.com/cuestionario/?t=v1.abc.def"), null);
  assert.equal(firstClassTokenIn(null), null);
});

// ---- templates --------------------------------------------------------------------

test("primera_clase templates: 6, no name / link, closing, one page per button, examples match", () => {
  const inputs = confirmTemplateInputs();
  assert.deepEqual(
    inputs.map((i) => i.name),
    ["primera_clase_es", "primera_clase_en", "primera_clase_kids_es", "primera_clase_kids_en", "primera_clase_bfc_es", "primera_clase_bfc_en"],
  );
  for (const i of inputs) {
    assert.equal(i.category, "UTILITY");
    assert.doesNotMatch(i.body, /\{link\}|https?:|\{who\}|\{kid\}|\{cuando\}/);
    assert.match(i.body, /👊/);
    assert.equal((i.body.match(/\{\{\d\}\}/g) ?? []).length, i.bodyExamples?.length);
    const b = i.buttons![0] as { url: string; text: string; example: string[] };
    assert.ok(b.text.length <= 25);
    assert.ok(b.example[0]!.startsWith(b.url.replace("{{1}}", "")));
  }
  const urls = inputs.map((i) => (i.buttons![0] as { url: string }).url);
  assert.equal(urls[0], "https://mdcondesa.com/tu-primera-clase/?t={{1}}");
  assert.equal(urls[2], "https://mdcondesa.com/tu-primera-clase-ninos/?t={{1}}");
  assert.equal(urls[4], "https://mdcondesa.com/tu-primera-clase-bebes/?t={{1}}");
  assert.equal(
    inputs[2]!.body,
    `Listo, {{1}} ya tiene su lugar! 🙌🔥 Los esperamos el {{2}} en MD Condesa para su primera clase. Aquí está todo lo que necesitan saber, y 3 minutos de preguntas para que su coach reciba a {{3}} sabiendo qué buscan ustedes 💪\n\n${CLOSING}`,
  );
  assert.equal(CONFIRM_SEED_KEY, "tpl_seed:primera_clase:2026-10-16");
});

test("confirmTemplateBody / Components: params in order of appearance, token as the button suffix", () => {
  const { body, params } = confirmTemplateBody("Listo{who}, {kid} ya{cuando} para {kid} {link}", "es", "C");
  assert.equal(body, "Listo, {{1}} ya el {{2}} para {{3}}\n\nC");
  assert.deepEqual(params, ["kid", "cuando", "kid"]);
  const comps = confirmTemplateComponents("es", WED_1PM, null, "tok", params) as {
    parameters: { text: string }[];
  }[];
  assert.deepEqual(comps[0]!.parameters.map((p) => p.text), ["tu peque", "miércoles 14 de octubre a la 1:00 PM", "tu peque"]);
  assert.equal(comps[1]!.parameters[0]!.text, "tok");
});

// ---- I/O --------------------------------------------------------------------------

test("personalizeBookingConfirmation: signed link for the record's page; dark/no record → text kept", async () => {
  const { db } = fakeKvDb();
  const on = { DB: db, CUESTIONARIO_ENABLED: "1", CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  const deps = {
    getRecord: async (_e: Env, id: string) => ({ id, fields: { ...LEAD, Programa: "Kids", "Nombre Del Niñ@": "Mateo" } }),
    getContact: async () => null,
  };
  const brain = "Listo Ana, Mateo ya tiene su lugar! 💪 mdcondesa.com/tu-primera-clase/";
  const out = await personalizeBookingConfirmation(on, "5215511112222", brain, { recordId: `${REC}#1`, lang: "es", deps, now: NOW });
  const token = firstClassTokenIn(out)!;
  assert.match(out, /https:\/\/mdcondesa\.com\/tu-primera-clase-ninos\/\?t=v1\./, "the record (kids) picks the page");
  assert.deepEqual(await verifyToken(SECRET, token, NOW), { recordId: REC, version: "kids", exp: NOW + 14 * 86400 });
  assert.ok(out.endsWith(CLOSING));

  const off = { DB: db, CUESTIONARIO_ENABLED: "0", CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  assert.equal(await personalizeBookingConfirmation(off, "5215511112222", brain, { recordId: REC, deps }), `${brain}\n\n${CLOSING}`);
  const gone = { getRecord: async () => null, getContact: async () => null };
  assert.equal(
    await personalizeBookingConfirmation(on, "5215511112222", brain, { recordId: REC, deps: gone, now: NOW }),
    `${brain}\n\n${CLOSING}`,
    "record not found → generic link, confirmation not blocked",
  );
});

test("sendFirstClassConfirmation: open window → one text with the link; closed → primera_clase template", async () => {
  const { db } = fakeKvDb();
  const env = { DB: db, CUESTIONARIO_ENABLED: "1", CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  const sent: string[] = [];
  const tpls: { name: string; components: unknown[] }[] = [];
  const base = {
    now: () => NOW,
    getRecord: async (_e: Env, id: string) => ({ id, fields: { ...LEAD } }),
    getContact: async () => null,
    sendTemplate: async (_e: Env, _p: string, name: string, _l: string, components?: unknown[]) => {
      tpls.push({ name, components: components ?? [] });
      return "wamid.t";
    },
  };
  const r = await sendFirstClassConfirmation(
    env,
    { ...base, sendText: async (_e, _p, body) => (sent.push(body), "wamid.1") },
    { recordId: REC, phone: "5215511112222" },
  );
  assert.deepEqual(r.ok && [r.via, r.version, r.recordId], ["text", "adultos", REC]);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^Listo Ana, ya tienes tu lugar! 🙌🔥 Te esperamos el viernes 16 de octubre a las 7:00 PM en MD Condesa/);
  assert.match(sent[0]!, /💪 https:\/\/mdcondesa\.com\/tu-primera-clase\/\?t=v1\.[\w-]+\.[\w-]+\n\nSi quieres invitar/);

  const closed = { ...base, sendText: async (_e: Env, p: string): Promise<string> => { throw new WindowClosedError(p); } };
  const r2 = await sendFirstClassConfirmation(env, closed, { recordId: REC, phone: "5215511112222" });
  assert.equal(r2.ok && r2.via, "template");
  assert.equal(tpls[0]!.name, "primera_clase_es");
  const comps = tpls[0]!.components as { parameters: { text: string }[] }[];
  assert.deepEqual(comps[0]!.parameters.map((p) => p.text), ["viernes 16 de octubre a las 7:00 PM"]);
  assert.equal(((await verifyToken(SECRET, comps[1]!.parameters[0]!.text, NOW)) as { recordId: string }).recordId, REC);

  const notApproved = {
    ...closed,
    sendTemplate: async (): Promise<string> => {
      throw new Error("(#132001) Template name does not exist in the translation");
    },
  };
  const r3 = await sendFirstClassConfirmation(env, notApproved, { recordId: REC, phone: "5215511112222" });
  assert.equal(!r3.ok && r3.reason, "window_closed", "caller falls back to trial_confirm + invite");

  const off = { DB: db, CUESTIONARIO_ENABLED: "0", CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  assert.deepEqual(await sendFirstClassConfirmation(off, base, { recordId: REC, phone: "5215511112222" }), {
    ok: false,
    reason: "disabled",
  });
});

test("afterBookingConfirmed: a confirmation that carried the signed link → video + stamp, no invite", async () => {
  const { db, kv } = fakeKvDb();
  const env = {
    DB: db,
    CUESTIONARIO_ENABLED: "1",
    CUESTIONARIO_SECRET: SECRET,
    WA_ACCESS_TOKEN: "x",
    WA_PHONE_NUMBER_ID: "1",
  } as unknown as Env;
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(url)} ${String(init?.body ?? "")}`);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.v" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(SECRET, { recordId: REC, version: "kids" }, now);
    const patches: Record<string, unknown>[] = [];
    await afterBookingConfirmed(env, "5215511112222", {
      sentText: `Listo! https://mdcondesa.com/tu-primera-clase-ninos/?t=${token}`,
      patch: async (_e, _id, f) => {
        patches.push(f);
      },
    });
    const graph = calls.filter((c) => c.includes("graph.facebook.com"));
    assert.equal(graph.length, 1, "only the booking video goes out");
    assert.match(graph[0]!, /"video"/);
    assert.equal(patches.length, 1);
    assert.equal(patches[0]!["Cuestionario versión"], "kids");
    assert.ok(kv.has(sentKey(REC)), "the sync loop will not send an invite on top");
  } finally {
    globalThis.fetch = realFetch;
  }
});
