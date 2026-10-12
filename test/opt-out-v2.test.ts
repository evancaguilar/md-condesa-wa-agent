import { test } from "node:test";
import assert from "node:assert/strict";
import { isOptOut, isOptOutBurst } from "../src/pipeline/opt-out.js";

// ---- v2 pattern family (2026-10-11) ----------------------------------------

for (const s of [
  "Ya no me manden mensaje.",
  "no me manden mensaje",
  "No me escriban más por favor",
  "ya no me envíen msjs porfa",
  "No me manden wsp",
  "no me manden whats",
  "Dejen de escribir",
  "dejen de escribirme por favor",
  "Ya no me escriban más",
  "Borren mi número",
  "Stop",
  "Baja por favor",
  "no me vuelvan a escribir",
  "Gracias. Ya no me manden mensajes.",
  "No me interesa, no me manden nada",
  "no me interesa la verdad y no me escriban",
]) {
  test(`isOptOut v2: ${s}`, () => assert.equal(isOptOut(s), true));
}

for (const s of [
  "baja de peso",
  "cuándo quieran pueden dejar de mandar mensajes",
  "cuando quieran pueden dejar de mandar mensajes",
  "quiero bajar de peso, ¿me mandan info?",
  "no me interesa el box, prefiero muay thai",
  "No me manden la ubicación, ya la tengo",
  "no me llegó el mensaje",
  "me pueden mandar mensaje mañana?",
  "No me interesa la verdad. Muy pocas clases para lo que cobran",
  "stop, mejor mándame la info",
  "quiero darme de baja del curso",
]) {
  test(`isOptOut v2 negative: ${s}`, () => assert.equal(isOptOut(s), false));
}

/** …4595, 2026-10-10 21:38 CDMX: three messages 20 s apart. */
export const BURST_4595 = [
  {
    direction: "in",
    ts: 1791686280,
    body: "No me interesa la verdad. Muy pocas clases para lo que cobran… Es un abuso.",
  },
  { direction: "in", ts: 1791686300, body: "Gracias" },
  { direction: "in", ts: 1791686320, body: "Ya no me manden mensaje." },
];

test("isOptOutBurst: …4595 burst → opt-out", () => {
  assert.equal(isOptOutBurst(BURST_4595), true);
});

test("isOptOutBurst: 'no me interesa' + 'no manden' split across two messages → opt-out", () => {
  assert.equal(
    isOptOutBurst([
      { ts: 100, body: "No me interesa" },
      { ts: 130, body: "no me manden nada" },
    ]),
    true,
  );
});

test("isOptOutBurst: messages older than 2 minutes do not join the burst", () => {
  assert.equal(
    isOptOutBurst([
      { ts: 100, body: "no me interesa" },
      { ts: 400, body: "no me manden la ubicación otra vez" },
    ]),
    false,
  );
});

test("isOptOutBurst: outbound rows ignored", () => {
  assert.equal(
    isOptOutBurst([
      { direction: "out_bot", ts: 100, body: "Ya no me manden mensaje." },
      { direction: "in", ts: 110, body: "hola" },
    ]),
    false,
  );
});
