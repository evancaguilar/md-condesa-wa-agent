import { test } from "node:test";
import assert from "node:assert/strict";
import { clockMinutes, staleDateIssue, staleDateLabel } from "../src/services/stale-dates.js";
import { lateDraftStaleLabel } from "../src/services/approvals.js";

// Fake clocks, America/Mexico_City (UTC-6, no DST). Fri 2026-11-06.
const at = (cdmx: string) => Date.parse(`${cdmx}-06:00`) / 1000;
const FRI_19 = at("2026-11-06T19:00:00");
const SAT_08 = at("2026-11-07T08:00:00");

test("staleDateIssue: 'mañana' / 'hoy' written yesterday are stale", () => {
  const d = staleDateIssue("Mañana sábado tenemos Muay Thai a las 10 am", FRI_19, SAT_08);
  assert.deepEqual(d, { kind: "day_changed", word: "mañana" });
  assert.equal(staleDateIssue("Hoy a las 8 pm hay MMA", FRI_19, SAT_08)?.kind, "day_changed");
  assert.equal(staleDateIssue("Tomorrow at 10 am works!", FRI_19, SAT_08)?.kind, "day_changed");
  assert.equal(staleDateIssue("Te esperamos esta noche", FRI_19, SAT_08)?.kind, "day_changed");
});

test("staleDateIssue: 'en la mañana' / weekday names / no dates survive the night", () => {
  assert.equal(staleDateIssue("Hay clases en la mañana y por la mañana del sábado a las 10 am", FRI_19, SAT_08), null);
  assert.equal(staleDateIssue("El sábado a las 10 am tenemos Muay Thai", FRI_19, SAT_08), null);
  assert.equal(staleDateIssue("Estamos en Av. México 49 📍", FRI_19, SAT_08), null);
  assert.equal(staleDateIssue("Las mañanas son tranquilas", FRI_19, SAT_08), null);
  // "mañana en la mañana" is still tomorrow.
  assert.equal(staleDateIssue("Mañana en la mañana a las 9 am", FRI_19, SAT_08)?.kind, "day_changed");
});

test("staleDateIssue: same day, a class time that passed (or is < 30 min away)", () => {
  const w = at("2026-11-05T16:00:00");
  assert.equal(staleDateIssue("Hoy a las 6 pm hay Muay Thai", w, at("2026-11-05T17:00:00")), null);
  assert.deepEqual(staleDateIssue("Hoy a las 6 pm hay Muay Thai", w, at("2026-11-05T17:40:00")), { kind: "time_passed", time: "6 pm" });
  assert.equal(staleDateIssue("Hoy a las 6:30 pm", w, at("2026-11-05T18:45:00"))?.kind, "time_passed");
  // Names today's weekday (Thursday) instead of "hoy".
  assert.equal(staleDateIssue("El jueves a las 6 pm", w, at("2026-11-05T18:10:00"))?.kind, "time_passed");
  // A time already past when written is not new information.
  assert.equal(staleDateIssue("Hoy a las 7 am fue la clase; mañana hay a las 7 pm", w, at("2026-11-05T17:00:00")), null);
  // Overnight: the Saturday 10 am offer is still ahead at 08:00 Saturday …
  assert.equal(staleDateIssue("El sábado a las 10 am", FRI_19, SAT_08), null);
  // … but not at 09:45.
  assert.equal(staleDateIssue("El sábado a las 10 am", FRI_19, at("2026-11-07T09:45:00"))?.kind, "time_passed");
});

test("clockMinutes: explicit meridiem only", () => {
  assert.deepEqual(clockMinutes("a las 7 y a las 9:15 pm, 12 pm o 12 am").map((c) => c.minute), [21 * 60 + 15, 12 * 60, 0]);
  assert.deepEqual(clockMinutes("7 p.m."), [{ minute: 19 * 60, label: "7 p.m." }]);
});

test("lateDraftStaleLabel: fresh drafts are never checked; late ones get a label", () => {
  const draft = "Hoy a las 8 pm hay MMA";
  assert.equal(lateDraftStaleLabel(draft, FRI_19, FRI_19 + 10 * 60), null);
  assert.ok(lateDraftStaleLabel(draft, FRI_19, SAT_08)?.includes("«hoy»"));
  assert.equal(staleDateLabel({ kind: "time_passed", time: "6 pm" }).includes("6 pm"), true);
});
