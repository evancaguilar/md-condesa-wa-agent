// Opt-out detection for inbound messages. Conservative EXACT-match only — a
// false positive here silently kills a paying lead's conversation, so we never
// substring-match (e.g. "baja de peso" must NOT trip "baja"). Pure module (no
// I/O) — unit-tested.

import { normalizeText } from "./campaigns.js";

/**
 * Opt-out phrases, already in normalizeText's output shape (lowercase, no
 * accents/punctuation, single-spaced) so the Set lookup is a direct equality
 * check against the normalized inbound body.
 */
const OPT_OUT_EXACT = new Set([
  "baja",
  "stop",
  "alto",
  "unsubscribe",
  "quiero darme de baja",
  "ya no me envien mensajes",
  "no me envien mas mensajes",
  "ya no me manden mensajes",
  "no me manden mas mensajes",
  // Polite/indirect but unambiguous "stop messaging me" shapes (seen live
  // 2026-07-15: "Oigan me pueden dejar de mandar mensajes?" slipped through).
  "me pueden dejar de mandar mensajes",
  "me puedes dejar de mandar mensajes",
  "pueden dejar de mandarme mensajes",
  "dejen de mandarme mensajes",
  "dejen de enviarme mensajes",
  "dejen de mandar mensajes",
  "ya no quiero recibir mensajes",
  "no quiero recibir mensajes",
  "ya no me escriban",
  "no me escriban",
  "stop messaging me",
  "stop texting me",
]);

/**
 * Leading filler tokens stripped (repeatedly) before the exact lookup, so
 * "Oigan, me pueden dejar de mandar mensajes?" still matches. ONLY leading
 * greetings/courtesy words — never content words, so "baja de peso" and
 * "cuando quieran pueden dejar de mandar mensajes" stay unmatched.
 */
const LEADING_FILLER = new Set([
  "hola",
  "oigan",
  "oye",
  "oiga",
  "buenas",
  "por",
  "favor",
  "porfa",
  "porfavor",
  "please",
]);

/**
 * True when the inbound body is (after normalizeText and stripping leading
 * greeting/courtesy fillers) exactly one of the known opt-out phrases.
 * normalizeText already tolerates trailing punctuation ("Baja." → "baja"),
 * accents ("envíen"/"más" → "envien"/"mas"), case, and surrounding whitespace.
 * No substring matching.
 */
export function isOptOut(body: string): boolean {
  const norm = normalizeText(body);
  if (OPT_OUT_EXACT.has(norm)) return true;
  const words = norm.split(" ");
  let i = 0;
  while (i < words.length && LEADING_FILLER.has(words[i]!)) i++;
  return i > 0 && OPT_OUT_EXACT.has(words.slice(i).join(" "));
}
