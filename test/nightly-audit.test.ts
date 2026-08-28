// Pure pieces of the nightly OPUS audit: transcript compaction, approval
// formatting, Slack chunking, and the prompt builders.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_MODEL,
  buildAuditSystem,
  buildAuditUser,
  chunkForSlack,
  compactTranscripts,
  formatApprovals,
  renderSlotsForAudit,
  type AuditApprovalRow,
  type AuditMessageRow,
} from "../src/cron/nightly-audit.js";

const TPL =
  "¡Hola! Veo que todavía no has agendado tu día gratuito 🙂 Te puedo apartar lugar en Jiu-Jitsu mañana sábado 9:00 am — ¿te late? Si prefieres otro horario: https://mdcondesa.com/clase-prueba-adultos/";

function msg(phone: string, dir: string, body: string, ts: number): AuditMessageRow {
  return { phone, direction: dir, body, ts };
}

test("compactTranscripts: repeated template keeps ONE full copy, rest collapse", () => {
  const rows = [
    msg("5215511111111", "in", "hola", 1_787_900_000),
    msg("5215511111111", "out_bot", TPL, 1_787_900_100),
    msg("5215522222222", "out_bot", TPL, 1_787_900_200),
    msg("5215533333333", "out_bot", TPL, 1_787_900_300),
  ];
  const out = compactTranscripts(rows, new Map());
  assert.equal(out.split("Jiu-Jitsu mañana sábado").length - 1, 1, "full text once");
  assert.equal(out.split("[= plantilla #1]").length - 1, 2, "two collapsed refs");
  assert.ok(out.includes("[plantilla #1]"), "first occurrence labeled");
});

test("compactTranscripts: short and inbound bodies never collapse", () => {
  const rows = [
    msg("5215511111111", "in", "hola", 1),
    msg("5215522222222", "in", "hola", 2),
    msg("5215511111111", "out_bot", "¡Va! Nos vemos 🙌", 3),
    msg("5215522222222", "out_bot", "¡Va! Nos vemos 🙌", 4),
  ];
  const out = compactTranscripts(rows, new Map());
  assert.ok(!out.includes("plantilla"), out);
  assert.equal(out.split("¡Va! Nos vemos 🙌").length - 1, 2);
});

test("compactTranscripts: groups by phone with the contact name", () => {
  const rows = [
    msg("5215511111111", "in", "hola", 1),
    msg("5215522222222", "in", "buenas", 2),
  ];
  const out = compactTranscripts(rows, new Map([["5215511111111", "Ana"]]));
  assert.ok(out.includes("## 5215511111111 (Ana)"));
  assert.ok(out.includes("## 5215522222222\n"), "no name → bare phone header");
  assert.ok(out.includes("LEAD: hola"));
});

test("formatApprovals: latency, edits, and pending states render", () => {
  const rows: AuditApprovalRow[] = [
    {
      id: 7,
      phone: "5215511111111",
      draft: "borrador",
      final_text: "texto final distinto",
      status: "edited",
      created_at: 1000,
      resolved_at: 1000 + 600,
    },
    {
      id: 8,
      phone: "5215522222222",
      draft: "esperando",
      final_text: null,
      status: "pending",
      created_at: 1000,
      resolved_at: null,
    },
  ];
  const out = formatApprovals(rows);
  assert.ok(out.includes("#7") && out.includes("[edited 10m]"), out);
  assert.ok(out.includes("EDITADA→ «texto final distinto»"), out);
  assert.ok(out.includes("#8") && out.includes("PENDIENTE"), out);
  assert.equal(formatApprovals([]), "(ninguna)");
});

test("chunkForSlack: splits on line boundaries under the cap", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `línea ${i} ${"x".repeat(90)}`);
  const chunks = chunkForSlack(lines.join("\n"), 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1000, String(c.length));
  assert.equal(chunks.join("\n"), lines.join("\n"), "nothing lost");
});

test("audit prompt: opus model, rubric, and the REAL slot grid ride along", () => {
  assert.equal(AUDIT_MODEL, "claude-opus-5");
  const sys = buildAuditSystem("KB_DE_PRUEBA");
  assert.equal(sys.length, 2);
  assert.ok(sys[0]!.text.includes("auditor nocturno"));
  assert.ok(sys[0]!.text.includes("sin_respuesta"), "leak patterns in rubric");
  assert.ok(sys[1]!.text.includes("PARRILLA REAL DE CLASES"));
  assert.ok(sys[1]!.text.includes("KB_DE_PRUEBA"), "injected KB rides in block 2");
  // The grid is the generated one, not prose: spot-check a known slot.
  const grid = renderSlotsForAudit();
  assert.ok(/mié 11:00 baby/.test(grid), grid.slice(0, 200));
  const user = buildAuditUser("TRANSCRIPTS", "APPROVALS", "ventana X");
  assert.ok(user.includes("ventana X") && user.includes("TRANSCRIPTS") && user.includes("APPROVALS"));
});
