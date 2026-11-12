// 2026-11-11 graded review of 475 conversations: nudges that ignore the chat,
// repetition / template overload, nudges right after a deferral, pre-release
// declines never stopped, junk greeting names. Fake clocks, CDMX wall time.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adultInText,
  conversationFacts,
  daysInText,
  deferUntilInText,
  disciplineInText,
  excludedDatesInText,
  lastInboundBurst,
  statementText,
  timeRangesInText,
  type ConvoMessage,
} from "../src/cron/nudge-context.js";
import {
  armHold,
  bandForConversation,
  campaignTimeRanges,
  deferralVerdict,
  isFinalStep,
  parseProposedSlots,
  planNudgeCopy,
  recordProposedSlot,
} from "../src/cron/nudges.js";
import { nudgeCopy, extendedCopy, classifyProgram, isTeensCampaign } from "../src/cron/nudge-copy.js";
import { DEFERRAL_HOLD_SECONDS, detectDecline, detectDeferral, isObjection } from "../src/pipeline/decline.js";
import {
  CEILING_ENFORCED_KINDS,
  DEFAULT_SEND_CEILING,
  SEND_CEILING,
  ceilingNote,
  ceilingVerdict,
  resolveSendCeiling,
  sentChasingSql,
} from "../src/cron/send-ceiling.js";
import {
  isCourtesy,
  maskPhone,
  parseBackfillBody,
  planDeclineBackfill,
  runDeclineBackfill,
} from "../src/services/decline-backfill.js";
import { greetingName } from "../src/cron/display-name.js";
import { CLIENT } from "../src/client.gen.js";
import { cdmxDateStr, cdmxParts, cdmxToEpoch, DAY } from "../src/cron/time.js";
import { next8am } from "../src/cron/quiet.js";
import type { Contact } from "../src/types.js";

const H = 3600;
/** Tuesday 2026-11-17 10:00 CDMX (Monday the 16th is a closed holiday). */
const TUE_10 = cdmxToEpoch(2026, 11, 17, 10, 0, 0);

function contact(over: Partial<Contact> = {}): Contact {
  return {
    phone: "5215512345678",
    name: "Laura",
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: TUE_10 - H,
    campaign_id: 1,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: TUE_10 - 2 * H,
    updated_at: TUE_10 - H,
    ...over,
  };
}

const lead = (body: string, ts: number): ConvoMessage => ({ direction: "in", body, ts });
const bot = (body: string, ts: number): ConvoMessage => ({ direction: "out_bot", body, ts });

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

// ---- 1. the conversation beats the campaign default ---------------------------

test("disciplineInText: the lead's choice, negated mentions dropped", () => {
  assert.equal(disciplineInText("no, quisiera Box"), "box"); // A32
  assert.equal(disciplineInText("Box"), "box"); // A46
  assert.equal(disciplineInText("Estoy interesado en Jiu jitsu más que en MMA"), "jiu"); // A24
  assert.equal(disciplineInText("Muay Thai"), "muay"); // A125, A218
  assert.equal(disciplineInText("MMA y Jiu-Jitsu"), null);
  assert.equal(disciplineInText("hola, info"), null);
});

test("A32/A46: MMA campaign, lead said Box → the nudge proposes Boxing, never MMA", () => {
  const msgs = [lead("Quiero info de MMA", TUE_10 - 3 * H), bot("¿Qué disciplina te interesa?", TUE_10 - 3 * H + 60), lead("no, quisiera Box", TUE_10 - 2 * H)];
  const plan = planNudgeCopy(contact(), "fw mma", msgs, TUE_10);
  assert.equal(plan.band, "adults");
  assert.equal(plan.facts.discipline, "box");
  if (plan.slot) assert.equal(plan.slot.discipline, "box");
  const body = nudgeCopy(plan.contact, "nudge_1h", plan.campaignName, TUE_10, plan.schedule, { slot: plan.slot, cta: plan.cta });
  assert.doesNotMatch(body, /MMA/);
  assert.match(body, /Boxing/);
});

