// "Declined" stop (2026-11-10). Distinct from the baja (opt-out.ts): the lead
// can still write and the bot still answers — we only stop CHASING. Pure
// module (no I/O); the D1 side lives in src/services/decline-stop.ts.
//
// Why: Meta flagged the number for spam twice. Baby-campaign lead "Hatt" said
// "No, me queda bastante lejos" on day 0; the bot closed politely, then the
// drip sent nudge_1h, nudge_8h, d2, d3, d4 — and twice the bot promised "no te
// molestamos más" with nothing in the system backing it.
//
// Owner rule (2026-11-10): on the FIRST objection or decline the bot gets
// exactly one re-invite, in its reply to that message. From that moment the
// stop is set: every pending unsolicited follow-up is cancelled and nothing new
// is armed (day-1 nudges, d2–d7, catch-up, blasts). The chase resumes only
// when the lead answers that re-invite with real interest (the brain's
// `lead_interested`, see shouldClearDecline), books, or staff reset it. Silence,
// "gracias", "hola" or a second objection leave it in place.
//
// Signals that SET it:
//   - the brain: send_reply.lead_declined (objection / decline / annoyance);
//   - deterministic backstops (this file): a clear not-interested statement
//     (isNotInterested), a distance / price objection stated as a fact
//     (isObjection), and a bot reply that PROMISES no more messages
//     (promisesNoMoreMessages — the promise is made true, never left hanging).

import { normalizeText } from "./campaigns.js";

export const DECLINED_KEY_PREFIX = "declined:";

/** kv key of the marker. */
export function declinedKey(phone: string): string {
  return `${DECLINED_KEY_PREFIX}${phone}`;
}

/** Who set the stop. */
export type DeclineSource = "brain" | "not_interested" | "objection" | "promise" | "complaint";

export interface DeclineMarker {
  /** When the stop was (last) set, epoch seconds. */
  ts: number;
  source: DeclineSource;
  /** The lead's words (or the bot's promise), clipped — for the panel / audit. */
  text?: string;
}

const SOURCES: readonly DeclineSource[] = ["brain", "not_interested", "objection", "promise", "complaint"];

export function encodeDeclineMarker(m: DeclineMarker): string {
  const out: DeclineMarker = { ts: m.ts, source: m.source };
  if (m.text) out.text = m.text.slice(0, 160);
  return JSON.stringify(out);
}

/** Pure. Any garbage value still counts as declined (ts 0) — fail toward silence. */
export function parseDeclineMarker(raw: string | null | undefined): DeclineMarker | null {
  if (raw == null) return null;
  try {
    const p = JSON.parse(raw) as Partial<DeclineMarker>;
    const ts = Number(p.ts);
    const source = SOURCES.includes(p.source as DeclineSource) ? (p.source as DeclineSource) : "brain";
    const m: DeclineMarker = { ts: Number.isFinite(ts) ? ts : 0, source };
    if (typeof p.text === "string" && p.text) m.text = p.text;
    return m;
  } catch {
    return { ts: 0, source: "brain" };
  }
}

// ---- follow-up kinds -------------------------------------------------------

/**
 * Pending rows cancelled when the stop is set, and refused at send time while
 * it is set. Everything that CHASES the lead:
 *  - the day-1 nudges and the extended drip (catch-up rows are the same kinds);
 *  - reengage_7d, the no-show chain and the attended-no-signup chain (sales
 *    touches after a trial — "no me interesa" after a no-show ends them too);
 *  - custom (a set_followup the brain promised before the decline);
 *  - origin_ask ("¿cómo nos encontraste?" — unsolicited);
 *  - blast rows (scheduled or paused).
 * NOT cancelled (KEPT_KINDS): the booked class's own reminders (trial_confirm,
 * day_before, same_day — the lead still has the class), a staff "send later"
 * (a human's explicit decision; any inbound already cancels it), the student
 * kit, and the post-trial Slack card (staff-facing, never sent to the lead).
 */
