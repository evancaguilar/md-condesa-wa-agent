// The persona's sureness calibration (2026-11-11): a doubt about FORM no longer
// drops a fully-backed reply below the 75 send line, while every factual box
// (price, schedule row, booking claims, escalation triggers) is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT } from "../src/client.gen.js";
import { decideAutoSend } from "../src/services/auto-send.js";

const P = CLIENT.persona;

test("persona: form-only doubts stay at 75+, the wait is ~15 min", () => {
  assert.ok(P.includes("- **75-85**: se cumplen todos los HECHOS y solo dudas de la forma"), "soft band moved up");
  assert.ok(!P.includes("- **60-75**"), "the old sub-75 soft band is gone");
  assert.ok(P.includes("25-74 ⇒ espera a un humano ~15 min"));
});

test("persona: factual boxes are untouched (price, row, booking, escalation, cupo)", () => {
  for (const s of [
    "3. **Precios**: no diste ningún precio, o solo una de las tres cifras aprobadas",
    "2. **Fila del horario**",
    "4. **Afirmaciones de agendado**",
    "6. **Sin disparador de escalación en el último mensaje del lead**",
    "8. **No es sobre cupo ni otra sede**",
    "- **25-50**: falla una casilla FACTUAL",
    "- **0-20**: estarías adivinando",
  ]) {
    assert.ok(P.includes(s), s);
  }
});

test("auto-send lane: a routine 78-sure reply sends; the booking-claim lock still holds", () => {
  const base = { action: "send", confidence: "high", dailyCount: 0, enabled: true };
  assert.equal(decideAutoSend({ ...base, sureness: 78, message: "Estamos en Av. México 49, 1er piso 📍 ¿Te queda bien?" }).auto, true);
  assert.equal(decideAutoSend({ ...base, sureness: 74, message: "Estamos en Av. México 49" }).blockedBy, "sureness");
  assert.equal(decideAutoSend({ ...base, sureness: 90, message: "¡Listo! Ya quedó agendada tu clase el lunes 7 pm" }).blockedBy, "booking_claim");
});
