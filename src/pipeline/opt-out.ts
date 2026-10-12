// Opt-out detection for inbound messages. Conservative ANCHORED matching — a
// false positive here silently kills a paying lead's conversation, so we never
// substring-match (e.g. "baja de peso" must NOT trip "baja"). Pure module (no
// I/O) — unit-tested.
//
// v2 (2026-10-11): a normalized PATTERN FAMILY instead of an exact-phrase set.
// 2026-10-10 21:38, …4595 wrote three messages 20 s apart — "No me interesa la
// verdad. Muy pocas clases para lo que cobran… Es un abuso." / "Gracias" / "Ya
// no me manden mensaje." — and nothing matched (singular "mensaje"); the draft
// sat overnight and the 09:00 holding line went out to someone who had asked
// us to stop. Now:
//  - each sentence/clause is matched on its own (a complaint sentence before a
//    clear "no me manden mensajes" no longer hides it), against anchored
//    regexes covering singular/plural, ya/por favor/porfa, mensajes/msjs/wsp/
//    whats, escriban/manden/envíen, "dejen de escribir", "borren mi número";
//  - bare one-word commands (baja/stop/alto/unsubscribe) still need to be the
//    WHOLE message ("stop, mejor mándame la info" stays a lead);
//  - "no me interesa" + "no (me) manden/escriban" in the same message counts;
//  - a 2-minute burst of up to 3 inbound messages is evaluated as one text.

import { normalizeText } from "./campaigns.js";

/** Whole-message one-word (or fixed) opt-outs. */
const WHOLE_MESSAGE = new Set([
  "baja",
  "stop",
  "alto",
  "unsubscribe",
  "quiero darme de baja",
  "denme de baja",
  "dame de baja",
  "darme de baja",
  "stop messaging me",
  "stop texting me",
  "please stop",
]);

/** Leading greeting/courtesy tokens stripped before matching (repeatedly). */
const LEADING_FILLER = new Set([
  "hola", "oigan", "oye", "oiga", "buenas", "por", "favor", "porfa",
  "porfavor", "please", "ya", "y", "pero", "gracias", "ok", "okey", "va",
]);

/** Trailing courtesy tokens stripped (repeatedly). */
const TRAILING_FILLER = new Set([
  "por", "favor", "porfa", "porfavor", "please", "gracias", "ya", "plis", "pls",
]);

const MSG = "(?:mensajes?|msjs?|mensajitos?|wsp|whats|whatsapps?|watsap|info|informacion|nada|publicidad|promociones?)";
const TAIL = `(?: (?:mas|nada|ningun|ninguno))?(?: ${MSG})?(?: (?:mas|nada))?(?: (?:por aqui|por este medio|aqui|a este numero))?`;
const SEND_VERB = "(?:escriban|escribas|manden|mandes|envien|envies|contacten|contactes)";
const INF_VERB = "(?:escribir|escribirme|mandar|mandarme|enviar|enviarme|contactar|contactarme|molestar|molestarme)";

/** Anchored clause patterns (input = normalized clause, filler-stripped). */
const CLAUSE_PATTERNS: RegExp[] = [
  // "no me manden mensaje(s)", "no me escriban mas", "ya no me envien nada", "no me vuelvan a escribir"
  new RegExp(`^(?:no|nunca) (?:me |nos )?(?:vuelvan a )?(?:${SEND_VERB}|${INF_VERB})${TAIL}$`),
  // "dejen de escribir(me)", "me pueden dejar de mandar mensajes", "pueden dejar de mandarme msjs"
  new RegExp(`^(?:(?:me )?(?:pueden|puedes|podrian|podrias) )?(?:dejen|deja|dejar|dejes) de ${INF_VERB}${TAIL}$`),
  // "ya no quiero recibir mensajes", "no quiero que me escriban"
  new RegExp(`^(?:no|ya no) quiero (?:recibir|que me ${SEND_VERB})${TAIL}$`),
  // "borren mi numero", "borra mi contacto", "eliminen mi numero"
  /^(?:borren|borra|borrar|eliminen|elimina|eliminar|quiten|quita) (?:mi|este) (?:numero|contacto|telefono|cel|celular)(?: de su (?:lista|base))?$/,
  // "quiero darme de baja", "denme de baja de la lista"
  /^(?:quiero |me quiero )?(?:darme|denme|dame|dar) de baja(?: de (?:la|su) (?:lista|base))?$/,
  // English
  /^(?:please )?(?:stop|quit) (?:messaging|texting|writing|contacting) me$/,
  /^(?:do not|dont) (?:message|text|write|contact) me(?: again| anymore)?$/,
];

const NOT_INTERESTED = /\bno me interesa\b|\bno nos interesa\b|\bno estoy interesad[oa]\b/;
const NO_SEND = new RegExp(`\\bno (?:me |nos )?(?:${SEND_VERB}|${INF_VERB})\\b`);

function stripFillers(norm: string): string {
  const words = norm.split(" ").filter(Boolean);
  let i = 0;
  let j = words.length;
  while (i < j && LEADING_FILLER.has(words[i]!)) i++;
  while (j > i && TRAILING_FILLER.has(words[j - 1]!)) j--;
  return words.slice(i, j).join(" ");
}

function clauseIsOptOut(raw: string): boolean {
  const norm = stripFillers(normalizeText(raw));
  if (!norm) return false;
  return CLAUSE_PATTERNS.some((re) => re.test(norm));
}

/** Splits on sentence punctuation / line breaks (before normalization eats them). */
function clauses(body: string): string[] {
  return body
    .split(/[.!?¡¿;\n…]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * True when the inbound text asks us to stop messaging. Whole-message one-word
 * commands, any clause matching the anchored family, or "no me interesa" plus
 * a "no manden/escriban" in the same text. Commas do NOT split a clause, so
 * "cuando quieran pueden dejar de mandar mensajes" and "stop, mejor mándame la
 * info" stay unmatched.
 */
export function isOptOut(body: string): boolean {
  const whole = normalizeText(body);
  if (!whole) return false;
  if (WHOLE_MESSAGE.has(whole) || WHOLE_MESSAGE.has(stripFillers(whole))) return true;
  if (clauses(body).some(clauseIsOptOut)) return true;
  if (NOT_INTERESTED.test(whole) && NO_SEND.test(whole)) return true;
  return false;
}

/** Window in which consecutive inbound messages count as one burst. */
export const OPT_OUT_BURST_SECONDS = 120;
const OPT_OUT_BURST_MAX = 3;

/**
 * Pure. The last ≤3 inbound messages within OPT_OUT_BURST_SECONDS of the
 * newest, evaluated as one text (joined as separate sentences). `inbound` is
 * any order; only `direction === "in"` rows count when a direction is given.
 */
export function isOptOutBurst(
  inbound: readonly { body: string; ts: number; direction?: string }[],
): boolean {
  const rows = inbound
    .filter((m) => m.direction === undefined || m.direction === "in")
    .slice()
    .sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) return false;
  const newest = rows[rows.length - 1]!.ts;
  const burst = rows
    .filter((m) => newest - m.ts <= OPT_OUT_BURST_SECONDS)
    .slice(-OPT_OUT_BURST_MAX);
  return isOptOut(burst.map((m) => m.body).join(".\n"));
}