export const DECLINE_CANCEL_KINDS = [
  "nudge_1h",
  "nudge_6h",
  "nudge_8h",
  "nudge_d2",
  "nudge_d3",
  "nudge_d4",
  "nudge_d5",
  "nudge_d7",
  "reengage_7d",
  "no_show_1",
  "no_show_hoy",
  "no_show_d2",
  "no_show_d3",
  "no_show_d7",
  "post_trial_d0",
  "post_trial_d2",
  "post_trial_d3",
  "post_trial_d5",
  "post_trial_d6",
  "custom",
  "origin_ask",
  "blast",
] as const;

export const DECLINE_KEPT_KINDS = [
  "trial_confirm",
  "day_before",
  "same_day",
  "attendance_check",
  "staff_later",
  "student_kit",
  "post_trial_card",
] as const;

const CANCEL_SET = new Set<string>(DECLINE_CANCEL_KINDS);

/** Pure. Is this followup kind stopped by a decline? */
export function isDeclineCancelKind(kind: string): boolean {
  return CANCEL_SET.has(kind);
}

// ---- deterministic detection -----------------------------------------------

const LEAD_FILLER = new Set([
  "hola", "buenas", "pues", "pero", "y", "ya", "gracias", "muchas", "mil",
  "ok", "okey", "va", "la", "verdad", "por", "ahora", "el", "momento", "de",
  "mira", "oye", "oiga", "fijate", "creo", "que", "mejor", "realmente", "igual",
  "perdon", "disculpa", "lo", "siento", "a", "mi", "en", "este",
]);
const TRAIL_FILLER = new Set([
  "gracias", "muchas", "mil", "la", "verdad", "por", "ahora", "el", "momento",
  "de", "ya", "mas", "realmente", "favor", "saludos", "ok", "bye", "igual",
  "tanto", "mucho", "pero", "les", "agradezco", "te", "lo", "y", "buen", "dia",
  "tarde", "noche", "bonito", "excelente",
]);

function strip(norm: string, lead: Set<string>, trail: Set<string>): string {
  const w = norm.split(" ").filter(Boolean);
  let i = 0;
  let j = w.length;
  while (i < j && lead.has(w[i]!)) i++;
  while (j > i && trail.has(w[j - 1]!)) j--;
  return w.slice(i, j).join(" ");
}

/** Non-question clauses (split on sentence punctuation AND commas). */
function statementClauses(body: string): string[] {
  return body
    .split(/[.!;\n…,]+/)
    .map((c) => c.trim())
    .filter((c) => c && !/[?¿]/.test(c));
}

const OBJ = "(?:la |el |las |los )?(?:clase|clases|info|informacion|oferta|promo|promocion|curso|programa|propuesta|plan|planes)";
const NOT_INTERESTED_PATTERNS: RegExp[] = [
  // "no me interesa", "ya no nos interesa", "no me interesa la clase", "no me interesan"
  new RegExp(`^(?:ya )?no (?:me|nos|le) interesa(?:n)?(?: ${OBJ})?$`),
  // "no estoy interesada", "ya no estamos interesados", "no estoy interesado en la clase"
  new RegExp(`^(?:ya )?no (?:estoy|estamos|esta) interesad[oa]s?(?: en ${OBJ})?$`),
  // "ya me inscribí en otro lado", "ya lo inscribí en otra academia", "ya entreno en otro gym"
  // (leading "ya" / "la" are stripped as filler, so the bare verb forms count too)
  /^(?:ya )?(?:me inscribi|inscribi|lo inscribi|la inscribi|los inscribi|las inscribi|estoy inscrit[oa]|esta inscrit[oa]|entreno|entrena|encontre|encontramos) (?:en |a )?(?:otro|otra) (?:lado|lugar|academia|gimnasio|gym|escuela|sitio|parte)$/,
  // "ya no", "mejor no" alone are too vague — brain only.
  // English
  /^(?:i m |im |i am |we re |were |we are )?(?:not|no longer) interested(?: anymore| at the moment| right now)?$/,
  /^(?:i m |im |i am |we re |were |we are )?not interested(?: in (?:the )?(?:class|classes|offer|info))?$/,
];

