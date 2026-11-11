// Conversation-quality fixes from grading 475 real conversations
// (2026-11-04 → 11-11). Fake clocks, America/Mexico_City dates.
// 2026-11-05 = jueves, 11-07 = sábado, 11-10 = martes, 11-14 = sábado,
// 11-16 = lunes, 11-17 = martes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarLine,
  confirmationDateIssues,
  findDateRefs,
  leadRequestedDate,
  statedDate,
  statedDateLine,
  withDayOfMonth,
} from "../src/brain/stated-date.js";
import { capacityClaim, comboClaimIssues, comboStartsAt, dayCombos } from "../src/brain/fact-guards.js";
import {
  bookResult,
  bookingDateError,
  guardBookingDateClaim,
  guardFactClaims,
  handleBookTrial,
  type PendingBooking,
} from "../src/brain/claude.js";
import { buildContextBlock, combosLine, dateLines } from "../src/brain/prompt.js";
import { TOOLS } from "../src/brain/tools.js";
import type { AirtablePort, BookTrialInput, BrainResult, Contact, ConvoContext, StoredMessage } from "../src/types.js";

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215512345678", name: "Ana", lang: "es", status: "lead", qualification: null,
    human_override_until: null, last_inbound_at: null, campaign_id: null, ad_ref: null,
    airtable_lead_id: null, created_at: 0, updated_at: 0, ...over,
  };
}

let seq = 0;
function msg(direction: "in" | "out", body: string): StoredMessage {
  seq++;
  return { wamid: `w${seq}`, phone: "5215512345678", direction: direction === "in" ? "in" : "out_bot", body, ts: 1_700_000_000 + seq, meta: null };
}

function ctxAt(nowCdmx: string, history: StoredMessage[], over: Partial<ConvoContext> = {}): ConvoContext {
  return {
    phone: "5215512345678",
    contact: contact(),
    history,
    nowCdmx,
    weekday: "",
    windowOpen: true,
    trainingWheels: true,
    ...over,
  };
}

// ---- 1. the date the lead pinned ------------------------------------------

test("statedDate: a day of the month beats the nearest weekday (A220, A51, A113, A174)", () => {
  assert.deepEqual(statedDate("Tendría que ser el Sábado 14", "2026-11-05"), { kind: "date", ymd: "2026-11-14", text: "sabado 14" });
  assert.equal((statedDate("La registre para el sábado 14", "2026-11-06") as { ymd: string }).ymd, "2026-11-14");
  assert.equal((statedDate("Podría ser proximo lunes 16", "2026-11-07") as { ymd: string }).ymd, "2026-11-16");
  assert.equal((statedDate("Sería el 16 por favor", "2026-11-07") as { ymd: string }).ymd, "2026-11-16");
  assert.equal((statedDate("Sábado 21", "2026-11-10") as { ymd: string }).ymd, "2026-11-21");
  assert.equal((statedDate("Podría ser para el próximo sábado? 14/11?", "2026-11-05") as { ymd: string }).ymd, "2026-11-14");
  assert.equal((statedDate("el 14 de noviembre", "2026-11-05") as { ymd: string }).ymd, "2026-11-14");
  // next month
  assert.equal((statedDate("el martes 1", "2026-11-25") as { ymd: string }).ymd, "2026-12-01");
});

test("statedDate: next week / el otro sábado", () => {
  // Wed 11 → next week's Saturday is the 21st; "el otro sábado" too.
  assert.equal((statedDate("el sábado de la próxima semana", "2026-11-11") as { ymd: string }).ymd, "2026-11-21");
  assert.equal((statedDate("la otra semana el sábado", "2026-11-11") as { ymd: string }).ymd, "2026-11-21");
  assert.equal((statedDate("mejor el otro sábado", "2026-11-11") as { ymd: string }).ymd, "2026-11-21");
  assert.deepEqual(statedDate("para la próxima semana", "2026-11-11"), {
    kind: "week", start: "2026-11-16", end: "2026-11-22", text: "la proxima semana",
  });
});

test("statedDate: weekday + day that disagree is a mismatch (A55: «sábado 17» = a Tuesday)", () => {
  const s = statedDate("el sábado 17 por favor", "2026-11-06");
  assert.equal(s?.kind, "mismatch");
});

test("statedDate: hours, ages, habits and plain weekdays are not pinned dates", () => {
  for (const t of [
    "el sábado a las 10",
    "sábado 10 am",
    "el sábado 10", // 10 am — the 10th is not a Saturday
    "mañana a las 7",
    "hoy en la tarde",
    "los sábados nada más",
    "tiene 5 años y su hermano 7",
    "mañana en la mañana",
    "el 14 no puedo, ¿el 21?",
  ]) {
    assert.equal(statedDate(t, "2026-11-11"), null, t);
  }
});

