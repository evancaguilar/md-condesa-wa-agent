// Meta `message_template_status_update` webhook → parser (routes/webhook-parse.ts)
// and the #evan-alerts / ops_log notice copy (services/template-status.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTemplateStatus, parseWebhook, type TemplateStatusEvent } from "../src/routes/webhook-parse.js";
import { templateStatusNotice } from "../src/services/template-status.js";

function envelope(value: unknown, field = "message_template_status_update"): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA1", time: 1761100000, changes: [{ field, value }] }],
  };
}

test("parseWebhook: a template status change yields ONE template_status event and nothing else", () => {
  const events = parseWebhook(
    envelope({
      event: "APPROVED",
      message_template_id: 1234567890123456,
      message_template_name: "student_qr_es",
      message_template_language: "es_MX",
      reason: "NONE",
    }),
  );
  assert.deepEqual(events, [
    {
      type: "template_status",
      event: "APPROVED",
      templateId: "1234567890123456",
      name: "student_qr_es",
      language: "es_MX",
      reason: null,
      detail: null,
    },
  ]);
  // No inbound / status events leak out of it (the inbound pipeline never sees it).
  assert.ok(events.every((e) => e.type === "template_status"));
});

test("parseTemplateStatus: rejection reason, other_info detail, lower-case event, junk", () => {
  const rej = parseTemplateStatus({
    event: "rejected",
    message_template_id: "99",
    message_template_name: "nivel0_anuncio",
    message_template_language: "es",
    reason: "INVALID_FORMAT",
  });
  assert.equal(rej?.event, "REJECTED");
  assert.equal(rej?.reason, "INVALID_FORMAT");
  assert.equal(rej?.templateId, "99");

  const paused = parseTemplateStatus({
    event: "PAUSED",
    message_template_name: "reengage_lead",
    message_template_language: "es_MX",
    reason: null,
    other_info: { title: "FIRST_PAUSE", description: "Calidad baja por reportes de usuarios." },
  });
  assert.equal(paused?.templateId, null);
  assert.equal(paused?.reason, null);
  assert.equal(paused?.detail, "FIRST_PAUSE — Calidad baja por reportes de usuarios.");

  assert.equal(parseTemplateStatus(null), null);
  assert.equal(parseTemplateStatus({ event: "APPROVED" }), null); // no name
  assert.equal(parseTemplateStatus({ message_template_name: "x" }), null); // no event
  assert.deepEqual(parseWebhook(envelope({ foo: 1 })), []);
});

function ev(over: Partial<TemplateStatusEvent>): TemplateStatusEvent {
  return {
    type: "template_status",
    event: "APPROVED",
    templateId: "1",
    name: "student_qr_es",
    language: "es_MX",
    reason: null,
    detail: null,
    ...over,
  };
}

test("templateStatusNotice: verdicts alert in Spanish, with the reason when there is one", () => {
  assert.deepEqual(templateStatusNotice(ev({})), {
    alert: true,
    text: "✅ Plantilla *student_qr_es* (es_MX) APROBADA por Meta",
  });
  assert.deepEqual(templateStatusNotice(ev({ event: "REJECTED", reason: "INVALID_FORMAT" })), {
    alert: true,
    text: "❌ Plantilla *student_qr_es* (es_MX) RECHAZADA por Meta — motivo: INVALID_FORMAT",
  });
  const paused = templateStatusNotice(ev({ event: "PAUSED", detail: "FIRST_PAUSE — Calidad baja" }));
  assert.equal(paused.alert, true);
  assert.match(paused.text, /^⏸️ Plantilla \*student_qr_es\* \(es_MX\) PAUSADA por Meta — FIRST_PAUSE — Calidad baja$/);
  assert.match(templateStatusNotice(ev({ event: "DISABLED" })).text, /DESACTIVADA/);
  assert.equal(templateStatusNotice(ev({ event: "FLAGGED" })).alert, true);
  assert.match(templateStatusNotice(ev({ event: "REINSTATED", language: null })).text, /^✅ Plantilla \*student_qr_es\* REACTIVADA/);
});

test("templateStatusNotice: pending / lifecycle noise is ops_log only", () => {
  for (const event of ["PENDING", "IN_APPEAL", "PENDING_DELETION", "DELETED", "ARCHIVED", "SOMETHING_NEW"]) {
    const n = templateStatusNotice(ev({ event }));
    assert.equal(n.alert, false, event);
    assert.match(n.text, new RegExp(`estado ${event} en Meta`));
  }
});