test("A24: 'Jiu jitsu más que MMA' → Jiu-Jitsu slot", () => {
  const msgs = [lead("Estoy interesado en Jiu jitsu más que en MMA", TUE_10 - 2 * H)];
  const plan = planNudgeCopy(contact(), "fw mma", msgs, TUE_10);
  assert.equal(plan.slot?.discipline, "jiu");
});

test("A261: kids campaign, lead answered 'Adultos' → adult copy (no 'tu peque')", () => {
  assert.equal(adultInText("Adultos"), true);
  assert.equal(adultInText("para mí"), true);
  assert.equal(adultInText("para mi hijo"), false);
  const msgs = [lead("Hola, info de las clases", TUE_10 - 3 * H), bot("¿Las clases son para ti o para tu peque?", TUE_10 - 3 * H + 30), lead("Adultos", TUE_10 - 2 * H)];
  const plan = planNudgeCopy(contact(), "Kids Jiu-Jitsu noviembre", msgs, TUE_10);
  assert.equal(plan.band, "adults");
  const body = nudgeCopy(plan.contact, "nudge_1h", plan.campaignName, TUE_10, plan.schedule, { slot: plan.slot, cta: plan.cta });
  assert.doesNotMatch(body, /peque|bebé/);
});

test("a stated child age still wins over a later 'para adultos' question", () => {
  const c = contact({ qualification: JSON.stringify({ child_age_months: 84, program: "kids", audience: "kid" }) });
  const facts = conversationFacts([lead("¿y para adultos también hay?", TUE_10 - H)], TUE_10);
  assert.equal(bandForConversation(c, null, facts), "kids");
});

test("baby lead with unknown age → no slot, the nudge asks the months (Nivel 0 is Friday 12 pm)", () => {
  const plan = planNudgeCopy(contact(), "Baby Fight Club", [lead("Info de Baby Fight Club", TUE_10 - 2 * H)], TUE_10);
  assert.equal(plan.band, "baby");
  assert.equal(plan.cta, "ask_age");
  assert.equal(plan.slot, null);
  const body = nudgeCopy(plan.contact, "nudge_1h", plan.campaignName, TUE_10, plan.schedule, { slot: plan.slot, cta: plan.cta });
  assert.match(body, /Cuántos meses tiene tu bebé/);
  assert.doesNotMatch(body, /miércoles a la 1:00 pm|sábado a las 2:00 pm/);
});

test("kids lead with unknown age → asks the age instead of Kids 4 pm (A265, A179)", () => {
  const plan = planNudgeCopy(contact(), "Kids Muay Thai", [lead("Info para mi hijo", TUE_10 - 2 * H)], TUE_10);
  assert.equal(plan.cta, "ask_age");
  const body = extendedCopy(plan.contact, "nudge_d2", plan.program, TUE_10, plan.schedule, plan.campaignName, true, { slot: plan.slot, cta: plan.cta });
  assert.match(body, /Qué edad tiene tu peque/);
});

test("baby with a known age keeps its concrete slot (Nivel 0 → Friday 12 pm)", () => {
  const c = contact({ qualification: JSON.stringify({ child_age_months: 8, program: "baby", audience: "kid", discipline: "baby" }) });
  const plan = planNudgeCopy(c, "Baby Fight Club", [lead("tiene 8 meses", TUE_10 - 2 * H)], TUE_10);
  assert.equal(plan.cta, "slot");
  assert.equal(plan.slot?.weekday, 4);
  assert.equal(plan.slot?.time, "12:00");
});

