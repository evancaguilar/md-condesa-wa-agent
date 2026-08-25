import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimsBooking,
  parseBookingHints,
} from "../src/services/booking-claims.js";

// ---- positives: confirmed bookings -----------------------------------------

test("claimsBooking: 'ya quedó agendado' matches", () => {
  assert.equal(claimsBooking("¡Perfecto! Ya quedó agendado 🙌"), true);
});

test("claimsBooking: 'Ya quedaste apartado' matches", () => {
  assert.equal(claimsBooking("Ya quedaste apartado para el sábado."), true);
});

test("claimsBooking: 'te esperamos mañana a las 7 pm' matches", () => {
  assert.equal(claimsBooking("Te esperamos mañana a las 7 pm en el tapete."), true);
});

test("claimsBooking: 'nos vemos el sábado 11 am' matches", () => {
  assert.equal(claimsBooking("Nos vemos el sábado 11 am"), true);
});

test("claimsBooking: 'tu clase quedó reservada' matches", () => {
  assert.equal(claimsBooking("Tu clase quedó reservada, nos vemos pronto."), true);
});

test("claimsBooking: 'you're booked' matches", () => {
  assert.equal(claimsBooking("All set — you're booked for Saturday."), true);
});

test("claimsBooking: 'te espero mañana a la 1 pm' matches (singular)", () => {
  assert.equal(claimsBooking("Te espero mañana a la 1 pm, no faltes."), true);
});

test("claimsBooking: 'Está confirmado tu lugar' matches", () => {
  assert.equal(claimsBooking("Está confirmado tu lugar para la clase muestra."), true);
});

test("claimsBooking: 'quedó apartado tu lugar' matches", () => {
  assert.equal(claimsBooking("Quedó apartado tu lugar para el miércoles."), true);
});

// ---- negatives: offers / questions / vague pleasantries --------------------

test("claimsBooking: '¿te agendo?' does NOT match", () => {
  assert.equal(claimsBooking("¿Te agendo para el sábado?"), false);
});

test("claimsBooking: 'puedo agendarte' does NOT match", () => {
  assert.equal(claimsBooking("Puedo agendarte el sábado a las 11."), false);
});

test("claimsBooking: '¿quieres agendar tu clase?' does NOT match", () => {
  assert.equal(claimsBooking("¿Quieres agendar tu clase muestra?"), false);
});

test("claimsBooking: '¿nos vemos mañana?' does NOT match (question)", () => {
  assert.equal(claimsBooking("¿Nos vemos mañana?"), false);
});

test("claimsBooking: 'para agendar entra aquí' does NOT match", () => {
  assert.equal(claimsBooking("Para agendar entra aquí: mdcondesa.com/agenda"), false);
});

test("claimsBooking: 'todavía no has agendado' does NOT match (nudge copy)", () => {
  assert.equal(claimsBooking("Todavía no has agendado tu clase muestra."), false);
});

test("claimsBooking: 'te esperamos pronto' does NOT match (no time/day)", () => {
  assert.equal(claimsBooking("Gracias por escribir, te esperamos pronto."), false);
});

test("claimsBooking: '¿confirmado?' does NOT match (question)", () => {
  assert.equal(claimsBooking("¿Confirmado?"), false);
});

// ---- documented borderline case --------------------------------------------

test("claimsBooking: 'una vez agendado te mando la info' MAY match (accepted false positive; the bare 'agendad…' alternative can't distinguish this conditional phrasing from a real claim — booking-recon-core.ts's nudge-phrase filter is the real backstop for these)", () => {
  assert.equal(claimsBooking("Una vez agendado te mando la info de la clase."), true);
});

// ---- parseBookingHints ------------------------------------------------------
// Fake clock: Monday 2026-08-24, 09:00 CDMX (weekday index 0 = Monday).

const MON = "2026-08-24T09:00";
const MON_IDX = 0;

function hints(text: string) {
  return parseBookingHints(text, MON, MON_IDX);
}

