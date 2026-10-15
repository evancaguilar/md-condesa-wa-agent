// One-shot, kv-guarded: SUBMIT the post-trial / no-show chain templates to Meta
// from the worker (docs/templates.md §11–§15). Until 2026-10-15 none of the v2
// names existed on the WABA, so every out-of-window v2 touch was skipped
// silently. Three sequences per step — adults (base name), kids (`_kids`:
// mini / kids / teens, plural to the parent) and baby (`_baby`: Baby Fight
// Club, the parent takes the class with the baby) — each × es / en, bodies
// derived from the client.mjs free-form copy so the two never drift.
//
// Same pattern as template-seed-student.ts: a name+language Meta already holds
// (any status) is skipped, a catalog read failure retries next tick silently, a
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
import { templateBodyFromCopy } from "./template-sync.js";
import { programLink } from "./nudges.js";

export const SEED_KEY = "tpl_seed:chains:2026-10-15";
export const SEED_PROGRESS_KEY = `${SEED_KEY}:progress`;
export const MAX_TRIES = 3;

const FOOTER: Record<Language, string> = {
  es: "Responde BAJA para dejar de recibir mensajes.",
  en: "Reply BAJA to stop receiving messages.",
};

type Variant = "adults" | "kids" | "baby";
type Step = "post_trial_d0" | "post_trial_d3" | "post_trial_d6" | "no_show_hoy" | "no_show_d2" | "no_show_d7";

/** Copy-key base per step (client.mjs: <base>[Kids|Baby]<Es|En>). */
const STEP_KEY: Record<Step, string> = {
  post_trial_d0: "postTrialD0",
  post_trial_d3: "postTrialD3",
  post_trial_d6: "postTrialD6",
  no_show_hoy: "noShowHoy",
  no_show_d2: "noShowD2",
  no_show_d7: "noShowD7",
};

/** What {{2}} carries per step (none ⇒ the template has only {{1}}). */
const PARAM2: Record<Step, "slot" | "link" | null> = {
  post_trial_d0: null,
  post_trial_d3: null,
  post_trial_d6: null,
  no_show_hoy: "link",
  no_show_d2: "slot",
  no_show_d7: null,
};

const KID_NOUN: Record<Exclude<Variant, "adults">, Record<Language, string>> = {
  kids: { es: "su peque", en: "your little one" },
  baby: { es: "su bebé", en: "your baby" },
};

const SLOT_EXAMPLE: Record<Variant, Record<Language, string>> = {
  adults: { es: "Muay Thai el sábado 10:00 am", en: "Muay Thai Saturday 10:00 am" },
  kids: { es: "Kids el sábado 10:00 am", en: "Kids Saturday 10:00 am" },
  baby: { es: "Baby Fight Club el sábado 2:00 pm", en: "Baby Fight Club Saturday 2:00 pm" },
};

/**
 * Pure. Template body from a chain's free-form copy: {who} → " {{1}}",
 * {kid} → a generic noun, {day} → "hoy" for no_show_hoy (only ever sent on the
 * class day) and dropped elsewhere (d0 kids / baby has no `_ayer` twin),
 * {cta} → "Tenemos {{2}}." and {link} → {{2}}. Meta rejects a body that ends in
 * a variable, so a trailing {{2}} gets a closing emoji.
 */
export function chainTemplateBody(copy: string, step: Step, variant: Variant, lang: Language): string {
  let b = templateBodyFromCopy(copy);
  if (variant !== "adults") b = b.replaceAll("{kid}", KID_NOUN[variant][lang]);
  b = step === "no_show_hoy"
    ? b.replaceAll("{day}", lang === "en" ? "today" : "hoy")
    : b.replaceAll(" {day}", "").replaceAll("{day}", "");
  b = b.replaceAll("{cta}", lang === "en" ? "We have {{2}}." : "Tenemos {{2}}.").replaceAll("{link}", "{{2}}");
  // "👋 your little one's trial…" → capital at a sentence start.
  b = b.replace(/([.!?]\s+(?:\p{Extended_Pictographic}\s+)?)(your|su)\b/gu, (_m, pre: string, w: string) =>
    pre + w[0]!.toUpperCase() + w.slice(1),
  );
  b = b.trim();
  if (b.endsWith("{{2}}")) b += " 🥋";
  return b;
}

/** Pure. Every chain template, in submission order (34 for md-condesa). */
export function chainTemplateInputs(): CreateTemplateInput[] {
  const c = CLIENT.copy as unknown as Record<string, string | undefined>;

  const out: CreateTemplateInput[] = [];
  const steps = Object.keys(STEP_KEY) as Step[];
  for (const step of steps) {
    for (const variant of ["adults", "kids", "baby"] as Variant[]) {
      // Adult d0 is the approved v1 post_trial_d0 (+ _ayer) — not re-seeded.
      if (step === "post_trial_d0" && variant === "adults") continue;
      for (const lang of ["es", "en"] as Language[]) {
        const key = `${STEP_KEY[step]}${variant === "adults" ? "" : variant === "kids" ? "Kids" : "Baby"}${lang === "en" ? "En" : "Es"}`;
        const copy = c[key];
        if (!copy) continue;
        const p2 = PARAM2[step];
        const name = `${step}${variant === "adults" ? "" : `_${variant}`}_${lang}`;
        out.push({
          name,
          language: lang,
          category: "MARKETING",
          body: chainTemplateBody(copy, step, variant, lang),
          bodyExamples: ["Ana", ...(p2 === "slot" ? [SLOT_EXAMPLE[variant][lang]] : p2 === "link" ? [programLink(variant)] : [])],
          footer: FOOTER[lang],
        });
      }
    }
  }
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

export async function seedChainTemplates(
  env: Env,
  deps: { postNote: (t: string) => Promise<void> },
  doFetch: typeof fetch = fetch,
): Promise<void> {
  if (await kvGet(env.DB, SEED_KEY)) return;
  if (!env.WA_WABA_ID?.trim()) return; // nothing to submit to yet; retry next tick
  const inputs = chainTemplateInputs();
  if (!inputs.length) return; // this client has no v2 chain copy

  const catalog = await fetchTemplateCatalog(env, doFetch);
  if (!catalog.ok) {
    console.warn(`[tpl-seed] chains: catalog unavailable, retrying next tick: ${catalog.error}`);
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
    `${failed.length ? "⚠️" : "📝"} Plantillas de seguimiento post-clase / no-show (adultos, kids, baby) — ${parts.join(" — ") || "nada que hacer"}.` +
      (failed.length
        ? " Revisa WhatsApp Manager; para reintentar hay que cambiar SEED_KEY en src/cron/template-seed-chains.ts."
        : " Meta las revisa (suele tardar minutos); el bot las usa con la ventana cerrada en cuanto queden APPROVED."),
  );
}