/**
 * Pure. A clear "not interested" statement: some clause of the message is
 * exactly that (after greeting / courtesy filler). Anchored, so "no me
 * interesa el box, prefiero muay thai" and "¿no me interesa si…?" stay leads.
 */
export function isNotInterested(body: string): boolean {
  return statementClauses(body).some((c) => {
    const n = strip(normalizeText(c), LEAD_FILLER, TRAIL_FILLER);
    return n !== "" && NOT_INTERESTED_PATTERNS.some((re) => re.test(n));
  });
}

const OBJECTION_PATTERNS: RegExp[] = [
  // distance: "me queda (bastante) lejos", "nos queda muy lejos", "está lejos", "vivo lejos",
  // "es q me queda lejos", "no me queda cerca"
  /(?<!\bno )\b(?:me|nos|les|le) (?:queda|quedan|quedaria) (?:muy |bastante |super |demasiado |algo |un poco |re |mega )?lejos\b/,
  /(?<!\bno (?:me |nos |les |le )?)\b(?:esta|estan|queda|quedan|es) (?:muy |bastante |super |demasiado |algo |un poco )?lejos(?: de (?:mi|nosotros|mi casa|casa|donde vivo|mi trabajo))?$/,
  /\bvivo (?:muy |bastante |super |demasiado )?lejos\b/,
  /\bno (?:me|nos) queda (?:cerca|de paso)\b/,
  // price stated as a fact: "está caro", "es muy caro", "no me alcanza", "fuera de mi presupuesto"
  /(?<!\bno (?:me |nos |les |le )?)\b(?:esta|es|sale|salen|estan|son) (?:muy |bastante |super |algo |un poco |demasiado )?car[oa]s?\b/,
  /\bno (?:me|nos) alcanza\b/,
  /\bfuera de (?:mi|nuestro) presupuesto\b/,
  // English
  /\b(?:it s |its |it is )?(?:too far|too expensive)\b/,
];

/**
 * Pure. A distance / price objection stated as a FACT (questions — "¿está muy
 * lejos del metro?" — never count). Under the owner rule the first objection
 * sets the stop; the bot's reply to it is the one re-invite. Schedule ("no
 * puedo", "no me quedan los horarios") is left to the brain: it is usually the
 * start of a day/time negotiation, not a no.
 */
export function isObjection(body: string): boolean {
  return statementClauses(body).some((c) => {
    const n = normalizeText(c);
    return n !== "" && OBJECTION_PATTERNS.some((re) => re.test(n));
  });
}

/** Pure. The deterministic source for an inbound text, or null. */
export function detectDecline(body: string): "not_interested" | "objection" | null {
  if (isNotInterested(body)) return "not_interested";
  if (isObjection(body)) return "objection";
  return null;
}

const SEND_VERBS =
  "(?:mandar|mandamos|mandaremos|mandarte|mandarles|enviar|enviamos|enviaremos|enviarte|escribir|escribimos|escribiremos|escribirte|contactar|contactamos|contactaremos|buscar|buscamos|buscaremos)";
const BOTHER_VERBS = "(?:molestar|molestamos|molestaremos|molestarte|molestarlos|insistir|insistimos|insistiremos)";
const PROMISE_PATTERNS: RegExp[] = [
  // "no te mandamos más mensajes", "no te vamos a escribir más", "no les escribiremos más"
  new RegExp(`\\bno (?:te |les |los |las |la |lo )?(?:vamos a |volvemos a |volveremos a )?${SEND_VERBS}(?: \\w+){0,3} mas\\b`),
  // "no te molestamos (más)", "no te vamos a molestar", "no insistimos más"
  new RegExp(`\\bno (?:te |les |los |las |la |lo )?(?:vamos a |volvemos a |volveremos a )?${BOTHER_VERBS}\\b`),
  // English
  /\bwe (?:won t|will not|wont) (?:message|text|write|contact|bother) you\b/,
];

