// WP1 (2026-10-11): the brain knows the lead's age band, discipline and memory.
// Unit tests for each pure piece + replay-fixture tests on the exact turns that
// failed in the 2026-10-09 audit (test/fixtures/replay/*.json).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BookTrialInput, Contact, ConvoContext, StoredMessage } from "../src/types.js";
import {
  classifyProgram,
  firstClassLink,
  legacyProgram,
  nudgeSlot,
  programLink,
  extendedTemplateName,
} from "../src/cron/nudge-copy.js";
import { bandDayOptions, upcomingBandSlots } from "../src/cron/next-slot.js";
import {
  botAskedAge,
  cleanDayKeys,
  disciplineFromAdText,
  mergeQualUpdate,
  programSignalUpdate,
} from "../src/services/program-signal.js";
import { buildContextBlock, knownFactsLine, upcomingSlotLines } from "../src/brain/prompt.js";
import { validateSlotBand } from "../src/brain/tools.js";
import {
  addPendingBooking,
  guardUnverifiedSlotClaim,
  handleBookTrial,
  qualUpdateFromInput,
  trimHistory,
  wantsLongHistory,
  type PendingBooking,
} from "../src/brain/claude.js";
import { findSlotClaimIssues } from "../src/brain/slot-claims.js";
import { bookingQualification } from "../src/services/booking-core.js";
import { cdmxToEpoch } from "../src/cron/time.js";

// ---- helpers ----

interface Fixture {
  case: string;
  phone: string;
  campaign: string | null;
  contact: { name: string | null; lang: "es" | "en"; status: "lead"; qualification: string | null; campaign_id: number | null };
  messages: { direction: StoredMessage["direction"]; ts: number; body: string }[];
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(`test/fixtures/replay/${name}.json`, "utf8")) as Fixture;
}

/** CDMX is UTC-6 all year (no DST since 2022). */
function cdmxIso(ts: number): string {
  return new Date((ts - 6 * 3600) * 1000).toISOString().slice(0, 16);
}

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215550000000",
    name: null,
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: null,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function ctxFrom(f: Fixture, turn: number, qualification: string | null, over: Partial<ConvoContext> = {}): ConvoContext {
  const ts = f.messages[turn]!.ts;
  return {
    phone: f.phone,
    contact: contact({
      phone: f.phone,
      name: f.contact.name,
      qualification,
      campaign_id: f.contact.campaign_id,
    }),
    history: [],
    nowCdmx: cdmxIso(ts),
    weekday: "",
    windowOpen: true,
    trainingWheels: true,
    ...(f.campaign ? { campaign: { name: f.campaign, info: "" } } : {}),
    ...over,
  };
}

function sendRes(message: string) {
  return { action: "send" as const, message, language: "es" as const, confidence: "high" as const, sureness: 90 };
}

const q = (o: Record<string, unknown>) => contact({ qualification: JSON.stringify(o) });

// ---- 1. classifyProgram: age first, campaign only as fallback ----

test("classifyProgram: stated age beats the campaign name", () => {
  assert.equal(classifyProgram(q({ child_age_months: 58, discipline: "baby" }), "baby fight club"), "mini");
  assert.equal(classifyProgram(q({ child_age_months: 30 }), "Kids septiembre"), "baby");
  assert.equal(classifyProgram(q({ child_age_months: 14 * 12 }), "Kids"), "teens");
  assert.equal(classifyProgram(q({ program: "kids" }), "baby fight club"), "kids");
  // Nothing in the qualification → campaign fallback.
  assert.equal(classifyProgram(contact(), "Promo Baby CDMX"), "baby");
  assert.equal(classifyProgram(contact(), "Kids septiembre"), "kids");
  assert.equal(classifyProgram(contact(), "Reto Gladiador"), "adults");
});

test("legacy mapping + links per band", () => {
  assert.equal(legacyProgram("mini"), "kids");
  assert.equal(legacyProgram("teens"), "kids");
  assert.equal(legacyProgram("baby"), "baby");
  assert.equal(extendedTemplateName("nudge_d2", "mini"), "nudge_d2_kids");
  assert.match(programLink("mini"), /clase-prueba-ninos/);
  assert.match(programLink("teens"), /clase-prueba-ninos/);
  assert.match(programLink("adults"), /clase-prueba-adultos/);
  assert.match(firstClassLink("baby"), /\/tu-primera-clase-bebes\/$/);
  assert.match(firstClassLink("mini"), /\/tu-primera-clase-bebes\/$/);
  assert.match(firstClassLink("kids"), /\/tu-primera-clase-ninos\/$/);
  assert.match(firstClassLink("teens"), /\/tu-primera-clase-ninos\/$/);
  assert.match(firstClassLink("adults"), /\/tu-primera-clase\/$/);
});

