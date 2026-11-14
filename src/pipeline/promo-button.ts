// Quick replies on promo templates that never reach the bot (2026-10-31).
// "Sí, quiero saber" on the Halloween promo: Evan quotes the promo himself, so
// the tap only alerts him. "No me interesa" on it: a baja. "Quiero
// inscribirme" on the Buen Fin 2026 promo: Evan + a #wa-leads task, one fixed
// ack to the lead, 48 h humans-only pause. Pure; the pipeline does the alert,
// the ack, the pause and the opt-out.

import type { InboundKind } from "../routes/webhook-parse.js";
import { normalizeText } from "./campaigns.js";
import { templateNameOf } from "../services/template-text.js";

type StoredLike = { direction: string; ts: number; body: string };

// One-tap opt-out quick reply (2026-11-05, after Meta flagged the account for
// spam): every marketing template carries a QUICK_REPLY button with one of
// these labels, and a tap on it is a baja whatever template it answers. Only
// `kind === "button"` taps count; the same words typed by hand keep going
// through the typed-text detector (opt-out.ts) unchanged.

/** Canonical Spanish label of the opt-out quick reply (template definitions use it). */
export const OPT_OUT_BUTTON_ES = "No recibir mensajes";
/** Canonical English label of the opt-out quick reply. */
export const OPT_OUT_BUTTON_EN = "Stop messages";

/** Template FOOTER that goes with the opt-out button (≤60 chars, Meta's limit). */
export const OPT_OUT_FOOTER = {
  es: `Toca «${OPT_OUT_BUTTON_ES}» para darte de baja.`,
  en: `Tap «${OPT_OUT_BUTTON_EN}» to unsubscribe.`,
} as const;

/** The QUICK_REPLY button a marketing template definition carries. */
export function optOutQuickReply(lang: "es" | "en"): { type: "QUICK_REPLY"; text: string } {
  return { type: "QUICK_REPLY", text: lang === "en" ? OPT_OUT_BUTTON_EN : OPT_OUT_BUTTON_ES };
}

/** Normalized (normalizeText) labels a template opt-out button may carry. */
export const OPT_OUT_BUTTON_LABELS: ReadonlySet<string> = new Set([
  "no recibir mensajes",
  "no recibir mas mensajes",
  "dejar de recibir mensajes",
  "stop promotions",
  "stop messages",
]);

/** True when this is a template quick-reply tap on an opt-out label (any template). */
export function isOptOutButtonLabel(kind: InboundKind | string | undefined, body: string): boolean {
  return kind === "button" && OPT_OUT_BUTTON_LABELS.has(normalizeText(body));
}

/** A promo template whose `handoff` quick reply a human answers (no brain turn). */
export interface PromoButton {
  template: string;
  /** normalizeText of the hand-off button label. */
  handoff: string;
  /** normalizeText of a promo-specific opt-out label (the generic
   *  OPT_OUT_BUTTON_LABELS count on every template anyway). */
  optOut?: string;
  /** Also open a #wa-leads task for the front desk (default: only Evan's
   *  #evan-alerts note). */
  teamTask?: boolean;
  /** What the lead wants, said in the Slack note. */
  note?: string;
  /** ONE short acknowledgement sent to the lead (default: nothing). */
  ack?: { es: string; en: string };
  /** Bot pause after the tap, in hours (default: the pipeline's 12 h). */
  pauseHours?: number;
  /** Package prices are humans-only for this lead: while the pause runs, a
   *  staff reply does NOT arm the 60-min "IA responde" override check. */
  humansOnly?: boolean;
  /** Emoji that leads the Slack note. */
  emoji?: string;
}

export const PROMO_BUTTONS: readonly PromoButton[] = [
  // Only Evan, no message to the lead, 12 h pause (2026-10-31).
  { template: "halloween_promo_prueba_oct26", handoff: "si quiero saber", optOut: "no me interesa", emoji: "🎃" },
  // Buen Fin 2026 blast (2026-11-14). Buttons: «Quiero mi día gratis» = normal
  // brain/booking flow; «Quiero inscribirme» = here; «No recibir mensajes» =
  // the generic opt-out label. Humans own package prices.
  {
    template: "buen_fin_2026_prueba_o_inscripcion",
    handoff: "quiero inscribirme",
    teamTask: true,
    note: "quiere inscribirse con la promo de Buen Fin",
    ack: {
      es: "¡Excelente! 🙌 En un momento te escribe alguien del equipo para dejar lista tu inscripción con la promo de Buen Fin.",
      en: "Great! 🙌 Someone from our team will message you shortly to get your enrollment with the Buen Fin promo ready.",
    },
    pauseHours: 48,
    humansOnly: true,
    emoji: "🛍️",
  },
];

