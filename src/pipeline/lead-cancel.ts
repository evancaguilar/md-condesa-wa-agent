// Lead cancels / reschedules a booked trial in chat. Pure module — unit-tested.
//
// Audit 2026-10-14 and 10-21: leads wrote "ya no voy a poder ir", "lo dejamos
// para otro día"… and still got "mañana es tu clase" and, after the class,
// "te esperábamos hoy". There was no handler: the only trace was a send-time
// regex on the LAST inbound (followups.CHAT_CANCEL_RE), which a later
// "gracias" defeated, and nothing ever covered the no-show touch.
//
// Flow (src/services/trial-cancel.ts + pipeline/inbound.ts step 1c):
//   detectLeadCancel(body) → only then (zero cost otherwise) the phone's
//   SCHEDULED pre-class rows (TRIAL_CANCEL_KINDS) are cancelled, a kv marker
//   remembers the cancelled trial(s) so a no-show chain armed later by
//   Airtable never chases that class, staff get a #wa-leads task note (update
//   Airtable), and the brain turn carries a <cancelacion> hint so it answers
//   with empathy and offers to reschedule. A new book_trial re-arms everything
//   for the NEW slot (scheduleTrialSequence moves the rows back to scheduled).
//
// The detector is deliberately conservative: hypotheticals ("si no puedo
// ir…"), lateness ("no llego a tiempo, llego 10 min tarde") and membership
// cancellations ("cancelar mi mensualidad") never count.

export type LeadCancelIntent = "cancel" | "reschedule";

/** The pre-class rows a cancellation retires (the reminders + the first
 *  no-show touch armed with the booking). */
export const TRIAL_CANCEL_KINDS = ["trial_confirm", "day_before", "same_day", "no_show_hoy"] as const;

/** Lowercase, accents stripped, punctuation → space (ñ → n). */
function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DAY_WORD = "(?:hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)";

/** "if I can't…" — a question about policy, not a cancellation. */
const HYPOTHETICAL =
  /\b(?:si|por si|en caso de que|que pasa si|y si)\s+(?:ya\s+)?no\s+(?:puedo|podemos|pudiera|pudieramos|llego|llegamos|voy|vamos|alcanzo|alcanzamos|asisto|asistimos)\b/;

/** Lateness, not absence. */
const LATE = /\b(?:tarde|retras\w*|minutos?|minutitos?|min)\b/;

/** Cancelling a membership / payment is a student matter, never a trial. */
const MEMBERSHIP = /\b(?:membresia|mensualidad|suscripcion|domiciliacion|cobro|cargo|tarjeta|pago)\b/;

const CANCEL_WORD = /\bcancel\w*/;

/** "no llego / no alcanzo" — absence unless it is about lateness. */
const NOT_ARRIVING = /\bno\s+(?:llego|llegamos|llegare|llegaremos|alcanzo|alcanzamos|alcanzare)\b/;

const CANCEL_PHRASES: readonly RegExp[] = [
  /\b(?:ya\s+)?no\s+(?:voy|vamos|va|van)\s+a\s+(?:poder|alcanzar|llegar|ir|asistir|acudir|venir)\b/,
  /\bno\s+(?:podre|podremos|podra|podran|podria|podriamos)\b(?!\s+(?:pagar|esperar))/,
  new RegExp(`\\bno\\s+(?:puedo|podemos|puede|pueden)\\s+(?:ir|asistir|llegar|acudir|venir|${DAY_WORD}|el\\s+${DAY_WORD})\\b`),
  /\bno\s+(?:asistire|asistiremos|ire|iremos|vamos\s+a\s+ir|voy\s+a\s+ir|va\s+a\s+ir|van\s+a\s+ir)\b/,
  /\bya\s+no\s+(?:voy|vamos|puedo|podemos|podre|podremos|ire|iremos|asistire|va|van|llego|llegamos)\b/,
  /\b(?:me|nos|le)\s+(?:surgio|salio|salieron|surgieron)\s+(?:algo|un|una|unos|unas|otro|otra)\b/,
  /\bse\s+(?:me|nos|le)\s+(?:complico|complicaron|atraveso|cruzo|presento|enfermo)\b/,
  /\b(?:tuve|tengo|tenemos|tuvimos)\s+(?:un|una)\s+(?:imprevisto|contratiempo|emergencia)\b/,
  /\bimprevisto\b/,
  /\b(?:esta|estoy|estamos|anda|amanecio|amaneci)\s+enferm\w*/,
  // English
  /\b(?:cant|cannot|can not|wont|will not|wont be able to|unable to)\s+(?:make it|come|attend|go|be there)\b/,
];