test("parseBookingHints: 'mañana a las 7 pm' → next day 19:00", () => {
  const h = hints("Listo, te esperamos mañana a las 7 pm 🙌");
  assert.equal(h.trialDate, "2026-08-25");
  assert.equal(h.trialTime, "19:00");
});

test("parseBookingHints: 'el sábado a las 2 pm' → the coming Saturday, 14:00", () => {
  const h = hints("Ya quedó agendado, nos vemos el sábado a las 2 pm.");
  assert.equal(h.trialDate, "2026-08-29");
  assert.equal(h.trialTime, "14:00");
});

test("parseBookingHints: 'hoy 11 am' → today 11:00", () => {
  const h = hints("Confirmado, te esperamos hoy 11 am.");
  assert.equal(h.trialDate, "2026-08-24");
  assert.equal(h.trialTime, "11:00");
});

test("parseBookingHints: 'pasado mañana a las 19:00' → +2 days, 24h time kept", () => {
  const h = hints("Quedó agendado pasado mañana a las 19:00.");
  assert.equal(h.trialDate, "2026-08-26");
  assert.equal(h.trialTime, "19:00");
});

test("parseBookingHints: a weekday that IS today resolves to NEXT week", () => {
  const h = hints("Nos vemos el lunes a las 7.");
  assert.equal(h.trialDate, "2026-08-31"); // not today's Monday
  assert.equal(h.trialTime, "19:00"); // bare "a las 7" ⇒ evening
});

test("parseBookingHints: 'hoy lunes' keeps the same-day Monday", () => {
  const h = hints("Confirmado: hoy lunes a las 10 am.");
  assert.equal(h.trialDate, "2026-08-24");
  assert.equal(h.trialTime, "10:00");
});

test("parseBookingHints: '3:15 pm' → 15:15, discipline read from the copy", () => {
  const h = hints("Te esperamos mañana a las 3:15 pm para Muay Thai 🙌");
  assert.equal(h.trialTime, "15:15");
  assert.equal(h.discipline, "muay");
  assert.equal(h.trialDate, "2026-08-25");
  assert.equal(h.confidence, "full");
});

test("parseBookingHints: 'jiu-jitsu el viernes a las 19:00' is full confidence", () => {
  const h = hints("Confirmado para jiu-jitsu el viernes a las 19:00.");
  assert.equal(h.discipline, "jiu");
  assert.equal(h.trialDate, "2026-08-28");
  assert.equal(h.trialTime, "19:00");
  assert.equal(h.confidence, "full");
});

test("parseBookingHints: Baby Fight Club + child word ⇒ baby/kid + child name", () => {
  const h = hints(
    "Ya quedó agendado Baby Fight Club el sábado a las 2 pm para tu bebé Sofía.",
  );
  assert.equal(h.discipline, "baby");
  assert.equal(h.audience, "kid");
  assert.equal(h.childName, "Sofía");
  assert.equal(h.trialDate, "2026-08-29");
  assert.equal(h.trialTime, "14:00");
});

test("parseBookingHints: 'mini muay thai' maps to muay + kid", () => {
  const h = hints("Quedó agendado mini muay thai el miércoles a las 4 pm.");
  assert.equal(h.discipline, "muay");
  assert.equal(h.audience, "kid");
  assert.equal(h.trialDate, "2026-08-26");
  assert.equal(h.trialTime, "16:00");
});

test("parseBookingHints: 'en la mañana' is a time of day, and still means tomorrow", () => {
  const h = hints("Te esperamos mañana en la mañana.");
  assert.equal(h.trialDate, "2026-08-25");
  assert.equal(h.trialTime, undefined);
  assert.equal(h.confidence, "partial");
});

test("parseBookingHints: nothing concrete ⇒ confidence 'none'", () => {
  const h = hints("¡Perfecto! Ya quedó agendado 🙌");
  assert.equal(h.confidence, "none");
  assert.equal(h.trialDate, undefined);
  assert.equal(h.trialTime, undefined);
  assert.equal(h.discipline, undefined);
});
