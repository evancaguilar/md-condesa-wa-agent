// One-shot, kv-guarded: SUBMIT the Baby Fight Club Nivel 0 announcement
// template to Meta from the worker (docs/templates.md "Blast templates").
// Evan, 2026-10-19: every lead who told us their baby is 6–12 months gets
// "we can now take your baby — Nivel 0 every Friday 12 pm, or Nivel 1 if
// they turned one"; most of them are out of the 24 h window, so the blast
// needs an APPROVED Marketing template. Same mechanics as the other seeders
// (template-seed-cuestionario.ts seedSet): existing name+language skipped,
// catalog failure retries silently, creation failures retry MAX_TRIES ticks
// then post one summary. Bump SEED_KEY to force a fresh pass.

import type { Env } from "../types.js";
import type { CreateTemplateInput } from "../services/blast-templates.js";
import { seedSet } from "./template-seed-cuestionario.js";

export const SEED_KEY = "tpl_seed:bfc_nivel0:2026-10-19";

export const FOOTER_ES = "Responde BAJA para dejar de recibir mensajes.";
export const FOOTER_EN = "Reply BAJA to stop receiving messages.";

/** Pure. {{1}} = first name, {{2}} = the concrete day + hour of the next class. */
export function nivel0TemplateInputs(): CreateTemplateInput[] {
  return [
    {
      name: "bfc_nivel0_viernes_es",
      language: "es",
      category: "MARKETING",
      body:
        "¡Hola {{1}}! 👋 Ya podemos recibir a tu bebé en Baby Fight Club 🥋 Si sigue entre los 6 y 12 meses, " +
        "el nuevo grupo Nivel 0 es todos los viernes a las 12 pm; y si ya cumplió el año, le toca Nivel 1 " +
        "(miércoles 1 pm o sábado 2 pm). Los papás participan toda la clase y la primera es gratis. " +
        "¿Les aparto su lugar este {{2}}?",
      bodyExamples: ["Ana", "viernes 23 de octubre a las 12 pm"],
      footer: FOOTER_ES,
      buttons: [
        { type: "QUICK_REPLY", text: "Sí, apártanos" },
        { type: "QUICK_REPLY", text: "Otro día" },
      ],
    },
    {
      name: "bfc_nivel0_viernes_en",
      language: "en",
      category: "MARKETING",
      body:
        "Hi {{1}}! 👋 We can now take your baby at Baby Fight Club 🥋 If they're still 6–12 months, " +
        "the new Level 0 group is every Friday at 12 pm; if they've turned one, Level 1 is Wednesday 1 pm " +
        "or Saturday 2 pm. Parents join the whole class and the first one is free. Shall I save your spot this {{2}}?",
      bodyExamples: ["Ana", "Friday, October 23 at 12 pm"],
      footer: FOOTER_EN,
      buttons: [
        { type: "QUICK_REPLY", text: "Yes, save our spot" },
        { type: "QUICK_REPLY", text: "Another day" },
      ],
    },
  ];
}

export async function seedNivel0Templates(
  env: Env,
  deps: { postNote: (t: string) => Promise<void> },
  doFetch: typeof fetch = fetch,
): Promise<void> {
  await seedSet(env, deps, doFetch, {
    key: SEED_KEY,
    inputs: nivel0TemplateInputs,
    label: "Plantilla del aviso Baby Fight Club Nivel 0 (bfc_nivel0_viernes)",
  });
}
