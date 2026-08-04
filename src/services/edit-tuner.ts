// Edit tuner: the training-wheels feedback loop. Every "✏️ Editar" stores a
// (bot draft → human final) pair in D1 `edits`; this module periodically feeds
// the accumulated pairs + the current overlay to the model, which detects
// RECURRING style/content patterns and proposes overlay edits via the shared
// kb-editor proposal pipeline. Proposals are persisted in kv and posted to
// Slack as one-tap Aplicar/Descartar cards; apply reuses applyProposal with
// all its validation (token cap, section existence).
//
// Cadence: piggybacks the daily 10:00 CDMX cron block, self-gated to run at
// most every ~6.5 days and only when ≥5 new edits accumulated. The pure gate/
// orchestration logic lives in ./edit-tuner-core.ts (unit-tested); this file
// is the Env-bound wiring: model call, kv/D1, Slack cards, apply/discard.

import type { Env } from "../types.js";
import {
  countEditsAfter,
  editsAfter,
  getKbSection,
  listKbSections,
  type EditRow,
} from "../db/queries-admin.js";
import { kvDelete, kvGet, kvSet, kvSetIfAbsent } from "../db/queries.js";
import { callAnthropic, type ToolUseContent } from "../brain/claude.js";
import type { SystemBlock } from "../brain/prompt.js";
import { assembleOverlay, estimateTokens } from "../brain/overlay.js";
import { KB } from "../kb.js";
import {
  accrueChatUsage,
  applyProposal,
  toProposal,
  TUNING_TOOLS,
  type Proposal,
} from "./kb-editor.js";
import {
  postNote,
  postTuningProposalCard,
  postTuningSummary,
  updateTuningCard,
} from "./slack.js";
import {
  claimKeyFor,
  formatEditsForAnalysis,
  maybeRunEditTuningWith,
  parseTuningRecord,
  type TunerIo,
  type TuningAnalysis,
} from "./edit-tuner-core.js";
import { CLIENT } from "../client.gen.js";

// Re-export the core surface so callers/tests have one import site each.
export * from "./edit-tuner-core.js";

const MAX_TUNER_OUTPUT_TOKENS = 3000;

// ---- analysis prompt ------------------------------------------------------

const TUNER_INSTRUCTIONS = `Eres el analista de estilo del bot de WhatsApp de ${CLIENT.businessName}. ${CLIENT.ownerName} (el dueño) revisa cada borrador del bot y a veces lo reescribe antes de enviarlo. Recibirás pares (BORRADOR DEL BOT → VERSIÓN FINAL DEL DUEÑO). Tu trabajo:
1. Detecta PATRONES RECURRENTES (2+ ediciones que apuntan a lo mismo): tono, largo, saludos, emojis, datos que el dueño corrige, horarios u opciones que evita ofrecer, frases que siempre borra o agrega.
2. IGNORA correcciones puntuales de una sola conversación (nombres, fechas, casos únicos).
3. Por cada patrón claro, propone UNA edición del overlay con propose_kb_edit. PREFIERE EDITAR una sección existente de estilo/tono (revisa la lista de ids del estado) antes que crear una nueva; crea una sección nueva solo si ninguna encaja (título corto, p. ej. "Estilo y tono").
4. Redacta INSTRUCCIONES imperativas para el bot, no descripciones de las ediciones. Mal: "El dueño acorta los saludos." Bien: "Saluda en una sola línea, directo al punto."
5. Máximo 3 propuestas por análisis (las mejor respaldadas). Textos breves: el overlay completo debe quedar bajo ~1500 tokens (límite duro 2000).
6. Si un patrón contradice algo del overlay actual, propone editar ESA sección; nunca dupliques.
7. Responde SIEMPRE con un resumen breve en es-MX en viñetas (patrón + cuántas ediciones lo evidencian). Si no hay patrones claros, dilo y NO llames herramientas.

# BASE DE CONOCIMIENTO COMPILADA (solo lectura; el overlay va encima)`;

