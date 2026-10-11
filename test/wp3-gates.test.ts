// WP3 — "the gates in front of the brain stop losing leads". Pure decision
// functions + replay-fixture assertions on the exact turns that failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fillSlotPlaceholder,
  firstReplyDecision,
  firstReplyFor,
  hasRealQuestion,
  shouldSkipCannedWelcome,
  slotQueryForCampaign,
} from "../src/pipeline/campaigns.js";
import { isOptOut, isOptOutBurst } from "../src/pipeline/opt-out.js";
import {
  classifyEscalation,
  decideEscalationPing,
  decideTimeout,
  escalationNeedsTask,
  parseEscalationTask,
  type TimeoutApprovalView,
} from "../src/services/slack-timeouts.js";
import { claimsBooking, promisesBooking } from "../src/services/booking-claims.js";
import { guardUnbackedBookingClaim, sendResult } from "../src/brain/claude.js";
import { classifyReminderReply, reminderAckText } from "../src/pipeline/reminder-reply.js";
import {
  armOverrideCheck,
  decideOverrideCheck,
  overrideFromStaffReply,
  overrideRouting,
  parseOverrideCheck,
} from "../src/pipeline/override-check.js";
import type { BrainResult, Campaign } from "../src/types.js";

interface Fixture {
  messages: { direction: string; ts: number; body: string }[];
}
function fixture(name: string): Fixture {
  // npm test runs from the repo root; fixtures stay in the source tree.
  return JSON.parse(readFileSync(`test/fixtures/replay/${name}.json`, "utf8")) as Fixture;
}

function campaign(p: Partial<Campaign>): Campaign {
  return {
    id: 1,
    name: "X",
    trigger_phrase: "",
    trigger_norm: "",
    info: "",
    status: "active",
    ends_at: null,
    ad_id: null,
    first_reply: null,
    ad_keywords: null,
    created_at: 0,
    updated_at: 0,
    ...p,
  };
}

/** 2026-10-12 12:00 CDMX (UTC-6) — business hours. */
const NOON = Date.UTC(2026, 9, 12, 18, 0, 0) / 1000;
/** 2026-10-12 07:00 CDMX — before 09:00. */
const EARLY = Date.UTC(2026, 9, 12, 13, 0, 0) / 1000;

// ---- 1. campaign first-reply gate -----------------------------------------

const resend = fixture("welcome_resend");
const RETO = campaign({
  name: "Reto Gladiador",
  trigger_phrase: "¿Cómo funciona el Reto Gladiador?",
  first_reply: resend.messages[resend.messages.length - 1]!.body,
});

test("welcome_resend fixture: 'Jueves está bien ☺️7:00am' → brain, not resend", () => {
  const turn = resend.messages.filter((m) => m.direction === "in").at(-1)!;
  assert.match(turn.body, /Jueves/);
  const skip = shouldSkipCannedWelcome(turn.body, RETO);
  assert.equal(skip, true);
  const decision = firstReplyDecision({
    hasPriorOutbound: true,
    hasReferral: true,
    hasActiveBooking: false,
    realQuestion: hasRealQuestion(turn.body, RETO.trigger_phrase, [RETO.name]),
    skipCanned: skip,
  });
  assert.equal(decision, "none");
});

test("firstReplyDecision: returning lead with real text → none; bare re-click → resend", () => {
  const base = { hasPriorOutbound: true, hasReferral: true, hasActiveBooking: false };
  assert.equal(firstReplyDecision({ ...base, realQuestion: true }), "none");
  assert.equal(firstReplyDecision({ ...base, realQuestion: false }), "resend");
  assert.equal(firstReplyDecision({ ...base, hasPriorOutbound: false }), "first");
  assert.equal(
    firstReplyDecision({ ...base, hasPriorOutbound: false, skipCanned: true }),
    "none",
  );
});

const joss = fixture("joss_bfc_mini");
const BFC = campaign({
  name: "Baby Fight Club",
  trigger_phrase: "Quiero info de Baby Fight Club",
  first_reply: joss.messages[1]!.body,
});

test("joss_bfc_mini turn 1: age in the text → skip the canned BFC welcome", () => {
  const turn1 = joss.messages[0]!;
  assert.equal(turn1.direction, "in");
  assert.equal(shouldSkipCannedWelcome(turn1.body, BFC), true);
  assert.equal(
    firstReplyDecision({
      hasPriorOutbound: false,
      hasReferral: true,
      hasActiveBooking: false,
      skipCanned: shouldSkipCannedWelcome(turn1.body, BFC),
    }),
    "none",
  );
});

