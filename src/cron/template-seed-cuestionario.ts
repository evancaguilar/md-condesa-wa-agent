// One-shot, kv-guarded: SUBMIT the questionnaire-invite templates to Meta from
// the worker (cuestionario_invite + cuestionario_invite_kids × es/en —
// docs/templates.md §19). They carry the link for leads whose 24 h window is
// closed (web-form bookers), so sendCuestionario can still reach them. Same
// pattern as template-seed-student.ts: a name+language Meta already holds (any
// status) is skipped, a catalog read failure retries next tick silently, a
// failed creation retries up to MAX_TRIES ticks and THEN posts one summary.
// Bump SEED_KEY to force a fresh pass.

import type { Env, Language } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { CLIENT } from "../client.gen.js";
import {
  createTemplate,
  fetchTemplateCatalog,
  findTemplate,
  type CreateTemplateInput,
} from "../services/blast-templates.js";
import { INVITE_BUTTON_URL, inviteTemplateBody, inviteWhenParam } from "../services/cuestionario-core.js";

export const SEED_KEY = "tpl_seed:cuestionario_invite:2026-10-13";
export const SEED_PROGRESS_KEY = `${SEED_KEY}:progress`;
export const MAX_TRIES = 3;

/** A realistic token (signed with a throwaway key) for Meta's URL-button sample. */
export const INVITE_TOKEN_EXAMPLE =
  "v1.eyJyIjoicmVjSkdCTGd4QmJzR3FyZjAiLCJ2IjoiYWR1bHRvcyIsImUiOjE3OTMyMDk2MDB9.aH_y4qlARj7FDpNrqeZx2w";
export const INVITE_URL_EXAMPLE = INVITE_BUTTON_URL.replace("{{1}}", INVITE_TOKEN_EXAMPLE);

/** viernes 16 de octubre 2026, 7:00 PM CDMX — the date sample. */
const SAMPLE_EPOCH = 1792198800;

/** Pure. The four templates (empty when the client has no invite copy). */
export function cuestionarioTemplateInputs(): CreateTemplateInput[] {
  const c = CLIENT.copy;
  const out: CreateTemplateInput[] = [];
  const add = (name: string, lang: Language, copy: string | undefined, button: string): void => {
    if (!copy) return;
    const { body, kidVars } = inviteTemplateBody(copy, lang);
    out.push({
      name,
      language: lang,
      category: "UTILITY",
      body,
      bodyExamples: [inviteWhenParam(SAMPLE_EPOCH, lang), ...Array.from({ length: kidVars }, () => "Mateo")],
      buttons: [{ type: "URL", text: button, url: INVITE_BUTTON_URL, example: [INVITE_URL_EXAMPLE] }],
    });
  };
  add("cuestionario_invite_es", "es", c.cuestionarioEs, "Contestar");
  add("cuestionario_invite_en", "en", c.cuestionarioEn, "Answer");
  add("cuestionario_invite_kids_es", "es", c.cuestionarioKidsEs, "Contestar");
  add("cuestionario_invite_kids_en", "en", c.cuestionarioKidsEn, "Answer");
  return out;
}

interface Progress {
  tries: number;
  created: string[];
}

function readProgress(raw: string | null): Progress {
  try {
    const p = JSON.parse(raw ?? "") as Partial<Progress>;
    return { tries: Number(p.tries) || 0, created: Array.isArray(p.created) ? p.created.map(String) : [] };
  } catch {
    return { tries: 0, created: [] };
  }
}

export async function seedCuestionarioTemplates(
  env: Env,
  deps: { postNote: (t: string) => Promise<void> },
  doFetch: typeof fetch = fetch,
): Promise<void> {
  if (await kvGet(env.DB, SEED_KEY)) return;
  if (!env.WA_WABA_ID?.trim()) return; // nothing to submit to yet; retry next tick
  const inputs = cuestionarioTemplateInputs();
  if (!inputs.length) return; // this client has no questionnaire

  const catalog = await fetchTemplateCatalog(env, doFetch);
  if (!catalog.ok) {
    console.warn(`[tpl-seed] cuestionario: catalog unavailable, retrying next tick: ${catalog.error}`);
    return;
  }
  const exists = (name: string, lang: string) => !!findTemplate(catalog.templates, name, lang);
  const progress = readProgress(await kvGet(env.DB, SEED_PROGRESS_KEY));
  const createdNames = new Set(progress.created.map((c) => c.split(" ")[0]!));
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const input of inputs) {
    if (exists(input.name, input.language)) {
      if (!createdNames.has(input.name)) skipped.push(input.name);
      continue;
    }
    const r = await createTemplate(env, input, doFetch);
    if (r.ok) progress.created.push(`${input.name}${r.status ? ` (${r.status})` : ""}`);
    else failed.push(`${input.name}: ${r.error ?? "error"}`);
  }

  progress.tries += 1;
  if (failed.length && progress.tries < MAX_TRIES) {
    await kvSet(env.DB, SEED_PROGRESS_KEY, JSON.stringify(progress));
    return;
  }
  await kvSet(env.DB, SEED_KEY, failed.length ? "error" : "ok");
  await kvSet(env.DB, SEED_PROGRESS_KEY, JSON.stringify(progress));
  const parts = [
    progress.created.length ? `enviadas a revisión: ${progress.created.join(", ")}` : "",
    skipped.length ? `ya existían: ${skipped.join(", ")}` : "",
    failed.length ? `fallaron: ${failed.join(" · ")}` : "",
  ].filter(Boolean);
  await deps.postNote(
    `${failed.length ? "⚠️" : "📝"} Plantillas del cuestionario pre-clase (cuestionario_invite) — ${parts.join(" — ") || "nada que hacer"}.` +
      (failed.length
        ? " Revisa WhatsApp Manager; para reintentar hay que cambiar SEED_KEY en src/cron/template-seed-cuestionario.ts."
        : " Meta las revisa (suele tardar minutos); el bot las usa con la ventana cerrada en cuanto queden APPROVED."),
  );
}
