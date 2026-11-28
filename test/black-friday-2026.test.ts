// Black Friday 2026 (2026-11-27): hand-off quick replies on the five blast
// templates go to staff (one ack, #wa-leads task, 48 h humans-only pause);
// the other buttons keep the normal flow or are the generic opt-out.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handoffAckText,
  handoffButtonFor,
  handoffButtonTemplate,
  humansOnlyPromo,
  isOptOutButton,
  PROMO_BUTTONS,
} from "../src/pipeline/promo-button.js";

const tpl = (name: string, ts = 100) => ({ direction: "out_bot", ts, body: `[template:${name}]` });

const VISITORS = ["black_friday_2026_visitantes", "black_friday_2026_visitantes_bfc"];
const COLD = ["black_friday_2026_adultos", "black_friday_2026_kids", "black_friday_2026_bfc"];

test("Black Friday: one row per template, all humans-only with a team task and an ack", () => {
  for (const name of [...VISITORS, ...COLD]) {
    const rows = PROMO_BUTTONS.filter((r) => r.template === name);
    assert.equal(rows.length, 1, name);
    const row = rows[0]!;
    assert.equal(row.teamTask, true);
    assert.equal(row.humansOnly, true);
    assert.equal(row.pauseHours, 48);
    assert.match(handoffAckText(row, "es") ?? "", /Black Friday/);
    assert.match(handoffAckText(row, "en") ?? "", /Black Friday/);
  }
});

test("Black Friday visitors: «Quiero inscribirme» hands off, «Tengo una duda» keeps the normal flow", () => {
  for (const name of VISITORS) {
    const sent = tpl(name);
    assert.equal(handoffButtonTemplate("button", "Quiero inscribirme", [sent]), name);
    assert.equal(handoffButtonTemplate("button", "Tengo una duda", [sent]), null);
    assert.equal(handoffButtonTemplate("text", "Quiero inscribirme", [sent]), null);
    assert.equal(isOptOutButton("button", "Quiero inscribirme", [sent]), false);
    assert.equal(isOptOutButton("button", "No recibir mensajes", [sent]), true);
  }
});

test("Black Friday never-booked: «Quiero ver las promos» hands off, «Quiero mi día gratis» keeps the normal flow", () => {
  for (const name of COLD) {
    const sent = tpl(name);
    const row = handoffButtonFor("button", "Quiero ver las promos", [sent]);
    assert.equal(row?.template, name);
    assert.equal(handoffButtonTemplate("button", "Quiero mi día gratis", [sent]), null);
    assert.equal(handoffButtonTemplate("text", "quiero ver las promos", [sent]), null);
    assert.equal(isOptOutButton("button", "No recibir mensajes", [sent]), true);
    // A newer template wins: the tap answers that one.
    assert.equal(handoffButtonTemplate("button", "Quiero ver las promos", [sent, tpl("otra", 200)]), null);
  }
});

test("Black Friday: after the hand-off tap the chat is humans-only", () => {
  const sent = tpl("black_friday_2026_adultos");
  assert.equal(humansOnlyPromo([sent]), null);
  assert.equal(
    humansOnlyPromo([sent, { direction: "in", ts: 150, body: "Quiero ver las promos" }])?.template,
    "black_friday_2026_adultos",
  );
  assert.equal(humansOnlyPromo([sent, { direction: "in", ts: 150, body: "Quiero mi día gratis" }]), null);
});
