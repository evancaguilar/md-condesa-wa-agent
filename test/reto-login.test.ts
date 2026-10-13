import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRetoLoginRequest,
  parseRetoLoginResponse,
  RETO_LOGIN_FALLBACK,
  RETO_LOGIN_MARKER,
  retoLoginConfigured,
} from "../src/pipeline/reto-login.js";
import { requestRetoLogin } from "../src/services/reto-login.js";
import { parseGoogleClickCode } from "../src/services/google-click.js";

// The exact prefill of the site's "Entrar con WhatsApp" button
// (md-condesa-site tools/templates/curso.js, WA_LOGIN_TEXT).
const SITE_TEXT = "Hola, quiero entrar a mis cursos del Reto [CURSOS]";

test("isRetoLoginRequest: the site's prefill and hand-typed variants", () => {
  for (const s of [
    SITE_TEXT,
    "hola quiero entrar a mis cursos del reto [cursos]",
    "[CURSOS]",
    "Hola, quiero entrar a mis cursos del Reto [ CURSOS ]",
    "Quiero entrar a mis cursos del Reto",
    "quiero entrar a mis cursos del reto!!",
  ]) {
    assert.equal(isRetoLoginRequest(s), true, s);
  }
  assert.ok(SITE_TEXT.includes(RETO_LOGIN_MARKER));
});

test("isRetoLoginRequest: leads talking about courses or the Reto stay with the brain", () => {
  for (const s of [
    "Hola, vengo de la página web y quiero agendar mi clase de prueba",
    "Quiero información de los cursos de verano",
    "¿Tienen cursos en línea?",
    "Me interesa el Reto Gladiador",
    "cursos",
    "Hola, vi su página en Google (kw: defensa personal) [K7M2QX]",
    "",
    `${"x".repeat(400)} [CURSOS]`,
  ]) {
    assert.equal(isRetoLoginRequest(s), false, s);
  }
});

test("the Google click-code parser leaves the [CURSOS] marker alone", () => {
  assert.deepEqual(parseGoogleClickCode(SITE_TEXT), { code: null, body: SITE_TEXT });
});

test("retoLoginConfigured: needs an https URL and the secret", () => {
  const url = "https://mdcondesa.com/api/reto/wa-login";
  assert.equal(retoLoginConfigured({}), false);
  assert.equal(retoLoginConfigured({ RETO_LOGIN_URL: url }), false);
  assert.equal(retoLoginConfigured({ RETO_BOT_SECRET: "s" }), false);
  assert.equal(retoLoginConfigured({ RETO_LOGIN_URL: "http://mdcondesa.com/x", RETO_BOT_SECRET: "s" }), false);
  assert.equal(retoLoginConfigured({ RETO_LOGIN_URL: url, RETO_BOT_SECRET: "s" }), true);
});

test("parseRetoLoginResponse: relays the site's reply; junk → fallback", () => {
  assert.deepEqual(parseRetoLoginResponse({ ok: true, member: true, reply: " Listo, Ana. https://x/t " }), {
    reply: "Listo, Ana. https://x/t",
    member: true,
    ok: true,
  });
  assert.equal(parseRetoLoginResponse({ ok: true, member: false, reply: "No encontramos…" }).member, false);
  assert.equal(parseRetoLoginResponse({ ok: false, member: null, reply: "Problema" }).member, null);
  for (const junk of [null, "x", {}, { reply: "" }, { reply: 5 }, { reply: "y".repeat(2000) }]) {
    assert.deepEqual(parseRetoLoginResponse(junk), { reply: RETO_LOGIN_FALLBACK, member: null, ok: false });
  }
});

const ENV = { RETO_LOGIN_URL: "https://mdcondesa.com/api/reto/wa-login", RETO_BOT_SECRET: "sekret" };

function fakeFetch(status: number, body: unknown, seen?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test("requestRetoLogin: posts the wa_id with the shared secret and relays the reply", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const res = await requestRetoLogin(ENV, "5215633343258", fakeFetch(200, { ok: true, member: true, reply: "Listo" }, seen), 50);
  assert.deepEqual(res, { reply: "Listo", member: true, ok: true });
  assert.equal(seen.url, ENV.RETO_LOGIN_URL);
  assert.equal(seen.init?.method, "POST");
  assert.equal((seen.init?.headers as Record<string, string>).Authorization, "Bearer sekret");
  assert.equal(seen.init?.body, JSON.stringify({ phone: "5215633343258" }));
});

test("requestRetoLogin: site error with a reply → relayed, error reported", async () => {
  const res = await requestRetoLogin(ENV, "1", fakeFetch(502, { ok: false, member: null, reply: "Tuvimos un problema" }), 50);
  assert.equal(res.reply, "Tuvimos un problema");
  assert.equal(res.error, "HTTP 502");
});

test("requestRetoLogin: 404 page / network failure → fallback, never throws", async () => {
  const notJson = await requestRetoLogin(ENV, "1", fakeFetch(404, "<html>Not found</html>"), 50);
  assert.equal(notJson.reply, RETO_LOGIN_FALLBACK);
  assert.equal(notJson.ok, false);
  const boom = await requestRetoLogin(ENV, "1", (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch, 50);
  assert.equal(boom.reply, RETO_LOGIN_FALLBACK);
  assert.match(boom.error ?? "", /network down/);
});

test("requestRetoLogin: a hung site → fallback after the timeout", async () => {
  const hung = (() => new Promise(() => {})) as unknown as typeof fetch;
  const res = await requestRetoLogin(ENV, "1", hung, 30);
  assert.equal(res.reply, RETO_LOGIN_FALLBACK);
  assert.match(res.error ?? "", /timeout/);
});
