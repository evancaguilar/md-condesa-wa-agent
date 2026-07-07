// KB editor: a chat surface where Evan describes a change in plain es-MX and the
// model PROPOSES overlay edits / campaign creation (never applies). The dashboard
// renders each proposal as a diff card; a second explicit call (applyProposal)
// writes it after validation. This split keeps the model from ever mutating the
// live KB directly.
//
// One Anthropic call per turn via the brain's shared callAnthropic (same
// transport + pricing). Two system blocks, both 1h-cached: (1) static es-MX
// editor instructions + the compiled KB base, (2) the current overlay (with
// section ids) + campaigns list + token budget, so the model sees exactly what
// it may edit.

import type { Campaign, Env, KbSection } from "../types.js";
import { KB } from "../kb.js";
import {
  callAnthropic,
  computeCost,
  type ApiMessage,
  type ApiUsage,
  type ToolUseContent,
} from "../brain/claude.js";
import type { SystemBlock } from "../brain/prompt.js";
import { assembleOverlay, estimateTokens } from "../brain/overlay.js";
import {
  createCampaign,
  createKbSection,
  deleteKbSection,
  getCampaign,
  getKbSection,
  insertKbRevision,
  listCampaigns,
  listKbSections,
  updateKbSection,
} from "../db/queries-admin.js";
import { accrueUsage } from "../db/queries.js";
import { normalizeText } from "../pipeline/campaigns.js";
import { cdmxDateStr } from "../cron/time.js";
import { CLIENT } from "../client.gen.js";

// ---- request constants ----------------------------------------------------

const MAX_TOKENS = 2000;
/** Hard ceiling on the assembled overlay (spec §4): reject edits above this. */
const OVERLAY_TOKEN_LIMIT = 2000;

// Intro pricing (per MTok) — MUST match claude.ts so cost accrual is consistent.
const PRICE_INPUT = 2 / 1_000_000;
const PRICE_OUTPUT = 10 / 1_000_000;
const PRICE_CACHE_READ = 0.2 / 1_000_000;
const PRICE_CACHE_WRITE_1H = 4 / 1_000_000;

// ---- Proposal union (W3 + W4 depend on this JSON shape) -------------------

/**
 * A model-proposed KB change. Never applied by runKbChat — the dashboard shows
 * it as a diff card and calls applyProposal on confirm. `prevTitle`/`prevContent`
 * are enriched from D1 (null for creates / campaigns) so the UI can render a
 * before/after diff without another round-trip.
 */
export type Proposal =
  | {
      kind: "kb_edit";
      /** null ⇒ create a new overlay section; number ⇒ edit that section. */
      sectionId: number | null;
      title: string;
      newContent: string;
      reason: string;
      prevTitle: string | null;
      prevContent: string | null;
    }
  | {
      kind: "kb_delete";
      sectionId: number;
      reason: string;
      prevTitle: string | null;
      prevContent: string | null;
    }
  | {
      kind: "campaign";
      name: string;
      triggerPhrase: string;
      info: string;
      endsAt: number | null;
    };

/**
 * One chat turn from the dashboard. `role` is deliberately a plain string: this
 * is a JSON API boundary (client-supplied), so runKbChat normalizes anything
 * that isn't "assistant" to "user" rather than trusting the caller to narrow.
 */
export interface ChatMessage {
  role: string;
  content: string;
}

export interface KbChatResult {
  reply: string;
  proposals: Proposal[];
}

/** Discriminated result of applyProposal. */
export type ApplyResult =
  | { ok: true; kind: "kb_edit"; section: KbSection; overlayTokens: number }
  | { ok: true; kind: "kb_delete"; overlayTokens: number }
  | { ok: true; kind: "campaign"; campaign: Campaign }
  | {
      ok: false;
      reason:
        | "section_not_found"
        | "overlay_too_large"
        | "duplicate_trigger"
        | "unknown_proposal";
    };

// ---- proposal-only tools --------------------------------------------------