test("Teens campaign / 'hijo adolescente' → Teens rows (Mon–Thu 4 pm), never Kids or adult (B68, B79, B142)", () => {
  assert.equal(isTeensCampaign("Teens MMA"), true);
  assert.equal(isTeensCampaign("Kids y Teens"), false);
  assert.equal(classifyProgram(null, "Teens MMA"), "teens");
  const a = planNudgeCopy(contact(), "Teens MMA", [lead("Info", TUE_10 - 2 * H)], TUE_10);
  assert.equal(a.band, "teens");
  assert.ok(a.slot && a.slot.weekday <= 3 && a.slot.time === "16:00", JSON.stringify(a.slot));
  const b = planNudgeCopy(contact(), "Kids Jiu-Jitsu", [lead("Es para mi hijo adolescente", TUE_10 - 2 * H)], TUE_10);
  assert.equal(b.band, "teens");
  assert.ok(b.slot && b.slot.weekday <= 3 && b.slot.time === "16:00", JSON.stringify(b.slot));
});

test("'solo fines de semana' → a Saturday/Sunday slot; 'el lunes no puedo' declines Monday (A76, A229)", () => {
  assert.deepEqual(daysInText("solo fines de semana").preferred, [5, 6]);
  assert.deepEqual(daysInText("entre semana no puedo").declined, [0, 1, 2, 3, 4]);
  assert.deepEqual(daysInText("el lunes no puedo").declined, [0]);
  assert.deepEqual(daysInText("el lunes no puedo").preferred, null);
  assert.deepEqual(daysInText("¿y el sábado?").preferred, [5]);
  const plan = planNudgeCopy(contact(), "fw mma", [lead("solo fines de semana", TUE_10 - 2 * H)], TUE_10);
  assert.ok(plan.slot && (plan.slot.weekday === 5 || plan.slot.weekday === 6), JSON.stringify(plan.slot));
});

test("time of day: 'por las tardes' → 12–8 pm; 'estudio en las mañanas' → after noon; 'salgo hasta las 9 pm' → nothing fits (A105, A210, A235)", () => {
  assert.deepEqual(timeRangesInText("por las tardes"), [[720, 1200]]);
  assert.deepEqual(timeRangesInText("estudio en las mañanas"), [[720, 1440]]);
  assert.deepEqual(timeRangesInText("salgo hasta las 9 pm"), [[1290, 1440]]);
  assert.deepEqual(timeRangesInText("salgo del trabajo a las 6"), [[1110, 1440]]);
  assert.deepEqual(timeRangesInText("en la mañana"), [[0, 720]]);
  assert.equal(timeRangesInText("mañana a las 10"), null); // "mañana" = tomorrow
  const tardes = planNudgeCopy(contact(), "fw mma", [lead("por las tardes", TUE_10 - 2 * H)], TUE_10);
  assert.ok(tardes.slot && minutes(tardes.slot.time) >= 720 && minutes(tardes.slot.time) < 1200, JSON.stringify(tardes.slot));
  const nine = planNudgeCopy(contact(), "fw mma", [lead("salgo hasta las 9 pm", TUE_10 - 2 * H)], TUE_10);
  assert.equal(nine.slot, null);
  assert.equal(nine.cta, "link");
});

test("morning-promo campaign → morning slot by default (morning-ad leads were offered 6–8 pm)", () => {
  assert.deepEqual(campaignTimeRanges("Promo matutino"), [[0, 720]]);
  assert.equal(campaignTimeRanges("fw mma"), null);
  const plan = planNudgeCopy(contact({ last_inbound_at: TUE_10 - H }), "Promo matutino", [lead("info", TUE_10 - 2 * H)], cdmxToEpoch(2026, 11, 17, 13, 0, 0));
  assert.ok(plan.slot && minutes(plan.slot.time) < 720, JSON.stringify(plan.slot));
});

test("'hoy tengo trabajo' / 'hoy no puedo' rules out today's date (A244, A47)", () => {
  assert.deepEqual(excludedDatesInText("hoy tengo trabajo", TUE_10), ["2026-11-17"]);
  assert.deepEqual(excludedDatesInText("mañana no puedo", TUE_10), ["2026-11-18"]);
  assert.deepEqual(excludedDatesInText("en la mañana no puedo", TUE_10), []);
  const plan = planNudgeCopy(contact(), "fw mma", [lead("Hoy no puedo, pero qué otros días tienes", TUE_10 - H)], TUE_10);
  assert.ok(plan.slot && plan.slot.date !== "2026-11-17", JSON.stringify(plan.slot));
});