test("findDateRefs: «de la mañana» is a time of day, «pasado mañana» is +2", () => {
  assert.deepEqual(findDateRefs("a las 7 de la mañana", "2026-11-11"), []);
  assert.deepEqual(findDateRefs("pasado mañana", "2026-11-11").map((r) => r.ymd), ["2026-11-13"]);
});

test("leadRequestedDate: the lead's trailing run, else our accepted offer (A44)", () => {
  const h = [msg("in", "Hola"), msg("out", "¡Va! Te aparto el martes 17 a las 6 pm. ¿Me confirmas tu nombre?"), msg("in", "Sí, Karla")];
  const r = leadRequestedDate(h, "2026-11-10");
  assert.equal(r?.kind === "date" && r.ymd, "2026-11-17");
  assert.equal(r?.source, "accepted_offer");
  // the lead said "mañana" — their own (weak) date wins: no expectation
  assert.equal(leadRequestedDate([...h.slice(0, 2), msg("in", "mejor mañana")], "2026-11-10"), null);
  // nothing after our message yet
  assert.equal(leadRequestedDate(h.slice(0, 2), "2026-11-10"), null);
});

test("calendarLine: weekday + day for 14 days, month on day 1", () => {
  const l = calendarLine("2026-11-25");
  assert.match(l, /^calendario \(próximos 14 días\): hoy mié 25 nov · jue 26 · /);
  assert.match(l, / · mar 1 dic · /);
});

test("statedDateLine / dateLines: the context names the pinned date and that day's options", () => {
  const h = [msg("in", "Tendría que ser el Sábado 14")];
  const line = statedDateLine(h, "2026-11-05", () => ["9:00 am Jiu-Jitsu"]);
  assert.match(line!, /2026-11-14/);
  assert.match(line!, /sábado 14 de noviembre/);
  assert.match(line!, /9:00 am Jiu-Jitsu/);
  const ctx = ctxAt("2026-11-05T16:40", h, {
    contact: contact({ qualification: JSON.stringify({ child_age_months: 48 }) }),
  });
  const lines = dateLines(ctx);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /Mini Muay Thai/, "Mini band: Saturday 1:15 pm");
  const block = buildContextBlock(ctx);
  assert.match(block, /calendario \(próximos 14 días\): hoy jue 5 nov/);
  assert.match(block, /fecha que el lead pidió: «sabado 14» = sábado 14 de noviembre/);
});

// ---- 1b. book_trial refuses the wrong date ---------------------------------

test("bookingDateError: weekday must match the calendar", () => {
  const ctx = ctxAt("2026-11-06T10:00", [msg("in", "va")]);
  assert.match(bookingDateError(ctx, "2026-11-17", "sab")!, /2026-11-17 is a martes, not a sábado/);
  assert.equal(bookingDateError(ctx, "2026-11-14", "sab"), null);
  assert.equal(bookingDateError(ctx, "2026-11-14", undefined), null);
});

test("bookingDateError: the lead's «sábado 14» refuses the nearest Saturday (A220)", () => {
  const ctx = ctxAt("2026-11-05T16:40", [msg("out", "¿Les queda el sábado?"), msg("in", "Tendría que ser el Sábado 14")]);
  assert.match(bookingDateError(ctx, "2026-11-07", "sab")!, /2026-11-14/);
  assert.equal(bookingDateError(ctx, "2026-11-14", "sab"), null);
  // A44: accepted offer "martes 17", the model booked today
  const a44 = ctxAt("2026-11-10T12:00", [msg("out", "Te aparto el martes 17 a las 6 pm. ¿Tu nombre?"), msg("in", "Karla")]);
  assert.match(bookingDateError(a44, "2026-11-10", "mar")!, /accepted our offer/);
  // next week asked, this week booked (A174)
  const a174 = ctxAt("2026-11-10T12:00", [msg("in", "mejor la próxima semana")]);
  assert.match(bookingDateError(a174, "2026-11-14", "sab")!, /outside that week/);
  assert.equal(bookingDateError(a174, "2026-11-21", "sab"), null);
  // «sábado 17» (a Tuesday): ask first
  const a55 = ctxAt("2026-11-06T10:00", [msg("in", "el sábado 17")]);
  assert.match(bookingDateError(a55, "2026-11-14", "sab")!, /ask the lead which date/);
});