test("shouldSkipCannedWelcome: bare prefills keep the instant welcome", () => {
  assert.equal(shouldSkipCannedWelcome("¿Cómo funciona el Reto Gladiador?", RETO), false);
  assert.equal(shouldSkipCannedWelcome("Hola! Quiero info de Baby Fight Club", BFC), false);
  assert.equal(shouldSkipCannedWelcome("Hola, quiero más información", RETO), false);
});

test("shouldSkipCannedWelcome: hour, weekday, uncovered discipline", () => {
  assert.equal(shouldSkipCannedWelcome("¿tienen a las 7 pm?", RETO), true);
  assert.equal(shouldSkipCannedWelcome("el sábado puedo", RETO), true);
  assert.equal(shouldSkipCannedWelcome("¿tienen box?", RETO), true);
  // A discipline the welcome DOES mention is not a reason to skip.
  const muay = campaign({ name: "Muay Thai", first_reply: "Muay Thai para todos" });
  assert.equal(shouldSkipCannedWelcome("info de muay thai", muay), false);
});

test("{{slot}} placeholder: filled from the slot, null without one", () => {
  const c = campaign({ first_reply: "La próxima clase es {{slot}}. ¿Te la aparto?" });
  assert.equal(firstReplyFor(c, false, "mañana sábado 2:00 pm"), "La próxima clase es mañana sábado 2:00 pm. ¿Te la aparto?");
  assert.equal(firstReplyFor(c, false, null), null);
  assert.equal(fillSlotPlaceholder("sin placeholder", null), "sin placeholder");
  assert.deepEqual(slotQueryForCampaign("Baby Fight Club"), { discipline: "baby", audience: "kid" });
  assert.deepEqual(slotQueryForCampaign("Kids Muay Thai"), { discipline: null, audience: "kid" });
  assert.deepEqual(slotQueryForCampaign("Reto Gladiador"), { discipline: null, audience: "adult" });
});

// ---- 2/3/4. opt-out burst, escalation kinds, holding line -----------------

function view(p: Partial<TimeoutApprovalView>): TimeoutApprovalView {
  return {
    id: 1,
    phone: "5215550004595",
    createdAt: NOON - 15 * 60,
    holdingSent: false,
    lastInboundAt: NOON - 15 * 60,
    ...p,
  };
}

test("…4595 burst: opt-out detected; an opt_out-tagged draft gets no holding line, no best-bet", () => {
  const t0 = Date.UTC(2026, 9, 11, 3, 38, 0) / 1000; // 2026-10-10 21:38 CDMX
  const burst = [
    { direction: "in", ts: t0, body: "No me interesa la verdad. Muy pocas clases para lo que cobran… Es un abuso." },
    { direction: "in", ts: t0 + 20, body: "Gracias" },
    { direction: "in", ts: t0 + 40, body: "Ya no me manden mensaje." },
  ];
  assert.equal(isOptOut(burst[2]!.body), true);
  assert.equal(isOptOutBurst(burst), true);
  // The first message alone is a complaint, not an opt-out.
  assert.equal(isOptOut(burst[0]!.body), false);
  // Next morning 09:00: a draft that survived must not get the holding line.
  const nineAm = Date.UTC(2026, 9, 11, 15, 0, 0) / 1000;
  const v = view({ createdAt: t0 + 30, lastInboundAt: t0 + 40, sureness: 60, reasonKind: "opt_out" });
  assert.equal(decideTimeout(v, nineAm).kind === "hold", false);
  assert.equal(decideTimeout(view({ createdAt: t0 + 30, lastInboundAt: t0 + 40, sureness: 60 }), nineAm).kind === "hold", false, "lead silent > 2 h");
});

test("decideTimeout: holding line gates", () => {
  assert.equal(decideTimeout(view({ sureness: 80 }), NOON).kind, "hold");
  assert.equal(decideTimeout(view({ sureness: 40 }), NOON).kind, "none");
  assert.equal(decideTimeout(view({ sureness: 80, reasonKind: "complaint" }), NOON).kind, "none");
  assert.equal(decideTimeout(view({ sureness: 80, reasonKind: "opt_out" }), NOON).kind, "none");
  assert.equal(decideTimeout(view({ guarded: true }), NOON).kind, "none");
  assert.equal(decideTimeout(view({ sureness: 80, lastInboundAt: NOON - 3 * 3600 }), NOON).kind, "none");
  assert.equal(decideTimeout(view({ sureness: 80, createdAt: EARLY - 15 * 60, lastInboundAt: EARLY - 900 }), EARLY).kind, "none");
  // Unknown sureness (escalation row) keeps the holding line.
  assert.equal(decideTimeout(view({}), NOON).kind, "hold");
});

