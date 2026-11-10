// Booking confirmations send on their own (owner, 2026-11-10) + the teen →
// adult Muay Thai exception (owner, same day).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confirmationMentionsPrice,
  decideAutoConfirm,
  type AutoConfirmInput,
} from "../src/services/auto-confirm.js";
import { bookResult, handleBookTrial, type PendingBooking } from "../src/brain/claude.js";
import { validateSlotBand } from "../src/brain/tools.js";
import { slotOpenToBand, teenAdultMuayRow } from "../src/services/age-band.js";
import { SLOTS } from "../src/brain/slots.gen.js";
import { CLIENT } from "../src/client.gen.js";
import { PERSONA_AND_POLICIES } from "../src/brain/prompt.js";
import type { BookTrialInput, Contact, ConvoContext } from "../src/types.js";

const CONFIRM =
  "Listo Ana, Emilia ya tiene su lugar! 🙌🔥 Los esperamos el lunes a las 4:00 pm en MD Condesa para su primera clase. mdcondesa.com/tu-primera-clase/";

function input(over: Partial<AutoConfirmInput> = {}): AutoConfirmInput {
  return {
    featureOn: true,
    forceReview: false,
    overrideCheck: false,
    reschedule: false,
    hadRecordedBooking: false,
    replyMissing: false,
    replySureness: 90,
    confirmation: CONFIRM,
    bookings: [{ audience: "kid", childName: "Emilia", program: "kids", childAgeMonths: 96 }],
    ...over,
  };
}

// ---- the decision ----

test("a validated first booking (adult or minor with a known age) auto-confirms", () => {
  assert.deepEqual(decideAutoConfirm(input()), { auto: true });
  assert.deepEqual(
    decideAutoConfirm(input({ bookings: [{ audience: "adult" }], confirmation: "Listo Luis, ya tienes tu lugar! Te esperamos mañana a las 7 pm." })),
    { auto: true },
  );
  // age stored in the qualification instead of on the call
  assert.equal(
    decideAutoConfirm(input({ bookings: [{ audience: "kid", childName: "Leo", program: "kids" }], storedAgeMonths: 84 })).auto,
    true,
  );
  // legacy result without a sureness: not blocked on that alone
  const { replySureness: _s, ...noSure } = input();
  assert.equal(decideAutoConfirm(noSure).auto, true);
});

test("every human-path reason blocks, first failure wins", () => {
  const cases: [Partial<AutoConfirmInput>, string][] = [
    [{ featureOn: false }, "feature_off"],
    [{ forceReview: true }, "force_review"],
    [{ overrideCheck: true }, "override_check"],
    [{ reschedule: true }, "existing_booking"],
    [{ hadRecordedBooking: true }, "existing_booking"],
    [{ replyMissing: true }, "no_reply"],
    [{ replyReason: "complaint: molesta por el cobro" }, "escalation"],
    [{ replyReason: "opt_out" }, "escalation"],
    [{ replySureness: 74 }, "sureness"],
    [{ slotWarning: "⚠️ Horario que no existe para este lead: …" }, "slot_warning"],
    [{ confirmation: `${CONFIRM} La inscripción es de $999.` }, "price"],
    [{ bookings: [{ audience: "kid", childName: "Emilia", program: "kids" }] }, "minor_age"],
    [{ bookings: [{ audience: "adult" }, { audience: "adult", childName: "Leo" }] }, "minor_age"],
  ];
  for (const [over, why] of cases) {
    assert.deepEqual(decideAutoConfirm(input(over)), { auto: false, blockedBy: why }, why);
  }
  assert.equal(decideAutoConfirm(input({ featureOn: false, replyMissing: true })).blockedBy, "feature_off");
  assert.equal(decideAutoConfirm(input({ replyReason: "   " })).auto, true, "blank reason is no reason");
});

