import { test } from "node:test";
import assert from "node:assert/strict";
import {
  templateNameOf,
  renderTemplateBody,
  describeTemplateSend,
  paramsFor,
  withTemplateText,
  cdmxStamp,
} from "../src/services/template-text.js";
import { templateBodyParams } from "../src/services/wa.js";
import type { Env, StoredMessage } from "../src/types.js";

function fakeEnvWithKv(store: Map<string, string>): Env {
  const prep = (sql: string) => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async first() {
        if (/FROM kv/.test(sql)) {
          const v = store.get(String(binds[0]));
          return v === undefined ? null : { value: v };
        }
        return null;
      },
      async run() {
        if (/INSERT INTO kv/.test(sql)) store.set(String(binds[0]), String(binds[1]));
        return { meta: { changes: 1 } };
      },
      async all() {
        return { results: [] };
      },
    };
    return stmt;
  };
  return { DB: { prepare: prep } } as unknown as Env;
}

test("templateNameOf / renderTemplateBody", () => {
  assert.equal(templateNameOf("[template:promo_x]"), "promo_x");
  assert.equal(templateNameOf("hola"), null);
  assert.equal(renderTemplateBody("¡Hola {{1}}! {{2}}", ["Ana"]), "¡Hola Ana! 👋");
});

test("templateBodyParams reads the BODY component in order", () => {
  assert.deepEqual(
    templateBodyParams([
      { type: "header", parameters: [{ type: "image", image: { link: "x" } }] },
      { type: "body", parameters: [{ type: "text", text: "Evan" }, { type: "text", text: "10 am" }] },
    ]),
    ["Evan", "10 am"],
  );
  assert.deepEqual(templateBodyParams(undefined), []);
});

test("paramsFor: recorded params win, else contact first name", () => {
  assert.deepEqual(paramsFor({ params: ["Ana"] }, "Luis Pérez"), ["Ana"]);
  assert.deepEqual(paramsFor(null, "Luis Pérez"), ["Luis"]);
  assert.deepEqual(paramsFor(null, null), []);
});

test("describeTemplateSend: dated prefix + rendered body + footer + button", () => {
  // 2026-09-18T01:21:00Z = jue 17 sep 19:21 CDMX
  const ts = Date.UTC(2026, 8, 18, 1, 21) / 1000;
  assert.equal(cdmxStamp(ts), "jue 17 sep 19:21");
  const out = describeTemplateSend(
    "promo_x",
    { body: "¡Hola {{1}}! Mañana 7 am.", footer: "Responde BAJA", buttons: ["Ver promos"] },
    ["Evan"],
    ts,
  );
  assert.match(out, /^\[Plantilla "promo_x" enviada el jue 17 sep 19:21/);
  assert.match(out, /¡Hola Evan! Mañana 7 am\./);
  assert.match(out, /\(pie: Responde BAJA\)/);
  assert.match(out, /\(botón: Ver promos\)/);
});

test("withTemplateText: kv miss → one catalog fetch, cached; history rewritten; no placeholder → untouched", async () => {
  const store = new Map<string, string>();
  const env = fakeEnvWithKv(store);
  let fetches = 0;
  const doFetch = (async () => {
    fetches++;
    return {
      ok: true,
      wabaId: "w",
      error: null,
      templates: [
        {
          id: "1", name: "promo_x", language: "es", status: "APPROVED", category: "MARKETING",
          headerFormat: null, headerText: null, headerVars: 0,
          body: "¡Hola {{1}}! Tenemos lugar a las 7 am, 8 am y 10 am.", bodyVars: 1,
          footer: "Responde BAJA", buttons: ["Ver promos"],
        },
      ],
    };
  }) as never;
  const history: StoredMessage[] = [
    { wamid: "a", phone: "p", direction: "out_bot", body: "[template:promo_x]", ts: 1789695614, meta: JSON.stringify({ type: "template", name: "promo_x", lang: "es" }) },
    { wamid: "b", phone: "p", direction: "in", body: "10 am", ts: 1789695700, meta: null },
  ];
  const out = await withTemplateText(env, history, "Carlos Ramos", doFetch);
  assert.equal(fetches, 1);
  assert.match(out[0]!.body, /¡Hola Carlos! Tenemos lugar a las 7 am, 8 am y 10 am\./);
  assert.equal(out[1]!.body, "10 am");
  assert.ok(store.has("tpl_body:promo_x"), "cached in kv");
  // second call: kv hit, no fetch
  await withTemplateText(env, history, "Carlos Ramos", doFetch);
  assert.equal(fetches, 1);
  // recorded params win over the contact name
  const withParams = [{ ...history[0]!, meta: JSON.stringify({ type: "template", name: "promo_x", params: ["Evan"] }) }];
  assert.match((await withTemplateText(env, withParams, "Carlos", doFetch))[0]!.body, /¡Hola Evan!/);
  // no placeholder → same array, no D1 work
  const plain = [history[1]!];
  assert.equal(await withTemplateText(env, plain, null, doFetch), plain);
});

test("withTemplateText: catalog failure is fail-soft", async () => {
  const env = fakeEnvWithKv(new Map());
  const boom = (async () => { throw new Error("graph down"); }) as never;
  const history: StoredMessage[] = [
    { wamid: "a", phone: "p", direction: "out_bot", body: "[template:promo_x]", ts: 1, meta: null },
  ];
  const out = await withTemplateText(env, history, null, boom);
  assert.equal(out[0]!.body, "[template:promo_x]");
});