test("nudgeSlot proposes only rows of the band", () => {
  const mon9 = cdmxToEpoch(2026, 10, 12, 9, 0, 0); // Monday
  const mini = nudgeSlot(q({ child_age_months: 48 }), "mini", mon9)!;
  assert.equal(mini.time, "15:15");
  const teens = nudgeSlot(q({ child_age_months: 14 * 12 }), "teens", mon9)!;
  assert.equal(`${teens.time} ${teens.discipline}`, "16:00 mma");
  const kids = nudgeSlot(q({ child_age_months: 8 * 12 }), "kids", mon9)!;
  assert.equal(kids.time, "16:00");
  assert.equal(kids.discipline, "muay");
  const baby = nudgeSlot(q({ child_age_months: 20 }), "baby", mon9)!;
  assert.equal(`${baby.weekday} ${baby.time}`, "2 13:00"); // miércoles 1 pm
  // Declined days are never proposed: "entre semana no" → Saturday.
  const wkend = nudgeSlot(
    q({ child_age_months: 48, declined_days: ["lun", "mar", "mie", "jue", "vie"] }),
    "mini",
    mon9,
  )!;
  assert.equal(`${wkend.weekday} ${wkend.time}`, "5 13:15");
});

test("band listing never crosses groups", () => {
  const mon9 = cdmxToEpoch(2026, 10, 12, 9, 0, 0);
  for (const s of upcomingBandSlots("mini", null, mon9, 6)) assert.equal(s.time.endsWith(":15"), true, s.time);
  const days = bandDayOptions("kids", mon9, 2);
  assert.equal(days.length, 2);
  assert.deepEqual(
    days[0]!.slots.map((s) => `${s.time} ${s.discipline}`),
    ["16:00 muay", "17:00 jiu"],
  );
});

// ---- 2. program signal on every inbound ----

test("programSignalUpdate: bare age only when we asked; new age overrides; no age never erases", () => {
  assert.equal(botAskedAge("¿Qué edad tiene tu peque?"), true);
  assert.equal(botAskedAge("¿cuántos años tiene?"), true);
  assert.equal(botAskedAge("¿Te late mañana?"), false);

  assert.equal(programSignalUpdate({}, { body: "3", lastOutboundBody: "¿Te late mañana 9 am?" }), null);
  const a = programSignalUpdate({ audience: "kid" }, { body: "3", lastOutboundBody: "¿cuántos años tiene?" })!;
  assert.equal(a.child_age_months, 36);
  assert.equal(a.program, "mini");
  const b = programSignalUpdate(a, { body: "perdón, ya tiene 6 años" })!;
  assert.equal(b.child_age_months, 72);
  assert.equal(b.program, "kids");
  assert.equal(programSignalUpdate(b, { body: "ok gracias" }), null);
});

test("programSignalUpdate: a mini age drops the campaign's 'baby' discipline (Joss)", () => {
  const f = fixture("joss_bfc_mini");
  const next = programSignalUpdate(JSON.parse(f.contact.qualification!), { body: f.messages[2]!.body })!;
  assert.equal(next.program, "mini");
  assert.equal(next.discipline, undefined);
  assert.equal(classifyProgram(contact({ qualification: JSON.stringify(next) }), f.campaign), "mini");
});

test("discipline from the ad fills an empty qualification only", () => {
  assert.equal(disciplineFromAdText("Prueba Muay Thai gratis en la Condesa"), "muay");
  assert.equal(disciplineFromAdText("Jiu-Jitsu, Muay Thai, MMA y Box"), null);
  assert.equal(disciplineFromAdText("Baby Fight Club"), null);
  const u = programSignalUpdate({}, { body: "Hola, quiero info", adText: "Clase de Muay Thai gratis" })!;
  assert.equal(u.discipline, "muay");
  assert.equal(programSignalUpdate({ discipline: "jiu" }, { body: "Hola", adText: "Muay Thai" }), null);
});