test("deferUntilInText: next week / next month / back on the 20th / in a month; questions defer nothing", () => {
  assert.equal(deferUntilInText("mejor la próxima semana", TUE_10), cdmxToEpoch(2026, 11, 23, 0, 0, 0));
  assert.equal(deferUntilInText("el otro mes", TUE_10), cdmxToEpoch(2026, 12, 1, 0, 0, 0));
  assert.equal(deferUntilInText("regreso de viaje el 20", TUE_10), cdmxToEpoch(2026, 11, 20, 0, 0, 0));
  assert.equal(deferUntilInText("regreso el 3", TUE_10), cdmxToEpoch(2026, 12, 3, 0, 0, 0));
  assert.equal(deferUntilInText("en un mes", TUE_10), cdmxToEpoch(2026, 11, 17, 0, 0, 0) + 30 * DAY);
  assert.equal(deferUntilInText(statementText("¿Cierran en diciembre?"), TUE_10), null);
  assert.equal(deferUntilInText("en diciembre", TUE_10), cdmxToEpoch(2026, 12, 1, 0, 0, 0));
});

test("A152/A285: 'la próxima semana' → day-1 nudges cancelled, extended waits, slot from next Monday", () => {
  const msgs = [lead("Mejor la próxima semana", TUE_10 - H)];
  const plan = planNudgeCopy(contact(), "fw mma", msgs, TUE_10);
  const monday = cdmxToEpoch(2026, 11, 23, 0, 0, 0);
  assert.equal(plan.facts.deferUntil, monday);
  assert.ok(plan.slot && plan.slot.date >= "2026-11-23", JSON.stringify(plan.slot));
  assert.deepEqual(deferralVerdict(plan.facts, { day1: true, isFinal: false }, TUE_10), { act: "cancel" });
  const ext = deferralVerdict(plan.facts, { day1: false, isFinal: false }, TUE_10);
  assert.equal(ext.act, "defer");
  if (ext.act === "defer") assert.equal(cdmxDateStr(ext.until), "2026-11-23");
  // arm time: re-anchored so the first extended step lands on the 23rd, 10:00.
  const hold = armHold(plan.facts, TUE_10);
  assert.ok(hold && hold.anchor !== null && hold.goodbyeAt === null);
  assert.equal(hold!.anchor! + DAY, monday + 10 * H);
  // a deferral more than 3 weeks out arms nothing at all
  const far = conversationFacts([lead("regresamos en enero", TUE_10 - H)], TUE_10);
  assert.deepEqual(armHold(far, TUE_10), { goodbyeAt: null, anchor: null });
});

test("8h nudge never repeats the 1h slot: proposed-slot memory (~105 conversations)", () => {
  const msgs = [lead("Quiero info de Muay Thai", TUE_10 - 2 * H)];
  const first = planNudgeCopy(contact(), null, msgs, TUE_10);
  assert.ok(first.slot);
  const raw = recordProposedSlot(null, first.slot!, TUE_10);
  const keys = parseProposedSlots(raw, TUE_10 + 7 * H);
  assert.ok(keys.has(`${first.slot!.date} ${first.slot!.time}`));
  const second = planNudgeCopy(contact(), null, msgs, TUE_10 + 7 * H, { proposedKeys: keys });
  assert.ok(second.slot);
  assert.notEqual(`${second.slot!.date} ${second.slot!.time}`, `${first.slot!.date} ${first.slot!.time}`);
  // memory expires after 48h
  assert.equal(parseProposedSlots(raw, TUE_10 + 49 * H).size, 0);
});