const RESCHEDULE_PHRASES: readonly RegExp[] = [
  /\breagend\w*/,
  /\breprogram\w*/,
  /\bpospon\w*/,
  /\b(?:cambiar|mover|recorrer|pasar)\s+(?:la|mi|su|el|de)?\s*(?:clase|cita|dia|hora|horario|fecha|prueba)\b/,
  /\b(?:cambiarla|moverla|recorrerla|pasarla|cambiarlo|moverlo|recorrerlo|pasarlo)\b/,
  /\b(?:la|lo)\s+(?:puedo|podemos|podria|podriamos|puedes|podrias)\s+(?:cambiar|mover|pasar|recorrer)\b/,
  /\b(?:lo|la)\s+(?:dejamos|dejo|pasamos|paso|movemos|muevo|cambiamos|cambio|recorremos|recorro)\s+para\b/,
  /\b(?:para|en)\s+otro\s+(?:dia|momento|horario)\b/,
  /\botro\s+dia\s+mejor\b|\bmejor\s+otro\s+dia\b|\botra\s+fecha\b/,
  /\bmejor\s+(?:la|el)\s+(?:proxim[ao]|otr[ao])\s+semana\b/,
  /\bresched\w*|\banother\s+day\b/,
];

/** "no puedo hoy, pero mañana sí": a cancel that already names another day. */
const BUT_ANOTHER_DAY = new RegExp(`\\bpero\\b.*\\b(?:${DAY_WORD.slice(3, -1)}|otro|otra|proxim\\w*)\\b`);

/**
 * Pure. "cancel" / "reschedule" when the message calls off a booked trial,
 * else null. Reschedule wins when both read (the brain offers new options
 * either way; the Slack note words it differently).
 */
export function detectLeadCancel(text: string | null | undefined): LeadCancelIntent | null {
  const t = norm(text ?? "");
  if (!t) return null;
  if (HYPOTHETICAL.test(t)) return null;

  const reschedule = RESCHEDULE_PHRASES.some((re) => re.test(t));
  const cancelWord = CANCEL_WORD.test(t) && !MEMBERSHIP.test(t);
  const notArriving = NOT_ARRIVING.test(t) && !LATE.test(t) && !/\ba\s+tiempo\b/.test(t);
  const cancel = cancelWord || notArriving || CANCEL_PHRASES.some((re) => re.test(t));

  if (reschedule) return "reschedule";
  if (cancel) return BUT_ANOTHER_DAY.test(t) ? "reschedule" : "cancel";
  return null;
}

// ---- the kv marker: which trial(s) the lead called off ----

export function trialCancelledKey(phone: string): string {
  return `trial_cancelled:${phone}`;
}

export interface TrialCancelMarker {
  /** When the lead called it off (epoch seconds). */
  ts: number;
  intent: LeadCancelIntent;
  /** Trial epochs (class start) the cancelled rows were armed for. */
  trials: number[];
}

export function parseTrialCancelMarker(raw: string | null): TrialCancelMarker | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<TrialCancelMarker>;
    if (typeof o.ts !== "number") return null;
    return {
      ts: o.ts,
      intent: o.intent === "reschedule" ? "reschedule" : "cancel",
      trials: Array.isArray(o.trials) ? o.trials.filter((n): n is number => typeof n === "number") : [],
    };
  } catch {
    return null;
  }
}

/** Pure. The marker to store: this cancellation's trials merged with the
 *  previous marker's (a family's second row, an earlier cancel), last 10. */
export function mergeTrialCancelMarker(
  prev: TrialCancelMarker | null,
  next: TrialCancelMarker,
): TrialCancelMarker {
  const trials = [...new Set([...(prev?.trials ?? []), ...next.trials])].slice(-10);
  return { ts: next.ts, intent: next.intent, trials };
}

/** Pure. Did the lead call off the class that starts at `trialEpoch`? */
export function isCancelledTrial(raw: string | null, trialEpoch: number | null): boolean {
  if (trialEpoch === null) return false;
  const m = parseTrialCancelMarker(raw);
  return m !== null && m.trials.some((t) => Math.abs(t - trialEpoch) <= 60);
}

/** Pure. A cancellation this recent still steers the brain turn (debounce:
 *  the newest message of a burst may not be the one that cancelled). */
export const CANCEL_HINT_SECONDS = 10 * 60;

export function recentCancelIntent(raw: string | null, now: number): LeadCancelIntent | null {
  const m = parseTrialCancelMarker(raw);
  return m && now - m.ts <= CANCEL_HINT_SECONDS ? m.intent : null;
}

/** Pure. The #wa-leads task note: what happened, and what staff must do in Airtable. */
export function cancelTaskNote(opts: {
  who: string;
  intent: LeadCancelIntent;
  body: string;
  /** "el martes 13 a las 4:00 pm" — the class(es) called off, may be empty. */
  classes: string[];
  cancelledRows: number;
}): string {
  const what = opts.intent === "reschedule" ? "quiere reagendar" : "canceló";
  const cls = opts.classes.length ? ` su clase de prueba (${opts.classes.join(" / ")})` : " su clase de prueba";
  const quote = opts.body.length > 300 ? `${opts.body.slice(0, 300)}…` : opts.body;
  return (
    `🗓️ ${opts.who} ${what}${cls}: «${quote}»\n` +
    `Cancelé ${opts.cancelledRows} recordatorio(s) automático(s) de esa clase; la IA le ofrece reagendar. ` +
    `*En Airtable:* si reagenda con la IA se actualiza solo; si no, mueve o borra la fecha de prueba (o marca Reprogramó) — no lo marques «No asistió».`
  );
}
