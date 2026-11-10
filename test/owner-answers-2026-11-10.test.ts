// Owner answers 2026-11-10: private-class escalation (task + owner alert) and
// the Monday 2026-11-16 holiday whose special schedule is not decided yet
// (closedDates mode "tbd"). Fake clocks in America/Mexico_City.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEscalation,
  escalationAlertsOwner,
  escalationNeedsTask,
  privateClassAlertText,
} from "../src/services/slack-timeouts.js";
import { sendResult } from "../src/brain/claude.js";
import { closureLines } from "../src/brain/prompt.js";
import { validateSlot } from "../src/brain/tools.js";
import { nextBandSlot, nextTrialSlot, upcomingBandSlots } from "../src/cron/next-slot.js";
import { nudgeSlot } from "../src/cron/nudge-copy.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import { CLIENT } from "../src/client.gen.js";

// ---- 1. private classes ---------------------------------------------------

test("classifyEscalation: private-class reasons → private_class (complaint still wins)", () => {
  assert.equal(classifyEscalation("clase_privada: pregunta precio"), "private_class");
  assert.equal(classifyEscalation("Quiere clases privadas para su hijo"), "private_class");
  assert.equal(classifyEscalation("private class inquiry"), "private_class");
  assert.equal(classifyEscalation("clases particulares de box"), "private_class");
  assert.equal(classifyEscalation("one-on-one lessons"), "private_class");
  assert.equal(classifyEscalation("complaint: la clase privada fue mala"), "complaint");
  assert.equal(classifyEscalation("opt_out"), "opt_out");
  // Unrelated reasons are untouched.
  assert.equal(classifyEscalation("visitante, pregunta drop-in"), "visitor");
  assert.equal(classifyEscalation("price negotiation"), "price");
  assert.equal(classifyEscalation("privacidad de datos"), null);
});

test("private_class opens a #wa-leads task AND alerts the owner; other kinds do not alert", () => {
  assert.equal(escalationNeedsTask("private_class"), true);
  assert.equal(escalationAlertsOwner("private_class"), true);
  for (const k of ["complaint", "visitor", "nivel0", "special_needs", "price", "opt_out", null] as const) {
    assert.equal(escalationAlertsOwner(k), false, String(k));
  }
});

test("privateClassAlertText: names the phone, the reason and what the bot did", () => {
  const drafted = privateClassAlertText("5215511112222", "clase_privada: Muay Thai 1 a 1", true);
  assert.match(drafted, /^🥋 Clase privada — 5215511112222/);
  assert.match(drafted, /\(clase_privada: Muay Thai 1 a 1\)/);
  assert.match(drafted, /gerente de ventas/);
  assert.match(drafted, /#wa-leads/);
  assert.match(privateClassAlertText("521", "", false), /El bot NO le respondió nada/);
});

test("sendResult: a high-sureness private-class reply is a draft carrying its reason", () => {
  const tu = (reason: string, sureness = 95) => ({
    type: "tool_use" as const,
    id: "t",
    name: "send_reply",
    input: { message: "¡Claro! 🙌 Sí damos clases privadas.", language: "es", sureness, escalation_reason: reason, awaiting_reply: true },
  });
  const r = sendResult(tu("clase_privada: pidió precio"));
  assert.equal(r.action, "draft");
  assert.equal(r.action === "draft" ? r.reason : null, "clase_privada: pidió precio");
  assert.equal(sendResult(tu("quiere clases privadas")).action, "draft");
  // Other high-sureness replies are unchanged.
  assert.equal(sendResult(tu("")).action, "send");
  assert.equal(sendResult(tu("pregunta horario")).action, "send");
});

// ---- 2. Monday 2026-11-16: holiday schedule TBD ---------------------------

test("client config: the 2026-11-16 tbd row survives the compile-kb whitelist", () => {
  const row = (CLIENT.closedDates ?? []).find((c) => c.date === "2026-11-16");
  assert.ok(row, "2026-11-16 missing from client.gen.ts");
  assert.equal(row?.mode, "tbd");
});

const TBD = [{ date: "2026-11-16", reason: "lunes feriado", mode: "tbd" as const }];

test("closureLines: tbd day says 'por confirmar', never 'CERRADO', and only inside the horizon", () => {
  const near = closureLines("2026-11-10T12:00", TBD);
  assert.equal(near.length, 1);
  assert.match(near[0]!, /HORARIO ESPECIAL POR CONFIRMAR el 2026-11-16 \(lunes feriado\)/);
  assert.match(near[0]!, /NUNCA ofrezcas, agendes ni confirmes/);
  assert.match(near[0]!, /escala/);
  assert.doesNotMatch(near[0]!, /CERRADO/);
  assert.match(closureLines("2026-11-16T09:00", TBD)[0]!, /POR CONFIRMAR HOY 2026-11-16/);
  assert.deepEqual(closureLines("2026-11-17T09:00", TBD), []); // past
  assert.deepEqual(closureLines("2026-10-20T09:00", TBD), []); // > 14 days out
  // A plain closure keeps its old copy.
  assert.match(closureLines("2026-11-10T12:00", [{ date: "2026-11-16" }])[0]!, /^CERRADO el 2026-11-16/);
});

test("validateSlot: a regular Monday class on 2026-11-16 is rejected with the tbd message", () => {
  // Monday 19:00 Muay Thai exists on the grid (it validates the Monday after).
  assert.equal(validateSlot("2026-11-23", "19:00", "adult", "muay").ok, true);
  const r = validateSlot("2026-11-16", "19:00", "adult", "muay");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /SPECIAL holiday schedule that is not decided yet/);
  assert.match(r.reason ?? "", /escalate_to_human/);
  // Same through the explicit list.
  assert.equal(validateSlot("2026-11-16", "16:00", "kid", "muay", undefined, TBD).ok, false);
});

