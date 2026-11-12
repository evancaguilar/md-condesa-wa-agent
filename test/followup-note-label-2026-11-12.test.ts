import { test } from "node:test";
import assert from "node:assert/strict";
import { looksInternalNote } from "../src/brain/followup-note.js";

test("looksInternalNote: possessive + label + URL is a customer sentence", () => {
  assert.equal(
    looksInternalNote("¡Hola! 🙌 Aquí puedes elegir el horario que le quede mejor a tu hijo: https://mdcondesa.com/clase-prueba-ninos/ 🙌"),
    false,
  );
  assert.equal(looksInternalNote("Aquí está el programa: https://mdcondesa.com/horarios"), false);
  assert.equal(looksInternalNote("Para su hijo: elige el día que prefieran"), false);
});

test("looksInternalNote: staff field notes still flagged", () => {
  assert.ok(looksInternalNote("Niño: Otto, edad: 5"));
  assert.ok(looksInternalNote("nombre: Dulce"));
  assert.ok(looksInternalNote("Hola. Teléfono: 5512345678"));
  assert.ok(looksInternalNote("hijo: Mateo"));
});
