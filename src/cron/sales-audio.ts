// Sales-conversation recordings → transcript + AI summary on the lead's row.
//
// Staff upload an audio file (phone voice memo, m4a/mp3, 10–30 min, mostly
// Spanish, sometimes mixed with English) to the `salesAudio.audio` attachment
// column of a Leads record. Each cron tick picks ONE unprocessed record,
// streams the file straight from Airtable's signed URL into Workers AI
// (Deepgram Nova-3 — the body is a ReadableStream, so the 128 MB isolate never
// buffers a 30 MB file), asks Claude for a structured sales summary, and writes
// transcript + summary back.
//
// The `processed` column is the claim AND the state machine, visible to staff:
//   blank            → waiting
//   "procesando…"    → a tick owns it (stale after 30 min → retried)
//   "att…,att…"      → done (ids of the attachments that were transcribed)
//   "ERROR: …"       → failed; clear the cell to retry
// Runs LAST in the tick so a slow transcription never starves the sales crons.

import type { Env } from "../types.js";
import { CLIENT } from "../client.gen.js";
import { airtableFetch, baseUrl, updateRecord, leadsMap } from "../services/airtable.js";
import { callAnthropic } from "../brain/claude.js";

export const NOVA_MODEL = "@cf/deepgram/nova-3";
export const PROCESSING_MARK = "procesando…";
export const PROCESSING_STALE_SECONDS = 30 * 60;
/** Airtable long-text cap is 100k chars; leave headroom. */
export const TRANSCRIPT_MAX_CHARS = 95_000;
const AUDIO_TYPES = /^(audio\/|video\/mp4|application\/octet-stream)/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|opus|aac|mp4|webm|flac|amr|3gp)$/i;

export interface AirtableAttachment {
  id: string;
  url: string;
  filename?: string;
  size?: number;
  type?: string;
}

export interface SalesAudioDeps {
  postNote: (text: string) => Promise<void>;
  /** Injectable for tests. */
  doFetch?: typeof fetch;
  summarize?: (env: Env, transcript: string, leadName: string | null) => Promise<string>;
}

/** Pure. Attachments that look like audio. */
export function audioAttachments(cell: unknown): AirtableAttachment[] {
  if (!Array.isArray(cell)) return [];
  return (cell as AirtableAttachment[]).filter(
    (a) => a && typeof a.url === "string" && typeof a.id === "string" &&
      (AUDIO_TYPES.test(a.type ?? "") || AUDIO_EXT.test(a.filename ?? "")),
  );
}

/** Pure. Airtable formula: has audio AND (never processed OR a stale claim). */
export function pendingFormula(f: { audio: string; processed: string }): string {
  return `AND(LEN({${f.audio}}&"")>0, OR({${f.processed}}=BLANK(), FIND("${PROCESSING_MARK}", {${f.processed}}&"")=1))`;
}

/** Pure. `procesando… <epoch>` claims older than the stale window may be retaken. */
export function claimIsStale(processed: string | null | undefined, nowEpoch: number): boolean {
  const p = (processed ?? "").trim();
  if (!p) return true;
  if (!p.startsWith(PROCESSING_MARK)) return false;
  const at = Number(p.slice(PROCESSING_MARK.length).trim());
  return !Number.isFinite(at) || nowEpoch - at > PROCESSING_STALE_SECONDS;
}

interface NovaWord { speaker?: number; punctuated_word?: string; word?: string }
interface NovaAlt {
  transcript?: string;
  words?: NovaWord[];
  paragraphs?: { transcript?: string };
}

/**
 * Pure. Best transcript text out of a Nova-3 response: the paragraph view when
 * present (speaker-labelled), else speaker turns rebuilt from words[], else the
 * flat transcript.
 */
export function extractNovaTranscript(out: unknown): string {
  const alt = (out as { results?: { channels?: { alternatives?: NovaAlt[] }[] } })?.results
    ?.channels?.[0]?.alternatives?.[0];
  if (!alt) return "";
  const para = alt.paragraphs?.transcript?.trim();
  if (para) return para;
  const words = alt.words ?? [];
  if (words.length && words.some((w) => typeof w.speaker === "number")) {
    const lines: string[] = [];
    let cur: number | undefined;
    let buf: string[] = [];
    for (const w of words) {
      if (w.speaker !== cur && buf.length) {
        lines.push(`Persona ${(cur ?? 0) + 1}: ${buf.join(" ")}`);
        buf = [];
      }
      cur = w.speaker;
      buf.push(w.punctuated_word ?? w.word ?? "");
    }
    if (buf.length) lines.push(`Persona ${(cur ?? 0) + 1}: ${buf.join(" ")}`);
    return lines.join("\n");
  }
  return (alt.transcript ?? "").trim();
}

