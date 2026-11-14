// Buen Fin 2026 (2026-11-14): the «Quiero inscribirme» quick reply goes to
// staff (Evan + #wa-leads, one ack, humans-only pause), and Monday 2026-11-16
// runs a special holiday schedule (closedDates mode "special"). Fake clocks in
// America/Mexico_City.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handoffAckText,
  handoffButtonFor,
  handoffButtonTemplate,
  handoffNoteText,
  humansOnlyPromo,
  isOptOutButton,
  isOptOutButtonLabel,
  PROMO_BUTTONS,
} from "../src/pipeline/promo-button.js";
import { isOptOut } from "../src/pipeline/opt-out.js";
import { CLIENT } from "../src/client.gen.js";
import { scheduleOn, validateSlot } from "../src/brain/tools.js";
import { bandOptionsOn, closureLines } from "../src/brain/prompt.js";
import { findSlotClaimIssues, scheduleForCopy } from "../src/brain/slot-claims.js";
import { guardUnverifiedSlotClaim } from "../src/brain/claude.js";
import { comboClaimIssues } from "../src/brain/fact-guards.js";
import { nextTrialSlot, upcomingBandSlots } from "../src/cron/next-slot.js";
import { cdmxToEpoch } from "../src/cron/time.js";

// ---- 1. Buen Fin promo buttons --------------------------------------------

const BF = "buen_fin_2026_prueba_o_inscripcion";
const bf = { direction: "out_bot", ts: 100, body: `[template:${BF}]` };
const HW = "halloween_promo_prueba_oct26";
const hw = { direction: "out_bot", ts: 100, body: `[template:${HW}]` };

test("Buen Fin: «Quiero inscribirme» tap hands off to staff (Evan + #wa-leads task)", () => {
  const row = handoffButtonFor("button", "Quiero inscribirme", [bf]);
  assert.ok(row);
  assert.equal(row?.template, BF);
  assert.equal(row?.teamTask, true);
  assert.equal(row?.humansOnly, true);
  assert.equal(row?.pauseHours, 48);
  assert.equal(handoffButtonTemplate("button", "Quiero inscribirme", [bf]), BF);
  // Free-form chatter after the template doesn't change which template it answers.
  assert.equal(
    handoffButtonTemplate("button", "Quiero inscribirme", [bf, { direction: "in", ts: 120, body: "hola" }, { direction: "out_bot", ts: 130, body: "¡Hola!" }]),
    BF,
  );
  // A newer template wins.
  assert.equal(handoffButtonTemplate("button", "Quiero inscribirme", [bf, { direction: "out_bot", ts: 200, body: "[template:otra]" }]), null);
  // The tap is not an opt-out.
  assert.equal(isOptOutButton("button", "Quiero inscribirme", [bf]), false);
});

test("Buen Fin: «Quiero mi día gratis» is NOT intercepted (normal brain / booking turn)", () => {
  assert.equal(handoffButtonFor("button", "Quiero mi día gratis", [bf]), null);
  assert.equal(handoffButtonTemplate("button", "Quiero mi día gratis", [bf]), null);
  assert.equal(isOptOutButton("button", "Quiero mi día gratis", [bf]), false);
  assert.equal(isOptOutButtonLabel("button", "Quiero mi día gratis"), false);
  assert.equal(isOptOut("Quiero mi día gratis"), false);
});

test("Buen Fin: «No recibir mensajes» tap is an opt-out (generic label, 2026-11-06)", () => {
  assert.equal(isOptOutButtonLabel("button", "No recibir mensajes"), true);
  assert.equal(isOptOutButton("button", "No recibir mensajes", [bf]), true);
  assert.equal(handoffButtonFor("button", "No recibir mensajes", [bf]), null);
});

test("Buen Fin: typed «quiero inscribirme» keeps the normal flow (parity: Halloween matches taps only)", () => {
  assert.equal(handoffButtonFor("text", "quiero inscribirme", [bf]), null);
  assert.equal(handoffButtonFor("text", "Quiero inscribirme", [bf]), null);
  // Same for the Halloween phrase typed by hand.
  assert.equal(handoffButtonTemplate("text", "Sí, quiero saber", [hw]), null);
});

test("Buen Fin: one fixed ack by contact language; Halloween still sends none", () => {
  const row = handoffButtonFor("button", "Quiero inscribirme", [bf])!;
  assert.equal(
    handoffAckText(row, "es"),
    "¡Excelente! 🙌 En un momento te escribe alguien del equipo para dejar lista tu inscripción con la promo de Buen Fin.",
  );
  assert.equal(handoffAckText(row, null), handoffAckText(row, "es"));
  assert.match(handoffAckText(row, "en")!, /^Great! 🙌 Someone from our team will message you shortly/);
  const halloween = handoffButtonFor("button", "Sí, quiero saber", [hw])!;
  assert.equal(handoffAckText(halloween, "es"), null);
});

