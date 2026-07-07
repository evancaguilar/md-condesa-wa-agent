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

/** Base64-encode bytes in chunks (avoids call-stack limits on large audios). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Transcribe audio bytes with Workers AI Whisper. The turbo model takes
 * `{ audio: <base64 string> }`; the classic model takes `{ audio: number[] }`.
 * Tries turbo first and falls back to classic on ANY error (input-shape
 * rejections included, not just model-not-found). Returns null when env.AI is
 * unbound (local/sandbox) or both models fail — never throws.
 */
export async function transcribe(
  env: Env,
  bytes: Uint8Array,
): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run(WHISPER_TURBO, { audio: toBase64(bytes) });
    const text = extractText(out);
    if (text) return text;
    console.warn("[media] turbo whisper returned no text, trying fallback");
  } catch (err) {
    console.warn(`[media] turbo whisper failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const out = await env.AI.run(WHISPER_FALLBACK, { audio: Array.from(bytes) });
    return extractText(out);
  } catch (err) {
    console.warn(`[media] fallback whisper failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
