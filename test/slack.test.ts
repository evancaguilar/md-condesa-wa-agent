import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adAttributionLine,
  classifyEscalation,
  decideTimeout,
  DEFAULT_APPROVALS,
  escalationNotes,
  lastLeadLine,
  nextInWindow,
  timeoutPolicy,
  hmacSha256Hex,
  isBusinessHours,
  parseInteractionPayload,
  timingSafeEqual,
  verifySlackSignature,
  windowHoursLeft,
  type TimeoutApprovalView,
} from "../src/services/slack-timeouts.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

// ---- signature verification ----

test("verifySlackSignature accepts a correctly-signed request (known-good HMAC)", async () => {
  const ts = "1531420618";
  const body = "token=xyz&team_id=T1";
  const digest = await hmacSha256Hex(SIGNING_SECRET, `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body,
    nowSec: parseInt(ts, 10), // clock at request time → within window
  });
  assert.equal(ok, true);
});

test("verifySlackSignature rejects a tampered body", async () => {
  const ts = "1531420618";
  const body = "token=xyz";
  const digest = await hmacSha256Hex(SIGNING_SECRET, `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body + "&tamper=1",
    nowSec: parseInt(ts, 10),
  });
  assert.equal(ok, false);
});

test("verifySlackSignature rejects wrong secret", async () => {
  const ts = "1531420618";
  const body = "token=xyz";
  const digest = await hmacSha256Hex("other-secret", `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body,
    nowSec: parseInt(ts, 10),
  });
  assert.equal(ok, false);
});

test("verifySlackSignature rejects a stale timestamp (replay window)", async () => {
  const ts = "1531420618";
  const body = "token=xyz";
  const digest = await hmacSha256Hex(SIGNING_SECRET, `v0:${ts}:${body}`);
  const ok = await verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    signature: `v0=${digest}`,
    timestamp: ts,
    rawBody: body,
    nowSec: parseInt(ts, 10) + 301, // just outside the 300s window
  });
  assert.equal(ok, false);
});

test("verifySlackSignature rejects missing / malformed headers", async () => {
  assert.equal(
    await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: null,
      timestamp: "1531420618",
      rawBody: "x",
    }),
    false,
  );
  assert.equal(
    await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: "v1=abc",
      timestamp: "1531420618",
      rawBody: "x",
      nowSec: 1531420618,
    }),
    false,
  );
});

test("timingSafeEqual basic behavior", () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});

// ---- payload parsing ----

test("parseInteractionPayload: block_actions approve button", () => {
  const payload = {
    type: "block_actions",
    trigger_id: "trg123",
    actions: [{ action_id: "approve|42", value: "approve|42" }],
  };
  const parsed = parseInteractionPayload(
    "payload=" + encodeURIComponent(JSON.stringify(payload)),
  );
  assert.equal(parsed.kind, "block_actions");
  assert.equal(parsed.triggerId, "trg123");
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].verb, "approve");
  assert.equal(parsed.actions[0].arg, "42");
});

test("parseInteractionPayload: overflow menu resolves selected_option.value", () => {
  const payload = {
    type: "block_actions",
    trigger_id: "trg1",
    actions: [
      {
        action_id: "overflow|7",
        selected_option: { value: "mark_student|7" },
      },
    ],
  };
  const parsed = parseInteractionPayload(JSON.stringify(payload));
  assert.equal(parsed.actions[0].verb, "mark_student");
  assert.equal(parsed.actions[0].arg, "7");
});

test("parseInteractionPayload: view_submission extracts input + private_metadata", () => {
  const payload = {
    type: "view_submission",
    view: {
      private_metadata: "42",
      state: {
        values: {
          edit_block: { edit_input: { value: "texto editado" } },
        },
      },
    },
  };
  const parsed = parseInteractionPayload(JSON.stringify(payload));
  assert.equal(parsed.kind, "view_submission");
  assert.equal(parsed.privateMetadata, "42");
  assert.equal(parsed.firstInputValue, "texto editado");
  assert.equal(parsed.viewValues.edit_block.edit_input, "texto editado");
});

test("parseInteractionPayload: form-encoded '+' decodes to spaces (edited replies)", () => {
  const payload = {
    type: "view_submission",
    view: {
      private_metadata: "42",
      state: {
        values: {
          edit_block: { edit_input: { value: "hola, nos vemos mañana a las 7 + calentamiento" } },
        },
      },
    },
  };
  // Slack sends application/x-www-form-urlencoded: spaces become "+",
  // literal "+" becomes %2B (encodeURIComponent already does the latter).
  const body =
    "payload=" +
    encodeURIComponent(JSON.stringify(payload)).replace(/%20/g, "+");
  const parsed = parseInteractionPayload(body);
  assert.equal(parsed.firstInputValue, "hola, nos vemos mañana a las 7 + calentamiento");
});

test("parseInteractionPayload: bot_pause action has null arg", () => {
  const payload = { type: "block_actions", actions: [{ action_id: "bot_pause" }] };
  const parsed = parseInteractionPayload(JSON.stringify(payload));
  assert.equal(parsed.actions[0].verb, "bot_pause");
  assert.equal(parsed.actions[0].arg, null);
});

test("parseInteractionPayload: garbage → unknown", () => {
  assert.equal(parseInteractionPayload("not json").kind, "unknown");
});

// ---- business hours ----

test("isBusinessHours: 09:00 open, 21:00 closed (CDMX)", () => {
  // 2026-07-06 is UTC-6 (no DST in Mexico). 15:00Z == 09:00 CDMX.
  const nineAm = Date.parse("2026-07-06T15:00:00Z") / 1000; // 09:00 CDMX
  const eightAm = Date.parse("2026-07-06T14:00:00Z") / 1000; // 08:00 CDMX
  const ninePm = Date.parse("2026-07-07T03:00:00Z") / 1000; // 21:00 CDMX
  const eightPm = Date.parse("2026-07-07T02:00:00Z") / 1000; // 20:00 CDMX
  assert.equal(isBusinessHours(nineAm), true);
  assert.equal(isBusinessHours(eightAm), false);
  assert.equal(isBusinessHours(ninePm), false); // 21:00 exclusive
  assert.equal(isBusinessHours(eightPm), true);
});

// ---- timeout decision logic ----

// Realistic rows: the lead's message lands, THEN the draft is queued.
const baseView = (over: Partial<TimeoutApprovalView>): TimeoutApprovalView => {
  const createdAt = over.createdAt ?? 0;
  return {
    id: 1,
    phone: "5215500000000",
    createdAt,
    holdingSent: false,
    lastInboundAt: createdAt - 30,
    ...over,
  };
};

// The legacy 1-hour wait, to exercise the holding line in isolation.
const P60 = timeoutPolicy({ ...DEFAULT_APPROVALS, autoSendAfterMin: 60 });
const TEN_AM = Date.parse("2026-07-06T16:00:00Z") / 1000; // Mon 10:00 CDMX

test("decideTimeout: >10min in business hours & window open ⇒ hold", () => {
  const view = baseView({ createdAt: TEN_AM - 11 * 60 });
  assert.equal(decideTimeout(view, TEN_AM, P60).kind, "hold");
  // Unknown sureness (no clean send coming) ⇒ holds under the default policy too.
  assert.equal(decideTimeout(view, TEN_AM).kind, "hold");
});

test("decideTimeout: a clean send due within 10 min skips the holding line", () => {
  const view = baseView({ createdAt: TEN_AM - 11 * 60, sureness: 60 });
  assert.equal(decideTimeout(view, TEN_AM).kind, "none", "sends at 15 min; no 'en un momento' at 10");
  assert.equal(decideTimeout(view, TEN_AM, P60).kind, "hold");
});

test("decideTimeout: holding already sent ⇒ none", () => {
  const view = baseView({ createdAt: TEN_AM - 11 * 60, holdingSent: true });
  assert.equal(decideTimeout(view, TEN_AM, P60).kind, "none");
});

test("decideTimeout: lead not awaiting a reply (closing pleasantry) ⇒ no hold", () => {
  const view = baseView({ createdAt: TEN_AM - 11 * 60, awaitingReply: false });
  assert.equal(decideTimeout(view, TEN_AM, P60).kind, "none");
});

test("decideTimeout: outside business hours ⇒ none before 08:00", () => {
  const now = Date.parse("2026-07-06T08:00:00Z") / 1000; // 02:00 CDMX
  const view = baseView({ createdAt: now - 30 * 60, sureness: 60 });
  assert.equal(decideTimeout(view, now).kind, "none");
});

test("decideTimeout: window closed ⇒ no hold; at the due time it escalates", () => {
  const view = baseView({ createdAt: TEN_AM - 11 * 60, lastInboundAt: TEN_AM - 25 * 3600, sureness: 90 });
  assert.equal(decideTimeout(view, TEN_AM, P60).kind, "none");
  const due = baseView({ createdAt: TEN_AM - 16 * 60, lastInboundAt: TEN_AM - 25 * 3600, sureness: 90 });
  const d = decideTimeout(due, TEN_AM);
  assert.equal(d.kind, "escalate");
  assert.deepEqual(d.kind === "escalate" && d.why, ["window_closed"]);
});

test("decideTimeout: >12h ⇒ expire, windowClosed + escalate reflect the row", () => {
  const open = baseView({ createdAt: TEN_AM - 13 * 3600, lastInboundAt: TEN_AM - 13 * 3600 - 30 });
  const d1 = decideTimeout(open, TEN_AM);
  assert.equal(d1.kind, "expire");
  assert.equal(d1.kind === "expire" && d1.windowClosed, false);
  assert.equal(d1.kind === "expire" && d1.escalate, true, "nobody was paged ⇒ the expiry pages");
  const paged = decideTimeout({ ...open, escalated: true }, TEN_AM);
  assert.equal(paged.kind === "expire" && paged.escalate, false);
  const closed = baseView({ createdAt: TEN_AM - 13 * 3600, lastInboundAt: TEN_AM - 25 * 3600 });
  const d2 = decideTimeout(closed, TEN_AM);
  assert.equal(d2.kind === "expire" && d2.windowClosed, true);
});

// ---- timeout send (owner directive 2026-08-25; 15 min since 2026-11-11) ----

test("decideTimeout: a safe draft sends at 15 min in the window; 14 min ⇒ not yet", () => {
  const d = decideTimeout(baseView({ createdAt: TEN_AM - 15 * 60, sureness: 30, holdingSent: true }), TEN_AM);
  assert.equal(d.kind, "bestbet");
  assert.equal(d.kind === "bestbet" && d.sureness, 30);
  assert.equal(decideTimeout(baseView({ createdAt: TEN_AM - 14 * 60, sureness: 30 }), TEN_AM).kind, "none");
});

test("decideTimeout: the 25% floor — 25 sends, 24 escalates (never dies silently)", () => {
  const v = (sureness: number) => baseView({ createdAt: TEN_AM - 20 * 60, sureness, holdingSent: true });
  assert.equal(decideTimeout(v(25), TEN_AM).kind, "bestbet");
  const low = decideTimeout(v(24), TEN_AM);
  assert.equal(low.kind, "escalate");
  assert.deepEqual(low.kind === "escalate" && low.why, ["low_sureness"]);
  // Once paged, the row just waits for a human (or the 12 h expiry).
  assert.equal(decideTimeout({ ...v(24), escalated: true }, TEN_AM).kind, "none");
});

test("decideTimeout: overnight drafts wait for 08:00 CDMX (and a 21:20 one too)", () => {
  const night = Date.parse("2026-07-07T05:10:00Z") / 1000; // Mon 23:10 CDMX
  const v = baseView({ createdAt: night, sureness: 60 });
  const sevenFiftyNine = Date.parse("2026-07-07T13:59:00Z") / 1000;
  const eight = Date.parse("2026-07-07T14:00:00Z") / 1000;
  assert.equal(decideTimeout(v, night + 3 * 3600).kind, "none");
  assert.equal(decideTimeout(v, sevenFiftyNine).kind, "none");
  assert.equal(decideTimeout(v, eight).kind, "bestbet");
  const late = baseView({ createdAt: Date.parse("2026-07-07T03:20:00Z") / 1000, sureness: 60 }); // 21:20
  assert.equal(decideTimeout(late, Date.parse("2026-07-07T03:40:00Z") / 1000).kind, "none", "21:40 is outside");
  assert.equal(decideTimeout(late, eight).kind, "bestbet");
});

test("nextInWindow: inside stays, before opens today, after opens tomorrow", () => {
  const p = timeoutPolicy();
  const at = (iso: string) => Date.parse(iso) / 1000;
  assert.equal(nextInWindow(at("2026-07-06T16:00:00Z"), p), at("2026-07-06T16:00:00Z")); // 10:00
  assert.equal(nextInWindow(at("2026-07-06T12:30:00Z"), p), at("2026-07-06T14:00:00Z")); // 06:30 → 08:00
  assert.equal(nextInWindow(at("2026-07-07T03:30:00Z"), p), at("2026-07-07T14:00:00Z")); // 21:30 → 08:00
  assert.equal(nextInWindow(at("2026-07-07T03:29:00Z"), p), at("2026-07-07T03:29:00Z")); // 21:29 inside
});

test("decideTimeout: unknown sureness escalates; the brain's apology regenerates", () => {
  const v = baseView({ createdAt: TEN_AM - 20 * 60, holdingSent: true });
  const d = decideTimeout(v, TEN_AM);
  assert.deepEqual(d.kind === "escalate" && d.why, ["no_sureness"]);
  const apology = decideTimeout({ ...v, apologyDraft: true }, TEN_AM);
  assert.equal(apology.kind, "regenerate");
  assert.equal(apology.kind === "regenerate" && apology.why, "no_answer");
});

test("decideTimeout: a GUARDED draft never sends — it escalates, then expires", () => {
  const v = baseView({ createdAt: TEN_AM - 2 * 3600, sureness: 70, guarded: true, holdingSent: true });
  const d = decideTimeout(v, TEN_AM);
  assert.deepEqual(d.kind === "escalate" && d.why, ["slot_warning"]);
  const old = baseView({ createdAt: TEN_AM - 13 * 3600, sureness: 70, guarded: true, escalated: true });
  assert.equal(decideTimeout(old, TEN_AM).kind, "expire");
});

test("decideTimeout: complaint / opt-out / price / medical / billing never send", () => {
  const ok = baseView({ createdAt: TEN_AM - 2 * 3600, sureness: 90, holdingSent: true });
  assert.equal(decideTimeout(ok, TEN_AM).kind, "bestbet");
  for (const k of ["complaint", "opt_out", "price", "medical", "billing"] as const) {
    const d = decideTimeout({ ...ok, reasonKind: k }, TEN_AM);
    assert.deepEqual(d.kind === "escalate" && d.why, ["reason_kind"], k);
  }
  // Task kinds still send (their human task is already open) — after 60 min.
  assert.equal(decideTimeout({ ...ok, reasonKind: "nivel0", tasked: true }, TEN_AM).kind, "bestbet");
});

test("decideTimeout: kill switch, human control, declined stop, baja", () => {
  const ok = baseView({ createdAt: TEN_AM - 20 * 60, sureness: 90, holdingSent: true });
  const why = (v: TimeoutApprovalView) => {
    const d = decideTimeout(v, TEN_AM);
    return d.kind === "escalate" ? d.why : d.kind;
  };
  assert.deepEqual(why({ ...ok, botEnabled: false }), ["kill_switch"]);
  assert.deepEqual(why({ ...ok, overrideActive: true }), ["override"]);
  assert.deepEqual(why({ ...ok, declined: true }), ["declined"]);
  assert.equal(decideTimeout({ ...ok, optedOut: true }, TEN_AM).kind, "discard");
});

test("decideTimeout: the lead wrote again ⇒ settle 5 min, then regenerate (even a shaky draft)", () => {
  const v = baseView({ createdAt: TEN_AM - 20 * 60, sureness: 10, holdingSent: true });
  assert.equal(decideTimeout({ ...v, lastInboundAt: TEN_AM - 2 * 60 }, TEN_AM).kind, "none");
  const d = decideTimeout({ ...v, lastInboundAt: TEN_AM - 6 * 60 }, TEN_AM);
  assert.equal(d.kind === "regenerate" && d.why, "lead_wrote_again");
  // …but never past a hard blocker.
  assert.equal(decideTimeout({ ...v, lastInboundAt: TEN_AM - 6 * 60, reasonKind: "complaint" }, TEN_AM).kind, "escalate");
});

test("decideTimeout: rows with a human task wait 60 min and leave paging to the SLA", () => {
  const v = baseView({ createdAt: TEN_AM - 30 * 60, sureness: 60, tasked: true, holdingSent: true });
  assert.equal(decideTimeout(v, TEN_AM).kind, "none");
  assert.equal(decideTimeout({ ...v, createdAt: TEN_AM - 61 * 60, lastInboundAt: TEN_AM - 62 * 60 }, TEN_AM).kind, "bestbet");
  const shaky = { ...v, createdAt: TEN_AM - 61 * 60, lastInboundAt: TEN_AM - 62 * 60, sureness: 10 };
  assert.equal(decideTimeout(shaky, TEN_AM).kind, "none", "the escalation SLA re-pings it");
  // A draft-less escalation row: SLA if tasked, else one escalation.
  const esc = baseView({ createdAt: TEN_AM - 20 * 60, hasDraft: false, holdingSent: true });
  assert.deepEqual((() => { const d = decideTimeout(esc, TEN_AM); return d.kind === "escalate" && d.why; })(), ["no_draft", "no_sureness"]);
  assert.equal(decideTimeout({ ...esc, tasked: true }, TEN_AM).kind, "none");
});

test("decideTimeout: a clean draft still sends past 12 h (cron was down), not past 13 h", () => {
  const v = baseView({ createdAt: TEN_AM - 12.5 * 3600, sureness: 55, holdingSent: true });
  assert.equal(decideTimeout(v, TEN_AM).kind, "bestbet");
  assert.equal(decideTimeout({ ...v, createdAt: TEN_AM - 13.5 * 3600, lastInboundAt: TEN_AM - 13.5 * 3600 - 30 }, TEN_AM).kind, "expire");
});

test("escalationNotes: one task + one alert for every row of the tick", () => {
  assert.equal(escalationNotes([]), null);
  const n = escalationNotes([
    { phone: "5215511111111", name: "Ana", question: "¿Qué horarios tienen?", why: ["⚠️ horario/agendado por verificar"], approvalId: 7 },
    { phone: "5215522222222", name: null, question: "tuve una operación de rodilla", why: ["tema para humano (medical)"], approvalId: 8 },
  ])!;
  assert.ok(n.task.startsWith("<!here> ⏰ 2 leads"), n.task);
  assert.ok(n.task.includes("Ana · 5215511111111 — «¿Qué horarios tienen?»"), n.task);
  assert.ok(n.task.includes("(#8)"), n.task);
  assert.ok(n.alert.includes("5215511111111") && n.alert.includes("5215522222222"), n.alert);
  assert.equal(lastLeadLine("👤 Hola\n🤖 ¡Hola!\n👤 🎤 Que horarios tienen?"), "Que horarios tienen?");
  assert.equal(lastLeadLine(null), "");
});

test("classifyEscalation: medical and billing buckets; a price QUESTION is neither", () => {
  assert.equal(classifyEscalation("medical question: knee surgery 2 months ago"), "medical");
  assert.equal(classifyEscalation("Lesión en la rodilla"), "medical");
  assert.equal(classifyEscalation("cobro no reconocido y quiere cancelar la membresía"), "billing");
  assert.equal(classifyEscalation("quiere factura"), "billing");
  assert.equal(classifyEscalation("pregunta cuánto cobran al mes"), null);
  assert.equal(classifyEscalation("dar de baja"), null, "never a silent opt-out by keyword");
});

test("windowHoursLeft: rounds up, floors at 0", () => {
  const now = 1_000_000;
  assert.equal(windowHoursLeft(now - 1 * 3600, now), 23);
  assert.equal(windowHoursLeft(now - 23.2 * 3600, now), 1);
  assert.equal(windowHoursLeft(now - 25 * 3600, now), 0);
  assert.equal(windowHoursLeft(null, now), 0);
});

// ---- ad/campaign attribution line ----

test("adAttributionLine: no ad, no campaign → null", () => {
  assert.equal(adAttributionLine(null, null), null);
});

test("adAttributionLine: malformed ad_ref JSON → treated as no ad", () => {
  assert.equal(adAttributionLine("{bad json", null), null);
  assert.equal(adAttributionLine("{bad json", "Reto Gladiador"), "🎯 Campaña: *Reto Gladiador*");
});

test("adAttributionLine: campaign + full ad → campaign, headline, snippet, id", () => {
  const adRef = JSON.stringify({
    headline: "¡Agenda tu Día Gratis!",
    body: "Te premiamos por cumplir tu propia meta. Así funciona el Reto Gladiador",
    sourceId: "120249684011870518",
  });
  const line = adAttributionLine(adRef, "Reto Gladiador")!;
  assert.ok(line.includes("🎯 Campaña: *Reto Gladiador*"));
  assert.ok(line.includes("📣 Anuncio: ¡Agenda tu Día Gratis!"));
  assert.ok(line.includes("Te premiamos por cumplir"));
  assert.ok(line.includes("(120249684011870518)"));
});

test("adAttributionLine: ad without campaign → flags 'sin asignar'", () => {
  const adRef = JSON.stringify({ headline: "¡Agenda tu Día Gratis!", sourceId: "123" });
  const line = adAttributionLine(adRef, null)!;
  assert.ok(line.includes("🎯 Campaña: _sin asignar_"));
  assert.ok(line.includes("📣 Anuncio: ¡Agenda tu Día Gratis! (123)"));
});

test("adAttributionLine: campaign only (trigger-phrase match, no ad) → campaign alone", () => {
  assert.equal(adAttributionLine(null, "Promo verano"), "🎯 Campaña: *Promo verano*");
});

test("adAttributionLine: long ad body is snipped to ~90 chars", () => {
  const adRef = JSON.stringify({ headline: "H", body: "y".repeat(300), sourceId: null });
  const line = adAttributionLine(adRef, null)!;
  const m = /«([^»]*)»/.exec(line)!;
  assert.ok(m[1]!.length <= 90);
  assert.ok(m[1]!.endsWith("…"));
});

test("adAttributionLine: id-only ad_ref falls back to the id as label", () => {
  const adRef = JSON.stringify({ sourceId: "999" });
  const line = adAttributionLine(adRef, null)!;
  assert.ok(line.includes("📣 Anuncio: 999"));
  assert.ok(!line.includes("(999)"));
});