test("Buen Fin: the Slack note says what the lead wants; the Halloween note is unchanged", () => {
  const row = handoffButtonFor("button", "Quiero inscribirme", [bf])!;
  const text = handoffNoteText(row, { name: "Ana", phone: "5215511112222", body: "Quiero inscribirme", url: "https://x/chat", acked: true, pauseHours: 48 });
  assert.match(text, /quiere inscribirse con la promo de Buen Fin/);
  assert.match(text, /5215511112222/);
  assert.match(text, /pausa 48 h \(no cotiza paquetes\)/);
  assert.match(text, /<https:\/\/x\/chat\|💬 Abrir chat>$/);
  const halloween = handoffButtonFor("button", "Sí, quiero saber", [hw])!;
  assert.equal(
    handoffNoteText(halloween, { name: null, phone: "521", body: "Sí, quiero saber", url: null, acked: false, pauseHours: 12 }),
    `🎃 *521* (521) tocó "Sí, quiero saber" en \`${HW}\`. El bot no respondió; contéstale tú.`,
  );
  assert.equal(halloween.teamTask, undefined, "Halloween stays Evan-only");
});

test("humansOnlyPromo: only after the Buen Fin hand-off tap, on the newest template", () => {
  const tap = { direction: "in", ts: 110, body: "Quiero inscribirme" };
  const staff = { direction: "out_human", ts: 120, body: "¡Hola! Te paso la promo…" };
  assert.equal(humansOnlyPromo([bf, tap, staff])?.template, BF);
  assert.equal(humansOnlyPromo([bf, { direction: "in", ts: 110, body: "Quiero mi día gratis" }, staff]), null);
  assert.equal(humansOnlyPromo([hw, { direction: "in", ts: 110, body: "Sí, quiero saber" }]), null);
  assert.equal(humansOnlyPromo([bf, tap, { direction: "out_bot", ts: 300, body: "[template:otra]" }]), null);
  assert.ok(PROMO_BUTTONS.some((b) => b.template === BF));
});

// ---- 2. Monday 2026-11-16 special holiday schedule -------------------------

const MON = "2026-11-16";
const SPECIAL = ["10:00 muay", "11:00 jiu", "18:00 muay", "19:00 jiu"];
const sat = cdmxToEpoch(2026, 11, 14, 12, 0);
const sun = cdmxToEpoch(2026, 11, 15, 20, 0);

test("client config: the 2026-11-16 special row survives the compile-kb whitelist", () => {
  const row = (CLIENT.closedDates ?? []).find((c) => c.date === MON);
  assert.equal(row?.mode, "special");
  assert.deepEqual(row?.slots?.map((s) => `${s.time} ${s.discipline}`), SPECIAL);
  assert.equal(row?.slots?.[1]?.label, "Jiu-Jitsu No-Gi");
  assert.match(row?.note ?? "", /open mat/);
});

test("Sat 14 / Sun 15: an adult asking for Monday gets only 10 / 11 am, 6 / 7 pm", () => {
  for (const now of [sat, sun]) {
    const mon = upcomingBandSlots("adults", null, now, 80).filter((s) => s.date === MON);
    assert.deepEqual([...new Set(mon.map((s) => `${s.time} ${s.discipline}`))], SPECIAL);
    const muay = upcomingBandSlots("adults", "muay", now, 40).filter((s) => s.date === MON);
    assert.deepEqual(muay.map((s) => s.time), ["10:00", "18:00"]);
    const jiu = upcomingBandSlots("adults", "jiu", now, 40).filter((s) => s.date === MON);
    assert.deepEqual(jiu.map((s) => s.time), ["11:00", "19:00"]);
    assert.deepEqual(upcomingBandSlots("adults", "mma", now, 40).filter((s) => s.date === MON), []);
  }
  // Sunday night: the soonest adult class is Monday 10 am (not the regular 7 am).
  const next = nextTrialSlot(null, "adult", sun);
  assert.equal(next?.date, MON);
  assert.equal(next?.time, "10:00");
  assert.deepEqual(bandOptionsOn(MON, "adults", null), [
    "10:00 am Muay Thai",
    "11:00 am Jiu-Jitsu",
    "6:00 pm Muay Thai",
    "7:00 pm Jiu-Jitsu",
  ]);
});

test("Monday 16: no Kids / Teens / Mini / Baby class is offered", () => {
  for (const band of ["kids", "teens", "mini", "baby"] as const) {
    const list = upcomingBandSlots(band, null, sat, 40);
    assert.ok(list.length > 0, band);
    assert.ok(!list.some((s) => s.date === MON), `${band} offered ${MON}`);
    assert.deepEqual(bandOptionsOn(MON, band, null), [], band);
  }
});