const proposeKbEdit = {
  name: "propose_kb_edit",
  description:
    "Propose creating or editing ONE overlay section (actualizaciones/correcciones que van sobre la base). Use section_id null to create a new section, or an existing id to edit it. Prefer editing an existing overlay section over creating a duplicate. Propose MINIMAL changes; keep the whole overlay under ~1500 tokens. NEVER applies — only proposes.",
  input_schema: {
    type: "object",
    properties: {
      section_id: {
        type: ["integer", "null"],
        description: "Existing overlay section id to edit, or null to create a new one.",
      },
      title: { type: "string", description: "Section title (short heading)." },
      new_content: { type: "string", description: "Full new content of the section." },
      reason: {
        type: "string",
        description: "Why this change (shown to the human reviewer).",
      },
    },
    required: ["section_id", "title", "new_content", "reason"],
    additionalProperties: false,
  },
} as const;

const proposeKbDelete = {
  name: "propose_kb_delete",
  description:
    "Propose deleting an overlay section by id (e.g. an outdated correction that no longer applies). NEVER applies — only proposes.",
  input_schema: {
    type: "object",
    properties: {
      section_id: { type: "integer", description: "Overlay section id to delete." },
      reason: { type: "string", description: "Why remove it." },
    },
    required: ["section_id", "reason"],
    additionalProperties: false,
  },
} as const;

const proposeCampaign = {
  name: "propose_campaign",
  description:
    "Propose a new ad/promo campaign: a trigger phrase (what the lead types from the ad) plus extra info the bot should use for those leads. NEVER applies — only proposes.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Campaign name (internal label)." },
      trigger_phrase: {
        type: "string",
        description: "The phrase from the ad that leads will send (matched loosely).",
      },
      info: { type: "string", description: "Extra knowledge fed to the brain for this campaign's leads." },
      ends_at: {
        type: ["integer", "null"],
        description: "Optional end date as epoch seconds; null for no end.",
      },
    },
    required: ["name", "trigger_phrase", "info"],
    additionalProperties: false,
  },
} as const;

const EDITOR_TOOLS = [proposeKbEdit, proposeKbDelete, proposeCampaign];

// ---- static editor instructions (block 1, cached) -------------------------

const EDITOR_INSTRUCTIONS = `Eres el asistente de edición de la base de conocimiento de ${CLIENT.businessName}. ${CLIENT.ownerName} (el dueño) te describe en español un cambio (una corrección, un dato nuevo, una promo/campaña) y tú PROPONES el cambio usando las herramientas propose_*. NUNCA aplicas nada: solo propones y el humano confirma.

Reglas:
- Propón cambios MÍNIMOS. Prefiere EDITAR una sección de overlay existente antes que crear una duplicada.
- El overlay son "actualizaciones y correcciones" que van SOBRE la base compilada de abajo. Si algo del overlay contradice la base, el overlay manda.
- Si detectas que la base ya dice algo distinto, señálalo en tu respuesta y propón una corrección en el overlay (no puedes editar la base directamente).
- Mantén el overlay por debajo de ~1500 tokens en total.
- Para promos/anuncios usa propose_campaign (frase del anuncio + info para el bot).
- Responde SIEMPRE con un texto breve en es-MX explicando qué propones (o pidiendo la aclaración que falte) ADEMÁS de llamar la(s) herramienta(s) cuando el cambio esté claro.

# BASE DE CONOCIMIENTO COMPILADA (solo lectura; el overlay va encima)`;

function block1Text(): string {
  return `${EDITOR_INSTRUCTIONS}\n\n${KB}`;
}

/** Block 2: the live overlay (with ids) + campaigns + current token budget. */
function block2Text(sections: KbSection[], campaigns: Campaign[]): string {
  const overlay = assembleOverlay(sections);
  const tokens = estimateTokens(overlay);

  const sectionLines =
    sections.length === 0
      ? "(sin secciones de overlay todavía)"
      : sections
          .map(
            (s) =>
              `- id ${s.id} · sort ${s.sort} · ${s.enabled === 1 ? "activa" : "desactivada"} · "${s.title}"`,
          )
          .join("\n");

  const campaignLines =
    campaigns.length === 0
      ? "(sin campañas)"
      : campaigns
          .map(
            (c) =>
              `- id ${c.id} · ${c.status} · "${c.name}" · trigger: "${c.trigger_phrase}"`,
          )
          .join("\n");

  return [
    "# ESTADO ACTUAL DEL OVERLAY Y CAMPAÑAS",
    `Tokens del overlay ahora: ${tokens} (límite duro 2000, meta <1500).`,
    "",
    "## Secciones del overlay (ids que puedes editar/borrar):",
    sectionLines,
    "",
    "## Campañas:",
    campaignLines,
    "",
    "## Overlay ensamblado actual (lo que el bot ve):",
    overlay || "(overlay vacío)",
  ].join("\n");
}

