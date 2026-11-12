import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEditedText, editAndSend } from "../src/services/approvals.js";
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
