// People who write again and used to get silence (grading 2026-11-04→11-11).
// Pure.
//
//  - A93: a contact marked opted_out came back twice ("¿Hay una persona que
//    responde?", "vengo de la página web y quiero agendar mi clase de prueba")
//    and nobody saw it. The bot still never writes to an opted-out contact on
//    its own; a clear new request opens a #wa-leads task so a human decides.
//  - B1: a contact with status `student` writing on the lead line got only a
//    Slack task and no reply at all for 30 h. Now ONE fixed acknowledgement
//    (client copy, owner-editable) at most once per 12 h, inside the window.

import { isOptOut } from "./opt-out.js";
import type { ClientCopy } from "../client-config.js";

/** One task / one ack per phone per this window. */
export const RETURNING_COOLDOWN_SECONDS = 12 * 3600;

/** Bare acknowledgements that are not a new request. */
const ACK_ONLY =
  /^(?:ok(?:ey|ay)?|okis|va|vale|sale|listo|gracias|muchas gracias|mil gracias|thanks|thank you|thx|si|sí|no|bye|adios|adiós|saludos|buen dia|buen día|buenas noches|de nada|perfecto|👍|🙏|👌|🙌)[\s.!¡?¿👍🙏👌🙌😊🙂]*$/i;

/**
 * Pure. Is this message from an opted-out contact a clear NEW request worth a
 * human's look? Not a stop word, not a bare "ok"/"gracias"/emoji, and has some
 * substance (a question, or at least three words).
 */
export function isReturningRequest(body: string): boolean {
  const t = body.trim();
  if (!t || isOptOut(t)) return false;
  if (ACK_ONLY.test(t)) return false;
  const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return t.includes("?") || words.length >= 3;
}

/** The #wa-leads task for an opted-out contact who wrote again. */
export function returningOptOutTask(phone: string, name: string | null, body: string): string {
  const s = body.replace(/\s+/g, " ").trim();
  return (
    `🔁 *${name ? `${name} · ` : ""}${phone}* está dado de BAJA y volvió a escribir:\n> ${s.length > 400 ? `${s.slice(0, 399)}…` : s}\n` +
    `_El bot no le contesta (baja). Si quiere retomar, cámbialo a «Lead» en el panel y contéstale tú._`
  );
}

/**
 * Pure. The fixed acknowledgement for a student on the lead line, in their
 * language, or null when the client has no such copy (feature off).
 */
export function studentAckText(copy: Pick<ClientCopy, "studentAckEs" | "studentAckEn">, lang: string): string | null {
  const es = copy.studentAckEs?.trim() || "";
  const en = copy.studentAckEn?.trim() || "";
  if (lang === "en") return en || es || null;
  return es || null;
}
