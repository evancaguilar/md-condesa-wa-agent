import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audioAttachments,
  pendingFormula,
  claimIsStale,
  extractNovaTranscript,
  sectionLine,
  runSalesAudio,
  PROCESSING_MARK,
  NOVA_MODEL,
} from "../src/cron/sales-audio.js";
import type { Env } from "../src/types.js";

test("audioAttachments keeps audio by mime or extension, drops images", () => {
  const cell = [
    { id: "att1", url: "https://x/1", filename: "venta.m4a", type: "audio/mp4" },
    { id: "att2", url: "https://x/2", filename: "nota de voz.mp3", type: "" },
    { id: "att3", url: "https://x/3", filename: "foto.jpg", type: "image/jpeg" },
  ];
  assert.deepEqual(audioAttachments(cell).map((a) => a.id), ["att1", "att2"]);
  assert.deepEqual(audioAttachments(undefined), []);
});

test("pendingFormula + claimIsStale", () => {
  const f = pendingFormula({ audio: "Audio venta", processed: "Audio venta procesado" });
  assert.match(f, /LEN\(\{Audio venta\}&""\)>0/);
  assert.match(f, /\{Audio venta procesado\}=BLANK\(\)/);
  assert.equal(claimIsStale("", 1000), true);
  assert.equal(claimIsStale(`${PROCESSING_MARK} 1000`, 1000 + 60), false, "fresh claim is owned");
  assert.equal(claimIsStale(`${PROCESSING_MARK} 1000`, 1000 + 31 * 60), true, "stale claim is retaken");
  assert.equal(claimIsStale("attA,attB", 99999), false, "done stays done");
  assert.equal(claimIsStale("ERROR: x", 99999), false, "errors wait for a human to clear the cell");
});

test("extractNovaTranscript: paragraphs > speaker turns > flat", () => {
  const alt = (a: unknown) => ({ results: { channels: [{ alternatives: [a] }] } });
  assert.equal(extractNovaTranscript(alt({ transcript: "hola", paragraphs: { transcript: "Speaker 0: hola" } })), "Speaker 0: hola");
  assert.equal(
    extractNovaTranscript(alt({ transcript: "hola que tal bien", words: [
      { speaker: 0, punctuated_word: "Hola," }, { speaker: 0, punctuated_word: "¿qué" }, { speaker: 0, punctuated_word: "tal?" },
      { speaker: 1, punctuated_word: "Bien." },
    ] })),
    "Persona 1: Hola, ¿qué tal?\nPersona 2: Bien.",
  );
  assert.equal(extractNovaTranscript(alt({ transcript: " solo texto " })), "solo texto");
  assert.equal(extractNovaTranscript({}), "");
});

test("sectionLine pulls the first line of a section", () => {
  const s = "RESULTADO: lo va a pensar — precio.\nPROSPECTO: Ana\nSIGUIENTE PASO: llamarle el lunes.";
  assert.equal(sectionLine(s, "RESULTADO"), "lo va a pensar — precio.");
  assert.equal(sectionLine(s, "SIGUIENTE PASO"), "llamarle el lunes.");
  assert.equal(sectionLine(s, "COACHING"), "");
});

const fakeRes = (status: number, data: unknown) => ({ ok: status < 400, status, body: { stream: true }, json: async () => data });

function envWithAi(run: (model: string, input: Record<string, unknown>) => Promise<unknown>): Env {
  return {
    AI: { run },
    AIRTABLE_PAT: "pat",
    AIRTABLE_BASE_ID: "appX",
    AIRTABLE_TRIALS_TABLE: "Leads",
    ANTHROPIC_API_KEY: "k",
  } as unknown as Env;
}

test("runSalesAudio: claims the row, streams the audio to Nova-3, writes transcript + summary, notes Slack", async () => {
  const patches: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.airtable.com") && (!init || init.method === "GET")) {
      return fakeRes(200, { records: [{ id: "rec1", fields: {
        "Nombre de Lead": "Ana López",
        "Audio venta": [{ id: "attA", url: "https://dl.airtable/attA", filename: "venta.m4a", type: "audio/mp4" }],
      } }] });
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
      patches.push(body.fields);
      return fakeRes(200, { id: "rec1", fields: body.fields });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const calls: { model: string; language: unknown; hasBody: boolean }[] = [];
    const env = envWithAi(async (model, input) => {
      const audio = input.audio as { body?: unknown };
      calls.push({ model, language: input.language, hasBody: !!audio?.body });
      return { results: { channels: [{ alternatives: [{ transcript: "Hola, me interesa inscribirme pero el precio..." }] }] } };
    });
    const notes: string[] = [];
    const out = await runSalesAudio(
      env,
      {
        postNote: async (t) => { notes.push(t); },
        doFetch: (async () => fakeRes(200, null)) as never,
        summarize: async (_e, transcript, name) => {
          assert.match(transcript, /me interesa inscribirme/);
          assert.equal(name, "Ana López");
          return "RESULTADO: lo va a pensar.\nSIGUIENTE PASO: mandarle WhatsApp mañana.";
        },
      },
      5000,
    );
    assert.equal(out.status, "done");
    assert.deepEqual(calls, [{ model: NOVA_MODEL, language: "multi", hasBody: true }]);
    assert.equal(patches[0]!["Audio venta procesado"], `${PROCESSING_MARK} 5000`, "claim first");
    assert.match(String(patches[1]!["Transcripción venta"]), /me interesa inscribirme/);
    assert.match(String(patches[1]!["Resumen venta (IA)"]), /RESULTADO/);
    assert.equal(patches[1]!["Audio venta procesado"], "attA");
    assert.match(notes[0]!, /Ana López/);
    assert.match(notes[0]!, /lo va a pensar/);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});

test("runSalesAudio: a model failure is written to the row and to Slack, never thrown; 'multi' falls back to 'es'", async () => {
  const patches: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push((JSON.parse(String(init.body)) as { fields: Record<string, unknown> }).fields);
      return fakeRes(200, { id: "rec1", fields: {} });
    }
    return fakeRes(200, { records: [{ id: "rec1", fields: {
      "Audio venta": [{ id: "attA", url: "https://dl/attA", filename: "v.m4a", type: "audio/mp4" }],
    } }] });
  };
  try {
    const langs: unknown[] = [];
    const env = envWithAi(async (_m, input) => { langs.push(input.language); throw new Error("payload too large"); });
    const notes: string[] = [];
    const out = await runSalesAudio(env, {
      postNote: async (t) => { notes.push(t); },
      doFetch: (async () => fakeRes(200, null)) as never,
    }, 5000);
    assert.equal(out.status, "failed");
    assert.deepEqual(langs, ["multi", "es"]);
    assert.match(String(patches[patches.length - 1]!["Audio venta procesado"]), /^ERROR: payload too large/);
    assert.match(notes[0]!, /No pude transcribir/);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});
