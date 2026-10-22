// WhatsApp template review / lifecycle notices (2026-10-22, docs/slack-routing.md).
// Meta's `message_template_status_update` webhook (routes/webhook-parse.ts
// parseTemplateStatus) → ONE #evan-alerts post for a verdict Evan acts on
// (approved ⇒ the template can be used; rejected / paused / disabled / flagged
// ⇒ something must be fixed), everything else → ops_log only. Pure.

import type { TemplateStatusEvent } from "../routes/webhook-parse.js";

export interface TemplateStatusNotice {
  /** true ⇒ #evan-alerts (postAlert); false ⇒ ops_log only (postNote). */
  alert: boolean;
  text: string;
}

const ALERT_COPY: Record<string, { icon: string; verb: string }> = {
  APPROVED: { icon: "✅", verb: "APROBADA" },
  REJECTED: { icon: "❌", verb: "RECHAZADA" },
  PAUSED: { icon: "⏸️", verb: "PAUSADA" },
  DISABLED: { icon: "⛔", verb: "DESACTIVADA" },
  FLAGGED: { icon: "⚠️", verb: "MARCADA por baja calidad (se pausa si no mejora)" },
  REINSTATED: { icon: "✅", verb: "REACTIVADA" },
};

export function templateStatusNotice(ev: TemplateStatusEvent): TemplateStatusNotice {
  const who = `*${ev.name}*${ev.language ? ` (${ev.language})` : ""}`;
  const copy = ALERT_COPY[ev.event];
  const why = [ev.reason ? `motivo: ${ev.reason}` : "", ev.detail ?? ""].filter(Boolean).join(" · ");
  if (copy) {
    return { alert: true, text: `${copy.icon} Plantilla ${who} ${copy.verb} por Meta${why ? ` — ${why}` : ""}` };
  }
  // PENDING, IN_APPEAL, PENDING_DELETION, DELETED, ARCHIVED, LIMIT_EXCEEDED…:
  // not a verdict anyone acts on — kept in ops_log for the record.
  return { alert: false, text: `📝 Plantilla ${who}: estado ${ev.event} en Meta${why ? ` — ${why}` : ""}` };
}