// ---- runKbChat ------------------------------------------------------------

/**
 * One editor turn. Sends the chat history + current KB state to the model, which
 * replies with a short es-MX message and zero or more propose_* tool calls. Tool
 * calls are collected as Proposals (enriched with prev title/content from D1 for
 * diffs) and returned — they are NOT executed and NOT round-tripped back to the
 * model. Usage is accrued at the same intro pricing as the brain.
 */
export async function runKbChat(
  env: Env,
  messages: ChatMessage[],
): Promise<KbChatResult> {
  const [sections, campaigns] = await Promise.all([
    listKbSections(env.DB),
    listCampaigns(env.DB),
  ]);

  const system: SystemBlock[] = [
    {
      type: "text",
      text: block1Text(),
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    {
      type: "text",
      text: block2Text(sections, campaigns),
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];

  const apiMessages: ApiMessage[] = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const resp = await callAnthropic(
    fetch,
    env.ANTHROPIC_API_KEY,
    system,
    apiMessages,
    EDITOR_TOOLS,
    MAX_TOKENS,
  );

  await accrueChatUsage(env, resp.usage);

  const reply = resp.content
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

  return { reply, proposals };
}

/** Map one tool_use to a Proposal, enriching prev title/content from D1. */
async function toProposal(
  env: Env,
  tu: ToolUseContent,
): Promise<Proposal | null> {
  const input = tu.input;
  if (tu.name === "propose_kb_edit") {
    const rawId = input.section_id;
    const sectionId = typeof rawId === "number" ? rawId : null;
    let prevTitle: string | null = null;
    let prevContent: string | null = null;
    if (sectionId !== null) {
      const existing = await getKbSection(env.DB, sectionId);
      if (existing) {
        prevTitle = existing.title;
        prevContent = existing.content;
      }
    }
    return {
      kind: "kb_edit",
      sectionId,
      title: String(input.title ?? ""),
      newContent: String(input.new_content ?? ""),
      reason: String(input.reason ?? ""),
      prevTitle,
      prevContent,
    };
  }

  if (tu.name === "propose_kb_delete") {
    const sectionId = Number(input.section_id);
    if (!Number.isFinite(sectionId)) return null;
    let prevTitle: string | null = null;
    let prevContent: string | null = null;
    const existing = await getKbSection(env.DB, sectionId);
    if (existing) {
      prevTitle = existing.title;
      prevContent = existing.content;
    }
    return {
      kind: "kb_delete",
      sectionId,
      reason: String(input.reason ?? ""),
      prevTitle,
      prevContent,
    };
  }

  if (tu.name === "propose_campaign") {
    const rawEnds = input.ends_at;
    const endsAt =
      typeof rawEnds === "number" && Number.isFinite(rawEnds) ? rawEnds : null;
    return {
      kind: "campaign",
      name: String(input.name ?? ""),
      triggerPhrase: String(input.trigger_phrase ?? ""),
      info: String(input.info ?? ""),
      endsAt,
    };
  }

  return null;
}

// ---- applyProposal --------------------------------------------------------

/**
 * Apply a confirmed proposal after validation. Writes kb_sections + a
 * kb_revisions audit row (source:'chat') for KB edits/deletes, or a campaigns
 * row for campaigns. Validation:
 *   - edit/delete of an existing section: the section must still exist.
 *   - kb_edit: the resulting assembled overlay must be ≤ 2000 est tokens.
 *   - campaign: the normalized trigger must be unique across campaigns.
 */
export async function applyProposal(
  env: Env,
  proposal: Proposal,
): Promise<ApplyResult> {
  if (proposal.kind === "kb_edit") {
    return applyKbEdit(env, proposal);
  }
  if (proposal.kind === "kb_delete") {
    return applyKbDelete(env, proposal);
  }
  if (proposal.kind === "campaign") {
    return applyCampaign(env, proposal);
  }
  return { ok: false, reason: "unknown_proposal" };
}

async function applyKbEdit(
  env: Env,
  p: Extract<Proposal, { kind: "kb_edit" }>,
): Promise<ApplyResult> {
  const sections = await listKbSections(env.DB);

  // Existing section must still exist when editing.
  let prev: KbSection | undefined;
  if (p.sectionId !== null) {
    prev = sections.find((s) => s.id === p.sectionId);
    if (!prev) return { ok: false, reason: "section_not_found" };
  }

  // Simulate the resulting overlay and enforce the token ceiling BEFORE writing.
  const projected =
    p.sectionId === null
      ? [
          ...sections,
          {
            id: Number.MAX_SAFE_INTEGER,
            title: p.title,
            content: p.newContent,
            sort: 100,
            enabled: 1,
            created_at: 0,
            updated_at: 0,
          } satisfies KbSection,
        ]
      : sections.map((s) =>
          s.id === p.sectionId
            ? { ...s, title: p.title, content: p.newContent }
            : s,
        );
  const overlayTokens = estimateTokens(assembleOverlay(projected));
  if (overlayTokens > OVERLAY_TOKEN_LIMIT) {
    return { ok: false, reason: "overlay_too_large" };
  }

  let section: KbSection;
  if (p.sectionId === null) {
    section = await createKbSection(env.DB, {
      title: p.title,
      content: p.newContent,
    });
    await insertKbRevision(env.DB, {
      sectionId: section.id,
      action: "create",
      title: section.title,
      content: section.content,
      prevContent: null,
      reason: p.reason || null,
      source: "chat",
    });
  } else {
    const updated = await updateKbSection(env.DB, p.sectionId, {
      title: p.title,
      content: p.newContent,
    });
    // Non-null: we found `prev` above, and update returns the row.
    section = updated as KbSection;
    await insertKbRevision(env.DB, {
      sectionId: p.sectionId,
      action: "update",
      title: p.title,
      content: p.newContent,
      prevContent: prev?.content ?? null,
      reason: p.reason || null,
      source: "chat",
    });
  }

  return { ok: true, kind: "kb_edit", section, overlayTokens };
}

async function applyKbDelete(
  env: Env,
  p: Extract<Proposal, { kind: "kb_delete" }>,
): Promise<ApplyResult> {
  const prev = await getKbSection(env.DB, p.sectionId);
  if (!prev) return { ok: false, reason: "section_not_found" };

  await deleteKbSection(env.DB, p.sectionId);
  await insertKbRevision(env.DB, {
    sectionId: p.sectionId,
    action: "delete",
    title: prev.title,
    content: null,
    prevContent: prev.content,
    reason: p.reason || null,
    source: "chat",
  });

  const overlayTokens = estimateTokens(
    assembleOverlay(await listKbSections(env.DB)),
  );
  return { ok: true, kind: "kb_delete", overlayTokens };
}

async function applyCampaign(
  env: Env,
  p: Extract<Proposal, { kind: "campaign" }>,
): Promise<ApplyResult> {
  const triggerNorm = normalizeText(p.triggerPhrase);
  const existing = await listCampaigns(env.DB);
  if (existing.some((c) => c.trigger_norm === triggerNorm)) {
    return { ok: false, reason: "duplicate_trigger" };
  }

  const campaign = await createCampaign(env.DB, {
    name: p.name,
    triggerPhrase: p.triggerPhrase,
    triggerNorm,
    info: p.info,
    endsAt: p.endsAt,
  });
  return { ok: true, kind: "campaign", campaign };
}

// ---- usage accrual (same pricing as the brain) ----------------------------

function accrueChatUsage(env: Env, u: ApiUsage | undefined): Promise<void> {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  const cost = computeCost({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  });
  return accrueUsage(
    env.DB,
    cdmxDateStr(Math.floor(Date.now() / 1000)),
    input,
    cacheRead,
    output,
    cost,
  );
}