test("cleanDayKeys / mergeQualUpdate", () => {
  assert.deepEqual(cleanDayKeys(["Sábado", "dom", "x", 3, "mié"]), ["sab", "dom", "mie"]);
  const m = mergeQualUpdate({ child_age_months: 48, declined_days: ["sab"] }, { preferred_days: ["sab"], child_name: "Cami" })!;
  assert.deepEqual(m.preferred_days, ["sab"]);
  assert.equal(m.declined_days, undefined);
  assert.equal(m.child_age_months, 48, "an update without age keeps the stated one");
  assert.equal(mergeQualUpdate(m, { child_name: "Cami" }), null);
  const n = mergeQualUpdate(m, { child_age_months: 30 })!;
  assert.equal(n.program, "baby");
});

// ---- 3. <context>: band in words, band slots, day-complete, combo, facts ----

test("joss_bfc_mini turn 09–12: age 58 m on a BFC campaign → Mini hours only", () => {
  const f = fixture("joss_bfc_mini");
  const qual = JSON.stringify({ ...JSON.parse(f.contact.qualification!), child_age_months: 58 });
  for (const turn of [9, 10, 12]) {
    const ctx = ctxFrom(f, turn, qual);
    assert.equal(classifyProgram(ctx.contact, f.campaign), "mini");
    const text = upcomingSlotLines(ctx).join("\n");
    assert.match(text, /programa por edad: Mini Muay Thai \(3–5 años\)/);
    assert.match(text, /3:15 pm/, text); // lun/mié Mini
    assert.ok(!/1:00 pm|2:00 pm/.test(text), `no BFC hours: ${text}`);
    assert.ok(!/Baby Fight Club/.test(text), text);
  }
});

test("jess_muay_9am: Muay Thai ad → Saturday lists 10:00 Muay Thai first + the add-on line", () => {
  const f = fixture("jess_muay_9am");
  const ctx = ctxFrom(f, 0, JSON.stringify({ discipline: "muay" }));
  const lines = upcomingSlotLines(ctx);
  const day = lines.find((l) => l.startsWith("todas las opciones"))!;
  assert.ok(day, lines.join("\n"));
  const sat = day.split(" | ").find((d) => d.includes("sábado"))!;
  assert.match(sat, /: 10:00 am Muay Thai, /, sat);
  assert.ok(sat.indexOf("10:00 am Muay Thai") < sat.indexOf("9:00 am Jiu-Jitsu"), sat);
  const combo = lines.find((l) => l.startsWith("combo"))!;
  assert.ok(combo, lines.join("\n"));
  assert.match(combo, /llegada es Muay Thai mañana sábado 10:00 am/);
  assert.match(combo, /Jiu-Jitsu 9:00 am \(justo antes\) es OPCIONAL de pilón/);
  const soon = lines.find((l) => l.startsWith("próximos horarios"))!;
  assert.match(soon, /^próximos horarios válidos de Muay Thai .*mañana sábado 10:00 am \(Muay Thai\)/);
});

test("known facts: child name, age and declined days are visible", () => {
  assert.equal(
    knownFactsLine({ child_name: "Camila", child_age_months: 58, declined_days: ["lun", "mar", "mie", "jue", "vie"] }),
    "el lead ya dijo: peque: Camila; edad: 4 años 10 meses; entre semana NO (nunca lo vuelvas a ofrecer)",
  );
  assert.equal(knownFactsLine({}), null);
  const block = buildContextBlock({
    phone: "5215550000000",
    contact: q({ child_age_months: 58, declined_days: ["lun", "mar", "mie", "jue", "vie"] }),
    history: [],
    nowCdmx: "2026-09-25T20:28",
    weekday: "viernes",
    windowOpen: true,
    trainingWheels: true,
  });
  assert.match(block, /entre semana NO/);
  // Declined days are filtered out of the slot lines too.
  const slots = block.split("\n").filter((l) => l.startsWith("próximos") || l.startsWith("todas"));
  assert.ok(slots.length >= 1);
  for (const l of slots) assert.ok(!/lunes|miércoles/.test(l), l);
});

// ---- 4. book_trial: band validation + one booking per person ----

test("validateSlotBand rejects a Kids row for a Mini child, naming the Mini options", () => {
  const r = validateSlotBand("2026-10-05", "16:00", "muay", "mini");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /Kids \(6–12 años\)/);
  assert.match(r.reason!, /Same-day Mini Muay Thai \(3–5 años\) options: 15:15/);
  assert.match(r.reason!, /lun 15:15 muay · mié 15:15 muay · sáb 13:15 muay/);
  assert.equal(validateSlotBand("2026-10-05", "15:15", "muay", "mini").ok, true);
});