test("price check: the approved confirmation copy is clean; figures and promo words are not", () => {
  assert.equal(confirmationMentionsPrice(CONFIRM + "\n\nSi quieres invitar a un amigo o pariente, estaría súper 👊 Cualquier duda, aquí estoy 🙏"), false);
  for (const t of ["$1,996 cada 4 semanas", "promo de mañanas", "10% de descuento", "la mensualidad", "500 pesos"]) {
    assert.equal(confirmationMentionsPrice(t), true, t);
  }
});

test("md-condesa ships the switch ON (compile-kb whitelist reached client.gen.ts)", () => {
  assert.equal(CLIENT.features.autoConfirmBookings, true);
});

// ---- the book result carries what the decision needs ----

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215512345678", name: null, lang: "es", status: "lead", qualification: null,
    human_override_until: null, last_inbound_at: null, campaign_id: null, ad_ref: null,
    airtable_lead_id: null, created_at: 0, updated_at: 0, ...over,
  };
}

const booking = (over: Partial<BookTrialInput> = {}, msg = CONFIRM): PendingBooking => ({
  input: { name: "Ana", discipline: "muay", audience: "kid", trialDate: "2026-11-16", trialTime: "16:00", phone: "5215512345678", childName: "Emilia", program: "kids", childAgeMonths: 96, ...over },
  followupMessage: msg,
  recordId: "recA",
});
const sendReply = (input: Record<string, unknown>) => ({ type: "tool_use" as const, id: "s1", name: "send_reply", input });

test("bookResult: sureness / escalation reason / missing reply ride on the result", () => {
  const ctx = { nowCdmx: "2026-11-12T18:30", contact: contact({ qualification: JSON.stringify({ child_age_months: 96 }) }) };
  const r = bookResult([booking()], ctx, sendReply({ message: "ok", sureness: 88, escalation_reason: "" }));
  assert.equal(r.action, "book");
  if (r.action !== "book") return;
  assert.equal(r.replySureness, 88);
  assert.equal(r.replyReason, undefined);
  assert.equal(r.replyMissing, undefined);
  assert.equal(r.confirmationWarning, undefined, "Kids Monday 4 pm is a real row");

  const esc = bookResult([booking()], ctx, sendReply({ sureness: 40, escalation_reason: "pregunta médica" }));
  assert.equal(esc.action === "book" && esc.replyReason, "pregunta médica");
  const none = bookResult([booking()], ctx, null);
  assert.equal(none.action === "book" && none.replyMissing, true);
});

test("bookResult: a confirmation naming a slot that does not exist carries the guard's warning", () => {
  const ctx = { nowCdmx: "2026-11-12T18:30", contact: contact() };
  const bad = bookResult(
    [booking({ audience: "adult", childName: undefined, program: undefined, childAgeMonths: undefined }, "Listo Ana, ya tienes tu lugar! Te esperamos el viernes a las 7 pm para tu clase de Muay Thai.")],
    ctx,
    sendReply({ sureness: 90 }),
  );
  assert.ok(bad.action === "book" && bad.confirmationWarning && /⚠️/.test(bad.confirmationWarning));
});

// ---- B) teens and Muay Thai ----

test("teenAdultMuayRow: Muay Thai adult rows only, teens only", () => {
  const adultMuay = SLOTS.find((s) => s.weekday === 0 && s.time === "19:00" && s.discipline === "muay")!;
  const adultJiu = SLOTS.find((s) => s.weekday === 0 && s.time === "19:00" && s.discipline === "jiu")!;
  const adultMma = SLOTS.find((s) => s.weekday === 0 && s.time === "20:00" && s.discipline === "mma")!;
  assert.equal(teenAdultMuayRow(adultMuay, "teens"), true);
  assert.equal(teenAdultMuayRow(adultMuay, "kids"), false);
  assert.equal(teenAdultMuayRow(adultMuay, "mini"), false);
  assert.equal(teenAdultMuayRow(adultJiu, "teens"), false);
  assert.equal(teenAdultMuayRow(adultMma, "teens"), false, "MMA adultos is 16+, coach-confirmed — not widened");
  assert.equal(slotOpenToBand(adultMuay, "teens"), true);
  assert.equal(slotOpenToBand(adultJiu, "teens"), false);
});

