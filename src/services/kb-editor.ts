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

import type {
  AirtableRule,
  Campaign,
  Env,
  KbSection,
  RuleAction,
  RuleProgram,
  RuleTrigger,
} from "../types.js";
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
  getBaseSchema,
  schemaSummary,
  type BaseSchema,
} from "./airtable.js";
import { parseRule, ruleSummaryEs } from "./airtable-rules.js";
import { validateRuleActions } from "./rule-actions.js";
import {
  createAirtableRule,
  createCampaign,
  createKbSection,
  deleteKbSection,
  getCampaign,
  getKbSection,
  insertKbRevision,
  listAirtableRules,
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
    }
  | {
      kind: "airtable_rule";
      name: string;
      trigger: RuleTrigger;
      actions: RuleAction[];
      reason: string;
      /** es-MX one-liner computed server-side via ruleSummaryEs (campaign name
       *  resolved) so the UI card renders "SI … ENTONCES …" without a round-trip. */
      summaryEs: string;
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
      ok: true;
      kind: "airtable_rule";
      rule: AirtableRule;
      /** Select-option values not yet in the schema; typecast will create them.
       *  The UI toasts these on confirm. */
      createdOptions: string[];
    }
  | {
      ok: false;
      reason:
        | "section_not_found"
        | "overlay_too_large"
        | "duplicate_trigger"
        | "unknown_proposal"
        | "unknown_field"
        | "bad_trigger"
        | "bad_action";
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

const proposeAirtableRule = {
  name: "propose_airtable_rule",
  description:
    "Propón una REGLA de Airtable: cuando un lead cumple un disparador (trigger), aplica acciones sobre su fila en la tabla Leads. Úsala para automatizaciones tipo «si llega de la campaña X → agrega el tag Y» o «si es del programa baby → Actividad = Baby Fight Club». " +
    "Disparadores: type 'campaign' (con campaign_id de la lista de Campañas), 'program' (adults|kids|baby), o 'always' (todo lead nuevo). " +
    "Acciones: cada una es {field, op, value}. USA SOLO nombres de campo EXACTOS de la sección '## Campos de Airtable (tabla Leads)'. op 'set' sobrescribe, op 'add' UNE un valor en un multi-select (SOLO válido en campos tipo multipleSelects), op 'clear' vacía el campo (sin value). " +
    "Si un value no existe entre las opciones de un campo select, se creará como opción nueva: menciónalo en tu respuesta. NUNCA aplica — solo propone; el humano confirma.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Nombre corto e interno de la regla (etiqueta para el dueño).",
      },
      trigger: {
        type: "object",
        description: "Qué hace que la regla se dispare.",
        properties: {
          type: {
            type: "string",
            enum: ["campaign", "program", "always"],
            description: "campaign | program | always.",
          },
          campaign_id: {
            type: ["integer", "null"],
            description: "id de la campaña (requerido cuando type='campaign').",
          },
          program: {
            type: ["string", "null"],
            enum: ["adults", "kids", "baby", null],
            description: "Programa (requerido cuando type='program').",
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
      actions: {
        type: "array",
        description: "Una o más mutaciones de campo a aplicar.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "Nombre EXACTO del campo en Leads." },
            op: {
              type: "string",
              enum: ["set", "add", "clear"],
              description: "set (sobrescribe) | add (une en multipleSelects) | clear (vacía).",
            },
            value: {
              type: ["string", "null"],
              description: "Valor a poner/agregar. Omite o null cuando op='clear'.",
            },
          },
          required: ["field", "op"],
          additionalProperties: false,
        },
      },
      reason: {
        type: "string",
        description: "Por qué esta regla (se muestra al humano que revisa).",
      },
    },
    required: ["name", "trigger", "actions", "reason"],
    additionalProperties: false,
  },
} as const;

const EDITOR_TOOLS = [
  proposeKbEdit,
  proposeKbDelete,
  proposeCampaign,
  proposeAirtableRule,
];

// ---- static editor instructions (block 1, cached) -------------------------

const EDITOR_INSTRUCTIONS = `Eres el asistente de edición de la base de conocimiento de ${CLIENT.businessName}. ${CLIENT.ownerName} (el dueño) te describe en español un cambio (una corrección, un dato nuevo, una promo/campaña) y tú PROPONES el cambio usando las herramientas propose_*. NUNCA aplicas nada: solo propones y el humano confirma.

Reglas:
- Propón cambios MÍNIMOS. Prefiere EDITAR una sección de overlay existente antes que crear una duplicada.
- El overlay son "actualizaciones y correcciones" que van SOBRE la base compilada de abajo. Si algo del overlay contradice la base, el overlay manda.
- Si detectas que la base ya dice algo distinto, señálalo en tu respuesta y propón una corrección en el overlay (no puedes editar la base directamente).
- Mantén el overlay por debajo de ~1500 tokens en total.
- Para promos/anuncios usa propose_campaign (frase del anuncio + info para el bot).
- Para automatizar Airtable (etiquetar leads, fijar campos según campaña/programa) usa propose_airtable_rule, referenciando SOLO campos reales de "## Campos de Airtable (tabla Leads)". "add" solo en campos multipleSelects; si una opción de select no existe, avisa que se creará.
- Responde SIEMPRE con un texto breve en es-MX explicando qué propones (o pidiendo la aclaración que falte) ADEMÁS de llamar la(s) herramienta(s) cuando el cambio esté claro.

# BASE DE CONOCIMIENTO COMPILADA (solo lectura; el overlay va encima)`;

function block1Text(): string {
  return `${EDITOR_INSTRUCTIONS}\n\n${KB}`;
}

