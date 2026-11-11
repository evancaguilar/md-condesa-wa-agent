// Auto-responders treated as leads (grading 2026-11-04→11-11). Pure.
//
// A108: a vet school's WhatsApp bot answered every message we sent and our bot
// answered back — ~50 near-identical replies over four days. A237 / A247 /
// A250: a business auto-reply ("Gracias por comunicarte con …", "Estamos aquí
// para realzar tu belleza natural", "For more information, visit …") got a
// brain reply and the whole nudge chain each time.
//
// Conservative on purpose: one of three signals, each hard for a human to hit.
//  - phrase: classic auto-reply boilerplate (thanks-for-contacting-<us>,
//    business-hours notice, "mensaje automático", "we'll get back to you");
//  - repeat: the SAME inbound text (≥ 12 chars, normalized) for the 3rd time;
//  - loop: 4+ long inbound messages each landing ≤ 8 s after one of OUR
//    messages (bot-to-bot ping-pong; a human cannot type 40+ chars in 8 s).
// The pipeline (inbound.ts) stops brain turns + chases while the verdict
// holds and resumes on the first message that trips none of them.

export type AutoResponderSignal = "phrase" | "repeat" | "loop";

/** Strong, self-sufficient boilerplate. */
const STRONG_PHRASES: readonly RegExp[] = [
  /\b(?:este\s+es\s+un\s+)?mensaje\s+autom[aá]tico\b/i,
  /\brespuesta\s+autom[aá]tica\b/i,
  /\bauto[-\s]?(?:reply|respuesta|responder)\b/i,
  /\bautomated\s+(?:message|reply|response)\b/i,
  /\b[Gg]racias\s+por\s+(?:comunicarte|comunicarse|contactarnos|escribirnos|ponerte\s+en\s+contacto|ponerse\s+en\s+contacto|tu\s+mensaje|su\s+mensaje)\b[^.!?\n]{0,60}\b(?:con\s+nosotros|con\s+[A-ZÁÉÍÓÚÑ]|en\s+breve|a\s+la\s+brevedad|pronto|lo\s+antes\s+posible|te\s+(?:atenderemos|responderemos|contestaremos|atendemos)|le\s+(?:atenderemos|responderemos|contestaremos|atendemos))/,
  /\b(?:en\s+breve|a\s+la\s+brevedad|lo\s+antes\s+posible)\s+(?:te|le|nos)\s+(?:atenderemos|responderemos|contestaremos|pondremos\s+en\s+contacto|comunicaremos|atendemos|respondemos)\b/i,
  /\b(?:nuestro|el)\s+horario\s+de\s+atenci[oó]n\s+(?:es|de|son)\b/i,
  /\bfuera\s+(?:de|del)\s+(?:nuestro\s+)?horario\s+(?:de\s+atenci[oó]n|laboral)\b/i,
  /\bthank\s+you\s+for\s+(?:contacting|reaching\s+out\s+to|your\s+message)\b/i,
  /\bwe(?:'ll|\s+will)\s+(?:get\s+back\s+to\s+you|respond\s+as\s+soon)\b/i,
  /\bfor\s+more\s+information,?\s+(?:please\s+)?visit\b/i,
  /\b(?:estamos|estoy)\s+aqu[ií]\s+para\s+(?:ayudarte|ayudarle|servirte|servirle|realzar)\b[^.!?\n]{0,80}\b(?:informaci[oó]n|servicios|cursos|belleza)\b/i,
];

/** Pure. Does the text read like auto-reply boilerplate? */
export function isAutoReplyText(body: string): boolean {
  const t = body.trim();
  if (t.length < 15) return false;
  return STRONG_PHRASES.some((re) => re.test(t));
}

/** Lowercase, no accents/punctuation/emoji, single spaces. */
export function normalizeBody(body: string): string {
  return body
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Minimum normalized length for the repeat signal ("ok" / "hola" never count). */
export const REPEAT_MIN_CHARS = 12;
/** Same text this many times (current message included) = automated. */
export const REPEAT_THRESHOLD = 3;
/** Loop: our message → their reply within this many seconds … */
export const LOOP_REPLY_SECONDS = 8;
/** … with at least this many characters … */
export const LOOP_MIN_CHARS = 40;
/** … this many times in the recent history. */
export const LOOP_THRESHOLD = 4;

export interface RecentMsg {
  direction: string;
  body: string;
  ts: number;
}

/**
 * Pure. Why the CURRENT inbound (the last "in" row of `recent`, or `body`)
 * looks automated, or null. `recent` = this phone's recent messages, oldest
 * first, the current one included (the pipeline stores before it gates).
 */
export function autoResponderSignal(body: string, recent: readonly RecentMsg[]): AutoResponderSignal | null {
  if (isAutoReplyText(body)) return "phrase";
  const norm = normalizeBody(body);
  if (norm.length >= REPEAT_MIN_CHARS) {
    let same = 0;
    for (const m of recent) if (m.direction === "in" && normalizeBody(m.body) === norm) same++;
    // The current message may or may not be in `recent` yet.
    const includesCurrent = recent.some((m) => m.direction === "in" && m.body === body);
    if (same + (includesCurrent ? 0 : 1) >= REPEAT_THRESHOLD) return "repeat";
  }
  let fast = 0;
  for (let i = 1; i < recent.length; i++) {
    const m = recent[i]!;
    const prev = recent[i - 1]!;
    if (
      m.direction === "in" &&
      prev.direction === "out_bot" &&
      m.ts - prev.ts >= 0 &&
      m.ts - prev.ts <= LOOP_REPLY_SECONDS &&
      normalizeBody(m.body).length >= LOOP_MIN_CHARS
    ) {
      fast++;
    }
  }
  if (fast >= LOOP_THRESHOLD) {
    // Only while THIS message is itself one of the fast, long ones: a human who
    // takes over the chat (slow, or short) resumes the bot.
    const last = recent[recent.length - 1];
    const before = recent[recent.length - 2];
    if (
      last &&
      before &&
      last.direction === "in" &&
      before.direction === "out_bot" &&
      last.ts - before.ts <= LOOP_REPLY_SECONDS &&
      normalizeBody(last.body).length >= LOOP_MIN_CHARS
    ) {
      return "loop";
    }
  }
  return null;
}

const SIGNAL_ES: Record<AutoResponderSignal, string> = {
  phrase: "texto típico de respuesta automática",
  repeat: `el mismo mensaje ${REPEAT_THRESHOLD}+ veces`,
  loop: "contesta en segundos a cada mensaje nuestro (bot con bot)",
};

/** The one ops note when the stop is set. */
export function autoResponderNote(phone: string, signal: AutoResponderSignal, sample: string): string {
  const s = sample.replace(/\s+/g, " ").trim();
  return (
    `🤖 ${phone} parece una RESPUESTA AUTOMÁTICA (${SIGNAL_ES[signal]}): «${s.length > 140 ? `${s.slice(0, 139)}…` : s}». ` +
    `El bot deja de contestarle y se detienen los seguimientos. Se reanuda solo si llega un mensaje que no parezca automático; ` +
    `si es una persona, panel → Chats → «Reactivar seguimiento».`
  );
}

/** Note when a human-looking message lifts the stop. */
export function autoResponderResumeNote(phone: string): string {
  return `🤖→🙂 ${phone}: llegó un mensaje que no parece automático; el bot vuelve a contestar (los seguimientos cancelados no se reactivan).`;
}