test("the schedule has MMA Teens (L–J 4 pm) and Jiu-Jitsu Teens (L–J 5 pm), no Teens Muay Thai", () => {
  const teens = SLOTS.filter((s) => s.group === "teens").map((s) => `${s.weekday} ${s.time} ${s.discipline}`);
  assert.deepEqual(teens.sort(), [
    "0 16:00 mma", "0 17:00 jiu", "1 16:00 mma", "1 17:00 jiu",
    "2 16:00 mma", "2 17:00 jiu", "3 16:00 mma", "3 17:00 jiu",
  ]);
  assert.ok(!SLOTS.some((s) => s.group === "teens" && s.discipline === "muay"));
});

test("validateSlotBand: a teen may book adult Muay Thai; not adult Jiu-Jitsu, MMA or Box; Kids still may not", () => {
  // Monday 2026-11-16
  assert.equal(validateSlotBand("2026-11-16", "19:00", "muay", "teens").ok, true);
  assert.equal(validateSlotBand("2026-11-16", "07:00", "muay", "teens").ok, true);
  assert.equal(validateSlotBand("2026-11-16", "19:00", "jiu", "teens").ok, false);
  assert.equal(validateSlotBand("2026-11-16", "20:00", "mma", "teens").ok, false);
  assert.equal(validateSlotBand("2026-11-16", "19:00", "muay", "kids").ok, false);
  assert.equal(validateSlotBand("2026-11-16", "16:00", "mma", "teens").ok, true, "MMA Teens");
  // Tuesday 21:00 Box (2026-11-17)
  assert.equal(validateSlotBand("2026-11-17", "21:00", "box", "teens").ok, false);
  // Kids Muay Thai at 4 pm stays closed to a teen
  assert.equal(validateSlotBand("2026-11-16", "16:00", "muay", "teens").ok, false);
});

test("handleBookTrial: a 14-year-old books adult Muay Thai even with audience kid; adult Jiu-Jitsu refused", async () => {
  let booked = 0;
  const airtable = { bookTrial: async () => { booked++; return "recT"; } };
  const tu = (i: Record<string, unknown>) => ({ type: "tool_use" as const, id: "t1", name: "book_trial", input: i });
  const ctx: ConvoContext = {
    phone: "5215512345678", contact: contact(), history: [], nowCdmx: "2026-11-12T18:30",
    weekday: "jueves", windowOpen: true, trainingWheels: true,
  };
  const base = { name: "Ana", child_name: "Diego", child_age: 14, trial_date: "2026-11-16", trial_time: "19:00", followup_message: "ok" };
  for (const audience of ["kid", "adult"]) {
    const ok = await handleBookTrial(airtable, ctx, tu({ ...base, discipline: "muay", audience }));
    assert.equal(ok.result.is_error, undefined, `${audience}: ${ok.result.content}`);
    assert.equal(ok.booking!.input.program, "teens");
  }
  assert.equal(booked, 2);
  const jiu = await handleBookTrial(airtable, ctx, tu({ ...base, discipline: "jiu", audience: "adult" }));
  assert.equal(jiu.result.is_error, true);
  assert.equal(booked, 2);
});

test("persona: no Teens Muay Thai — suggest MMA Teens, adult Muay Thai if they only want Muay Thai", () => {
  assert.ok(!PERSONA_AND_POLICIES.includes("para Muay Thai, desde los 13 entran al grupo de adultos"));
  assert.ok(PERSONA_AND_POLICIES.includes("No hay Muay Thai Teens: si quiere Muay Thai, sugiere MMA Teens (incluye striking); si solo quiere Muay Thai, puede probar la clase de adultos"));
});