const okAirtable: AirtablePort = {
  bookTrial: async () => "recNEW",
} as unknown as AirtablePort;

function bookCall(input: Record<string, unknown>) {
  return { type: "tool_use" as const, id: "b1", name: "book_trial", input };
}

test("handleBookTrial: refuses once, a second call with the same date books with a warning", async () => {
  const ctx = ctxAt("2026-11-05T16:40", [msg("in", "Tendría que ser el Sábado 14 a las 9")]);
  const call = bookCall({
    name: "Ana", discipline: "jiu", audience: "adult", trial_date: "2026-11-07", trial_weekday: "sab",
    trial_time: "09:00", followup_message: "Listo Ana, te esperamos el sábado a las 9 am.",
  });
  const refused = new Set<string>();
  const first = await handleBookTrial(okAirtable, ctx, call, undefined, refused);
  assert.equal(first.result.is_error, true);
  assert.equal(first.booking, undefined);
  const second = await handleBookTrial(okAirtable, ctx, call, undefined, refused);
  assert.equal(second.booking?.recordId, "recNEW");
  assert.match(second.booking!.dateWarning!, /⚠️ Fecha/);
  // the weekday mismatch never gets the override
  const wrongWd = bookCall({ ...call.input, trial_date: "2026-11-14", trial_weekday: "mar" });
  const r1 = await handleBookTrial(okAirtable, ctx, wrongWd, undefined, refused);
  const r2 = await handleBookTrial(okAirtable, ctx, wrongWd, undefined, refused);
  assert.equal(r1.result.is_error, true);
  assert.equal(r2.result.is_error, true);
  // the right date books straight away
  const right = await handleBookTrial(okAirtable, ctx, bookCall({ ...call.input, trial_date: "2026-11-14" }), undefined, new Set());
  assert.equal(right.booking?.dateWarning, undefined);
});

test("book_trial schema asks for trial_weekday", () => {
  const bt = TOOLS.find((t) => t.name === "book_trial")!;
  assert.ok(bt.input_schema.required.includes("trial_weekday"));
});

// ---- 1c. the confirmation text vs the booked record ------------------------

test("confirmationDateIssues: regression cases", () => {
  // A44: booked Tue 17, confirmation says "hoy"
  assert.equal(confirmationDateIssues("Los esperamos hoy a las 6 pm", ["2026-11-17"], "2026-11-10").length, 1);
  // A220: booked Sat 14, confirmation says "sábado 7"
  assert.equal(confirmationDateIssues("Ya quedaron sus lugares para el sábado 7: tú a las 10 am", ["2026-11-14"], "2026-11-05").length, 1);
  // A55: "sábado 17 de noviembre" is a Tuesday
  assert.match(confirmationDateIssues("Te aparto el sábado 17 de noviembre a las 2 pm", ["2026-11-14"], "2026-11-06")[0]!, /el 17 es martes/);
  // A205: "mañana" on Thursday for a Saturday class
  assert.equal(confirmationDateIssues("Nos vemos mañana a las 9 am!", ["2026-11-07"], "2026-11-05").length, 1);
  // bare weekday, booked two weeks out
  assert.match(confirmationDateIssues("Te esperamos el sábado a las 2 pm", ["2026-11-14"], "2026-11-05")[0]!, /sin el número de día/);
  // correct ones
  assert.deepEqual(confirmationDateIssues("Nos vemos el sábado 14 a las 2 pm", ["2026-11-14"], "2026-11-05"), []);
  assert.deepEqual(confirmationDateIssues("Te esperamos mañana a las 7 pm", ["2026-11-06"], "2026-11-05"), []);
  assert.deepEqual(confirmationDateIssues("Los esperamos el sábado, 14 de noviembre", ["2026-11-14"], "2026-11-05"), []);
  // no day at all for a class 2+ days out
  assert.equal(confirmationDateIssues("¡Listo, quedó agendado!", ["2026-11-14"], "2026-11-05", { requireDay: true }).length, 1);
  assert.deepEqual(confirmationDateIssues("¡Listo, quedó agendado!", ["2026-11-06"], "2026-11-05", { requireDay: true }), []);
});

