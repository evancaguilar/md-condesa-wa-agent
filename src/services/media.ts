// WhatsApp media fetch + Workers AI (Whisper) transcription for voice notes.
// Everything here is best-effort: every failure resolves to null so a bad
// download or a model hiccup can never crash the inbound webhook. Zero deps.

import type { Env } from "../types.js";

const GRAPH_VERSION = "v21.0";
const WHISPER_TURBO = "@cf/openai/whisper-large-v3-turbo";
const WHISPER_FALLBACK = "@cf/openai/whisper";

/**
 * Resolve a Graph media id to bytes. Two hops per the Cloud API:
 *   1. GET graph.facebook.com/<version>/<mediaId>  → { url }
 *   2. GET that url (same bearer)                  → binary
 * Returns null on any non-OK response or error (never throws).
 */
export async function fetchMediaBytes(
  env: Env,
  mediaId: string,
): Promise<Uint8Array | null> {
  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` } },
    );
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as { url?: string };
    if (!meta.url) return null;

    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    if (!binRes.ok) return null;
    const buf = await binRes.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Pulls a transcript string out of the various Whisper response shapes. */
function extractText(out: unknown): string | null {
  if (!out || typeof out !== "object") return null;
  const o = out as { text?: unknown; result?: { text?: unknown } };
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  if (o.result && typeof o.result.text === "string" && o.result.text.trim()) {
    return o.result.text.trim();
  }
  return null;
}

/**
 * Transcribe audio bytes with Workers AI Whisper. Tries the turbo model, and on
 * a model-not-found error falls back to the base whisper model. Returns null
 * when env.AI is unbound (local/sandbox) or on any failure — never throws.
 */
export async function transcribe(
  env: Env,
  bytes: Uint8Array,
): Promise<string | null> {
  if (!env.AI) return null;
  const audio = Array.from(bytes);
  try {
    const out = await env.AI.run(WHISPER_TURBO, { audio });
    return extractText(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not\s*found|no\s*such\s*model|unknown\s*model|404/i.test(msg)) {
      try {
        const out = await env.AI.run(WHISPER_FALLBACK, { audio });
        return extractText(out);
      } catch {
        return null;
      }
    }
    return null;
  }
}
