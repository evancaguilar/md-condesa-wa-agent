// Quick replies on promo templates that never reach the bot (2026-10-31).
// "Sí, quiero saber" on the Halloween promo: Evan quotes the promo himself, so
// the tap only alerts him. "No me interesa" on it: a baja. Pure; the pipeline
// does the alert, the pause and the opt-out.

import type { InboundKind } from "../routes/webhook-parse.js";
import { normalizeText } from "./campaigns.js";
import { templateNameOf } from "../services/template-text.js";

type StoredLike = { direction: string; ts: number; body: string };

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

/** True when this tap is a promo template's opt-out button. */
export function isOptOutButton(
  kind: InboundKind | undefined,
  body: string,
  recent: readonly StoredLike[],
): boolean {
  const row = promoFor(kind, recent);
  return row !== null && row.optOut === normalizeText(body);
}
