import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findUnbackedConfirmations,
  type ReconBooking,
  type ReconSend,
} from "../src/cron/booking-recon-core.js";

const NOW = 1_800_000_000; // arbitrary fixed "now" epoch seconds
const DAY = 24 * 3600;

test("booking-recon: unbacked confirmation is flagged", () => {
  const sends: ReconSend[] = [
    { phone: "5215512345678", ts: NOW - DAY, body: "¡Perfecto! Ya quedó agendado, nos vemos pronto." },
  ];
  const bookings: ReconBooking[] = [];
  const mismatches = findUnbackedConfirmations(sends, bookings, NOW);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].phone, "5215512345678");
  assert.equal(mismatches[0].ts, NOW - DAY);
  assert.ok(mismatches[0].snippet.startsWith("¡Perfecto! Ya quedó agendado"));
});

test("booking-recon: booking backs the claim via +52/521/(55)-formatted phones (last-10-digit match)", () => {
  const sendTs = NOW - DAY;
  const cases: Array<[sendPhone: string, bookingPhone: string]> = [
    ["5215512345678", "+52 55 1234 5678"],
    ["5215512345678", "521 55 1234 5678"],
    ["5215512345678", "(55) 1234-5678"],
  ];
  for (const [sendPhone, bookingPhone] of cases) {
    const sends: ReconSend[] = [
      { phone: sendPhone, ts: sendTs, body: "Te esperamos mañana a las 7 pm, ya quedó agendado." },
    ];
    const bookings: ReconBooking[] = [
      {
        phone: bookingPhone,
        trialDateTimeIso: new Date((sendTs + 2 * DAY) * 1000).toISOString(),
      },
    ];
    const mismatches = findUnbackedConfirmations(sends, bookings, NOW);
    assert.equal(mismatches.length, 0, `expected phone ${bookingPhone} to back the claim`);
  }
});

test("booking-recon: booking 20 days out is NOT backed (outside the +14d window)", () => {
  const sendTs = NOW - DAY;
  const sends: ReconSend[] = [
    { phone: "5215512345678", ts: sendTs, body: "Ya quedó agendado, nos vemos pronto." },
  ];
  const bookings: ReconBooking[] = [
    {
      phone: "5215512345678",
      trialDateTimeIso: new Date((sendTs + 20 * DAY) * 1000).toISOString(),
    },
  ];
  const mismatches = findUnbackedConfirmations(sends, bookings, NOW);
  assert.equal(mismatches.length, 1);
});

test("booking-recon: nudge body ('todavía no has agendado') is excluded entirely", () => {
  const sends: ReconSend[] = [
    { phone: "5215512345678", ts: NOW - DAY, body: "Todavía no has agendado tu clase muestra, ¿la agendamos?" },
  ];
  const mismatches = findUnbackedConfirmations(sends, [], NOW);
  assert.equal(mismatches.length, 0);
});

test("booking-recon: multiple claims for the same phone collapse into one mismatch with the latest ts", () => {
  const sends: ReconSend[] = [
    { phone: "5215512345678", ts: NOW - 3 * DAY, body: "Ya quedó agendado para el lunes." },
    { phone: "5215512345678", ts: NOW - DAY, body: "Confirmado, nos vemos el sábado 11 am." },
    { phone: "5215512345678", ts: NOW - 2 * DAY, body: "Recordatorio: ya quedó agendado." },
  ];
  const mismatches = findUnbackedConfirmations(sends, [], NOW);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].ts, NOW - DAY);
  assert.ok(mismatches[0].snippet.includes("nos vemos el sábado"));
});

test("booking-recon: a backed claim within the -7d..+14d window produces no mismatch", () => {
  const sendTs = NOW - DAY;
  const sends: ReconSend[] = [
    { phone: "5215512345678", ts: sendTs, body: "Ya quedó agendado, te esperamos mañana a las 5 pm." },
  ];
  const bookings: ReconBooking[] = [
    { phone: "5215512345678", trialDateTimeIso: new Date((sendTs + DAY) * 1000).toISOString() },
  ];
  assert.equal(findUnbackedConfirmations(sends, bookings, NOW).length, 0);
});

test("booking-recon: sends that don't claim a booking are ignored", () => {
  const sends: ReconSend[] = [
    { phone: "5215512345678", ts: NOW - DAY, body: "¿Te gustaría agendar tu clase muestra?" },
  ];
  assert.equal(findUnbackedConfirmations(sends, [], NOW).length, 0);
});