test("our own last message proposed a time → the nudge keeps it instead of offering another (A116, A230, A275)", () => {
  const msgs = [lead("Muay Thai", TUE_10 - 3 * H), bot("¡Va! Te late mañana miércoles a las 7 pm? ¿Me confirmas tu nombre?", TUE_10 - 2 * H)];
  const plan = planNudgeCopy(contact(), null, msgs, TUE_10);
  assert.equal(plan.cta, "keep_offer");
  const body = nudgeCopy(plan.contact, "nudge_1h", plan.campaignName, TUE_10, plan.schedule, { slot: plan.slot, cta: plan.cta });
  assert.match(body, /el horario que te comenté/);
  // a previous NUDGE naming a time is not a negotiated offer
  const own = planNudgeCopy(contact(), null, [lead("Muay Thai", TUE_10 - 9 * H), bot("¡Hola! Te puedo apartar lugar en Muay Thai hoy a las 7:00 pm — ¿te late?", TUE_10 - 8 * H)], TUE_10);
  assert.notEqual(own.cta, "keep_offer");
});

test("the goodbye step keeps its link-only close whatever the plan", () => {
  const plan = planNudgeCopy(contact(), null, [lead("Muay Thai", TUE_10 - 3 * H)], TUE_10);
  const body = extendedCopy(plan.contact, "nudge_d7", plan.program, TUE_10, plan.schedule, plan.campaignName, true, { slot: plan.slot, cta: plan.cta });
  assert.doesNotMatch(body, /apartar lugar/);
});

// ---- 2. hard per-lead ceiling ---------------------------------------------------

test("ceiling: config lands in client.gen.ts and resolves to 1/day, 4/7 days", () => {
  assert.deepEqual(CLIENT.nudgePolicy?.ceiling, { perDay: 1, per7Days: 4, firstDay: 3 });
  assert.deepEqual(SEND_CEILING, { perDay: 1, per7Days: 4, firstDay: 3 });
  assert.deepEqual(resolveSendCeiling(null), DEFAULT_SEND_CEILING);
  assert.deepEqual(resolveSendCeiling({ perDay: 0, per7Days: -2 }), DEFAULT_SEND_CEILING);
  assert.deepEqual(resolveSendCeiling({ perDay: 2, per7Days: 5 }), { perDay: 2, per7Days: 5 });
});

test("ceiling: second unsolicited message on the same CDMX day — day-1 dropped, others wait for 08:00", () => {
  const C = DEFAULT_SEND_CEILING; // no first-day allowance
  const last = TUE_10 - 2 * H;
  const sent = [TUE_10 - H];
  assert.deepEqual(ceilingVerdict("nudge_8h", sent, last, TUE_10 + 6 * H, C), { ok: false, scope: "day", action: "cancel", retryAt: next8am(TUE_10 + 6 * H) });
  const d = ceilingVerdict("no_show_d2", sent, last, TUE_10 + 6 * H, C);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.action, "defer");
  // next CDMX day it goes
  assert.deepEqual(ceilingVerdict("nudge_d2", sent, last, TUE_10 + DAY, C), { ok: true });
});

test("ceiling: first 24 h after the lead's message allow 3 (1 h + 8 h both go), then 1 per day (owner 2026-11-11)", () => {
  assert.equal(SEND_CEILING.firstDay, 3);
  assert.equal(SEND_CEILING.perDay, 1);
  const last = TUE_10;
  // 1 h nudge went → the 8 h one still goes
  assert.deepEqual(ceilingVerdict("nudge_8h", [last + H], last, last + 8 * H), { ok: true });
  // two went → a third inside 24 h still goes; a fourth does not
  assert.deepEqual(ceilingVerdict("nudge_d2", [last + H, last + 8 * H], last, last + 23 * H), { ok: true });
  const v = ceilingVerdict("nudge_d2", [last + H, last + 8 * H, last + 20 * H], last, last + 23 * H);
  assert.equal(v.ok, false);
  // past 24 h the 1-per-CDMX-day rule is back
  const later = last + 2 * DAY;
  const w = ceilingVerdict("no_show_d2", [later - H], last, later);
  assert.equal(w.ok, false);
  // config: firstDay survives resolve; junk is dropped
  assert.equal(resolveSendCeiling({ perDay: 1, per7Days: 4, firstDay: 3 }).firstDay, 3);
  assert.equal(resolveSendCeiling({ perDay: 1, per7Days: 4, firstDay: 0 }).firstDay, undefined);
  assert.match(ceilingNote(new Map([["día nudge_8h", 1]]))!, /3 en las primeras 24 h/);
});

