// Safe greeting name for OUTBOUND copy. The WhatsApp push name is whatever the
// lead typed into their phone — we have shipped "¡Hola orco_publicidad@yahoo.com!"
// and "¡Hola 𝙂𝙧𝙞𝙢𝙢𝙟𝙤̄𝙬!" to real leads. Deterministic sends (nudges, reminders,
// templates) have no judgment of their own, so they ask here first and simply
// drop the greeting name when it isn't clearly a person's first name.
//
// Bias: when in doubt, return "" (no name). A missing name reads as neutral;
// a wrong one reads as spam. Pure module — unit-tested.

/**
 * Tokens that are never a greeting name even though they look like plain words:
 * articles/particles that start a nickname ("El Shadow"), titles, and the
 * business-inbox words that show up as WhatsApp profile names.
 */
const NOT_A_NAME = new Set([
  "el", "la", "los", "las", "mi", "tu", "su", "de", "del",
  "don", "dona", "doña", "sr", "sra", "srta", "dr", "dra", "ing", "lic", "mtro",
  "info", "contacto", "ventas", "admin", "soporte", "publicidad", "marketing",
  "hola", "buenas", "whatsapp", "wa", "cliente", "usuario", "user", "test",
  "mama", "mamá", "papa", "papá", "casa", "trabajo", "oficina",
]);

/** Anything in the raw string that means "this is a handle, not a name". */
const DISQUALIFYING = /[@_\d]|https?:|www\.|\.com|\.mx|\.net/i;

/**
 * The lead's first name, ONLY when the stored name is clearly a person's first
 * name; otherwise "".
 *
 * Accepts a decorated real name (emoji/symbol garnish is stripped:
 * "jesse♡" → "Jesse", "🌌 Zaira Covian 🌷" → "Zaira") and normalizes casing.
 * Rejects: emails/handles (anything with @, _ or a digit), URLs, fancy-font
 * names (Unicode math letters are Script=Common, not Latin), single letters and
 * vowel-less initials ("HM"), over-long tokens, and the NOT_A_NAME list.
 */
export function greetingName(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s || DISQUALIFYING.test(s)) return "";

  // Strip leading decoration from the whole string first, so a leading emoji
  // doesn't make the first whitespace token be the emoji itself.
  const lead = s.replace(/^[^\p{Script=Latin}]+/u, "");
  const token = lead.split(/\s+/)[0] ?? "";
  // Keep only a Latin-letter run (internal ' and - allowed: "Ma-Ré", "D'Angelo").
  const match = token.match(/^[\p{Script=Latin}]+(?:['’-][\p{Script=Latin}]+)*/u);
  const name = match ? match[0] : "";

  if (name.length < 2 || name.length > 20) return "";
  if (!/[aeiouáéíóúü]/i.test(name)) return ""; // "HM", "TQ", consonant soup
  if (NOT_A_NAME.has(name.toLowerCase())) return "";

  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}