/** Streams one attachment into Nova-3. `language: "multi"` = Spanish/English code-switching. */
export async function transcribeAttachment(
  env: Env,
  att: AirtableAttachment,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  if (!env.AI) throw new Error("AI binding no disponible");
  let lastErr: unknown = null;
  // A consumed stream cannot be replayed, so each attempt re-fetches the URL.
  for (const language of ["multi", "es"]) {
    const res = await doFetch(att.url);
    // `body` is the ReadableStream; typed loosely because the test tsconfig
    // ships a minimal Response type.
    const stream = (res as unknown as { body?: unknown }).body;
    if (!res.ok || !stream) throw new Error(`no pude descargar el audio (HTTP ${res.status})`);
    try {
      const out = await env.AI.run(NOVA_MODEL, {
        audio: { body: stream, contentType: att.type || "audio/mp4" },
        language,
        smart_format: true,
        punctuate: true,
        diarize: true,
        paragraphs: true,
      });
      const text = extractNovaTranscript(out);
      if (text) return text;
      lastErr = new Error("transcripción vacía");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const SUMMARY_SYSTEM = `Eres el analista de ventas de MD Self Defense Academy Condesa (academia de artes marciales en CDMX: Jiu-Jitsu, Muay Thai, MMA, Box, Kids, Teens, Mini Muay Thai y Baby Fight Club). Recibes la transcripción automática (puede tener errores y estar mezclada español/inglés) de una conversación de venta EN PERSONA entre alguien del staff y un prospecto, normalmente después de su clase de prueba.

Escribe en español un resumen ÚTIL para cerrar la venta y para mejorar al equipo. Usa EXACTAMENTE estas secciones, cada una en 1–4 líneas, sin inventar nada que no esté en la transcripción (si algo no se dijo, escribe "No se mencionó"):

RESULTADO: (se inscribió / dijo que se inscribe después / lo va a pensar / no le interesa / no queda claro) + una línea de por qué.
PROSPECTO: quién es, para quién es la clase, objetivo o motivación, experiencia previa, horarios que le acomodan.
OBJECIONES: cada objeción o duda real (precio, horario, distancia, pareja/familia, tiempo, miedo, etc.) y cómo se respondió.
OFERTA PRESENTADA: planes, precios, promos o condiciones que el staff mencionó, tal cual se dijeron.
SIGUIENTE PASO: qué quedó acordado, con fecha si se dijo, y quién debe hacer qué.
MENSAJE SUGERIDO: un WhatsApp corto (2–3 líneas, tono cálido, de tú) que el staff podría mandarle hoy para avanzar el cierre.
COACHING: 1–3 observaciones concretas para quien vendió (qué funcionó, qué pregunta faltó, qué objeción quedó sin resolver).`;

async function summarizeWithClaude(env: Env, transcript: string, leadName: string | null): Promise<string> {
  const resp = await callAnthropic(
    fetch,
    env.ANTHROPIC_API_KEY,
    [{ type: "text", text: SUMMARY_SYSTEM }],
    [
      {
        role: "user",
        content: `${leadName ? `Prospecto en el CRM: ${leadName}\n\n` : ""}<transcripcion>\n${transcript.slice(0, 120_000)}\n</transcripcion>`,
      },
    ],
    [],
    1200,
  );
  return resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** First line of a section, for the Slack note. */
export function sectionLine(summary: string, header: string): string {
  const m = new RegExp(`${header}:\\s*([^\\n]+)`, "i").exec(summary);
  return (m?.[1] ?? "").trim();
}

export type SalesAudioResult =
  | { status: "off" | "idle" }
  | { status: "done" | "failed"; recordId: string; detail: string };

/** One record per tick. Never throws for a per-record failure (it is written to the row). */
export async function runSalesAudio(
  env: Env,
  deps: SalesAudioDeps,
  nowEpoch: number,
): Promise<SalesAudioResult> {
  const f = CLIENT.airtableLeads?.salesAudio;
  if (!f || !env.AI || !env.AIRTABLE_PAT) return { status: "off" };
  const table = env.AIRTABLE_TRIALS_TABLE;

  const url = new URL(baseUrl(env, table));
  url.searchParams.set("filterByFormula", pendingFormula(f));
  url.searchParams.set("pageSize", "5");
  const res = await airtableFetch(env, url.toString(), { method: "GET" });
  if (!res.ok) throw new Error(`airtable salesAudio list failed: HTTP ${res.status}`);
  const data = (await res.json()) as { records?: { id: string; fields: Record<string, unknown> }[] };
  const rec = (data.records ?? []).find(
    (r) => audioAttachments(r.fields[f.audio]).length > 0 &&
      claimIsStale(typeof r.fields[f.processed] === "string" ? (r.fields[f.processed] as string) : "", nowEpoch),
  );
  if (!rec) return { status: "idle" };

  const atts = audioAttachments(rec.fields[f.audio]);
  const nameCell = rec.fields[leadsMap().name];
  const leadName = typeof nameCell === "string" && nameCell.trim() ? nameCell.trim() : null;
  await updateRecord(env, table, rec.id, { [f.processed]: `${PROCESSING_MARK} ${nowEpoch}` });

  try {
    const parts: string[] = [];
    for (const att of atts) {
      const text = await transcribeAttachment(env, att, deps.doFetch);
      parts.push(atts.length > 1 ? `=== ${att.filename ?? att.id} ===\n${text}` : text);
    }
    const transcript = parts.join("\n\n");
    const summary = await (deps.summarize ?? summarizeWithClaude)(env, transcript, leadName);
    await updateRecord(env, table, rec.id, {
      [f.transcript]: transcript.slice(0, TRANSCRIPT_MAX_CHARS),
      [f.summary]: summary,
      [f.processed]: atts.map((a) => a.id).join(","),
    });
    const resultado = sectionLine(summary, "RESULTADO");
    const paso = sectionLine(summary, "SIGUIENTE PASO");
    await deps.postNote(
      `🎙️ Conversación de venta transcrita — *${leadName ?? rec.id}*\n• Resultado: ${resultado || "—"}\n• Siguiente paso: ${paso || "—"}\n_Resumen completo en Airtable → «${f.summary}»._`,
    );
    return { status: "done", recordId: rec.id, detail: `${transcript.length} chars` };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await updateRecord(env, table, rec.id, { [f.processed]: `ERROR: ${msg}` }).catch(() => {});
    await deps.postNote(
      `🎙️⚠️ No pude transcribir el audio de venta de *${leadName ?? rec.id}*: ${msg}\n_Borra la celda «${f.processed}» en Airtable para reintentar._`,
    ).catch(() => {});
    return { status: "failed", recordId: rec.id, detail: msg };
  }
}