test("ceiling: 4 unanswered in 7 days stops the 5th; a reply from the lead resets it (A258, A224)", () => {
  const sent = [TUE_10, TUE_10 + DAY, TUE_10 + 3 * DAY, TUE_10 + 5 * DAY];
  assert.deepEqual(ceilingVerdict("nudge_d7", sent, TUE_10 - H, TUE_10 + 6 * DAY), { ok: false, scope: "week", action: "cancel" });
  assert.deepEqual(ceilingVerdict("nudge_d7", sent, TUE_10 + 5 * DAY + H, TUE_10 + 6 * DAY), { ok: true });
  // older than 7 days does not count
  assert.deepEqual(ceilingVerdict("nudge_d7", sent, TUE_10 - H, TUE_10 + 8 * DAY), { ok: true });
});

test("ceiling: the shipped chains fit (engaged 1h+d2+d4+d7 = 4); blasts and custom count but are not blocked", () => {
  assert.ok(!CEILING_ENFORCED_KINDS.includes("blast"));
  assert.ok(!CEILING_ENFORCED_KINDS.includes("custom"));
  assert.ok(CEILING_ENFORCED_KINDS.includes("nudge_1h") && CEILING_ENFORCED_KINDS.includes("post_trial_d2"));
  const day = (n: number) => TUE_10 + n * DAY;
  const sent = [day(0), day(1), day(3)];
  assert.deepEqual(ceilingVerdict("nudge_d7", sent, TUE_10 - H, day(6)), { ok: true });
  assert.match(sentChasingSql(3), /WHERE phone = \?1 AND status = 'sent' AND due_at >= \?2 AND kind IN \(\?3, \?4, \?5\)/);
  assert.match(ceilingNote(new Map([["día nudge_8h", 2], ["semana nudge_d7", 1]]))!, /3 envío\(s\) detenidos/);
  assert.equal(ceilingNote(new Map()), null);
});

// ---- 3. soft deferral ------------------------------------------------------------

test("which pre-fix deferral cases the DEPLOYED detectors catch: A66 yes (distance); A84, A271 no", () => {
  assert.equal(detectDecline("me queda muy lejos"), "objection"); // A66 — caught since 11-10
  assert.equal(detectDecline("Se complica el sábado… más adelante me comunico"), null); // A84
  assert.equal(detectDecline("Salgo de viaje, a mi regreso les escribo"), null); // A271
});

test("detectDeferral: postponements, not questions or bookings", () => {
  for (const s of [
    "Se complica el sábado… más adelante me comunico", // A84
    "Salgo de viaje, a mi regreso les escribo", // A271
    "No me es posible mañana, pero los contacto más adelante", // A31
    "yo les aviso",
    "Ok, luego les escribo",
    "estoy de viaje",
    "Por ahora no",
    "Deja reviso",
    "Necesito comentarlo con mi esposo",
    "lo voy a pensar",
    "pido permiso y les aviso", // A235 — "les aviso" clause
  ]) {
    assert.equal(detectDeferral(s), true, s);
  }
  for (const s of ["¿más adelante hay más horarios?", "te confirmo mañana", "quiero agendar el sábado", "Muay Thai", "gracias"]) {
    assert.equal(detectDeferral(s), false, s);
  }
});