test("closureLines: the special day lists exactly its classes, No-Gi label and the open-mat note", () => {
  const lines = closureLines("2026-11-14T12:00");
  const line = lines.find((l) => l.includes(MON));
  assert.ok(line);
  assert.match(line!, /^HORARIO ESPECIAL el 2026-11-16 \(lunes feriado\)/);
  assert.match(line!, /SOLO hay estas clases \(adultos\): 10:00 am Muay Thai, 11:00 am Jiu-Jitsu No-Gi, 6:00 pm Muay Thai, 7:00 pm Jiu-Jitsu No-Gi\./);
  assert.match(line!, /open mat/);
  assert.doesNotMatch(line!, /POR CONFIRMAR|CERRADO/);
  assert.match(closureLines("2026-11-16T08:00").find((l) => l.includes(MON))!, /HORARIO ESPECIAL HOY 2026-11-16/);
  assert.equal(closureLines("2026-11-17T08:00").some((l) => l.includes(MON)), false);
});

test("book_trial: Mon 16 18:00 Muay Thai is accepted; 07:00 and Kids 16:00 are refused", () => {
  assert.equal(validateSlot(MON, "18:00", "adult", "muay").ok, true);
  assert.equal(validateSlot(MON, "11:00", "adult", "jiu").ok, true);
  const early = validateSlot(MON, "07:00", "adult", "muay");
  assert.equal(early.ok, false);
  assert.match(early.reason ?? "", /SPECIAL holiday schedule/);
  assert.deepEqual(early.alternatives, ["10:00", "18:00"]);
  const kids = validateSlot(MON, "16:00", "kid", "muay");
  assert.equal(kids.ok, false);
  assert.match(kids.reason ?? "", /ONLY these classes run that day/);
  assert.equal(validateSlot(MON, "10:00", "adult", "jiu").ok, false); // 10 am is Muay Thai only
  assert.equal(validateSlot(MON, "20:00", "adult", "mma").ok, false);
});

test("reply guard: «el lunes a las 8 pm» is flagged on Sat 14 / Sun 15; 7 pm is fine", () => {
  const bad = "¡Va! Te espero el lunes a las 8 pm para tu clase de Jiu-Jitsu 🥋";
  const good = "¡Va! Te espero el lunes a las 7 pm para tu clase de Jiu-Jitsu 🥋";
  for (const [today, wd] of [["2026-11-14", 5], ["2026-11-15", 6]] as const) {
    const opts = (m: string) => ({ band: "adults" as const, discipline: "jiu", schedule: scheduleForCopy(m, today) });
    assert.ok(findSlotClaimIssues(bad, wd, opts(bad)).length > 0, today);
    assert.deepEqual(findSlotClaimIssues(good, wd, opts(good)), [], today);
    const r = guardUnverifiedSlotClaim({ action: "send", message: bad, language: "es", confidence: "high" }, { nowCdmx: `${today}T12:00` });
    assert.equal(r.action, "draft", today);
    const ok = guardUnverifiedSlotClaim({ action: "send", message: good, language: "es", confidence: "high" }, { nowCdmx: `${today}T12:00` });
    assert.equal(ok.action, "send", today);
  }
  // Multi-offer copy goes through the band tier.
  const multi = "El lunes tenemos Muay Thai a las 7 am y a las 10 am, ¿cuál te late?";
  const r = guardUnverifiedSlotClaim({ action: "send", message: multi, language: "es", confidence: "high" }, { nowCdmx: "2026-11-14T12:00" });
  assert.equal(r.action, "draft");
  // Copy naming another Monday keeps the regular grid for that weekday.
  const other = "El lunes 23 a las 8 pm hay Jiu-Jitsu.";
  assert.equal(scheduleForCopy(other, "2026-11-14"), scheduleForCopy("hola", "2026-11-14"));
  // Combos are read off the special day too: 10 am Muay Thai → 11 am Jiu-Jitsu exists, 7 am does not.
  assert.deepEqual(comboClaimIssues("El lunes 16 llegas a las 10 am y tomas Muay Thai y luego Jiu-Jitsu seguidas.", "2026-11-14"), []);
  assert.ok(comboClaimIssues("El lunes 16 llegas a las 7 am y tomas Jiu-Jitsu y Muay Thai seguidas.", "2026-11-14").length > 0);
});

test("normal Monday grid is back on 2026-11-23", () => {
  assert.equal(validateSlot("2026-11-23", "07:00", "adult", "muay").ok, true);
  assert.equal(validateSlot("2026-11-23", "16:00", "kid", "muay").ok, true);
  const sunday22 = cdmxToEpoch(2026, 11, 22, 20, 0);
  const next = nextTrialSlot(null, "adult", sunday22);
  assert.equal(next?.date, "2026-11-23");
  assert.equal(next?.time, "07:00");
  assert.ok(bandOptionsOn("2026-11-23", "adults", null)!.includes("7:00 am Muay Thai"));
  assert.ok(upcomingBandSlots("kids", null, sunday22, 5).some((s) => s.date === "2026-11-23"));
  const msg = "¡Va! Te espero el lunes a las 8 pm para tu clase de Jiu-Jitsu 🥋";
  assert.deepEqual(findSlotClaimIssues(msg, 5, { band: "adults", discipline: "jiu", schedule: scheduleForCopy(msg, "2026-11-21") }), []);
  // scheduleOn leaves ordinary dates alone.
  assert.equal(scheduleOn("2026-11-23").length, scheduleOn("2026-11-24").length);
});
