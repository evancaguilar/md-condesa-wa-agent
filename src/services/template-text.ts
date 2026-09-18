// Template placeholder → real text for the brain's history.
//
// Outbound template sends are logged as `[template:<name>]` (wa.ts). The brain
// reads that placeholder as its own previous turn, so when a lead answers a
// blast with "10 am" the model has no idea what was offered (2026-09-17, first
// promo blast). This module swaps the placeholder for the template's actual
// body — rendered with the params that were sent, prefixed with the CDMX
// send time so relative words like "mañana" are unambiguous — using the Meta
// catalog cached in kv (`tpl_body:<name>`), one Graph fetch per cold name.
//
// Pure helpers are exported for tests; `withTemplateText` is the only
// D1/Graph-touching entry point and is fail-soft (falls back to the
// placeholder on any error).

import type { Env, StoredMessage } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { fetchTemplateCatalog } from "./blast-templates.js";
import { cdmxParts } from "../cron/time.js";

export const TPL_BODY_KV_PREFIX = "tpl_body:";
const PLACEHOLDER_RE = /^\[template:([a-z0-9_]+)\]$/;

export interface TemplateMeta {
  type?: string;
  name?: string;
  lang?: string;
  /** Body params in {{1}}..{{n}} order (recorded since 2026-09-17). */
  params?: string[];
}

/** Cached shape of a template's text. */
export interface TemplateText {
  body: string;
  footer: string | null;
  buttons: string[];
}

/** Pure. `[template:name]` → name, else null. */
export function templateNameOf(body: string | null | undefined): string | null {
  const m = PLACEHOLDER_RE.exec((body ?? "").trim());
  return m ? m[1]! : null;
}

/** Pure. Replace {{n}} with params[n-1]; missing params render as `fallback`. */
export function renderTemplateBody(body: string, params: string[], fallback = "👋"): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
    const v = params[Number(n) - 1];
    return v && v.trim() ? v : fallback;
  });
}

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Pure. "jue 17 sep 20:21" in CDMX wall-clock. */
export function cdmxStamp(epoch: number): string {
  const p = cdmxParts(epoch);
  const wd = new Date((epoch - 6 * 3600) * 1000).getUTCDay();
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${WEEKDAYS[wd]} ${p.day} ${MONTHS[p.month - 1]} ${hh}:${mm}`;
}

/**
 * Pure. The text the brain should see for a template send: dated prefix +
 * rendered body (+ footer/buttons so the model knows a BAJA line and a link
 * button were there).
 */
export function describeTemplateSend(
  name: string,
  text: TemplateText,
  params: string[],
  ts: number,
): string {
  const parts = [`[Plantilla "${name}" enviada el ${cdmxStamp(ts)} — texto exacto que recibió el lead:]`];
  parts.push(renderTemplateBody(text.body, params));
  if (text.footer) parts.push(`(pie: ${text.footer})`);
  if (text.buttons.length) parts.push(`(botón: ${text.buttons.join(" · ")})`);
  return parts.join("\n");
}

/** Pure. Params from the recorded meta, else the contact's first name for {{1}}. */
export function paramsFor(meta: TemplateMeta | null, contactName: string | null): string[] {
  if (meta?.params && meta.params.length) return meta.params;
  const first = (contactName ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? [first] : [];
}

function parseMeta(raw: string | null): TemplateMeta | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as TemplateMeta;
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

/**
 * Loads template texts for `names`: kv first, one catalog fetch for any miss
 * (the whole catalog is cached on that fetch). Names that are still unknown
 * are omitted.
 */
export async function loadTemplateTexts(
  env: Env,
  names: Iterable<string>,
  doFetch: typeof fetchTemplateCatalog = fetchTemplateCatalog,
): Promise<Map<string, TemplateText>> {
  const out = new Map<string, TemplateText>();
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const raw = await kvGet(env.DB, TPL_BODY_KV_PREFIX + name);
    if (raw) {
      try {
        out.set(name, JSON.parse(raw) as TemplateText);
        continue;
      } catch {
        /* refetch */
      }
    }
    missing.push(name);
  }
  if (missing.length === 0) return out;
  const cat = await doFetch(env);
  if (!cat.ok && cat.templates.length === 0) return out;
  for (const t of cat.templates) {
    if (t.status !== "APPROVED" && !missing.includes(t.name)) continue;
    const text: TemplateText = { body: t.body, footer: t.footer, buttons: t.buttons };
    if (missing.includes(t.name)) {
      out.set(t.name, text);
      await kvSet(env.DB, TPL_BODY_KV_PREFIX + t.name, JSON.stringify(text));
    }
  }
  return out;
}

/**
 * History with template placeholders replaced by their real text. Fail-soft:
 * any error (Graph down, kv error) returns the input untouched. No D1 reads
 * when the history holds no placeholder.
 */
export async function withTemplateText(
  env: Env,
  history: StoredMessage[],
  contactName: string | null,
  doFetch: typeof fetchTemplateCatalog = fetchTemplateCatalog,
): Promise<StoredMessage[]> {
  const names = history.map((m) => templateNameOf(m.body)).filter((n): n is string => !!n);
  if (names.length === 0) return history;
  try {
    const texts = await loadTemplateTexts(env, names, doFetch);
    return history.map((m) => {
      const name = templateNameOf(m.body);
      const text = name ? texts.get(name) : undefined;
      if (!name || !text) return m;
      const params = paramsFor(parseMeta(m.meta), contactName);
      return { ...m, body: describeTemplateSend(name, text, params, m.ts) };
    });
  } catch (err) {
    console.error(`[template-text] resolve failed: ${String(err)}`);
    return history;
  }
}
