// Pure regex + helper for detecting a WhatsApp reply that CLAIMS a completed
// booking. Shared by src/brain/claude.ts (guardUnbackedBookingClaim — blocks
// auto-send when book_trial didn't actually run this turn) and
// src/cron/booking-recon.ts (nightly reconciliation backstop — flags any
// such claim that Airtable never backs with a trial datetime).

/**
 * Past-participle / confirmatory booking claims ("ya quedó agendado", "tu
 * clase está reservada", "you're booked", "te esperamos mañana a las 7 pm",
 * "nos vemos el sábado 11 am"). Deliberately does NOT match offers or
 * questions ("¿quieres agendar?", "puedo agendarte", "¿nos vemos mañana?") —
 * offering to book, or asking about a future meetup, is fine.
 *
 * Patterns:
 *  - bare past participles: agendad(o/a)(s), reservad(o/a)(s), booked,
 *    "you're all set", confirmad(o/a)(s) (not immediately followed by "?").
 *    The bare "agendad…" form excludes an immediately preceding "no (has/ha)
 *    " so nudge copy ("todavía no has agendado") doesn't trip it — the
 *    reconciliation layer (booking-recon-core.ts) also excludes these bodies
 *    explicitly as a second line of defense.
 *  - "quedó/quedo agendado/apartado/reservado…" and "ya quedaste apartado".
 *  - "te esperamos"/"te espero" or "nos vemos" followed, within the same
 *    sentence, by a weekday/hoy/mañana/clock-time — i.e. a specific promised
 *    meetup, not a vague pleasantry ("te esperamos pronto" does NOT match).
 *    "nos vemos …" additionally does not match when the sentence is a
 *    question ("¿nos vemos mañana?" does NOT match).
 */
export const CLAIMS_BOOKED =
  /(?<!\bno\s(?:has\s|ha\s)?)\bagendad[oa]s?\b|\breservad[oa]s?\b|\bbooked\b|\byou'?re all set\b|\bte esper(?:amos|o)\b(?=[^.?!]*(?:hoy|mañana|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo|\d{1,2}\s*(?::\d{2})?\s*[ap]m))|\bqued(?:ó|o)\s+(?:agendad|apartad|reservad)\w*|\bya\s+quedaste\b|\bconfirmad[oa]s?\b(?!\?)|\bnos vemos\b(?=[^.!?]*(?:hoy|mañana|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo|\d{1,2}\s*(?::\d{2})?\s*[ap]m)(?:[^.!?]*[.!]|[^.!?]*$))/i;

/** True when `text` reads as a confirmed (not offered) booking claim. */
export function claimsBooking(text: string): boolean {
  return CLAIMS_BOOKED.test(text);
}
