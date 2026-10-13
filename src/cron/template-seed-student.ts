// One-shot, kv-guarded: SUBMIT the student-kit templates to Meta from the
// worker (student_welcome, student_qr, student_responsiva × es/en — docs/
// templates.md §10, §17, §18). The owner cannot easily submit them by hand (the QR one
// needs an image sample uploaded through the Resumable Upload API), so the
// worker does it (owner, 2026-10-13). Same pattern as template-sync.ts.
//
// Idempotent: a name+language Meta already holds (any status) is skipped, so a
// re-run only fills gaps. A tick that cannot read the catalog retries next tick
// silently; a tick where some creation failed retries up to MAX_TRIES ticks and
// THEN posts its one summary. Bump SEED_KEY to force a fresh pass.

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { CLIENT } from "../client.gen.js";
import { renderCopy } from "../client-config.js";
import {
  createTemplate,
  fetchTemplateCatalog,
  findTemplate,
  uploadHeaderSample,
  type CreateTemplateInput,
} from "../services/blast-templates.js";
import { checkinUrl, qrPng } from "../services/qr-png.js";
import { responsivaFallbackLink } from "./student-kit.js";

export const SEED_KEY = "tpl_seed:student_kit:2026-10-13";
/** Progress across ticks: {tries, created[]} (JSON), until the guard is set. */
export const SEED_PROGRESS_KEY = `${SEED_KEY}:progress`;
export const MAX_TRIES = 3;

/** The sample Meta reviews for the URL button (a real Alumno id shape). */
export const RESPONSIVA_EXAMPLE = responsivaFallbackLink("recJGBLgxBbsGqrf0");
export const RESPONSIVA_BUTTON_URL = "https://responsiva.mdcondesa.com/?rid={{1}}";

/** Pure. Template body from free-form copy: drop the "👉 {link}" line (the
 *  button carries the link) and any blank lines it leaves behind. */
export function stripLinkLine(copy: string): string {
  return copy
    .split("\n")
    .filter((l) => !l.includes("{link}"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Pure. The six templates. `qrHandle` = the uploaded header sample; null leaves
 * the student_qr pair out (its upload failed — reported as failed).
 */
export function studentKitTemplateInputs(qrHandle: string | null): CreateTemplateInput[] {
  const c = CLIENT.copy;
  const links = {
    link: CLIENT.links.welcome ?? CLIENT.links.schedule,
    group: CLIENT.links.group ?? "",
  };
  const out: CreateTemplateInput[] = [
    // student_welcome: §10 — the welcome copy with the links baked in, NO variables.
    { name: "student_welcome_es", language: "es", category: "UTILITY", body: renderCopy(c.welcomeEs, links) },
    { name: "student_welcome_en", language: "en", category: "UTILITY", body: renderCopy(c.welcomeEn, links) },
  ];
  if (qrHandle && c.studentQrEs && c.studentQrEn) {
    out.push(
      { name: "student_qr_es", language: "es", category: "UTILITY", header: { type: "IMAGE", handle: qrHandle }, body: c.studentQrEs },
      { name: "student_qr_en", language: "en", category: "UTILITY", header: { type: "IMAGE", handle: qrHandle }, body: c.studentQrEn },
    );
  }
  if (c.studentResponsivaEs && c.studentResponsivaEn) {
    const button = (text: string) =>
      [{ type: "URL" as const, text, url: RESPONSIVA_BUTTON_URL, example: [RESPONSIVA_EXAMPLE] }];
    out.push(
      { name: "student_responsiva_es", language: "es", category: "UTILITY", body: stripLinkLine(c.studentResponsivaEs), buttons: button("Firmar responsiva") },
      { name: "student_responsiva_en", language: "en", category: "UTILITY", body: stripLinkLine(c.studentResponsivaEn), buttons: button("Sign waiver") },
    );
  }
  return out;
}

export const STUDENT_KIT_TEMPLATE_NAMES: [string, string][] = [
  ["student_welcome_es", "es"],
  ["student_welcome_en", "en"],
  ["student_qr_es", "es"],
  ["student_qr_en", "en"],
  ["student_responsiva_es", "es"],
  ["student_responsiva_en", "en"],
];

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

export async function seedStudentKitTemplates(
  env: Env,
  deps: { postNote: (t: string) => Promise<void> },
  doFetch: typeof fetch = fetch,
): Promise<void> {
  if (await kvGet(env.DB, SEED_KEY)) return;
  if (!env.WA_WABA_ID?.trim()) return; // nothing to submit to yet; retry next tick
  if (!CLIENT.copy.studentQrEs) return; // this client has no student kit

  const catalog = await fetchTemplateCatalog(env, doFetch);
  if (!catalog.ok) {
    console.warn(`[tpl-seed] catalog unavailable, retrying next tick: ${catalog.error}`);
    return;
  }
  const exists = (name: string, lang: string) => !!findTemplate(catalog.templates, name, lang);
  const progress = readProgress(await kvGet(env.DB, SEED_PROGRESS_KEY));
  const failed: string[] = [];
  const skipped: string[] = [];

  // The IMAGE header sample only when a student_qr template is still missing.
  let qrHandle: string | null = null;
  if (!exists("student_qr_es", "es") || !exists("student_qr_en", "en")) {
    const up = await uploadHeaderSample(
      env,
      await qrPng(checkinUrl("sample")),
      "image/png",
      doFetch,
    );
    if (up.ok && up.handle) qrHandle = up.handle;
    else failed.push(`student_qr (muestra de imagen: ${up.error ?? "error"})`);
  }

  // Already on the WABA (any status) → skipped, unless an earlier try of this
  // seed is what created it (then it is reported as created).
  const createdNames = new Set(progress.created.map((c) => c.split(" ")[0]!));
  for (const [name, lang] of STUDENT_KIT_TEMPLATE_NAMES) {
    if (exists(name, lang) && !createdNames.has(name)) skipped.push(name);
  }
  for (const input of studentKitTemplateInputs(qrHandle)) {
    if (exists(input.name, input.language)) continue;
    const r = await createTemplate(env, input, doFetch);
    if (r.ok) progress.created.push(`${input.name}${r.status ? ` (${r.status})` : ""}`);
    else failed.push(`${input.name}: ${r.error ?? "error"}`);
  }

  progress.tries += 1;
  if (failed.length && progress.tries < MAX_TRIES) {
    await kvSet(env.DB, SEED_PROGRESS_KEY, JSON.stringify(progress));
    return; // retry next tick; created ones are skipped then
  }
  await kvSet(env.DB, SEED_KEY, failed.length ? "error" : "ok");
  await kvSet(env.DB, SEED_PROGRESS_KEY, JSON.stringify(progress));
  const parts = [
    progress.created.length ? `enviadas a revisión: ${progress.created.join(", ")}` : "",
    skipped.length ? `ya existían: ${skipped.join(", ")}` : "",
    failed.length ? `fallaron: ${failed.join(" · ")}` : "",
  ].filter(Boolean);
  await deps.postNote(
    `${failed.length ? "⚠️" : "📝"} Plantillas del kit de alumno nuevo (QR + responsiva + bienvenida) — ${parts.join(" — ") || "nada que hacer"}.` +
      (failed.length
        ? " Revisa WhatsApp Manager; para reintentar hay que cambiar SEED_KEY en src/cron/template-seed-student.ts."
        : " Meta las revisa (suele tardar minutos); el bot las usa en cuanto queden APPROVED."),
  );
}