test("withDayOfMonth: adds the day after the booked weekday, first mention only", () => {
  assert.equal(
    withDayOfMonth("Los esperamos el Sábado a las 2 pm. El sábado traigan agua.", "2026-11-14", "2026-11-05"),
    "Los esperamos el Sábado 14 a las 2 pm. El sábado traigan agua.",
  );
  assert.equal(withDayOfMonth("el miércoles a la 1 pm", "2026-11-18", "2026-11-11"), "el miércoles 18 a la 1 pm");
  assert.equal(withDayOfMonth("el sábado 14 a las 2", "2026-11-14", "2026-11-05"), "el sábado 14 a las 2");
  assert.equal(withDayOfMonth("mañana a las 7", "2026-11-06", "2026-11-05"), "mañana a las 7", "tomorrow: untouched");
  assert.equal(withDayOfMonth("el lunes a las 4", "2026-11-14", "2026-11-05"), "el lunes a las 4", "other weekday: untouched");
});

const sendReply = (input: Record<string, unknown>) => ({ type: "tool_use" as const, id: "s1", name: "send_reply", input });
const bk = (over: Partial<BookTrialInput>, message: string, extra: Partial<PendingBooking> = {}): PendingBooking => ({
  input: { name: "Ana", discipline: "jiu", audience: "adult", trialDate: "2026-11-14", trialTime: "09:00", phone: "5215512345678", ...over },
  followupMessage: message,
  recordId: "recA",
  ...extra,
});

test("bookResult: a wrong-date confirmation carries a ⚠️ warning (never auto-sends); the bare weekday gets its number", () => {
  const ctx = { nowCdmx: "2026-11-05T16:40", contact: contact() };
  const wrong = bookResult([bk({}, "Listo Ana, te esperamos mañana a las 9 am 🙌")], ctx, sendReply({ sureness: 90 }));
  assert.ok(wrong.action === "book" && /⚠️ Fecha de la confirmación/.test(wrong.confirmationWarning ?? ""));
  const fixed = bookResult([bk({}, "Listo Ana, te esperamos el sábado a las 9 am 🙌")], ctx, sendReply({ sureness: 90 }));
  assert.equal(fixed.action === "book" && fixed.followupMessage, "Listo Ana, te esperamos el sábado 14 a las 9 am 🙌");
  assert.equal(fixed.action === "book" && fixed.confirmationWarning, undefined);
  const insisted = bookResult([bk({}, "Listo Ana, el sábado 14 a las 9 am", { dateWarning: "⚠️ Fecha: x" })], ctx, sendReply({ sureness: 90 }));
  assert.ok(insisted.action === "book" && /⚠️ Fecha: x/.test(insisted.confirmationWarning ?? ""));
});

test("guardBookingDateClaim: «mañana» for a recorded Saturday booking becomes a draft (A205, A51)", () => {
  const send: BrainResult = { action: "send", message: "¡Perfecto! Nos vemos mañana a las 9 am 🙌", language: "es", confidence: "high", sureness: 90 };
  const ctx = { nowCdmx: "2026-11-05T12:00", recordedBooking: { ts: 1, trialDate: "2026-11-07", trialTime: "09:00" } };
  const r = guardBookingDateClaim(send, ctx);
  assert.equal(r.action, "draft");
  assert.ok(r.action === "draft" && /⚠️ Fecha ≠ reserva/.test(r.reason ?? ""));
  // the right day passes; no booking claim passes
  assert.equal(guardBookingDateClaim({ ...send, message: "¡Perfecto! Nos vemos el sábado a las 9 am 🙌" }, ctx).action, "send");
  assert.equal(guardBookingDateClaim({ ...send, message: "¿Te queda mañana a las 9?" }, ctx).action, "send");
});

// ---- 2a. capacity claims ------------------------------------------------------

test("capacityClaim: graded cases flagged, booking phrases not", () => {
  for (const t of [
    "mañana jueves a las 6 o 7 pm también hay lugar", // A11
    "el lunes a las 4 pm también hay lugar", // A45
    "mañana miércoles a la 1 pm hay lugar", // A174
    "el sábado ya no tenemos cupo para su grupo", // A187
    "Hoy todavía tienes lugar a las 9 am o 10 am", // A54
    "quedan pocos lugares",
    "the class is fully booked",
  ]) {
    assert.ok(capacityClaim(t), t);
  }
  for (const t of [
    "Listo Ana, Emilia ya tiene su lugar! 🙌",
    "Les puedo apartar lugar mañana a la 1 pm",
    "¿Te aparto tu lugar?",
    "El número de alumnos varía según el horario",
  ]) {
    assert.equal(capacityClaim(t), null, t);
  }
});

test("guardFactClaims: capacity talk never auto-sends", () => {
  const send: BrainResult = { action: "send", message: "¡Claro! El lunes a las 4 pm también hay lugar 🙌", language: "es", confidence: "high", sureness: 90 };
  const r = guardFactClaims(send, { nowCdmx: "2026-11-11T10:00", contact: contact() });
  assert.ok(r.action === "draft" && /⚠️ Cupo/.test(r.reason ?? ""));
});

