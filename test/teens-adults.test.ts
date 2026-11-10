// Teens with adults (owner, 2026-11-10): 16–17 may book ANY adult class; 13–15
// adult Muay Thai any day + exactly what intake.md's Saturday Teens line says
// (any Saturday adult class except sparring; Blindaje 8 12 pm 16+ or 14–15;
// Kids 11 am at 13–14). Booking validation, the reply-text slot checker and
// the KB copy must agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSlotBand } from "../src/brain/tools.js";
import { teenAdultRow, slotOpenToBand } from "../src/services/age-band.js";
import { findSlotClaimIssues } from "../src/brain/slot-claims.js";
import { bookResult, guardUnverifiedSlotClaim, handleBookTrial, type PendingBooking } from "../src/brain/claude.js";
import { SLOTS } from "../src/brain/slots.gen.js";
import { readFileSync } from "node:fs";
import type { BookTrialInput, BrainResult, Contact, ConvoContext } from "../src/types.js";

const Y = (n: number) => n * 12;
// Dates (CDMX): Mon 2026-11-23, Tue 2026-11-24, Sat 2026-11-21, Sun 2026-11-22.
const MON = "2026-11-23";
const TUE = "2026-11-24";
const SAT = "2026-11-21";
const SUN = "2026-11-22";
const ok = (d: string, t: string, disc: string, age: number | null, band: "teens" | "kids" = "teens") =>
  validateSlotBand(d, t, disc, band, undefined, age).ok;

test("16–17: any adult class, any day", () => {
  for (const age of [Y(16), Y(17) + 11]) {
    assert.equal(ok(MON, "19:00", "jiu", age), true, "adult Jiu-Jitsu Monday");
    assert.equal(ok(MON, "20:00", "mma", age), true, "adult MMA (coach confirms in class, per KB)");
    assert.equal(ok(TUE, "21:00", "box", age), true, "adult Box Tuesday");
    assert.equal(ok(SUN, "12:00", "jiu", age), true, "Sunday Jiu-Jitsu");
    assert.equal(ok(SAT, "12:00", "jiu", age), true, "Blindaje 8 (16+)");
    assert.equal(ok(MON, "16:00", "mma", age), true, "MMA Teens still fine");
  }
  assert.equal(ok(MON, "16:00", "muay", Y(16)), false, "Kids Muay Thai stays closed");
});

test("13–15: adult Muay Thai any day, other adult classes only on Saturday", () => {
  for (const age of [Y(13), Y(15) + 11, null]) {
    assert.equal(ok(MON, "19:00", "muay", age), true);
    assert.equal(ok(SUN, "11:00", "muay", age), true, "Sunday Muay Thai (13+)");
    assert.equal(ok(MON, "19:00", "jiu", age), false, "weekday adult Jiu-Jitsu");
    assert.equal(ok(MON, "20:00", "mma", age), false, "adult MMA is 16+");
    assert.equal(ok(TUE, "21:00", "box", age), false, "weekday Box");
    assert.equal(ok(SUN, "12:00", "jiu", age), false, "Sunday Jiu-Jitsu");
    // intake.md Saturday line: 9 am Jiu-Jitsu, 10 am Jiu-Jitsu/Muay Thai, 2 pm Box
    assert.equal(ok(SAT, "09:00", "jiu", age), true);
    assert.equal(ok(SAT, "10:00", "jiu", age), true);
    assert.equal(ok(SAT, "10:00", "muay", age), true);
    assert.equal(ok(SAT, "14:00", "box", age), true);
  }
});

test("Saturday Blindaje 8 (12 pm): 16+ or 14–15, never 13 or unknown age", () => {
  assert.equal(ok(SAT, "12:00", "jiu", Y(14)), true);
  assert.equal(ok(SAT, "12:00", "jiu", Y(15) + 6), true);
  assert.equal(ok(SAT, "12:00", "jiu", Y(13) + 11), false);
  assert.equal(ok(SAT, "12:00", "jiu", null), false);
});

test("Saturday 11 am Kids class: 13–14 only; 11 am Muay Thai sparring never", () => {
  assert.equal(ok(SAT, "11:00", "jiu", Y(13)), true);
  assert.equal(ok(SAT, "11:00", "jiu", Y(14) + 11), true);
  assert.equal(ok(SAT, "11:00", "jiu", Y(15)), false);
  assert.equal(ok(SAT, "11:00", "jiu", null), false);
  const kids12 = SLOTS.find((s) => s.weekday === 5 && s.time === "12:00" && s.group === "kids")!;
  assert.equal(teenAdultRow(kids12, "teens", Y(13)), false, "only the 11 am Kids class is named");
  // sparring rows never pass validateSlotBand's trial filter (row-less ⇒ validateSlot's job)
  const spar = SLOTS.find((s) => s.weekday === 5 && s.time === "11:00" && s.discipline === "muay")!;
  assert.equal(spar.trial, false);
});

test("under 13 unchanged: Kids never get adult rows", () => {
  for (const [d, t, disc] of [[MON, "19:00", "muay"], [SAT, "10:00", "jiu"], [SAT, "14:00", "box"]] as const) {
    assert.equal(ok(d, t, disc, Y(12), "kids"), false);
  }
  const adultMuay = SLOTS.find((s) => s.weekday === 0 && s.time === "19:00" && s.discipline === "muay")!;
  assert.equal(slotOpenToBand(adultMuay, "kids", Y(12)), false);
  assert.equal(teenAdultRow(adultMuay, "adults", Y(30)), false);
});