test("liliana_kids_mini: a 3-year-old booked into Kids 16:00 is rejected with Mini alternatives", async () => {
  const f = fixture("liliana_kids_mini");
  const qual = JSON.stringify({ ...JSON.parse(f.contact.qualification!), child_age_months: 36 });
  const ctx = ctxFrom(f, 20, qual);
  let booked = 0;
  const airtable = { bookTrial: async () => { booked++; return "rec1"; } };
  const tu = (input: Record<string, unknown>) => ({ type: "tool_use" as const, id: "t1", name: "book_trial", input });
  const base = { name: "Liliana", child_name: "David Emmanuel", discipline: "muay", audience: "kid", trial_date: "2026-10-05", followup_message: "ok" };

  const bad = await handleBookTrial(airtable, ctx, tu({ ...base, trial_time: "16:00" }));
  assert.equal(booked, 0);
  assert.equal(bad.result.is_error, true);
  assert.match(bad.result.content, /Mini Muay Thai/);
  assert.match(bad.result.content, /15:15/);

  // child_age on the call wins even with nothing stored.
  const ctx2 = ctxFrom(f, 20, null);
  const bad2 = await handleBookTrial(airtable, ctx2, tu({ ...base, trial_time: "16:00", child_age: 3 }));
  assert.equal(bad2.result.is_error, true);

  const ok = await handleBookTrial(airtable, ctx, tu({ ...base, trial_time: "15:15", child_age: 3 }));
  assert.equal(booked, 1);
  assert.equal(ok.booking!.input.program, "mini");
  assert.equal(ok.booking!.input.childAgeMonths, 36);

  // A parent booking their OWN adult class is never band-checked.
  const own = await handleBookTrial(airtable, ctx, tu({ name: "Liliana", discipline: "muay", audience: "adult", trial_date: "2026-10-05", trial_time: "18:00", followup_message: "ok" }));
  assert.equal(own.result.is_error, undefined);
});

test("one booking per person per turn; a family still books twice", () => {
  const mk = (name: string, childName: string | undefined, time: string): PendingBooking => ({
    input: { name, discipline: "muay", audience: "kid", trialDate: "2026-10-05", trialTime: time, phone: "521", ...(childName ? { childName } : {}) } as BookTrialInput,
    followupMessage: time,
    recordId: `rec-${time}`,
  });
  const list: PendingBooking[] = [];
  addPendingBooking(list, mk("Ana", "Leo", "16:00"));
  addPendingBooking(list, mk("Ana", "Leo", "15:15"));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.input.trialTime, "15:15");
  addPendingBooking(list, mk("Ana", "Mía", "16:00"));
  assert.equal(list.length, 2);
});

test("bookingQualification merges — the stated age survives the booking", () => {
  const b: BookTrialInput = { name: "Ana", discipline: "muay", audience: "kid", trialDate: "2026-10-05", trialTime: "15:15", phone: "521", childName: "Leo", program: "mini", childAgeMonths: 48 };
  const out = bookingQualification(JSON.stringify({ declined_days: ["sab"], child_age_months: 47 }), b);
  assert.deepEqual(out, { declined_days: ["sab"], child_age_months: 48, discipline: "muay", audience: "kid", name: "Ana", child_name: "Leo", program: "mini" });
  assert.equal(bookingQualification("{bad", { ...b, childAgeMonths: undefined, program: undefined }).child_age_months, undefined);
});

// ---- 5. send_reply facts ----

test("qualUpdateFromInput reads the new send_reply fields", () => {
  assert.deepEqual(
    qualUpdateFromInput({ child_name: "Camila", child_age_years: 4.9, declined_days: ["lun", "mar"], preferred_days: "sab" }),
    { child_name: "Camila", child_age_months: 59, declined_days: ["lun", "mar"] },
  );
  assert.equal(qualUpdateFromInput({ child_age_years: "" }), undefined);
  assert.equal(qualUpdateFromInput({ child_age_years: 30 }), undefined);
});

// ---- 6. history ----

