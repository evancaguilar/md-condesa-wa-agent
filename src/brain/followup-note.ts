// set_followup's `note` is SENT VERBATIM to the lead on WhatsApp when the row
// comes due (src/cron/followups.ts customText). 2026-11 grading, A90: the model
// wrote a staff reminder there ("Gilda espera confirmación de si el lunes 16
// hay clase… Confirmar y agendar… Niño: 3 años 11 meses") and the lead got it.
// Pure: flags text that reads as an internal note, not a message to the lead.

const INTERNAL_NOTE_RE: readonly RegExp[] = [
  /\b(?:el|la|al|del)\s+lead\b/i,
  /\blead\s+(?:pidi[oó]|quiere|dijo|espera|pregunt[oó])\b/i,
  /^\s*(?:nota|recordatorio|pendiente|tarea|to\s?do|seguimiento|follow[-\s]?up)\s*:/i,
  // Staff-style "Field: value". NOT a note when the label is preceded by a
  // possessive/article ("…le quede mejor a tu hijo: https://…" is a customer
  // sentence) or when the value is a URL.
  /(?<!\b(?:tu|tus|su|sus|mi|mis|del|al|el|la|un|una)\s)\b(?:ni[ñn][oa]|hij[oa]|beb[eé]|edad|tel[eé]fono|nombre|programa|disciplina)\s*:\s*(?!(?:https?:\/\/|www\.))\S/i,
  /\bconfirmar\s+y\s+agendar\b/i,
  /\bespera(?:n)?\s+(?:confirmaci[oó]n|respuesta|que\s+le)\b/i,
  /\b(?:llamarle|escribirle|preguntarle|recordarle|confirmarle|contactarle|avisarle|darle\s+seguimiento)\b/i,
  /\b(?:checar|verificar|revisar)\s+(?:con|si)\b/i,
];

/** Pure. Does this follow-up note read like a note for staff? */
export function looksInternalNote(note: string): boolean {
  const t = note.trim();
  if (!t) return false;
  return INTERNAL_NOTE_RE.some((re) => re.test(t));
}

export const INTERNAL_NOTE_ERROR =
  "error: set_followup.note is sent VERBATIM to the lead on WhatsApp when it comes due — this reads like a note for staff. Rewrite it as the exact message to the lead (second person, their language), or leave the reminder out. Staff tasks go in send_reply.escalation_reason. Then end with send_reply.";
