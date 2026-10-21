// Range / summary schedule claims (2026-10-21) + the non-blocking post-send
// check of human-written text. Positive cases are the nightly auditor's real
// findings (10-15, 10-18, 10-21; last-4 only); negative cases are correct
// copy — the KB's own canonical summary first — that must never be flagged.
// todayWd: 0=Mon … 6=Sun.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findSlotClaimIssues } from "../src/brain/slot-claims.js";
import { auditHumanSlotClaims, slotWarningText, type SlotAuditDeps } from "../src/services/slot-audit.js";
import type { ProgramBand } from "../src/services/age-band.js";
import type { Env } from "../src/types.js";

const TUE = 1;
const SAT = 5;

function notes(msg: string, todayWd: number, band: ProgramBand | null = null, discipline: string | null = null): string[] {
  return findSlotClaimIssues(msg, todayWd, { band, discipline }).map((i) => i.note);
}

// ---- must flag (real auditor findings) ---------------------------------------

test("MMA Wednesday 8 pm (sparring) offered — brain or staff edit (…6136, …2488, 10-20)", () => {
  for (const msg of [
    "Para esa hora mejor te va MMA a las 8 pm mañana miércoles 🙌",
    "¿Te late venir mañana miércoles a las 8 pm para tu clase de MMA?",
  ]) {
    const n = notes(msg, TUE);
    assert.equal(n.length, 1, msg);
    assert.match(n[0]!, /miércoles 8:00 pm \(mma\) es sparring: NO acepta clase de prueba/);
  }
});

test("…6518 (10-20): range offer + closing time + adult start time, all false", () => {
  const n = notes("De MMA tenemos lunes a jueves a las 8 pm — ¿mañana miércoles a las 8 pm te late?", TUE);
  assert.equal(n.length, 1, "Wednesday flagged once (range + pair dedupe)");
  assert.match(n[0]!, /sparring/);
  const close = notes("El horario cierra a las 8 pm.", TUE, "adults");
  assert.equal(close.length, 1);
  assert.match(close[0]!, /terminan a las 8:00 pm.*termina a las 10:00 pm/);
  const open = notes("Las clases de adultos empiezan a las 6 pm.", TUE);
  assert.equal(open.length, 1);
  assert.match(open[0]!, /primera clase de adultos es a las 7:00 am/);
});

test("Saturday 11 am Muay Thai (sparring) and «12 pm Jiu-Jitsu» (it's Blindaje 8) — …7540, 10-17", () => {
  const n = notes("¿Te late hoy a las 11 am (Muay Thai) o 12 pm (Jiu-Jitsu)?", SAT);
  assert.equal(n.length, 2);
  assert.match(n[0]!, /sábado 11:00 am \(muay\) es sparring/);
  assert.match(n[1]!, /sábado 12:00 pm no es Jiu-Jitsu: es «Blindaje 8»/);
});

test("summaries that imply Friday afternoon / every day all day (10-15 auditor)", () => {
  const all = notes("Tenemos clases todos los días de lunes a domingo, en la mañana y en la tarde-noche 🙌", TUE);
  assert.ok(all.some((x) => /viernes en la tarde/.test(x)), all.join("\n"));
  assert.ok(all.some((x) => /domingo en la noche/.test(x)), all.join("\n"));
  assert.ok(!all.some((x) => /lunes|martes|miércoles|jueves/.test(x.slice(0, 30))), "Mon–Thu really have mornings and evenings");

  const muay = notes("Tenemos Muay Thai de lunes a sábado, mañana y tarde.", TUE);
  assert.ok(muay.some((x) => /viernes en la tarde/.test(x)), muay.join("\n"));

  const ft = notes("Hay clases de lunes a viernes por la mañana (7-10 am) y tarde (6-7 pm).", TUE);
  assert.ok(ft.some((x) => /viernes hay clases de 6:00 pm a 7:00 pm/.test(x)), ft.join("\n"));
  assert.ok(ft.every((x) => /viernes/.test(x)), "only Friday is wrong");
});

test("Teens on Saturday — with or without an hour", () => {
  assert.equal(notes("Para Teens también hay clase el sábado 🙌", TUE).length, 1);
  assert.match(notes("Tenemos Teens el sábado.", TUE)[0]!, /NO hay ninguna clase de ese grupo/);
  assert.ok(notes("El sábado hay Teens a las 10 am", TUE).length >= 1);
  assert.ok(notes("El domingo hay Kids a las 11 am", TUE).length >= 1);
});

// ---- must NOT flag (precision) -----------------------------------------------

test("the KB's canonical schedule summary is never flagged (it was: «lunes 9 pm no existe»)", () => {
  // Verbatim from clients/md-condesa/intake.md «Cómo describir el horario».
  const canonical =
    "Tenemos clases desde las 7 am hasta las 9 pm de lunes a jueves (y hasta las 10 pm los martes y jueves). " +
    "Los viernes solo hay clases en la mañana (7 a 10 am), los sábados de 9 am a 2 pm y los domingos a las 11 am y 12 pm. " +
    "Con una sola membresía tienes acceso a todas las disciplinas. ¿Te queda mejor en la mañana o en la tarde?";
  for (const band of [null, "adults"] as const) assert.deepEqual(notes(canonical, TUE, band), []);
});

