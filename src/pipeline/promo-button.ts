// Template quick replies that a human answers, never the bot (2026-10-31).
// "Sí, quiero saber" on the Halloween promo: Evan quotes the promo himself, so
// the tap only alerts him. Pure; the pipeline does the alert and the pause.

import type { InboundKind } from "../routes/webhook-parse.js";
import { normalizeText } from "./campaigns.js";
import { templateNameOf } from "../services/template-text.js";

const HANDOFF_BUTTONS: readonly { template: string; button: string }[] = [
  { template: "halloween_promo_prueba_oct26", button: "si quiero saber" },
];

/**
 * The template whose button this tap answers, or null. The newest template we
 * sent decides, so the same words on another template, or typed by hand, keep
 * the normal flow. `recent` is in any order.
 */
export function handoffButtonTemplate(
  kind: InboundKind | undefined,
  body: string,
  recent: readonly { direction: string; ts: number; body: string }[],
): string | null {
  if (kind !== "button") return null;
  const text = normalizeText(body);
  const last = recent
    .filter((m) => m.direction !== "in" && templateNameOf(m.body) !== null)
    .reduce<{ ts: number; body: string } | null>((a, m) => (a && a.ts >= m.ts ? a : m), null);
  const name = last ? templateNameOf(last.body) : null;
  return HANDOFF_BUTTONS.some((b) => b.template === name && b.button === text) ? name : null;
}