// ---- 2b. combos -----------------------------------------------------------------

test("comboStartsAt / dayCombos follow the grid", () => {
  // Thursday (3): 6 pm JJ → 7 pm MT exists; at 7 pm JJ and MT run together and no MT at 8.
  assert.equal(comboStartsAt(3, "18:00", "jiu", "muay"), true);
  assert.equal(comboStartsAt(3, "19:00", "jiu", "muay"), false);
  // Wednesday (2) 10 am: one class, nothing at 11.
  assert.equal(comboStartsAt(2, "10:00", null, null), false);
  const wed = dayCombos(2);
  assert.ok(wed.some((c) => c.startsWith("6 pm Jiu-Jitsu→Muay Thai")));
  assert.ok(!wed.some((c) => c.startsWith("10 am")));
});

test("comboClaimIssues: graded wrong combos are flagged, real ones pass", () => {
  // A236: Thursday 11-12 "hoy a las 7 pm … JJ y MT seguidas"
  assert.equal(comboClaimIssues("¿Te late hoy a las 7 pm? Pruebas Jiu-Jitsu y Muay Thai seguidas", "2026-11-12").length, 1);
  // A0: Tue 11-10, "mañana miércoles 7 am, 10 am o 6 pm y pruebas JJ y MT seguidas": only 10 am is wrong
  const a0 = comboClaimIssues("mañana miércoles puedes llegar a las 7 am, 10 am o 6 pm y pruebas Jiu-Jitsu y Muay Thai seguidas", "2026-11-10");
  assert.equal(a0.length, 1);
  assert.match(a0[0]!, /10 am/);
  // real combos
  assert.deepEqual(comboClaimIssues("Hoy a las 6 pm puedes llegar y probar Jiu-Jitsu y Muay Thai seguidas", "2026-11-12"), []);
  assert.deepEqual(comboClaimIssues("El sábado llegas a las 10 am a Muay Thai; si quieres, 9 am Jiu-Jitsu de pilón", "2026-11-11"), []);
  // no day readable: left alone
  assert.deepEqual(comboClaimIssues("A las 10 am pruebas dos clases seguidas", "2026-11-11"), []);
});

test("combosLine: the context lists only the grid's combos", () => {
  const line = combosLine([{ date: "2026-11-11", weekday: 2, label: "hoy miércoles", slots: [{ weekday: 2, date: "2026-11-11", time: "10:00", discipline: "muay", label: "" }] }]);
  assert.match(line!, /6 pm Jiu-Jitsu→Muay Thai/);
  assert.doesNotMatch(line!, /10 am Muay Thai→/);
  const full = combosLine([{ date: "2026-11-12", weekday: 3, label: "mañana jueves", slots: [{ weekday: 3, date: "2026-11-12", time: "07:00", discipline: "jiu", label: "" }] }]);
  assert.match(full!, /6 pm Jiu-Jitsu→Muay Thai/);
  assert.doesNotMatch(full!, /7 pm Jiu-Jitsu→Muay Thai/);
});

// ---- 2c / 3. persona + BFC price at the first ask ------------------------------

import { asksPrice, bfcPriceLine, PERSONA_AND_POLICIES } from "../src/brain/prompt.js";
import { CLIENT } from "../src/client.gen.js";

test("persona: no capacity wording in its own examples; BFC exception precedes the generic reframe", () => {
  assert.doesNotMatch(PERSONA_AND_POLICIES, /también hay lugar/);
  const bfc = PERSONA_AND_POLICIES.indexOf("**Baby Fight Club es la excepción**");
  const generic = PERSONA_AND_POLICIES.indexOf("- Adultos/Kids/Teens, primera pregunta de precio");
  assert.ok(bfc > 0 && generic > 0 && bfc < generic);
});