/** Block 2: the live overlay (with ids) + campaigns + Airtable schema + rules. */
function block2Text(
  sections: KbSection[],
  campaigns: Campaign[],
  schema: BaseSchema | null,
  rules: AirtableRule[],
): string {
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

  const schemaText = schema ? schemaSummary(schema) : "(esquema no disponible)";

  const campName = (id: number): string | undefined =>
    campaigns.find((c) => c.id === id)?.name;
  const ruleLines =
    rules.length === 0
      ? "(sin reglas todavía)"
      : rules
          .map((r) => {
            const parsed = parseRule(r.trigger_json, r.actions_json);
            const state = r.enabled === 1 ? "activa" : "pausada";
            const summary = parsed
              ? ruleSummaryEs(
                  parsed.trigger,
                  parsed.actions,
                  parsed.trigger.type === "campaign"
                    ? campName(parsed.trigger.campaignId)
                    : undefined,
                )
              : "(JSON inválido)";
            return `- id ${r.id} · ${state} · ${summary}`;
          })
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
    "## Campos de Airtable (tabla Leads)",
    schemaText,
    "",
    "## Reglas de Airtable actuales",
    ruleLines,
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
  const [sections, campaigns, schema, rules] = await Promise.all([
    listKbSections(env.DB),
    listCampaigns(env.DB),
    getBaseSchema(env),
    listAirtableRules(env.DB),
  ]);

  const system: SystemBlock[] = [
    {
      type: "text",
      text: block1Text(),
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    {
      type: "text",
      text: block2Text(sections, campaigns, schema, rules),
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

  if (tu.name === "propose_airtable_rule") {
    const trigger = coerceTrigger(input.trigger);
    const actions = coerceActions(input.actions);
    // Resolve the campaign's name (best-effort) so the summary reads nicely.
    let campaignName: string | undefined;
    if (trigger.type === "campaign") {
      const c = await getCampaign(env.DB, trigger.campaignId);
      campaignName = c?.name;
    }
    return {
      kind: "airtable_rule",
      name: String(input.name ?? ""),
      trigger,
      actions,
      reason: String(input.reason ?? ""),
      summaryEs: ruleSummaryEs(trigger, actions, campaignName),
    };
  }

  return null;
}

const RULE_PROGRAMS: readonly RuleProgram[] = ["adults", "kids", "baby"];

/** Best-effort coercion of the tool's trigger input into a RuleTrigger. Falls
 *  back to {type:"always"} on anything malformed (applyProposal re-validates). */
function coerceTrigger(raw: unknown): RuleTrigger {
  if (typeof raw === "object" && raw !== null) {
    const t = raw as { type?: unknown; campaign_id?: unknown; program?: unknown };
    if (t.type === "campaign") {
      const id = Number(t.campaign_id);
      if (Number.isFinite(id)) return { type: "campaign", campaignId: id };
    }
    if (t.type === "program" && RULE_PROGRAMS.includes(t.program as RuleProgram)) {
      return { type: "program", program: t.program as RuleProgram };
    }
  }
  return { type: "always" };
}

/** Best-effort coercion of the tool's actions input into RuleAction[]. */
function coerceActions(raw: unknown): RuleAction[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleAction[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as { field?: unknown; op?: unknown; value?: unknown };
    const field = typeof a.field === "string" ? a.field : "";
    if (!field) continue;
    if (a.op === "clear") {
      out.push({ op: "clear", field });
    } else if (a.op === "set" || a.op === "add") {
      out.push({ op: a.op, field, value: String(a.value ?? "") });
    }
  }
  return out;
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
  if (proposal.kind === "airtable_rule") {
    return applyAirtableRule(env, proposal);
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

// ---- airtable rules -------------------------------------------------------

/**
 * Apply a confirmed Airtable-rule proposal. Validates the trigger (campaign must
 * exist; program must be adults|kids|baby) and the actions (against a fresh base
 * schema), then persists the rule (trigger/actions JSON-stringified). Returns any
 * createdOptions so the UI can note the new select options that typecast will add.
 */
async function applyAirtableRule(
  env: Env,
  p: Extract<Proposal, { kind: "airtable_rule" }>,
): Promise<ApplyResult> {
  // ---- trigger validation ----
  const t = p.trigger;
  if (t.type === "campaign") {
    const c = await getCampaign(env.DB, t.campaignId);
    if (!c) return { ok: false, reason: "bad_trigger" };
  } else if (t.type === "program") {
    if (!RULE_PROGRAMS.includes(t.program)) {
      return { ok: false, reason: "bad_trigger" };
    }
  } else if (t.type !== "always") {
    return { ok: false, reason: "bad_trigger" };
  }

  // ---- action validation (against the fresh schema) ----
  const schema = await getBaseSchema(env);
  let createdOptions: string[] = [];
  if (schema) {
    const v = validateRuleActions(p.actions, schema);
    if (!v.ok) return { ok: false, reason: v.reason ?? "bad_action" };
    createdOptions = v.createdOptions;
  } else {
    // Schema temporarily unavailable: enforce only the structural value rule so a
    // malformed action never lands. Field/type checks resume when the cache heals.
    if (!Array.isArray(p.actions) || p.actions.length === 0) {
      return { ok: false, reason: "bad_action" };
    }
    for (const a of p.actions) {
      if (a.op !== "clear") {
        const value = (a as { value?: unknown }).value;
        if (typeof value !== "string" || value === "") {
          return { ok: false, reason: "bad_action" };
        }
      }
    }
  }

  const rule = await createAirtableRule(env.DB, {
    name: p.name,
    triggerJson: JSON.stringify(p.trigger),
    actionsJson: JSON.stringify(p.actions),
  });
  return { ok: true, kind: "airtable_rule", rule, createdOptions };
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