/**
 * Pure. The BOT's reply promises we stop writing ("No te mandamos más mensajes
 * sobre esto"). Whenever the bot makes that promise the stop is set too, so it
 * is never a hollow one. "No te mandamos la ubicación" (no "más") is not it.
 */
export function promisesNoMoreMessages(text: string): boolean {
  const n = normalizeText(text);
  return n !== "" && PROMISE_PATTERNS.some((re) => re.test(n));
}

// ---- decisions --------------------------------------------------------------

/**
 * Pure. What a brain turn sets: the brain's own flag first, then the promise
 * backstop. null = this turn does not set the stop.
 */
export function turnDeclineSource(input: { leadDeclined?: boolean; message: string }): DeclineSource | null {
  if (input.leadDeclined === true) return "brain";
  if (promisesNoMoreMessages(input.message)) return "promise";
  return null;
}

/**
 * Pure. The stop a routed brain result sets (routeResult). Owner, 2026-11-10:
 * "angry messages should always get stopped the sequence and referred to
 * humans" — every complaint-class escalation (escalate_to_human, or a draft
 * whose escalation reason classifies as complaint) sets the stop with source
 * `complaint`, on top of the human task it already creates. Otherwise the
 * send/draft rules of turnDeclineSource. A booking never sets it. Explicit
 * stop wording is the opt-out path (a full baja) and never reaches here.
 */
export function routeDeclineSource(input: {
  action: string;
  escalationKind: string | null;
  leadDeclined?: boolean;
  message?: string;
}): DeclineSource | null {
  if (input.action !== "send" && input.action !== "draft" && input.action !== "escalate") return null;
  if (input.escalationKind === "complaint" && input.action !== "send") return "complaint";
  if (input.action === "escalate") return null;
  return turnDeclineSource({ leadDeclined: input.leadDeclined, message: input.message ?? "" });
}

/**
 * Pure. Does this brain turn RE-OPEN the chase? Only when the brain flagged
 * `lead_interested`, did not flag a decline this turn, and the interest came in
 * ANSWER to something we said after the stop was set: there is an outbound
 * (bot or staff) newer than the marker and an inbound newer than that outbound.
 * So the objection message itself ("me queda lejos, ¿tienen sábado?"), a burst
 * before our re-invite went out, or a marker with no reply since never clears;
 * a bare "Hola" / "Gracias" never carries lead_interested in the first place.
 */
export function shouldClearDecline(
  marker: DeclineMarker | null,
  turn: {
    interested?: boolean;
    declinedThisTurn: boolean;
    history: readonly { direction: string; ts: number }[];
  },
): boolean {
  if (!marker || turn.interested !== true || turn.declinedThisTurn) return false;
  const outAfter = turn.history
    .filter((m) => m.direction !== "in" && m.ts > marker.ts)
    .map((m) => m.ts);
  if (outAfter.length === 0) return false;
  const firstOut = Math.min(...outAfter);
  return turn.history.some((m) => m.direction === "in" && m.ts > firstOut);
}

const SOURCE_LABEL: Record<DeclineSource, string> = {
  brain: "la IA lo detectó",
  not_interested: "dijo que no le interesa",
  objection: "puso una objeción (distancia/precio)",
  promise: "el bot le prometió no escribirle más",
  complaint: "queja / enojo — pasó a humano",
};

/** Pure. The ONE ops_log line per stop event. */
export function declineNote(phone: string, source: DeclineSource, cancelled: number): string {
  return (
    `🤚 ${phone} declinó (${SOURCE_LABEL[source]}): seguimiento automático detenido` +
    `${cancelled > 0 ? `, ${cancelled} envío(s) pendientes cancelados` : ""}. ` +
    `El bot sigue contestando si escribe. Reabrir: agenda, interés explícito, o panel → Chats → «Reactivar seguimiento» (o Estado «Lead»).`
  );
}