test("bfcPriceLine: a BFC parent asking the price gets the explicit first-ask override", () => {
  const ask = [msg("out", "¡Hola! ¿Les queda el miércoles 1 pm?"), msg("in", "y cuales son los costos?")];
  const baby = ctxAt("2026-11-10T12:00", ask, { campaign: { name: "Baby Fight Club nov", info: "" } });
  assert.match(bfcPriceLine(baby)!, /Excepción Baby Fight Club/);
  // their own words name the program
  const said = ctxAt("2026-11-10T12:00", [msg("in", "Info de Baby Fight Club"), msg("out", "¡Claro!"), msg("in", "¿Cuánto cuesta?")]);
  assert.ok(bfcPriceLine(said));
  // stated age in months → baby band
  const aged = ctxAt("2026-11-10T12:00", ask, { contact: contact({ qualification: JSON.stringify({ child_age_months: 18 }) }) });
  assert.ok(bfcPriceLine(aged));
  // not BFC / not a price question
  assert.equal(bfcPriceLine(ctxAt("2026-11-10T12:00", ask)), null, "adult lead");
  assert.equal(bfcPriceLine(ctxAt("2026-11-10T12:00", [msg("in", "¿Dónde están?")], { campaign: { name: "Baby Fight Club nov", info: "" } })), null);
  // a 4-year-old from a BFC ad is Mini Muay Thai: no BFC price
  const mini = ctxAt("2026-11-10T12:00", ask, {
    campaign: { name: "Baby Fight Club nov", info: "" },
    contact: contact({ qualification: JSON.stringify({ child_age_months: 50 }) }),
  });
  assert.equal(bfcPriceLine(mini), null);
  // and it lands in the context block
  assert.match(buildContextBlock(baby), /precio Baby Fight Club/);
});

test("asksPrice: graded phrasings", () => {
  for (const t of ["Qué costo tienen las clases", "De cuánto es la colegiatura", "y cuales son los costos?", "cuánto cuesta la mensualidad?", "how much is it?"]) {
    assert.ok(asksPrice(t), t);
  }
  assert.equal(asksPrice("¿dónde están?"), false);
});

test("the KB keeps the BFC first-ask figures (no invented price)", () => {
  // the line points at the KB; the figures themselves live only in persona/KB
  assert.match(PERSONA_AND_POLICIES, /inscripción \$999 \+ \$1,996 cada 4 semanas/);
  assert.equal(CLIENT.copy.studentAckEs?.includes("$"), false);
});

// ---- 4. auto-responders -----------------------------------------------------------

import { autoResponderSignal, isAutoReplyText } from "../src/pipeline/auto-responder.js";

test("isAutoReplyText: graded auto-replies (A237, A247, A250, A108)", () => {
  for (const t of [
    "Gracias por comunicarte con BabyFusion México Tribu Mamá Koala",
    "¡Hola! Gracias por contactarnos Estamos aquí para realzar tu belleza natural",
    "For more information, visit www.fema.org Thank you.",
    "Parece que ha habido una confusión. Estoy aquí para ayudarte con información sobre cursos y servicios veterinarios.",
    "Gracias por tu mensaje, en breve te atenderemos.",
    "Nuestro horario de atención es de lunes a viernes de 9 a 18 h.",
    "Este es un mensaje automático.",
  ]) {
    assert.ok(isAutoReplyText(t), t);
  }
  for (const t of [
    "Gracias por la info! ¿el sábado a las 10?",
    "Hola, quiero agendar una clase de prueba",
    "gracias, ahí nos vemos",
    "Gracias por responder tan rápido",
    "ok",
  ]) {
    assert.equal(isAutoReplyText(t), false, t);
  }
});

test("autoResponderSignal: the same text a third time, and a fast long ping-pong", () => {
  const same = "Hola, en este momento no podemos atenderte";
  const h = [msg("in", same), msg("out", "¡Hola!"), msg("in", same), msg("out", "¿Te late?"), msg("in", same)];
  assert.equal(autoResponderSignal(same, h), "repeat");
  assert.equal(autoResponderSignal(same, h.slice(0, 3)), null, "twice is not enough");
  assert.equal(autoResponderSignal("ok", [msg("in", "ok"), msg("in", "ok"), msg("in", "ok")]), null, "short text never counts");
  // loop: our message, their 40+ char reply 2 s later, four times
  const loop: StoredMessage[] = [];
  let t = 1_800_000_000;
  for (let i = 0; i < 4; i++) {
    loop.push({ ...msg("out", "¿Les queda el sábado?"), ts: t });
    loop.push({ ...msg("in", `Respuesta distinta número ${i} sobre nuestros servicios y cursos disponibles`), ts: t + 2 });
    t += 600;
  }
  const last = loop[loop.length - 1]!.body;
  assert.equal(autoResponderSignal(last, loop), "loop");
  // a human typing slowly afterwards resumes
  const human = [...loop, { ...msg("out", "¿Te late?"), ts: t }, { ...msg("in", "Hola, soy la mamá, ¿el sábado 14 a las 2?"), ts: t + 90 }];
  assert.equal(autoResponderSignal(human[human.length - 1]!.body, human), null);
});

// ---- 5. returning contacts --------------------------------------------------------