/** One model call over the edit batch. Reuses the brain transport + pricing. */
export async function runEditAnalysis(
  env: Env,
  edits: EditRow[],
): Promise<TuningAnalysis> {
  const sections = await listKbSections(env.DB);
  const overlay = assembleOverlay(sections);
  const sectionLines =
    sections.length === 0
      ? "(sin secciones de overlay todavía)"
      : sections
          .map(
            (s) =>
              `- id ${s.id} · ${s.enabled === 1 ? "activa" : "desactivada"} · "${s.title}"`,
          )
          .join("\n");

  const system: SystemBlock[] = [
    {
      type: "text",
      text: `${TUNER_INSTRUCTIONS}\n\n${KB}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    {
      type: "text",
      text: [
        "# ESTADO ACTUAL DEL OVERLAY",
        `Tokens del overlay ahora: ${estimateTokens(overlay)} (límite duro 2000, meta <1500).`,
        "",
        "## Secciones del overlay (ids que puedes editar/borrar):",
        sectionLines,
        "",
        "## Overlay ensamblado actual (lo que el bot ve):",
        overlay || "(overlay vacío)",
      ].join("\n"),
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];

  const resp = await callAnthropic(
    fetch,
    env.ANTHROPIC_API_KEY,
    system,
    [
      {
        role: "user",
        content: `Analiza estas ${edits.length} ediciones (orden cronológico):\n\n${formatEditsForAnalysis(edits)}`,
      },
    ],
    TUNING_TOOLS,
    MAX_TUNER_OUTPUT_TOKENS,
  );

  await accrueChatUsage(env, resp.usage);

  const summary = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const toolUses = resp.content.filter(
    (b): b is ToolUseContent => b.type === "tool_use",
  );
  const proposals: Proposal[] = [];
  for (const tu of toolUses) {
    const p = await toProposal(env, tu);
    if (p) proposals.push(p);
  }

  return { summary, proposals };
}

// ---- cron entry -----------------------------------------------------------

const REAL_IO: TunerIo = {
  countEditsAfter,
  editsAfter,
  kvGet,
  kvSet,
  analyze: runEditAnalysis,
  postSummary: postTuningSummary,
  postCard: postTuningProposalCard,
};

/** The cron entry (daily 10:00 block): core orchestration + real I/O. */
export function maybeRunEditTuning(
  env: Env,
  deps: { slack: { postNote(text: string): Promise<void> } },
  nowEpoch: number,
): Promise<void> {
  return maybeRunEditTuningWith(REAL_IO, env, deps, nowEpoch);
}

// ---- apply / discard (Slack buttons) --------------------------------------

/** es-MX card lines for applyProposal failure reasons. */
const APPLY_ERROR_ES: Record<string, string> = {
  overlay_too_large:
    "El overlay excedería 2000 tokens — recorta secciones en el panel KB y vuelve a intentar.",
  section_not_found: "La sección del overlay ya no existe.",
  duplicate_trigger: "Ya existe una campaña con esa frase.",
  unknown_proposal: "Tipo de propuesta desconocido.",
  unknown_field: "Campo de Airtable desconocido.",
  bad_trigger: "Disparador inválido.",
  bad_action: "Acción inválida.",
};

/** Short label for a proposal on card updates. */
function proposalLabel(p: Proposal): string {
  if (p.kind === "kb_edit") return p.title;
  if (p.kind === "kb_delete") return `eliminar «${p.prevTitle ?? `sección ${p.sectionId}`}»`;
  return p.kind;
}

/**
 * One-tap apply from Slack. Guards: status check → staleness check (the
 * overlay section changed since the analysis → warning card with an explicit
 * force button) → at-most-once kv claim → applyProposal. A failed apply
 * releases the claim so Evan can retry after fixing the cause.
 */
export async function applyTuningProposal(
  env: Env,
  key: string,
  force = false,
): Promise<void> {
  const record = parseTuningRecord(await kvGet(env.DB, key));
  if (!record) {
    await postNote(env, `🧠 Propuesta no encontrada (${key}).`);
    return;
  }
  const ts = record.slackTs;

  if (record.status !== "pending") {
    if (ts) {
      const done =
        record.status === "applied" ? "✅ Ya estaba aplicada" : "🗑 Ya estaba descartada";
      await updateTuningCard(env, ts, done, proposalLabel(record.proposal));
    }
    return;
  }

  // Staleness: the target section changed under the proposal → require force.
  if (!force && record.proposal.kind === "kb_edit" && record.proposal.sectionId !== null) {
    const current = await getKbSection(env.DB, record.proposal.sectionId);
    const changed = !current || current.content !== record.proposal.prevContent;
    if (changed) {
      if (ts) {
        await updateTuningCard(
          env,
          ts,
          "⚠️ La sección cambió desde el análisis",
          `«${proposalLabel(record.proposal)}» — revisa el overlay en el panel, o aplica de todos modos (sobrescribe).`,
          [
            { text: "✅ Aplicar de todos modos", actionId: `tune_force|${key}` },
            { text: "🗑 Descartar", actionId: `tune_discard|${key}` },
          ],
        );
      }
      return;
    }
  }

  // At-most-once claim: the loser of a double-tap race exits silently.
  const claimKey = claimKeyFor(key);
  const claimed = await kvSetIfAbsent(
    env.DB,
    claimKey,
    String(Math.floor(Date.now() / 1000)),
  );
  if (!claimed) return;

  const result = await applyProposal(env, record.proposal);
  if (!result.ok) {
    await kvDelete(env.DB, claimKey);
    if (ts) {
      await updateTuningCard(
        env,
        ts,
        "❌ No se pudo aplicar",
        `«${proposalLabel(record.proposal)}» — ${APPLY_ERROR_ES[result.reason] ?? result.reason}`,
        [
          { text: "✅ Aplicar", actionId: `tune_apply|${key}`, style: "primary" },
          { text: "🗑 Descartar", actionId: `tune_discard|${key}` },
        ],
      );
    }
    return;
  }

  await kvSet(env.DB, key, JSON.stringify({ ...record, status: "applied" }));
  const tokens =
    result.kind === "kb_edit" || result.kind === "kb_delete"
      ? ` · overlay ${result.overlayTokens} tokens`
      : "";
  if (ts) {
    await updateTuningCard(
      env,
      ts,
      "✅ Aplicada al overlay",
      `«${proposalLabel(record.proposal)}»${tokens}`,
    );
  }
}

/** One-tap discard from Slack. */
export async function discardTuningProposal(env: Env, key: string): Promise<void> {
  const record = parseTuningRecord(await kvGet(env.DB, key));
  if (!record) {
    await postNote(env, `🧠 Propuesta no encontrada (${key}).`);
    return;
  }
  if (record.status !== "pending") return;
  await kvSet(env.DB, key, JSON.stringify({ ...record, status: "discarded" }));
  if (record.slackTs) {
    await updateTuningCard(
      env,
      record.slackTs,
      "🗑 Descartada",
      proposalLabel(record.proposal),
    );
  }
}
