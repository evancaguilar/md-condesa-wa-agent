// Meta message-template catalog for the WABA (docs/blasts.md §2). Read-only:
// GET /{WABA_ID}/message_templates with the WhatsApp token. The pure summary
// (variables, header format, buttons) is what the dashboard shows and what the
// queue endpoint validates a run against, so a run can only be queued on a
// template that is APPROVED and whose parameter shape matches.
//
// Needs env.WA_WABA_ID (wrangler var; the WABA the sales number lives on). When
// it is unset the catalog is "unavailable" and the owner types names by hand.

import type { Env } from "../types.js";

const GRAPH_VERSION = "v21.0";
const MAX_PAGES = 3;

export type TemplateStatus =
  | "APPROVED"
  | "PENDING"
  | "REJECTED"
  | "PAUSED"
  | "DISABLED"
  | "IN_APPEAL"
  | "PENDING_DELETION"
  | "DELETED"
  | "LIMIT_EXCEEDED"
  | string;

export interface TemplateSummary {
  id: string | null;
  name: string;
  language: string;
  status: TemplateStatus;
  category: string;
  /** Header: TEXT / IMAGE / VIDEO / DOCUMENT / LOCATION, or null when absent. */
  headerFormat: string | null;
  headerText: string | null;
  /** {{n}} placeholders in the header text (unsupported by the sender when > 0). */
  headerVars: number;
  body: string;
  /** Distinct {{n}} placeholders in the body. */
  bodyVars: number;
  footer: string | null;
  buttons: string[];
  rejectedReason: string | null;
}

interface GraphComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string }[];
}

export interface GraphTemplate {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: GraphComponent[];
  rejected_reason?: string;
}

/** Pure. Count distinct {{n}} placeholders in a template text. */
export function countVars(text: string | null | undefined): number {
  if (!text) return 0;
  const seen = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) seen.add(m[1]!);
  return seen.size;
}

/** Pure. Flatten one Graph template into the dashboard/validation shape. */
export function summarizeTemplate(t: GraphTemplate): TemplateSummary {
  const comps = Array.isArray(t.components) ? t.components : [];
  const header = comps.find((c) => (c.type ?? "").toUpperCase() === "HEADER") ?? null;
  const body = comps.find((c) => (c.type ?? "").toUpperCase() === "BODY") ?? null;
  const footer = comps.find((c) => (c.type ?? "").toUpperCase() === "FOOTER") ?? null;
  const buttons = comps.find((c) => (c.type ?? "").toUpperCase() === "BUTTONS") ?? null;
  const headerFormat = header ? (header.format ?? "TEXT").toUpperCase() : null;
  return {
    id: t.id ?? null,
    name: t.name ?? "",
    language: t.language ?? "",
    status: (t.status ?? "").toUpperCase(),
    category: (t.category ?? "").toUpperCase(),
    headerFormat,
    headerText: headerFormat === "TEXT" ? (header?.text ?? "") : null,
    headerVars: headerFormat === "TEXT" ? countVars(header?.text) : 0,
    body: body?.text ?? "",
    bodyVars: countVars(body?.text),
    footer: footer?.text ?? null,
    buttons: (buttons?.buttons ?? []).map((b) => b.text ?? b.type ?? "").filter(Boolean),
    rejectedReason: t.rejected_reason ?? null,
  };
}

export interface TemplateCheck {
  ok: boolean;
  /** Human-readable Spanish reason when !ok. */
  reason: string | null;
}

/**
 * Pure. Can a run be queued on this template with these parameters?
 * APPROVED only; body param count must match; a media header needs a link of
 * the same type; header text variables are not supported.
 */
export function checkTemplateForRun(
  tpl: TemplateSummary | null,
  params: string[],
  header: { type: string; link: string } | null,
): TemplateCheck {
  if (!tpl) return { ok: false, reason: "La plantilla no existe en la cuenta de WhatsApp (revisa nombre e idioma)." };
  if (tpl.status !== "APPROVED") {
    return {
      ok: false,
      reason:
        tpl.status === "PENDING"
          ? "Meta aún no aprueba la plantilla (PENDING). Espera la aprobación."
          : tpl.status === "REJECTED"
            ? `Meta rechazó la plantilla${tpl.rejectedReason ? ` (${tpl.rejectedReason})` : ""}.`
            : `La plantilla está en estado ${tpl.status}; solo se puede enviar una APPROVED.`,
    };
  }
  if (tpl.headerVars > 0) {
    return { ok: false, reason: "El encabezado tiene variables ({{1}} en el header); el envío masivo no las soporta." };
  }
  if (tpl.bodyVars !== params.length) {
    return {
      ok: false,
      reason: `La plantilla tiene ${tpl.bodyVars} variable(s) en el cuerpo y mandaste ${params.length}.`,
    };
  }
  const media = tpl.headerFormat && ["IMAGE", "VIDEO", "DOCUMENT"].includes(tpl.headerFormat);
  if (media) {
    if (!header || header.type.toUpperCase() !== tpl.headerFormat || !/^https:\/\//.test(header.link)) {
      return {
        ok: false,
        reason: `La plantilla lleva encabezado ${tpl.headerFormat}: falta el link https del archivo.`,
      };
    }
  } else if (header) {
    return { ok: false, reason: "La plantilla no tiene encabezado multimedia; quita el link." };
  }
  return { ok: true, reason: null };
}