test("correct schedule copy stays clean", () => {
  const ok: [string, number, ProgramBand | null][] = [
    ["De lunes a jueves el combo es 6 pm Jiu-Jitsu + 7 pm Muay Thai 🙌", TUE, "adults"],
    ["De lunes a jueves tenemos clases en la mañana y en la tarde", TUE, "adults"],
    ["Tenemos clases de lunes a viernes en la mañana", TUE, "adults"],
    ["Kids de lunes a jueves a las 4 pm y sábado a las 11 am", TUE, "kids"],
    ["Box: martes y jueves a las 9 pm y sábado a las 2 pm", TUE, null],
    ["Mini Muay Thai: lunes y miércoles a las 3:15 pm y sábado a la 1:15 pm", TUE, "mini"],
    ["Los sábados abrimos a las 9 am", TUE, "adults"],
    ["Cerramos a las 10 pm los martes y jueves", TUE, "adults"],
    ["Las clases de niños empiezan a las 4 pm", TUE, "kids"],
    ["Tu clase empieza a las 6 pm, llega 10 min antes 🙏", TUE, "adults"],
    ["El sábado 12 pm es Blindaje 8 (defensa personal)", TUE, "adults"],
    ["No hay Teens el sábado ni el domingo", TUE, null],
    ["El sábado a las 11 am es sparring, no acepta prueba; ven a las 10 am a Muay Thai", TUE, "adults"],
    ["El MMA del miércoles 8 pm es sparring (sin pruebas); ese día te recomiendo Jiu-Jitsu a las 8 pm", TUE, "adults"],
    ["De lunes a viernes hay clases en la mañana, pero el viernes solo hasta las 10 am", TUE, "adults"],
    ["Nivel 0 es de 6 a 11 meses, el viernes a las 12 pm", TUE, "baby"],
    ["Teens: de lunes a jueves a las 4 pm MMA Teens 🙌", TUE, "teens"],
    ["¡Buenas tardes! De lunes a jueves a las 6 pm tienes Jiu-Jitsu", TUE, "adults"],
  ];
  for (const [msg, wd, band] of ok) assert.deepEqual(notes(msg, wd, band), [], msg);
});

// ---- post-send check of human text (non-blocking) ----------------------------

function auditHarness(band: ProgramBand | null = "adults"): { deps: SlotAuditDeps; posted: string[] } {
  const posted: string[] = [];
  return {
    posted,
    deps: {
      async postTaskNote(_env, text) {
        posted.push(text);
      },
      now: () => 1_792_519_200, // 2026-10-20 (martes) 12:00 CDMX
      async leadEvidence() {
        return { band, discipline: null };
      },
    },
  };
}

const ENV = {} as Env;

test("auditHumanSlotClaims: an edited approval offering Wed 8 pm MMA → one #wa-leads warning (…2488, #2067)", async () => {
  const { deps, posted } = auditHarness();
  await auditHumanSlotClaims(ENV, "5215552488102", "¿te late venir mañana miércoles a las 8 pm para tu clase de MMA?", "edited", undefined, deps);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /^⚠️ Horario a revisar — \(aprobación editada\) le envió a 5215552488102:/);
  assert.match(posted[0]!, /sparring/);
  assert.match(posted[0]!, /YA salió/);
});

test("auditHumanSlotClaims: composer / scheduled sends are checked; clean text and brain-approved drafts are not", async () => {
  const { deps, posted } = auditHarness();
  await auditHumanSlotClaims(ENV, "5215500000001", "Box los sábados de 3 a 4 pm 🥊", "staff", "valeria", deps);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /valeria \(panel\)/);
  await auditHumanSlotClaims(ENV, "5215500000001", "Te esperamos mañana miércoles a las 7 pm 🙌", "staff_later", "valeria", deps);
  assert.equal(posted.length, 1, "real slot → silent");
  await auditHumanSlotClaims(ENV, "5215500000001", "mañana miércoles a las 8 pm MMA", "approved", undefined, deps);
  assert.equal(posted.length, 1, "approved = brain text, already guarded");
});

test("auditHumanSlotClaims never throws (Slack down / bad evidence)", async () => {
  const deps: SlotAuditDeps = {
    async postTaskNote() {
      throw new Error("slack down");
    },
    now: () => 1_792_519_200,
    async leadEvidence() {
      throw new Error("d1 down");
    },
  };
  await auditHumanSlotClaims(ENV, "5215500000001", "mañana miércoles a las 8 pm MMA", "edited", undefined, deps);
});

test("slotWarningText: quotes and caps the sent text", () => {
  const t = slotWarningText("5215500000001", "staff", "fer", "x".repeat(400), ["nota"]);
  assert.match(t, /fer \(panel\)/);
  assert.ok(t.includes(`> ${"x".repeat(220)}…`));
  assert.match(t, /\nnota\n/);
});
