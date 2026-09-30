// One-shot, kv-guarded template maintenance for the post-trial chain:
//
//  1. syncPostTrialD0Templates — push the CURRENT post_trial_d0 copy
//     (client.mjs) onto the post_trial_d0_es/en templates Meta already holds.
//     The copy changed on 2026-09-21 while the templates were still PENDING;
//     editing in place keeps the names the sender uses. Bump SYNC_KEY whenever
//     the copy changes again.
//  2. createPostTrialV2Templates — submit the templates the 2026-09-30 arc
//     added (post_trial_d1 "ayer", d4, d7, d14 × es/en) for review. The d30
//     goodbye reuses the approved post_trial_d5 body, so it needs none.
//
// Each runs once per key: success and failure both set the guard (a failure
// posts one Slack note; POST /admin/api/blast/templates/{update,create} is the
// manual retry).

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { CLIENT } from "../client.gen.js";
import {
  createTemplate,
  updateTemplate,
  type CreateTemplateInput,
  type UpdateTemplateInput,
} from "../services/blast-templates.js";

export const SYNC_KEY = "tpl_sync:post_trial_d0:2026-09-21";

const FOOTER_ES = "Responde BAJA para dejar de recibir mensajes.";
const FOOTER_EN = "Reply BAJA to stop receiving messages.";

/**
 * Pure. client.mjs copy uses `{who}` (" Ana" or ""); the template wants
 * ` {{1}}`. `{when}` and `{link}` are fixed at template time (a template has
 * one variable in this pack — see services/template-params.ts).
 */
export function templateBodyFromCopy(
  copy: string,
  vars: { when?: string; link?: string } = {},
): string {
  return copy
    .replace("{who}", " {{1}}")
    .replaceAll("{when}", vars.when ?? "")
    .replaceAll("{link}", vars.link ?? "");
}

export function postTrialD0TemplateInputs(): UpdateTemplateInput[] {
  const c = CLIENT.copy;
  return [
    { name: "post_trial_d0_es", language: "es", body: templateBodyFromCopy(c.postTrialD0Es, { when: "hoy" }), footer: FOOTER_ES },
    { name: "post_trial_d0_en", language: "en", body: templateBodyFromCopy(c.postTrialD0En, { when: "today" }), footer: FOOTER_EN },
  ];
}

export const CREATE_V2_KEY = "tpl_create:post_trial_v2:2026-09-30";

/** Pure. The 8 templates the +30d arc needs that Meta does not have yet. */
export function postTrialV2TemplateInputs(): CreateTemplateInput[] {
  const c = CLIENT.copy;
  const link = CLIENT.links.schedule ?? CLIENT.links.booking;
  const mk = (
    base: string,
    es: string,
    en: string,
    vars: { es?: { when?: string; link?: string }; en?: { when?: string; link?: string } } = {},
  ): CreateTemplateInput[] => [
    {
      name: `${base}_es`,
      language: "es",
      category: "MARKETING",
      body: templateBodyFromCopy(es, vars.es),
      footer: FOOTER_ES,
      bodyExamples: ["Ana"],
    },
    {
      name: `${base}_en`,
      language: "en",
      category: "MARKETING",
      body: templateBodyFromCopy(en, vars.en),
      footer: FOOTER_EN,
      bodyExamples: ["Ana"],
    },
  ];
  return [
    ...mk("post_trial_d1", c.postTrialD0Es, c.postTrialD0En, { es: { when: "ayer" }, en: { when: "yesterday" } }),
    ...mk("post_trial_d4", c.postTrialD4Es, c.postTrialD4En),
    ...mk("post_trial_d7", c.postTrialD7Es, c.postTrialD7En),
    ...mk("post_trial_d14", c.postTrialD14Es, c.postTrialD14En, { es: { link }, en: { link } }),
  ];
}

/** Meta's "a template with this name and language already exists" is a success here. */
function alreadyExists(error: string | undefined): boolean {
  return /already exists|ya existe/i.test(error ?? "");
}

export async function createPostTrialV2Templates(
  env: Env,
  deps: { postNote: (t: string) => Promise<void> },
  doFetch: typeof fetch = fetch,
): Promise<void> {
  if (await kvGet(env.DB, CREATE_V2_KEY)) return;
  if (!env.WA_WABA_ID?.trim()) return; // nothing to submit against yet; retry next tick
  const results: string[] = [];
  let allOk = true;
  for (const input of postTrialV2TemplateInputs()) {
    const r = await createTemplate(env, input, doFetch);
    const ok = r.ok || alreadyExists(r.error);
    allOk = allOk && ok;
    results.push(`${input.name}: ${r.ok ? `ok (${r.status ?? "?"})` : ok ? "ya existía" : r.error ?? "error"}`);
  }
  await kvSet(env.DB, CREATE_V2_KEY, allOk ? "ok" : "error");
  await deps.postNote(
    `${allOk ? "📝" : "⚠️"} Plantillas post_trial v2 (d1 "ayer", d4, d7, d14 × es/en) enviadas a revisión — ${results.join(" · ")}` +
      (allOk
        ? ". Hasta que Meta las apruebe, los toques fuera de ventana de 24h se saltan con una nota diaria."
        : ". Reintento manual: POST /admin/api/blast/templates/create"),
  );
}

export async function syncPostTrialD0Templates(
  env: Env,
  deps: { postNote: (t: string) => Promise<void> },
  doFetch: typeof fetch = fetch,
): Promise<void> {
  if (await kvGet(env.DB, SYNC_KEY)) return;
  if (!env.WA_WABA_ID?.trim()) return; // nothing to sync against yet; retry next tick
  const results: string[] = [];
  let allOk = true;
  for (const input of postTrialD0TemplateInputs()) {
    const r = await updateTemplate(env, input, doFetch);
    allOk = allOk && r.ok;
    results.push(`${input.name}: ${r.ok ? `ok (${r.status ?? "?"})` : r.error ?? "error"}`);
  }
  await kvSet(env.DB, SYNC_KEY, allOk ? "ok" : "error");
  await deps.postNote(
    `${allOk ? "📝" : "⚠️"} Plantillas post_trial_d0 actualizadas con el texto nuevo — ${results.join(" · ")}` +
      (allOk ? "" : ". Reintento manual: POST /admin/api/blast/templates/update"),
  );
}
