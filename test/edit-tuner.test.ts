import { test } from "node:test";
import assert from "node:assert/strict";

import {
  claimKeyFor,
  decideTuningRun,
  EDIT_SIDE_MAX_CHARS,
  formatEditsForAnalysis,
  maybeRunEditTuningWith,
  MIN_NEW_EDITS,
  MIN_RUN_INTERVAL_S,
  parseTuningRecord,
  tuningKey,
  type TuningRecord,
} from "../src/services/edit-tuner-core.js";
import type { EditRow } from "../src/db/queries-admin.js";
import type { Proposal } from "../src/services/kb-editor.js";
import type { Env } from "../src/types.js";
import { cdmxToEpoch } from "../src/cron/time.js";

const NOW = cdmxToEpoch(2026, 8, 4, 10, 0, 0);

function edit(over: Partial<EditRow> = {}): EditRow {
  return {
    id: 1,
    phone: "5215512345678",
    draft: "Hola! Te cuento todo sobre nuestros planes...",
    final: "Hola! ¿Vienes hoy a probar?",
    ts: NOW - 3600,
    ...over,
  };
}

function proposal(over: Partial<Extract<Proposal, { kind: "kb_edit" }>> = {}): Proposal {
  return {
    kind: "kb_edit",
    sectionId: null,
    title: "Estilo y tono",
    newContent: "Saluda en una sola línea.",
    reason: "3 ediciones acortan el saludo",
    prevTitle: null,
    prevContent: null,
    ...over,
  };
}

// ---- decideTuningRun ------------------------------------------------------

test("decideTuningRun: never ran + enough edits ⇒ run", () => {
  assert.deepEqual(
    decideTuningRun({ nowEpoch: NOW, lastRunEpoch: null, newEditCount: MIN_NEW_EDITS }),
    { run: true },
  );
});

test("decideTuningRun: ran 3 days ago ⇒ too_soon even with many edits", () => {
  const d = decideTuningRun({
    nowEpoch: NOW,
    lastRunEpoch: NOW - 3 * 86400,
    newEditCount: 50,
  });
  assert.deepEqual(d, { run: false, reason: "too_soon" });
});

test("decideTuningRun: interval elapsed but few edits ⇒ few_edits", () => {
  const d = decideTuningRun({
    nowEpoch: NOW,
    lastRunEpoch: NOW - 8 * 86400,
    newEditCount: MIN_NEW_EDITS - 1,
  });
  assert.deepEqual(d, { run: false, reason: "few_edits" });
});

test("decideTuningRun: exactly the interval boundary ⇒ runs", () => {
  const d = decideTuningRun({
    nowEpoch: NOW,
    lastRunEpoch: NOW - MIN_RUN_INTERVAL_S,
    newEditCount: MIN_NEW_EDITS,
  });
  assert.deepEqual(d, { run: true });
});

// ---- formatEditsForAnalysis ----------------------------------------------

test("formatEditsForAnalysis renders numbered chronological pairs", () => {
  const out = formatEditsForAnalysis([
    edit({ id: 1, draft: "borrador uno", final: "final uno" }),
    edit({ id: 2, draft: "borrador dos", final: "final dos" }),
  ]);
  assert.ok(out.includes("### Edición 1"));
  assert.ok(out.includes("### Edición 2"));
  assert.ok(out.indexOf("borrador uno") < out.indexOf("borrador dos"));
  assert.ok(out.includes("BORRADOR DEL BOT:"));
  assert.ok(out.includes("VERSIÓN FINAL DEL DUEÑO:"));
});

test("formatEditsForAnalysis truncates long sides with ellipsis", () => {
  const long = "x".repeat(EDIT_SIDE_MAX_CHARS * 2);
  const out = formatEditsForAnalysis([edit({ draft: long })]);
  const line = out.split("\n").find((l) => l.startsWith("x"))!;
  assert.ok(line.length <= EDIT_SIDE_MAX_CHARS);
  assert.ok(line.endsWith("…"));
});

test("formatEditsForAnalysis excludes phone numbers", () => {
  const out = formatEditsForAnalysis([edit()]);
  assert.ok(!out.includes("5215512345678"));
});

test("formatEditsForAnalysis: empty batch → empty string", () => {
  assert.equal(formatEditsForAnalysis([]), "");
});

// ---- keys + record round-trip --------------------------------------------

test("tuningKey/claimKeyFor shapes", () => {
  const key = tuningKey(1754300000, 2);
  assert.equal(key, "tuning_proposal:1754300000:2");
  assert.equal(claimKeyFor(key), "tuning_claim:1754300000:2");
});

test("parseTuningRecord round-trips and rejects malformed JSON", () => {
  const rec: TuningRecord = {
    proposal: proposal(),
    status: "pending",
    createdAt: NOW,
    slackTs: "123.456",
  };
  assert.deepEqual(parseTuningRecord(JSON.stringify(rec)), rec);
  assert.equal(parseTuningRecord(null), null);
  assert.equal(parseTuningRecord("{bad"), null);
  assert.equal(parseTuningRecord(JSON.stringify({ nope: 1 })), null);
});

