// Quick replies on promo templates that never reach the bot (2026-10-31).
// "Sí, quiero saber" on the Halloween promo: Evan quotes the promo himself, so
// the tap only alerts him. "No me interesa" on it: a baja. Pure; the pipeline
// does the alert, the pause and the opt-out.

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

const PROMO_BUTTONS: readonly { template: string; handoff: string; optOut: string }[] = [
  { template: "halloween_promo_prueba_oct26", handoff: "si quiero saber", optOut: "no me interesa" },
];

/**
 * The promo row this tap answers, or null. The newest template we sent decides,
 * so the same words on another template, or typed by hand, keep the normal flow.
 * `recent` is in any order.
 */
function promoFor(kind: InboundKind | undefined, recent: readonly StoredLike[]) {
  if (kind !== "button") return null;
  const last = recent
    .filter((m) => m.direction !== "in" && templateNameOf(m.body) !== null)
    .reduce<StoredLike | null>((a, m) => (a && a.ts >= m.ts ? a : m), null);
  const name = last ? templateNameOf(last.body) : null;
  return PROMO_BUTTONS.find((b) => b.template === name) ?? null;
}

/** The template whose "a human answers this" button was tapped, or null. */
export function handoffButtonTemplate(
  kind: InboundKind | undefined,
  body: string,
  recent: readonly StoredLike[],
): string | null {
  const row = promoFor(kind, recent);
  return row && row.handoff === normalizeText(body) ? row.template : null;
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
  return row !== null && row.optOut === normalizeText(body);
}