test("decideTimeout: no best-bet on complaint / opt-out / price negotiation", () => {
  const old = { createdAt: NOON - 2 * 3600, lastInboundAt: NOON - 2 * 3600, holdingSent: true, sureness: 90 };
  assert.equal(decideTimeout(view(old), NOON).kind, "bestbet");
  for (const k of ["complaint", "opt_out", "price"] as const) {
    assert.notEqual(decideTimeout(view({ ...old, reasonKind: k }), NOON).kind, "bestbet", k);
  }
});

test("classifyEscalation", () => {
  assert.equal(classifyEscalation("opt_out: pidió no más mensajes"), "opt_out");
  assert.equal(classifyEscalation("baja de peso"), null);
  assert.equal(classifyEscalation("complaint — publicidad engañosa"), "complaint");
  assert.equal(classifyEscalation("queja: 'no gano 5 mil'"), "complaint");
  assert.equal(classifyEscalation("price negotiation"), "price");
  assert.equal(classifyEscalation("pregunta precio mensual"), null);
  assert.equal(classifyEscalation("Nivel 0 — bebé de 8 meses"), "nivel0");
  assert.equal(classifyEscalation("pre-diagnóstico TDAH"), "special_needs");
  assert.equal(classifyEscalation("visitante, pregunta drop-in"), "visitor");
  assert.equal(escalationNeedsTask("complaint"), true);
  assert.equal(escalationNeedsTask("price"), false);
  assert.equal(escalationNeedsTask(null), false);
});

test("sendResult: complaint / opt_out reason never comes back as a plain send", () => {
  const tu = (reason: string) => ({
    type: "tool_use" as const,
    id: "t",
    name: "send_reply",
    input: { message: "x", language: "es", sureness: 95, confidence: "high", escalation_reason: reason, awaiting_reply: true },
  });
  assert.equal(sendResult(tu("complaint: se queja del precio")).action, "draft");
  assert.equal(sendResult(tu("opt_out")).action, "draft");
  assert.equal(sendResult(tu("")).action, "send");
});

// ---- 7. unbacked booking promise ------------------------------------------

test("…6601 Mayra: 'Les apunto el sábado 2 pm' without book_trial → forced draft, never best-bet", () => {
  const text = "¡Perfecto! Les apunto el sábado 2 pm para Baby Fight Club 🙌";
  assert.equal(claimsBooking(text), true);
  const res: BrainResult = { action: "send", message: text, language: "es", confidence: "high", sureness: 90 };
  const g = guardUnbackedBookingClaim(res);
  assert.equal(g.action, "draft");
  assert.ok(g.action === "draft" && g.reason?.includes("⚠️"));
  assert.ok(g.action === "draft" && g.sureness === undefined);
  // Guarded + no sureness ⇒ no best-bet and no holding line.
  const v = view({ guarded: true, createdAt: NOON - 2 * 3600, lastInboundAt: NOON - 600 });
  assert.notEqual(decideTimeout(v, NOON).kind, "bestbet");
});

test("promisesBooking: statements yes, offers/questions no", () => {
  assert.equal(promisesBooking("Te aparto lugar el jueves 7 am."), true);
  assert.equal(promisesBooking("Listo, quedan apartadas las dos."), true);
  assert.equal(promisesBooking("¿Les aparto el sábado 2 pm?"), false);
  assert.equal(promisesBooking("Dime qué día y te aparto lugar"), false);
  assert.equal(promisesBooking("Si te late, te apunto el sábado"), false);
  assert.equal(claimsBooking("Te puedo apartar lugar el sábado, ¿te late?"), false);
});

// ---- 5. reminder buttons ---------------------------------------------------

