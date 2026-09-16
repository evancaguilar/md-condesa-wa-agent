// Meta template catalog: pure summary + run validation, plus the paged fetch
// against a stubbed Graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTemplateForRun,
  countVars,
  fetchTemplateCatalog,
  findTemplate,
  summarizeTemplate,
  type GraphTemplate,
} from "../src/services/blast-templates.js";
import type { Env } from "../src/types.js";

const promo: GraphTemplate = {
  id: "1",
  name: "promo_octubre_es",
  language: "es",
  status: "APPROVED",
  category: "MARKETING",
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "¡Hola {{1}}! Este {{2}} tenemos promo. {{1}} te esperamos." },
    { type: "FOOTER", text: "Responde BAJA para dejar de recibir mensajes." },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Agendar" }, { type: "QUICK_REPLY", text: "Info" }] },
  ],
};

test("countVars counts distinct {{n}} placeholders", () => {
  assert.equal(countVars("¡Hola {{1}}! {{ 2 }} y {{1}}"), 2);
  assert.equal(countVars(""), 0);
  assert.equal(countVars(null), 0);
});

test("summarizeTemplate flattens header/body/footer/buttons", () => {
  const s = summarizeTemplate(promo);
  assert.equal(s.headerFormat, "IMAGE");
  assert.equal(s.headerVars, 0);
  assert.equal(s.bodyVars, 2);
  assert.equal(s.footer, "Responde BAJA para dejar de recibir mensajes.");
  assert.deepEqual(s.buttons, ["Agendar", "Info"]);
  assert.equal(s.status, "APPROVED");
  const bare = summarizeTemplate({ name: "x", language: "en", status: "pending" });
  assert.equal(bare.headerFormat, null);
  assert.equal(bare.bodyVars, 0);
  assert.equal(bare.status, "PENDING");
});

test("checkTemplateForRun: approved + matching params + media header", () => {
  const s = summarizeTemplate(promo);
  assert.equal(checkTemplateForRun(null, [], null).ok, false);
  assert.match(checkTemplateForRun(summarizeTemplate({ ...promo, status: "PENDING" }), ["a", "b"], null).reason ?? "", /PENDING/);
  assert.match(
    checkTemplateForRun(summarizeTemplate({ ...promo, status: "REJECTED", rejected_reason: "ABUSIVE_CONTENT" }), ["a", "b"], null).reason ?? "",
    /ABUSIVE_CONTENT/,
  );
  assert.match(checkTemplateForRun(s, ["a"], { type: "image", link: "https://x/y.jpg" }).reason ?? "", /2 variable/);
  assert.match(checkTemplateForRun(s, ["a", "b"], null).reason ?? "", /encabezado IMAGE/);
  assert.match(checkTemplateForRun(s, ["a", "b"], { type: "video", link: "https://x/y.mp4" }).reason ?? "", /encabezado IMAGE/);
  assert.match(checkTemplateForRun(s, ["a", "b"], { type: "image", link: "http://x/y.jpg" }).reason ?? "", /https/);
  assert.equal(checkTemplateForRun(s, ["a", "b"], { type: "image", link: "https://x/y.jpg" }).ok, true);
  // Text-only template must not carry a header link; header vars unsupported.
  const plain = summarizeTemplate({ ...promo, components: [{ type: "BODY", text: "Hola {{1}}" }] });
  assert.equal(checkTemplateForRun(plain, ["a"], null).ok, true);
  assert.match(checkTemplateForRun(plain, ["a"], { type: "image", link: "https://x" }).reason ?? "", /quita el link/);
  const hv = summarizeTemplate({ ...promo, components: [{ type: "HEADER", format: "TEXT", text: "{{1}}" }, { type: "BODY", text: "x" }] });
  assert.equal(checkTemplateForRun(hv, [], null).ok, false);
});

test("fetchTemplateCatalog follows paging, sorts approved first, fails soft", async () => {
  const calls: string[] = [];
  const doFetch = (async (url: string) => {
    calls.push(url);
    const body =
      calls.length === 1
        ? { data: [{ ...promo, status: "PENDING", name: "zzz_pending" }, promo], paging: { next: "https://next" } }
        : { data: [{ name: "abc_en", language: "en", status: "APPROVED", category: "UTILITY", components: [] }] };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  const env = { WA_WABA_ID: "123", WA_ACCESS_TOKEN: "t" } as unknown as Env;
  const cat = await fetchTemplateCatalog(env, doFetch);
  assert.equal(cat.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /\/123\/message_templates\?fields=/);
  assert.deepEqual(cat.templates.map((t) => t.name), ["abc_en", "promo_octubre_es", "zzz_pending"]);
  assert.equal(findTemplate(cat.templates, "promo_octubre_es", "es")?.bodyVars, 2);
  assert.equal(findTemplate(cat.templates, "promo_octubre_es", "es_MX"), null);

  const noWaba = await fetchTemplateCatalog({ WA_ACCESS_TOKEN: "t" } as unknown as Env, doFetch);
  assert.equal(noWaba.ok, false);
  assert.match(noWaba.error ?? "", /WA_WABA_ID/);

  const denied = (async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: "(#200) Permissions error", code: 200 } }),
  })) as unknown as typeof fetch;
  const bad = await fetchTemplateCatalog(env, denied);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /Graph 403 \[200\]/);
});