test("trimHistory: 7 days / 3000 tokens for kid leads or live bookings, else 48h / 1000", () => {
  const now = 2_000_000_000;
  const msg = (agoH: number, chars: number): StoredMessage =>
    ({ id: agoH, phone: "521", direction: "in", body: "x".repeat(chars), ts: now - agoH * 3600, wamid: null }) as unknown as StoredMessage;
  const hist = [msg(100, 100), msg(30, 2800), msg(1, 2800)];
  assert.equal(trimHistory(hist, false, now).length, 1);
  assert.equal(trimHistory(hist, true, now).length, 3);
  assert.equal(wantsLongHistory({ contact: q({ child_age_months: 48 }) }), true);
  assert.equal(wantsLongHistory({ contact: q({ audience: "adult" }) }), false);
  assert.equal(wantsLongHistory({ contact: contact(), recordedBooking: { ts: now } }), true);
});

// ---- 7. slot/fact guard ----

test("mini_loop: 'el lunes a la 1:15 pm' is flagged with the real options", () => {
  const f = fixture("mini_loop");
  const ctx = ctxFrom(f, 4, f.contact.qualification);
  const r = guardUnverifiedSlotClaim(sendRes(f.messages[4]!.body), ctx);
  assert.equal(r.action, "draft");
  if (r.action === "draft") {
    assert.match(r.reason ?? "", /lunes 1:15 pm/);
    assert.match(r.reason ?? "", /Opciones reales de Kids \(6–12 años\) el lunes: 4:00 pm Muay Thai/);
    assert.equal(r.sureness, undefined);
  }
  // With the age known, the options are Mini's.
  const mini = guardUnverifiedSlotClaim(
    sendRes(f.messages[6]!.body),
    ctxFrom(f, 6, JSON.stringify({ child_age_months: 48 })),
  );
  assert.equal(mini.action, "draft");
  if (mini.action === "draft") assert.match(mini.reason ?? "", /Mini Muay Thai.*3:15 pm/);
});

test("kids_saturday_false: 'No hay Kids el sábado' is flagged", () => {
  const f = fixture("kids_saturday_false");
  const ctx = ctxFrom(f, 10, JSON.stringify({ audience: "kid", child_age_months: 108 }));
  const r = guardUnverifiedSlotClaim(sendRes(f.messages[10]!.body), ctx);
  assert.equal(r.action, "draft");
  if (r.action === "draft") assert.match(r.reason ?? "", /no hay Kids \(6–12 años\) el sábado, pero SÍ hay: 11:00 am Jiu-Jitsu, 12:00 pm Muay Thai/);
});

test("guard keeps false positives low", () => {
  const f = fixture("jess_muay_9am");
  const ctx = ctxFrom(f, 1, JSON.stringify({ discipline: "muay" }));
  // Real Saturday combo: both rows exist.
  assert.equal(guardUnverifiedSlotClaim(sendRes(f.messages[1]!.body), ctx).action, "send");
  // No explicit day → never judged.
  assert.deepEqual(findSlotClaimIssues("Es a las 3:15 pm 🙌", 0, { band: "kids", discipline: null }), []);
  // "en la mañana" is not "tomorrow".
  assert.deepEqual(findSlotClaimIssues("Tenemos clases en la mañana a las 7 am", 0, { band: "adults", discipline: null }), []);
  // Sunday morning for adults: 11 am Muay Thai is real, 9 am is not.
  assert.equal(findSlotClaimIssues("el domingo a las 11 am Muay Thai", 0, { band: "adults", discipline: "muay" }).length, 0);
  assert.equal(findSlotClaimIssues("el domingo a las 9 am", 0, { band: "adults", discipline: "muay" }).length, 1);
});

test("validateSlotBand: a 2-year-old cannot book Nivel 0 Friday 12 pm, a 7-month-old cannot book Wed 1 pm", () => {
  const big = validateSlotBand("2026-10-23", "12:00", "baby", "baby", undefined, 24);
  assert.equal(big.ok, false);
  assert.match(big.reason ?? "", /6–11 meses/);
  assert.match(big.reason ?? "", /mié 13:00|sáb 14:00/);
  const small = validateSlotBand("2026-10-21", "13:00", "baby", "baby", undefined, 7);
  assert.equal(small.ok, false);
  assert.match(small.reason ?? "", /vie 12:00/);
  assert.equal(validateSlotBand("2026-10-23", "12:00", "baby", "baby", undefined, 7).ok, true);
  assert.equal(validateSlotBand("2026-10-23", "12:00", "baby", "baby").ok, true); // unknown age → band only
});