test("A271: nudge 4 minutes after 'salgo de viaje' → day-1 cancelled; only the goodbye, ≥ 7 days later", () => {
  const t = TUE_10 - 4 * 60;
  const msgs = [bot("¿Te late mañana a las 7 pm?", t - 600), lead("Salgo de viaje, a mi regreso les escribo", t)];
  const facts = conversationFacts(msgs, TUE_10);
  assert.ok(facts.softDeferral);
  assert.deepEqual(deferralVerdict(facts, { day1: true, isFinal: false }, TUE_10), { act: "cancel" });
  assert.deepEqual(deferralVerdict(facts, { day1: false, isFinal: false }, TUE_10), { act: "cancel" });
  const g = deferralVerdict(facts, { day1: false, isFinal: true }, TUE_10);
  assert.equal(g.act, "defer");
  if (g.act === "defer") assert.ok(g.until >= t + DEFERRAL_HOLD_SECONDS);
  assert.deepEqual(deferralVerdict(facts, { day1: false, isFinal: true }, t + DEFERRAL_HOLD_SECONDS + H), { act: "send" });
  const hold = armHold(facts, TUE_10);
  assert.deepEqual(hold, { goodbyeAt: t + DEFERRAL_HOLD_SECONDS, anchor: null });
  assert.equal(isFinalStep("nudge_d7", ["nudge_d2", "nudge_d7"]), true);
  assert.equal(isFinalStep("nudge_d2", ["nudge_d2", "nudge_d7"]), false);
});

test("a later message from the lead supersedes the deferral (only the last burst counts)", () => {
  const msgs = [lead("yo les aviso", TUE_10 - 5 * H), bot("¡Va!", TUE_10 - 5 * H + 60), lead("Ya pude, ¿el sábado a qué hora?", TUE_10 - H)];
  assert.equal(lastInboundBurst(msgs).length, 1);
  assert.equal(conversationFacts(msgs, TUE_10).softDeferral, null);
});

test("objection detector extended conservatively: 'retirado', 'estoy lejos', 'no soy de México'", () => {
  assert.equal(isObjection("Me encantaría pero me queda muy retirado"), true); // A151
  assert.equal(isObjection("Estoy lejos en tlahuac, gracias"), true); // A153
  assert.equal(isObjection("yo no soy de México"), true); // A290
  assert.equal(isObjection("¿Les queda retirado el metro?"), false);
  assert.equal(isObjection("no me queda retirado"), false);
});

// ---- 4. backfill -------------------------------------------------------------------

test("parseBackfillBody: dryRun by default, bounded window", () => {
  assert.deepEqual(parseBackfillBody({}), { ok: true, opts: { dryRun: true, sinceDays: 14, limit: 500 } });
  assert.deepEqual(parseBackfillBody({ dryRun: false, sinceDays: 30 }), { ok: true, opts: { dryRun: false, sinceDays: 30, limit: 500 } });
  assert.equal(parseBackfillBody({ sinceDays: 60 }).ok, false);
  assert.equal(parseBackfillBody({ limit: 0 }).ok, false);
});

test("planDeclineBackfill: latest hit per phone; a real message after it means re-engaged", () => {
  const a = "5215500000001";
  const b = "5215500000002";
  const c = "5215500000003";
  const inbound = [
    { phone: a, direction: "in", body: "me queda muy lejos", ts: 100 },
    { phone: a, direction: "in", body: "gracias", ts: 200 },
    { phone: b, direction: "in", body: "no me interesa", ts: 100 },
    { phone: b, direction: "in", body: "bueno, ¿el sábado a qué hora es?", ts: 300 },
    { phone: c, direction: "in", body: "info", ts: 50 },
  ];
  const outbound = [{ phone: c, direction: "out_bot", body: "Sin bronca, no te mandamos más mensajes sobre esto 🙏", ts: 60 }];
  const r = planDeclineBackfill(inbound, outbound);
  assert.equal(r.reengaged, 1);
  assert.deepEqual(r.hits.map((h) => [h.phone, h.source]).sort(), [[a, "objection"], [c, "promise"]]);
  assert.equal(isCourtesy("👍"), true);
  assert.equal(isCourtesy("¿cuánto cuesta?"), false);
  assert.equal(maskPhone(a), "…0001");
});