import { isReturningRequest, returningOptOutTask, studentAckText } from "../src/pipeline/returning-contact.js";

test("isReturningRequest: A93's messages open a task; acks and stop words do not", () => {
  assert.ok(isReturningRequest("Hay una persona que responde?"));
  assert.ok(isReturningRequest("Hola, vengo de la página web y quiero agendar mi clase de prueba"));
  for (const t of ["ok", "Gracias", "👍", "no", "Ya no me manden mensajes", "Stop"]) {
    assert.equal(isReturningRequest(t), false, t);
  }
  assert.match(returningOptOutTask("5215512345678", "Ana", "quiero agendar"), /dado de BAJA/);
});

test("studentAckText: client copy, in the contact's language, no time promise", () => {
  const es = studentAckText(CLIENT.copy, "es")!;
  const en = studentAckText(CLIENT.copy, "en")!;
  assert.ok(es && en && es !== en);
  for (const t of [es, en]) assert.doesNotMatch(t, /\b\d+\s*(?:min|minutos|horas|hours|minutes)\b|en breve|shortly/i);
  assert.equal(studentAckText({}, "es"), null, "no copy ⇒ silent");
  assert.equal(studentAckText({ studentAckEs: "Hola" }, "en"), "Hola", "English falls back to Spanish copy");
});

// ---- 6. holding line + internal notes ------------------------------------------------

import { holdingClaimMinAge, holdingLineFor, HOLDING_LINE_EN, secondsSinceCdmxMidnight } from "../src/services/holding-line.js";
import { HOLDING_LINE } from "../src/services/slack-timeouts.js";
import { looksInternalNote } from "../src/brain/followup-note.js";
import { cdmxToEpoch } from "../src/cron/time.js";

test("holding line: contact's language, once per CDMX day", () => {
  assert.equal(holdingLineFor("en"), HOLDING_LINE_EN);
  assert.equal(holdingLineFor("es"), HOLDING_LINE);
  assert.equal(holdingLineFor(null), HOLDING_LINE);
  const at1540 = cdmxToEpoch(2026, 11, 7, 15, 40);
  assert.equal(secondsSinceCdmxMidnight(at1540), 15 * 3600 + 40 * 60);
  // A140: 15:40 sent → 16:55 the same day is refused (stored must predate midnight)
  const at1655 = cdmxToEpoch(2026, 11, 7, 16, 55);
  assert.ok(at1540 > at1655 - holdingClaimMinAge(at1655), "15:40 is not old enough at 16:55");
  // next day 14:35 → allowed
  const next = cdmxToEpoch(2026, 11, 8, 14, 35);
  assert.ok(at1540 <= next - holdingClaimMinAge(next));
  // just after midnight: still 45 min apart
  const late = cdmxToEpoch(2026, 11, 7, 23, 50);
  const early = cdmxToEpoch(2026, 11, 8, 0, 10);
  assert.ok(late > early - holdingClaimMinAge(early));
});

test("looksInternalNote: A90's staff note is refused; a real follow-up passes", () => {
  assert.ok(looksInternalNote("Gilda espera confirmación de si el lunes 16 de nov hay clase de Mini Muay Thai (asueto). Confirmar y agendar. Niño: 3 años 11 meses."));
  assert.ok(looksInternalNote("Recordatorio: preguntarle si ya decidió"));
  assert.ok(looksInternalNote("El lead quiere venir el sábado"));
  assert.equal(looksInternalNote("¡Hola Gilda! 🙌 ¿Ya saben si les queda el lunes 16 a las 3:15 pm?"), false);
  assert.equal(looksInternalNote("Hi! Just checking in — still up for Saturday?"), false);
});

test("fact guards: no false alarms on ordinary copy", () => {
  assert.deepEqual(comboClaimIssues("Te esperamos el sábado a las 10 am y luego te mando el link", "2026-11-11"), []);
  assert.equal(capacityClaim("No tenemos estacionamiento, pero hay lugares de paga para estacionar alrededor del parque"), null);
  assert.equal(capacityClaim("hay espacio abajo para dejar la bici"), null);
});

test("statedDateLine: a closed / TBD date is never offered (A113: lunes 16 = holiday TBD)", () => {
  const line = statedDateLine([msg("in", "Podría ser proximo lunes 16")], "2026-11-07", () => null);
  assert.match(line!, /cerrado o con horario especial/);
});

test("bookingDateError: a lead asking for a closed/TBD date does not block the alternative", () => {
  // 2026-11-16 is the TBD holiday in client.mjs closedDates
  const ctx = ctxAt("2026-11-07T10:00", [msg("in", "Sería el 16 por favor")]);
  assert.equal(bookingDateError(ctx, "2026-11-18", "mie"), null);
});