test("nudges and the brain's slot list skip 2026-11-16 (fake clock, CDMX)", () => {
  // Sunday 2026-11-15, 20:00 CDMX: the next class would normally be Monday 7 am.
  const sunNight = cdmxToEpoch(2026, 11, 15, 20, 0);
  const adult = nextTrialSlot(null, "adult", sunNight);
  assert.ok(adult);
  assert.equal(adult?.date, "2026-11-17");
  assert.equal(adult?.time, "07:00");

  const kids = nextBandSlot("kids", null, sunNight);
  assert.ok(kids);
  assert.equal(kids?.date, "2026-11-17");
  assert.equal(kids?.time, "16:00");

  const mini = nudgeSlot(null, "mini", sunNight);
  assert.ok(mini);
  assert.notEqual(mini?.date, "2026-11-16"); // Monday 3:15 pm Mini MT is skipped
  assert.equal(mini?.date, "2026-11-18");

  for (const band of ["adults", "kids", "teens", "mini", "baby"] as const) {
    const list = upcomingBandSlots(band, null, cdmxToEpoch(2026, 11, 13, 9, 0), 40);
    assert.ok(list.length > 0, band);
    assert.ok(!list.some((s) => s.date === "2026-11-16"), `${band} offered 2026-11-16`);
  }
  // Without the row the same clock DOES offer Monday — the exception is what skips it.
  assert.equal(nextTrialSlot(null, "adult", sunNight, undefined, [])?.date, "2026-11-16");
});

// ---- KB copy (items 3–9) ---------------------------------------------------

test("compiled KB: owner answers land, the retired facts are gone, editor notes stripped", async () => {
  const { readFileSync } = await import("node:fs");
  const kb = readFileSync("kb/compiled/kb.md", "utf8");
  const body = kb.replace(/^<!--[\s\S]*?-->\s*/, ""); // the compiler's own header
  assert.doesNotMatch(body, /<!--/, "intake.md editor notes leaked into the KB");
  assert.match(kb, /SÍ aceptamos WellHub/);
  assert.doesNotMatch(kb, /dio de alta sin nuestra autorización/);
  assert.doesNotMatch(kb, /\$600|\$400/, "drop-in prices must not be quoted");
  assert.match(kb, /drop-in NO se cotiza/);
  assert.match(kb, /clases de adultos 1 hora · Mini Muay Thai 45 min/);
  assert.match(kb, /si tienen el suyo, tráiganlo; si no, se lo prestamos/);
  assert.match(kb, /tampoco a las 10:30/);
  assert.match(kb, /fuera menos de 6 meses, NO pagan inscripción/);
  assert.match(kb, /Nivel 0 = 6 meses a 11 meses 30 días \(viernes 12 pm/);
  assert.match(CLIENT.persona, /Clases privadas: SÍ se venden/);
  assert.match(CLIENT.persona, /`clase_privada`/);
});