test("runDeclineBackfill: dry run counts, apply writes the marker + cancels via applyDecline", async () => {
  const phone = "5215500000009";
  const kv = new Map<string, string>();
  const updates: string[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...v: unknown[]) {
          binds = v;
          return stmt;
        },
        async all() {
          if (/FROM messages WHERE direction = 'in'/.test(sql)) {
            assert.equal(typeof binds[0], "number");
            return { results: [{ phone, direction: "in", body: "No me interesa, gracias", ts: TUE_10 - 3 * DAY }] };
          }
          if (/FROM messages/.test(sql)) return { results: [] };
          if (/FROM kv WHERE key IN/.test(sql)) return { results: [...kv.entries()].filter(([k]) => binds.includes(k)).map(([key, value]) => ({ key, value })) };
          return { results: [] };
        },
        async first() {
          if (/FROM contacts/.test(sql)) return { status: "lead" };
          if (/status IN \('scheduled', 'paused'\)/.test(sql)) return { n: 5 };
          if (/status = 'sent' AND due_at >/.test(sql)) return { n: 3 };
          if (/FROM kv WHERE key = \?1/.test(sql)) return kv.has(String(binds[0])) ? { value: kv.get(String(binds[0])) } : null;
          return null;
        },
        async run() {
          if (/INSERT INTO kv|INSERT OR REPLACE INTO kv|ON CONFLICT/.test(sql)) kv.set(String(binds[0]), String(binds[1]));
          if (/UPDATE followups SET status = 'cancelled'/.test(sql)) updates.push(sql);
          return { meta: { changes: /UPDATE followups/.test(sql) ? 5 : 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  const dry = await runDeclineBackfill(db, { dryRun: true, sinceDays: 14, limit: 500 }, TUE_10);
  assert.equal(dry.candidates, 1);
  assert.equal(dry.pendingRows, 5);
  assert.equal(dry.messagedAfterDecline, 1);
  assert.equal(dry.applied, 0);
  assert.equal(dry.sample[0]!.phone, "…0009");
  assert.equal(kv.size, 0);
  const notes: string[] = [];
  const live = await runDeclineBackfill(db, { dryRun: false, sinceDays: 14, limit: 500 }, TUE_10, { postNote: async (t) => void notes.push(t) });
  assert.equal(live.applied, 1);
  assert.equal(live.cancelledRows, 5);
  assert.equal(updates.length, 1);
  assert.equal(notes.length, 1);
});

// ---- 5. junk first names --------------------------------------------------------------

test("greetingName: words and businesses are not names ('Hola Simplemente', 'Hola En', 'Hola Para')", () => {
  for (const raw of [
    "Simplemente",
    "En",
    "Para",
    "Simplemente yo ✨",
    "Organizacion Deportiva",
    "BabyFusion México Tribu Mamá Koala",
    "Memento Mori",
    "Bendiciones 🙏",
    "Gym Power",
    "Spa Relax",
    "🙏🙏",
  ]) {
    assert.equal(greetingName(raw), "", raw);
  }
  for (const [raw, want] of [["Pam", "Pam"], ["raul ramirez", "Raul"], ["Paz", "Paz"], ["Itzel", "Itzel"], ["Ángel", "Ángel"]] as const) {
    assert.equal(greetingName(raw), want, raw);
  }
});

test("a junk profile name never reaches the nudge greeting", () => {
  const plan = planNudgeCopy(contact({ name: "Simplemente" }), null, [lead("Muay Thai", TUE_10 - 2 * H)], TUE_10);
  const body = nudgeCopy(plan.contact, "nudge_1h", plan.campaignName, TUE_10, plan.schedule, { slot: plan.slot, cta: plan.cta });
  assert.match(body, /^¡Hola! /);
  assert.ok(cdmxParts(TUE_10).hour === 10);
});