test("KB copy states the rule the validation implements", () => {
  const KB_MARKDOWN = readFileSync("kb/compiled/kb.md", "utf8");
  assert.ok(KB_MARKDOWN.includes("En sábado, desde los 13 entran a CUALQUIER clase de adultos (9 am Jiu-Jitsu, 10 am Jiu-Jitsu/Muay Thai, 2 pm Box — la de 11 am es sparring, sin pruebas; la de 12 pm es Blindaje 8: 16+, o 14–15 con papá o mamá); solo con 13–14 años pueden optar por la clase Kids (6–12) del sábado 11 am."));
  assert.ok(KB_MARKDOWN.includes("Con 16–17, si prefieren, cualquier clase de adultos cualquier día."));
  assert.ok(KB_MARKDOWN.includes("(lo confirma el coach)"), "adult MMA coach confirmation kept");
});

// ---- booking path ----

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215512345678", name: null, lang: "es", status: "lead", qualification: null,
    human_override_until: null, last_inbound_at: null, campaign_id: null, ad_ref: null,
    airtable_lead_id: null, created_at: 0, updated_at: 0, ...over,
  };
}
const ctx = (c: Contact = contact()): ConvoContext => ({
  phone: "5215512345678", contact: c, history: [], nowCdmx: "2026-11-19T18:30",
  weekday: "jueves", windowOpen: true, trainingWheels: true,
});
const tu = (i: Record<string, unknown>) => ({ type: "tool_use" as const, id: "t1", name: "book_trial", input: i });

test("handleBookTrial: a 16-year-old books adult Jiu-Jitsu Monday; a 14-year-old Saturday Box but not Monday Jiu-Jitsu", async () => {
  let booked = 0;
  const airtable = { bookTrial: async () => { booked++; return "recT"; } };
  const base = { name: "Ana", child_name: "Diego", followup_message: "ok" };
  const r16 = await handleBookTrial(airtable, ctx(), tu({ ...base, child_age: 16, discipline: "jiu", audience: "kid", trial_date: MON, trial_time: "19:00" }));
  assert.equal(r16.result.is_error, undefined, String(r16.result.content));
  const r14 = await handleBookTrial(airtable, ctx(), tu({ ...base, child_age: 14, discipline: "box", audience: "kid", trial_date: SAT, trial_time: "14:00" }));
  assert.equal(r14.result.is_error, undefined, String(r14.result.content));
  const no = await handleBookTrial(airtable, ctx(), tu({ ...base, child_age: 14, discipline: "jiu", audience: "kid", trial_date: MON, trial_time: "19:00" }));
  assert.equal(no.result.is_error, true);
  assert.equal(booked, 2);
});

// ---- reply-text slot checker ----

const teenContact = (months: number) =>
  contact({ qualification: JSON.stringify({ program: "teens", child_age_months: months }) });
const send = (message: string): BrainResult => ({ action: "send", message, language: "es", confidence: "high" });

test("slot claims: a teen confirmation naming an allowed adult class is not flagged", () => {
  const sat = "Listo Ana, Diego ya tiene su lugar! 🙌🔥 Los esperamos el sábado a las 10 am en MD Condesa para su primera clase de Jiu-Jitsu.";
  const mon = "Listo Ana, Diego ya tiene su lugar! 🙌🔥 Los esperamos el lunes a las 7 pm en MD Condesa para su primera clase de Jiu-Jitsu.";
  // Thursday context
  assert.equal(guardUnverifiedSlotClaim(send(sat), { nowCdmx: "2026-11-19T18:30", contact: teenContact(Y(14)) }).action, "send");
  assert.equal(guardUnverifiedSlotClaim(send(mon), { nowCdmx: "2026-11-19T18:30", contact: teenContact(Y(16)) }).action, "send");
  // 14-year-old on weekday adult Jiu-Jitsu: still flagged
  assert.equal(guardUnverifiedSlotClaim(send(mon), { nowCdmx: "2026-11-19T18:30", contact: teenContact(Y(14)) }).action, "draft");
});

test("slot claims: copy that names the Teens group on Saturday stays flagged", () => {
  const THU = 3;
  for (const msg of ["Tenemos Teens el sábado.", "El sábado a las 10 am hay Teens."]) {
    const n = findSlotClaimIssues(msg, THU, { band: "teens", discipline: null, ageMonths: Y(16) });
    assert.ok(n.length >= 1, msg);
  }
});

test("bookResult: no confirmation warning for a 16-year-old's adult Jiu-Jitsu booking (band/age from the booking)", () => {
  const b: PendingBooking = {
    input: { name: "Ana", discipline: "jiu", audience: "kid", trialDate: MON, trialTime: "19:00", phone: "5215512345678", childName: "Diego", program: "teens", childAgeMonths: Y(16) } as BookTrialInput,
    followupMessage: "Listo Ana, Diego ya tiene su lugar! 🙌🔥 Los esperamos el lunes a las 7 pm en MD Condesa para su primera clase.",
    recordId: "recA",
  };
  const r = bookResult([b], { nowCdmx: "2026-11-19T18:30", contact: contact() });
  assert.equal(r.action, "book");
  assert.equal((r as { confirmationWarning?: string }).confirmationWarning, undefined);
  const b14 = {
    ...b,
    input: { ...b.input, childAgeMonths: Y(14) },
    followupMessage: "Listo Ana, Diego ya tiene su lugar! Los esperamos el lunes a las 7 pm para su primera clase de Jiu-Jitsu.",
  };
  const r14 = bookResult([b14], { nowCdmx: "2026-11-19T18:30", contact: contact() });
  assert.ok((r14 as { confirmationWarning?: string }).confirmationWarning, "14 on weekday adult Jiu-Jitsu is flagged");
});