// ---- orchestration (injected io fakes) ------------------------------------

interface Harness {
  kv: Map<string, string>;
  kvSets: { key: string; value: string }[];
  notes: string[];
  summaries: unknown[][];
  cards: { key: string; p: Proposal }[];
}

function harness(opts: {
  count: number;
  maxId: number;
  edits: EditRow[];
  analysis?: { summary: string; proposals: Proposal[] };
  failCardPost?: boolean;
  kvInit?: Record<string, string>;
}): {
  h: Harness;
  run: () => Promise<void>;
} {
  const h: Harness = { kv: new Map(), kvSets: [], notes: [], summaries: [], cards: [] };
  for (const [k, v] of Object.entries(opts.kvInit ?? {})) h.kv.set(k, v);
  const env = { DB: {} } as unknown as Env;
  const run = () =>
    maybeRunEditTuningWith(
      {
        kvGet: async (_db, key) => h.kv.get(key) ?? null,
        kvSet: async (_db, key, value) => {
          h.kv.set(key, value);
          h.kvSets.push({ key, value });
        },
        countEditsAfter: async () => ({ count: opts.count, maxId: opts.maxId }),
        editsAfter: async () => opts.edits,
        analyze: async () =>
          opts.analysis ?? { summary: "sin patrones", proposals: [] },
        postSummary: async (_env, ...args) => {
          h.summaries.push(args as unknown[]);
          return "ts-summary";
        },
        postCard: async (_env, key, p) => {
          if (opts.failCardPost) throw new Error("slack down");
          h.cards.push({ key, p });
          return `ts-${key}`;
        },
      },
      env,
      { slack: { postNote: async (t) => void h.notes.push(t) } },
      NOW,
    );
  return { h, run };
}

test("orchestration: gate skip writes nothing and posts nothing", async () => {
  const { h, run } = harness({
    count: 2, // below MIN_NEW_EDITS
    maxId: 10,
    edits: [edit()],
  });
  await run();
  assert.equal(h.kvSets.length, 0);
  assert.equal(h.notes.length, 0);
  assert.equal(h.cards.length, 0);
});

test("orchestration: no proposals → postNote + watermark advances", async () => {
  const { h, run } = harness({
    count: 6,
    maxId: 42,
    edits: [edit({ id: 40 }), edit({ id: 41 }), edit({ id: 42 })],
    analysis: { summary: "- nada claro", proposals: [] },
  });
  await run();
  assert.equal(h.notes.length, 1);
  assert.ok(h.notes[0]!.includes("no encontré patrones"));
  assert.equal(h.kv.get("edit_tuner_watermark"), "42");
  assert.equal(h.kv.get("edit_tuner_last_run"), String(NOW));
});

test("orchestration: proposals → summary, kv-before-card, watermark LAST", async () => {
  const p0 = proposal({ title: "Estilo y tono" });
  const p1 = proposal({ title: "Horarios que no ofrecer" });
  const { h, run } = harness({
    count: 8,
    maxId: 50,
    edits: [edit()],
    analysis: { summary: "- dos patrones", proposals: [p0, p1] },
  });
  await run();
  assert.equal(h.summaries.length, 1);
  assert.equal(h.cards.length, 2);
  // Every card's kv record was written before its post (kv first, card second):
  // the FIRST kvSet for each key precedes the card, and the record with the ts
  // lands after. Verify by checking the stored record has the ts.
  const key0 = tuningKey(NOW, 0);
  const rec0 = parseTuningRecord(h.kv.get(key0) ?? null)!;
  assert.equal(rec0.status, "pending");
  assert.equal(rec0.slackTs, `ts-${key0}`);
  // Watermark + last_run are the final two kv writes.
  const lastTwo = h.kvSets.slice(-2).map((s) => s.key);
  assert.deepEqual(lastTwo, ["edit_tuner_watermark", "edit_tuner_last_run"]);
  assert.equal(h.kv.get("edit_tuner_watermark"), "50");
});

test("orchestration: a failing card post leaves the watermark untouched", async () => {
  const { h, run } = harness({
    count: 8,
    maxId: 60,
    edits: [edit()],
    analysis: { summary: "- patrón", proposals: [proposal()] },
    failCardPost: true,
  });
  await assert.rejects(run);
  assert.equal(h.kv.get("edit_tuner_watermark"), undefined);
  assert.equal(h.kv.get("edit_tuner_last_run"), undefined);
});

test("orchestration: respects existing watermark via kvGet", async () => {
  let boundAfterId = -1;
  const env = { DB: {} } as unknown as Env;
  await maybeRunEditTuningWith(
    {
      kvGet: async (_db, key) => (key === "edit_tuner_watermark" ? "17" : null),
      kvSet: async () => {},
      countEditsAfter: async (_db, afterId) => {
        boundAfterId = afterId;
        return { count: 0, maxId: 17 };
      },
      editsAfter: async () => [],
      analyze: async () => ({ summary: "", proposals: [] }),
      postSummary: async () => "ts",
      postCard: async () => "ts",
    },
    env,
    { slack: { postNote: async () => {} } },
    NOW,
  );
  assert.equal(boundAfterId, 17);
});
