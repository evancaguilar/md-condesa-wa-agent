// One-shot, kv-guarded: push the CURRENT post_trial_d0 copy (client.mjs) onto
// the post_trial_d0_es/en templates Meta already holds. The copy changed on
// 2026-09-21 while the templates were still PENDING from the 09-21 submission;
// editing in place keeps the names the sender uses. Bump SYNC_KEY whenever the
// copy changes again. Runs once per key: success and failure both set the
// guard (a failure posts one Slack note; POST /admin/api/blast/templates/update
// is the manual retry).

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { CLIENT } from "../client.gen.js";
import { updateTemplate, type UpdateTemplateInput } from "../services/blast-templates.js";

export const SYNC_KEY = "tpl_sync:post_trial_d0:2026-09-21";

const FOOTER_ES = "Responde BAJA para dejar de recibir mensajes.";
const FOOTER_EN = "Reply BAJA to stop receiving messages.";

/** Pure. client.mjs copy uses `{who}` (" Ana" or ""); the template wants ` {{1}}`. */
export function templateBodyFromCopy(copy: string): string {
  return copy.replace("{who}", " {{1}}");
}

export function postTrialD0TemplateInputs(): UpdateTemplateInput[] {
  const c = CLIENT.copy;
  return [
    { name: "post_trial_d0_es", language: "es", body: templateBodyFromCopy(c.postTrialD0Es), footer: FOOTER_ES },
    { name: "post_trial_d0_en", language: "en", body: templateBodyFromCopy(c.postTrialD0En), footer: FOOTER_EN },
  ];
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
