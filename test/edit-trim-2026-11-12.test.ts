import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEditedText, editAndSend, isNoopEdit } from "../src/services/approvals.js";
import type { Env } from "../src/types.js";

test("cleanEditedText: leading/trailing whitespace and newlines are trimmed", () => {
  assert.equal(cleanEditedText("  Hola, ¿cómo estás?\n "), "Hola, ¿cómo estás?");
  assert.equal(cleanEditedText("Hola\n\nadiós"), "Hola\n\nadiós");
  assert.equal(cleanEditedText(undefined), "");
});

test("editAndSend: whitespace-only edit is refused as empty_draft before touching D1", async () => {
  const env = { DB: null } as unknown as Env; // any DB access would throw
  assert.deepEqual(await editAndSend(env, 1, " \n  "), { ok: false, reason: "empty_draft" });
  assert.deepEqual(await editAndSend(env, 1, ""), { ok: false, reason: "empty_draft" });
});

test("isNoopEdit: an unchanged draft (whitespace aside) is not an edit", () => {
  assert.equal(isNoopEdit("¡Va!  🙌 ¿Te late\nel sábado 14?", " ¡Va! 🙌 ¿Te late el sábado 14? "), true);
  assert.equal(isNoopEdit("Nos vemos mañana martes 17", "Nos vemos hoy martes 17"), false);
  // An escalation row has no draft: whatever staff type is a real edit.
  assert.equal(isNoopEdit("", "Hola"), false);
  assert.equal(isNoopEdit(null, ""), false);
});
