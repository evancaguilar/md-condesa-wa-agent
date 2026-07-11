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
]);

/**
 * True when the inbound body is (after normalizeText) exactly one of the
 * known opt-out phrases. normalizeText already tolerates trailing punctuation
 * ("Baja." → "baja"), accents ("envíen"/"más" → "envien"/"mas"), case, and
 * surrounding whitespace. No substring matching.
 */
export function isOptOut(body: string): boolean {
  return OPT_OUT_EXACT.has(normalizeText(body));
}