/**
 * The promo row this tap answers, or null. The newest template we sent decides,
 * so the same words on another template, or typed by hand, keep the normal flow.
 * `recent` is in any order.
 */
function lastTemplate(recent: readonly StoredLike[]): StoredLike | null {
  return recent
    .filter((m) => m.direction !== "in" && templateNameOf(m.body) !== null)
    .reduce<StoredLike | null>((a, m) => (a && a.ts >= m.ts ? a : m), null);
}

function promoFor(
  kind: InboundKind | undefined,
  recent: readonly StoredLike[],
  rows: readonly PromoButton[] = PROMO_BUTTONS,
): PromoButton | null {
  if (kind !== "button") return null;
  const last = lastTemplate(recent);
  const name = last ? templateNameOf(last.body) : null;
  return rows.find((b) => b.template === name) ?? null;
}

/** The promo row whose "a human answers this" button was tapped, or null. */
export function handoffButtonFor(
  kind: InboundKind | undefined,
  body: string,
  recent: readonly StoredLike[],
  rows: readonly PromoButton[] = PROMO_BUTTONS,
): PromoButton | null {
  const row = promoFor(kind, recent, rows);
  return row && row.handoff === normalizeText(body) ? row : null;
}

/** The template whose "a human answers this" button was tapped, or null. */
export function handoffButtonTemplate(
  kind: InboundKind | undefined,
  body: string,
  recent: readonly StoredLike[],
): string | null {
  return handoffButtonFor(kind, body, recent)?.template ?? null;
}

/**
 * The humans-only promo row this chat is in, or null: the newest template we
 * sent is a `humansOnly` row AND the lead tapped its hand-off button after it
 * (the stored inbound body is the button text). `recent` is in any order.
 */
export function humansOnlyPromo(
  recent: readonly StoredLike[],
  rows: readonly PromoButton[] = PROMO_BUTTONS,
): PromoButton | null {
  const last = lastTemplate(recent);
  if (!last) return null;
  const row = rows.find((b) => b.humansOnly && b.template === templateNameOf(last.body));
  if (!row) return null;
  const tapped = recent.some((m) => m.direction === "in" && m.ts >= last.ts && normalizeText(m.body) === row.handoff);
  return tapped ? row : null;
}

/** The lead's acknowledgement for a hand-off tap, or null (row has none). */
export function handoffAckText(row: PromoButton, lang: string | null | undefined): string | null {
  if (!row.ack) return null;
  return lang === "en" ? row.ack.en : row.ack.es;
}

/** Pure. The Slack note for a hand-off tap (Evan's alert and, if set, the team task). */
export function handoffNoteText(
  row: PromoButton,
  a: { name: string | null; phone: string; body: string; url: string | null; acked: boolean; pauseHours: number },
): string {
  const who = `*${a.name ?? a.phone}* (${a.phone})`;
  const wants = row.note ? ` — *${row.note}*` : "";
  const bot = a.acked
    ? `El bot solo le avisó que alguien del equipo le escribe y queda en pausa ${a.pauseHours} h${row.humansOnly ? " (no cotiza paquetes)" : ""}; contéstale tú.`
    : "El bot no respondió; contéstale tú.";
  return (
    `${row.emoji ?? "📣"} ${who} tocó "${a.body}" en \`${row.template}\`${wants}. ${bot}` +
    (a.url ? `\n<${a.url}|💬 Abrir chat>` : "")
  );
}

/**
 * True when this tap is an opt-out button: a generic opt-out label on any
 * template (isOptOutButtonLabel), or a promo template's own opt-out button.
 */
export function isOptOutButton(
  kind: InboundKind | undefined,
  body: string,
  recent: readonly StoredLike[],
): boolean {
  if (isOptOutButtonLabel(kind, body)) return true;
  const row = promoFor(kind, recent);
  return row !== null && row.optOut !== undefined && row.optOut === normalizeText(body);
}
