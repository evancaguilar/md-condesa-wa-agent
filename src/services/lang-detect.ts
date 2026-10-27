// Language of ONE inbound message (2026-10-24).
//
// contacts.lang was never written after creation, so every lead stayed "es"
// and the per-turn <context> told the brain "lang: es" even when the lead
// wrote in English: Thilo (+41, visiting CDMX) wrote "Hey team" and got a
// Spanish welcome, then a Spanish goodbye to "But thanks for the info!".
// The pipeline now stores what this returns; null = not sure, keep the stored
// language. Pure, stopword counting — no dependency, no model call.

import type { Language } from "../types.js";

/** Accent-stripped, lowercase words. Words that exist in both languages
 *  ("me", "no", "a", "info", "ok") are in neither list. */
const EN_WORDS = new Set([
  "the", "is", "are", "was", "i", "im", "i'm", "you", "your", "it", "its", "it's", "there", "any",
  "what", "how", "when", "where", "do", "does", "can", "could", "would", "will", "please", "thanks",
  "thank", "hi", "hello", "hey", "here", "this", "that", "and", "for", "with", "of", "to", "on",
  "at", "be", "today", "tomorrow", "week", "class", "classes", "price", "prices", "team", "want",
  "like", "but", "already", "gone", "unfortunately", "yes", "have", "has", "my", "just", "much",
  "time", "great", "awesome", "sounds", "good", "morning", "afternoon", "evening", "trial", "free",
  "about", "interested", "book", "visiting", "cool", "see", "we", "our", "they", "sure",
]);
const ES_WORDS = new Set([
  "el", "la", "los", "las", "de", "del", "que", "y", "en", "un", "una", "para", "por", "con", "es",
  "hola", "quiero", "gracias", "clase", "clases", "mi", "tengo", "buenas", "buenos", "dias", "tardes",
  "noches", "cuanto", "precio", "precios", "horario", "horarios", "manana", "hoy", "si", "informacion",
  "te", "se", "lo", "le", "pero", "como", "puedo", "tienen", "hay", "estan", "esta", "muchas", "bien",
  "ya", "soy", "quisiera", "saber", "costo", "gratis", "bebe", "hijo", "hija", "nino", "nina", "adulto",
  "vale", "claro", "perfecto", "nos", "vemos", "seria", "donde", "cuando", "tambien",
]);
/** One of these alone settles a message of ≤ 3 words ("Hey team", "Gracias"). */
const STRONG_EN = new Set(["hi", "hello", "hey", "thanks", "thank"]);
const STRONG_ES = new Set(["hola", "gracias", "buenas", "buenos"]);

function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter((w) => w !== "");
}

/** Pure. "en" / "es" when the message clearly is one of them, else null. */
export function detectLanguage(text: string | null | undefined): Language | null {
  const ws = words(text ?? "");
  if (ws.length === 0) return null;
  let en = 0;
  let es = 0;
  for (const w of ws) {
    if (EN_WORDS.has(w)) en++;
    if (ES_WORDS.has(w)) es++;
  }
  if (en >= 2 && en > es * 2) return "en";
  if (es >= 2 && es > en * 2) return "es";
  if (ws.length <= 3) {
    if (es === 0 && ws.some((w) => STRONG_EN.has(w))) return "en";
    if (en === 0 && ws.some((w) => STRONG_ES.has(w))) return "es";
  }
  return null;
}