// ---- reply-text slot guard false positives (approvals agent, 2026-11-11) ---------

import { findSlotClaimIssues } from "../src/brain/slot-claims.js";
import { guardUnverifiedSlotClaim } from "../src/brain/claude.js";

const FP: [string, string, number, { band: "adults" | "teens" | "kids" | "mini"; discipline: string | null }][] = [
  ["A98 range end captured the weekday hours", "Tenemos Muay Thai de lunes a sábado: entre semana 7, 8 y 10 am, y el sábado 10 am. ¿Te late mañana domingo a las 11 am?", 5, { band: "adults", discipline: "muay" }],
  ["JJ 6/7/8 pm bound to the lead's MMA", "El martes tenemos Jiu-Jitsu a las 6, 7 u 8 pm. ¿Cuál te late?", 0, { band: "adults", discipline: "mma" }],
  ["JJ 6/7/8 pm, lead wanted Box", "Mañana martes puedes venir a Jiu-Jitsu a las 6 pm, 7 pm u 8 pm 🙌", 0, { band: "adults", discipline: "box" }],
  ["A155 adult Saturday rows to a teen", "¡Claro! 🙌 El sábado no hay grupo Teens, pero desde los 13 puede entrar a cualquier clase de adultos: a las 10 am hay Jiu-Jitsu y Muay Thai, y a las 2 pm Box. ¿Qué edad tiene?", 5, { band: "teens", discipline: null }],
  ["adult Saturday rows to a lead filed as kids", "El fin de semana no hay grupo de su edad, pero desde los 13 años pueden entrar a las clases de adultos. Mañana sábado a las 10 am hay Jiu-Jitsu y Muay Thai, y a las 2 pm Box.", 4, { band: "kids", discipline: null }],
  ["A163 18-year-old filed as kid", "¡Perfecto! Con 18 años entra directo a la clase de adultos 🥊 Box es mañana sábado a las 2 pm, ¿te late?", 4, { band: "kids", discipline: "box" }],
  ["A206 combo with the other discipline after the hour", "Mañana sábado tenemos Muay Thai a las 10 am 🥊 y si quieres llegas desde las 9 am y pruebas también Jiu-Jitsu, dos clases en una visita. ¿Te late?", 4, { band: "adults", discipline: "muay" }],
  ["A197 Mini Monday", "Entendido, sin bronca 🙌 Entonces te quedaría el lunes a las 3:15 pm en Mini Muay Thai.", 4, { band: "mini", discipline: null }],
];

for (const [why, text, wd, o] of FP) {
  test(`slot guard: no false positive — ${why}`, () => {
    assert.deepEqual(findSlotClaimIssues(text, wd, o).map((i) => i.note), []);
  });
}

const TP: [string, string, number, { band: "adults" | "teens" | "kids"; discipline: string | null }][] = [
  ["Teens on Saturday", "Tenemos Teens el sábado a las 10 am", 2, { band: "teens", discipline: null }],
  ["Box at 7 am", "El jueves tenemos Box a las 7 am", 2, { band: "adults", discipline: "box" }],
  ["Friday 6 pm Muay Thai", "El viernes a las 6 pm tenemos Muay Thai", 2, { band: "adults", discipline: "muay" }],
  ["«entre semana» 6 pm includes Friday", "Muay Thai entre semana a las 6 pm", 2, { band: "adults", discipline: "muay" }],
  ["Kids on Sunday", "Para Kids el domingo a las 11 am", 2, { band: "kids", discipline: null }],
  ["a range still checks every day", "Muay Thai de lunes a sábado a las 7 am", 2, { band: "adults", discipline: "muay" }],
];

for (const [why, text, wd, o] of TP) {
  test(`slot guard: still flagged — ${why}`, () => {
    assert.ok(findSlotClaimIssues(text, wd, o).length > 0);
  });
}

test("guardUnverifiedSlotClaim: the A98 schedule answer keeps its sureness and sends", () => {
  const send: BrainResult = {
    action: "send",
    message: "Tenemos Muay Thai de lunes a sábado: entre semana 7, 8 y 10 am, y el sábado 10 am. ¿Te late mañana domingo a las 11 am?",
    language: "es", confidence: "high", sureness: 85,
  };
  const r = guardUnverifiedSlotClaim(send, { nowCdmx: "2026-11-07T19:09", contact: contact({ qualification: JSON.stringify({ discipline: "muay" }) }) });
  assert.equal(r.action, "send");
});
