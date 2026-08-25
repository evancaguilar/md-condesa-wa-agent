import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsBooking } from "../src/services/booking-claims.js";

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