export interface TemplateCatalog {
  ok: boolean;
  wabaId: string | null;
  templates: TemplateSummary[];
  error: string | null;
}

/** Fetch every template of the WABA (up to MAX_PAGES × 100). Never throws. */
export async function fetchTemplateCatalog(
  env: Env,
  doFetch: typeof fetch = fetch,
): Promise<TemplateCatalog> {
  const wabaId = env.WA_WABA_ID?.trim() || null;
  if (!wabaId) {
    return { ok: false, wabaId: null, templates: [], error: "WA_WABA_ID no está configurado" };
  }
  const templates: TemplateSummary[] = [];
  let url: string | null =
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates` +
    `?fields=id,name,status,category,language,components,rejected_reason&limit=100`;
  try {
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await doFetch(url, {
        headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      });
      const data = (await res.json()) as {
        data?: GraphTemplate[];
        paging?: { next?: string };
        error?: { message?: string; code?: number };
      };
      if (!res.ok || data.error) {
        return {
          ok: false,
          wabaId,
          templates,
          error: `Graph ${res.status}${data.error?.code ? ` [${data.error.code}]` : ""}: ${data.error?.message ?? "error"}`,
        };
      }
      for (const t of data.data ?? []) templates.push(summarizeTemplate(t));
      url = data.paging?.next ?? null;
    }
  } catch (err) {
    return { ok: false, wabaId, templates, error: err instanceof Error ? err.message : String(err) };
  }
  templates.sort((a, b) => {
    const ra = a.status === "APPROVED" ? 0 : 1;
    const rb = b.status === "APPROVED" ? 0 : 1;
    return ra - rb || a.name.localeCompare(b.name) || a.language.localeCompare(b.language);
  });
  return { ok: true, wabaId, templates, error: null };
}

/** Pure. Find one template by exact name + language in a catalog. */
export function findTemplate(
  templates: TemplateSummary[],
  name: string,
  language: string,
): TemplateSummary | null {
  return templates.find((t) => t.name === name && t.language === language) ?? null;
}

/** Input for createTemplate — the shapes the sender supports (docs/templates.md → Blast templates). */
export interface CreateTemplateInput {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  body: string;
  /** Sample values for {{1}}..{{n}} in the body (Meta requires one per variable). */
  bodyExamples?: string[];
  footer?: string;
  buttons?: { type: "URL"; text: string; url: string }[] | { type: "QUICK_REPLY"; text: string }[];
}

export interface CreateTemplateResult {
  ok: boolean;
  id?: string;
  status?: string;
  category?: string;
  error?: string;
}

/** Pure. Graph payload for POST /{WABA}/message_templates. */
export function buildCreateTemplatePayload(input: CreateTemplateInput): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];
  const bodyComp: Record<string, unknown> = { type: "BODY", text: input.body };
  const n = countVars(input.body);
  if (n > 0) {
    const ex = (input.bodyExamples ?? []).slice(0, n);
    while (ex.length < n) ex.push("Ana");
    bodyComp.example = { body_text: [ex] };
  }
  components.push(bodyComp);
  if (input.footer) components.push({ type: "FOOTER", text: input.footer });
  if (input.buttons && input.buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: input.buttons.map((b) =>
        b.type === "URL" ? { type: "URL", text: b.text, url: b.url } : { type: "QUICK_REPLY", text: b.text },
      ),
    });
  }
  return { name: input.name, language: input.language, category: input.category, components };
}

const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;

/** Submits a template to Meta for review on env.WA_WABA_ID. Owner-only route. */
export async function createTemplate(
  env: Env,
  input: CreateTemplateInput,
  doFetch: typeof fetch = fetch,
): Promise<CreateTemplateResult> {
  const wabaId = env.WA_WABA_ID?.trim() || null;
  if (!wabaId) return { ok: false, error: "WA_WABA_ID no está configurado" };
  if (!TEMPLATE_NAME_RE.test(input.name)) return { ok: false, error: "nombre inválido (a-z, 0-9, _)" };
  if (!input.body?.trim()) return { ok: false, error: "body vacío" };
  try {
    const res = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(buildCreateTemplatePayload(input)),
    });
    const data = (await res.json()) as {
      id?: string;
      status?: string;
      category?: string;
      error?: { message?: string; code?: number; error_user_msg?: string };
    };
    if (!res.ok || data.error) {
      return {
        ok: false,
        error: `Graph ${res.status}${data.error?.code ? ` [${data.error.code}]` : ""}: ${data.error?.error_user_msg ?? data.error?.message ?? "error"}`,
      };
    }
    return { ok: true, id: data.id, status: data.status, category: data.category };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