test("classifyReminderReply", () => {
  const sent = [{ kind: "same_day", due_at: NOON - 3600 }];
  assert.equal(classifyReminderReply({ body: "Ahí estaré", kind: "button", reminders: [], now: NOON }), "confirm");
  assert.equal(classifyReminderReply({ body: "Ahí estaré 🙌", kind: "text", reminders: sent, now: NOON }), "confirm");
  assert.equal(classifyReminderReply({ body: "I'll be there", reminders: sent, now: NOON }), "confirm");
  assert.equal(classifyReminderReply({ body: "Necesito reagendar", kind: "button", reminders: [], now: NOON }), "reschedule");
  assert.equal(classifyReminderReply({ body: "Ahí estaré", reminders: [{ kind: "same_day", due_at: NOON - 13 * 3600 }], now: NOON }), null);
  assert.equal(classifyReminderReply({ body: "Ahí estaré", reminders: [{ kind: "day_before", due_at: NOON + 3600 }], now: NOON }), null);
  assert.equal(classifyReminderReply({ body: "ahí estaré a las 7?", reminders: sent, now: NOON }), null);
  assert.equal(reminderAckText("¡Perfecto {name}! Los esperamos 🥋", "Ana López"), "¡Perfecto Ana! Los esperamos 🥋");
  assert.equal(reminderAckText("¡Perfecto {name}! Los esperamos 🥋", null), "¡Perfecto! Los esperamos 🥋");
});

// ---- 6. human override v2 --------------------------------------------------

test("override v2: arm only after a staff reply; 60-min clock; routing at 70", () => {
  assert.equal(overrideFromStaffReply([{ direction: "in", ts: 1 }, { direction: "out_human_echo", ts: 2 }, { direction: "in", ts: 3 }]), true);
  assert.equal(overrideFromStaffReply([{ direction: "out_human_echo", ts: 2 }, { direction: "out_bot", ts: 3 }]), false);
  assert.equal(overrideFromStaffReply([{ direction: "in", ts: 3 }]), false);
  const s1 = armOverrideCheck(null, { wamid: "a", ts: 100, body: "hola?" }, 100);
  const s2 = armOverrideCheck(s1, { wamid: "b", ts: 200, body: "sigo aquí" }, 200);
  assert.equal(s2.armedAt, 100);
  assert.equal(s2.wamid, "b");
  assert.deepEqual(parseOverrideCheck(JSON.stringify(s2)), s2);
  assert.equal(decideOverrideCheck({ state: s2, now: 100 + 3599, answeredAfter: false, contactStatus: "lead" }), "wait");
  assert.equal(decideOverrideCheck({ state: s2, now: 100 + 3600, answeredAfter: false, contactStatus: "lead" }), "run");
  assert.equal(decideOverrideCheck({ state: s2, now: 100 + 3600, answeredAfter: true, contactStatus: "lead" }), "drop");
  assert.equal(decideOverrideCheck({ state: s2, now: 100 + 3600, answeredAfter: false, contactStatus: "opted_out" }), "drop");
  assert.equal(overrideRouting({ sureness: 70, trainingWheels: false, guarded: false }), "send");
  assert.equal(overrideRouting({ sureness: 69, trainingWheels: false, guarded: false }), "draft");
  assert.equal(overrideRouting({ sureness: 95, trainingWheels: true, guarded: false }), "draft");
  assert.equal(overrideRouting({ sureness: 95, trainingWheels: false, guarded: true }), "draft");
});

// ---- 8. escalation SLA -----------------------------------------------------

test("decideEscalationPing: 45-min re-ping, then owner DM, business hours only", () => {
  assert.equal(decideEscalationPing({ createdAt: NOON - 44 * 60, pings: 0 }, NOON), "none");
  assert.equal(decideEscalationPing({ createdAt: NOON - 45 * 60, pings: 0 }, NOON), "reping");
  assert.equal(decideEscalationPing({ createdAt: NOON - 60 * 60, pings: 1 }, NOON), "none");
  assert.equal(decideEscalationPing({ createdAt: NOON - 90 * 60, pings: 1 }, NOON), "dm_owner");
  assert.equal(decideEscalationPing({ createdAt: NOON - 300 * 60, pings: 2 }, NOON), "none");
  assert.equal(decideEscalationPing({ createdAt: EARLY - 90 * 60, pings: 0 }, EARLY), "none");
  assert.equal(parseEscalationTask("garbage"), null);
  assert.deepEqual(parseEscalationTask(JSON.stringify({ ts: "1.2", approvalId: 5, createdAt: 9 })), { ts: "1.2", approvalId: 5, createdAt: 9, pings: 0 });
});
