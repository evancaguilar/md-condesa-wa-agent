import { test } from "node:test";
import assert from "node:assert/strict";
import { isOptOut } from "../src/pipeline/opt-out.js";

for (const s of [
  "Pueden por favor eliminar mi contacto?",
  "¿Pueden por favor eliminar mi contacto? Ya lo pedí dos veces",
  "pueden eliminar mi contacto",
  "Pueden borrar mi número",
  "podrían quitar mi número por favor",
  "Podrían eliminar mi contacto",
  "me pueden borrar mi numero",
  "Me podrían eliminar mi contacto de su lista",
  "Favor de eliminar mi número",
  "Por favor eliminar mi numero",
  "quiero que eliminen mi número",
  "quiero que borren mi contacto",
  "Elimínenme de su lista",
  "bórrenme de su lista",
  "quitenme de la lista",
]) {
  test(`opt-out polite: ${s}`, () => assert.equal(isOptOut(s), true));
}

for (const s of [
  "¿Pueden eliminar el cargo?",
  "borré mi número viejo",
  "quiten la clase del sábado",
  "pueden eliminar el cargo de mi tarjeta",
  "quiero que borren mi número viejo de la lista de espera y pongan el nuevo",
  "pueden quitar mi hijo de la clase del lunes",
  "me pueden pasar mi contacto",
]) {
  test(`opt-out polite negative: ${s}`, () => assert.equal(isOptOut(s), false));
}
