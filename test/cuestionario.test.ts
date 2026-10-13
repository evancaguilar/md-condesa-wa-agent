import { test } from "node:test";
import assert from "node:assert/strict";
import {
  b64urlDecode,
  b64urlEncode,
  signToken,
  TOKEN_TTL_SEC,
  tokenId,
  verifyToken,
} from "../src/services/cuestionario-token.js";
import {
  allowedOrigin,
  answerFields,
  answersFromFields,
  cdmxDia,
  cdmxHora,
  completionFields,
  completionSummary,
  corsHeaders,
  dayBeforeMotivoText,
  deriveVersion,
  inviteText,
  motivoPhrase,
  sanitizeAnswers,
} from "../src/services/cuestionario-core.js";
import {
  cuestionarioEnabled,
  doneKey,
  patchLeadAnswers,
  postCompletionOnce,
  rateKey,
  sendCuestionario,
  sentKey,
  syncCuestionario,
} from "../src/services/cuestionario.js";
import { reminderAudience } from "../src/cron/followups.js";
import { WindowClosedError } from "../src/services/send.js";
import {
  inviteTemplateBody,
  inviteTemplateComponents,
  slackEscape,
} from "../src/services/cuestionario-core.js";
import { cuestionarioTemplateInputs, INVITE_URL_EXAMPLE } from "../src/cron/template-seed-cuestionario.js";
import { AirtableWriteError, leadsMap } from "../src/services/airtable.js";
import type { Env } from "../src/types.js";

const SECRET = "test-secret-123";
const NOW = 1792000000; // 2026-10-14 (fixed clock)
const REC = "recAbCdEfGhIjKlMn";
/** viernes 16 de octubre 2026, 7:00 PM CDMX */
const FRI_7PM = 1792198800;
/** miércoles 14 de octubre 2026, 1:00 PM CDMX (baby trial hour) */
const WED_1PM = 1792004400;

// ---- token ------------------------------------------------------------------

test("b64url: round-trips every tail length, url-safe alphabet only", () => {
  for (let n = 0; n < 8; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 250) & 0xff);
    const enc = b64urlEncode(bytes);
    assert.doesNotMatch(enc, /[+/=]/);
    assert.deepEqual([...(b64urlDecode(enc) ?? [])], [...bytes]);
  }
  assert.equal(b64urlDecode("ab+c"), null);
  assert.equal(b64urlDecode("a"), null);
});

test("token: sign → verify round-trip with a fixed secret and clock", async () => {
  const t = await signToken(SECRET, { recordId: REC, version: "kids" }, NOW);
  assert.match(t, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/); // 16-byte sig → 22 chars
  const payload = JSON.parse(String.fromCharCode(...(b64urlDecode(t.split(".")[1]!) ?? [])));
  assert.deepEqual(payload, { r: REC, v: "kids", e: NOW + 14 * 86400 });
  assert.deepEqual(await verifyToken(SECRET, t, NOW + 60), {
    recordId: REC,
    version: "kids",
    exp: NOW + TOKEN_TTL_SEC,
  });
  // deterministic: same inputs → same token
  assert.equal(await signToken(SECRET, { recordId: REC, version: "kids" }, NOW), t);
});

test("token: expired after 14 days, invalid when tampered / wrong secret / garbage", async () => {
  const t = await signToken(SECRET, { recordId: REC, version: "adultos" }, NOW);
  assert.deepEqual(await verifyToken(SECRET, t, NOW + TOKEN_TTL_SEC - 1), {
    recordId: REC,
    version: "adultos",
    exp: NOW + TOKEN_TTL_SEC,
  });
  assert.deepEqual(await verifyToken(SECRET, t, NOW + TOKEN_TTL_SEC), { error: "expired" });
  assert.deepEqual(await verifyToken("other-secret", t, NOW), { error: "invalid" });

  // Re-encode the payload for another record, keep the old signature.
  const [, , sig] = t.split(".");
  const forged = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ r: "recZZZZZZZZZZZZZZ", v: "adultos", e: NOW + 999 })),
  );
  assert.deepEqual(await verifyToken(SECRET, `v1.${forged}.${sig}`, NOW), { error: "invalid" });
  // An expired token with a broken signature reads "invalid", never "expired".
  assert.deepEqual(await verifyToken("x", t, NOW + TOKEN_TTL_SEC + 5), { error: "invalid" });

  for (const bad of ["", "v1", "v1..", "v2.a.b", "garbage", `${t}x`, null, undefined]) {
    assert.deepEqual(await verifyToken(SECRET, bad, NOW), { error: "invalid" }, String(bad));
  }
  assert.deepEqual(await verifyToken("", t, NOW), { error: "invalid" });
});

test("token: a correctly signed payload with a bad version or record id is invalid", async () => {
  // signToken only accepts valid versions, so sign by hand through the same API
  // with a bogus record id instead.
  const t = await signToken(SECRET, { recordId: "not-a-record", version: "bfc" }, NOW);
  assert.deepEqual(await verifyToken(SECRET, t, NOW), { error: "invalid" });
});

test("tokenId / rateKey: per token, hour bucket first", async () => {
  const t = await signToken(SECRET, { recordId: REC, version: "bfc" }, NOW);
  assert.equal(tokenId(t), t.split(".")[2]);
  assert.equal(rateKey(t, NOW), `cq_rl:${Math.floor(NOW / 3600)}:${tokenId(t)}`);
  assert.notEqual(rateKey(t, NOW), rateKey(t, NOW + 3600));
});

// ---- CORS -------------------------------------------------------------------

test("allowedOrigin: site, www, Pages previews, local preview; nothing else", () => {
  for (const ok of [
    "https://mdcondesa.com",
    "https://www.mdcondesa.com",
    "https://abc123.md-condesa-site.pages.dev",
    "https://cuestionario.md-condesa-site.pages.dev",
    "http://localhost:4173",
  ]) {
    assert.equal(allowedOrigin(ok), ok);
  }
  for (const bad of [
    null,
    "",
    "http://mdcondesa.com",
    "https://mdcondesa.com.evil.com",
    "https://evil.com",
    "https://md-condesa-site.pages.dev.evil.com",
    "https://a.b.md-condesa-site.pages.dev",
    "https://x.other-site.pages.dev",
    "http://localhost:3000",
    "https://localhost:4173",
  ]) {
    assert.equal(allowedOrigin(bad), null, String(bad));
  }
  assert.equal(corsHeaders("https://evil.com")["Access-Control-Allow-Origin"], undefined);
  const h = corsHeaders("https://www.mdcondesa.com");
  assert.equal(h["Access-Control-Allow-Origin"], "https://www.mdcondesa.com");
  assert.equal(h["Access-Control-Allow-Methods"], "GET, PATCH, OPTIONS");
  assert.equal(h["Access-Control-Allow-Headers"], "content-type");
});

// ---- whitelist / sanitize ------------------------------------------------------

test("sanitizeAnswers: whitelist per version; send-path + completion columns never writable", () => {
  const { fields, complete } = sanitizeAnswers("adultos", {
    answers: {
      "Motivo principal": "  Bajar de peso  ",
      "Qué dejaría de sentir": "ansiedad",
      "Cómo es el niño": "inquieto", // kids-only → dropped for adultos
      "Cuestionario enviado": "2026-01-01",
      "Cuestionario versión": "kids",
      "Cuestionario completado": true,
      "Cuestionario completado el": "2026-01-01",
      "# de Teléfono": "+520000000000",
      hacker: "x",
    },
  });
  assert.equal(complete, false);
  assert.deepEqual(fields, { "Motivo principal": "Bajar de peso", "Qué dejaría de sentir": "ansiedad" });
  assert.ok(!answerFields("kids").includes("Cuestionario enviado"));
  assert.ok(answerFields("bfc").includes("Nombre Del Niñ@"));
  assert.ok(!answerFields("kids").includes("Nombre Del Niñ@"));
  assert.ok(answerFields("kids").includes("Quiere venir"));
});

test("sanitizeAnswers: types — cap 2000, multi-select arrays, numbers, booleans, clears", () => {
  const { fields } = sanitizeAnswers("kids", {
    answers: {
      "Situación actual": "x".repeat(2500),
      Motivos: ["Disciplina", " Confianza ", "Disciplina", 3, "", "Defensa"],
      "Horarios preferidos": "Tardes",
      "Días por semana": 3,
      "Quiere venir": true,
      "Lesiones / cuidados": "",
      "Qué ha intentado": null,
      "Cómo nos encontró": { nested: 1 },
      "Por qué ahora": Number.NaN,
    },
  });
  assert.equal((fields["Situación actual"] as string).length, 2000);
  assert.deepEqual(fields.Motivos, ["Disciplina", "Confianza", "Defensa"]);
  assert.deepEqual(fields["Horarios preferidos"], ["Tardes"]);
  assert.equal(fields["Días por semana"], "3");
  assert.equal(fields["Quiere venir"], true);
  assert.equal(fields["Lesiones / cuidados"], null);
  assert.equal(fields["Qué ha intentado"], null);
  assert.ok(!("Cómo nos encontró" in fields));
  assert.ok(!("Por qué ahora" in fields));
});

test("sanitizeAnswers: __complete at top level or inside answers; odd bodies are empty", () => {
  assert.equal(sanitizeAnswers("bfc", { __complete: true }).complete, true);
  assert.equal(sanitizeAnswers("bfc", { answers: { __complete: true } }).complete, true);
  assert.equal(sanitizeAnswers("bfc", { __complete: "true" }).complete, false);
  assert.deepEqual(sanitizeAnswers("bfc", null), { fields: {}, complete: false });
  assert.deepEqual(sanitizeAnswers("bfc", { answers: [1, 2] }), { fields: {}, complete: false });
  assert.deepEqual(completionFields(FRI_7PM), {
    "Cuestionario completado": true,
    "Cuestionario completado el": "2026-10-16",
  });
});

test("answersFromFields: version columns + completion state, empties omitted, nothing else", () => {
  const a = answersFromFields("kids", {
    "Motivo principal": "Disciplina",
    Motivos: ["A", "B"],
    "Días por semana": 2,
    "Cómo es el niño": "  ",
    "Horarios preferidos": [],
    "Cuestionario completado": true,
    "Cuestionario enviado": "2026-10-14",
    "# de Teléfono": "+5215500000000",
    "Qué dejaría de sentir": "adult-only",
  });
  assert.deepEqual(a, {
    Motivos: ["A", "B"],
    "Motivo principal": "Disciplina",
    "Días por semana": 2,
    "Cuestionario completado": true,
  });
});

// ---- version ------------------------------------------------------------------

test("deriveVersion: Programa first, then Actividad, then age band, else adultos", () => {
  const m = leadsMap();
  const v = (fields: Record<string, unknown>, band: Parameters<typeof deriveVersion>[2] = null) =>
    deriveVersion(fields, m, band);
  assert.equal(v({ [m.audience]: "Adultos" }), "adultos");
  assert.equal(v({ [m.audience]: "Kids" }), "kids");
  assert.equal(v({ [m.audience]: "Mini Muay Thai" }), "kids");
  assert.equal(v({ [m.audience]: "Teens" }), "kids");
  assert.equal(v({ [m.audience]: "Baby Fight Club (BFC)" }), "bfc");
  assert.equal(v({ [m.discipline]: ["BJJ Kids"] }), "kids");
  assert.equal(v({ [m.discipline]: ["Baby Fight Club"] }), "bfc");
  assert.equal(v({ [m.discipline]: ["Muay Thai"] }), "adultos");
  assert.equal(v({}, "baby"), "bfc");
  assert.equal(v({}, "mini"), "kids");
  assert.equal(v({}, "teens"), "kids");
  assert.equal(v({}), "adultos");
  // The CRM wins over a stale band.
  assert.equal(v({ [m.audience]: "Adultos" }, "kids"), "adultos");
});

// ---- wording --------------------------------------------------------------------

test("cdmxDia / cdmxHora", () => {
  assert.equal(cdmxDia(FRI_7PM), "viernes 16 de octubre");
  assert.equal(cdmxDia(FRI_7PM, "en"), "Friday, October 16");
  assert.equal(cdmxHora(FRI_7PM), "7:00 PM");
  assert.equal(cdmxHora(WED_1PM), "1:00 PM");
  assert.equal(cdmxHora(1792243800), "7:30 AM");
});

const LINK = "https://mdcondesa.com/cuestionario/?t=v1.x.y";

test("inviteText: adultos ES with and without a name", () => {
  assert.equal(
    inviteText({ version: "adultos", lang: "es", name: "Ana", kid: null, trialEpoch: FRI_7PM, link: LINK }),
    `Listo Ana, quedó tu clase el viernes 16 de octubre a las 7:00 PM. Una cosa más - contéstanos esto en 3 minutos para que tu coach te reciba sabiendo qué buscas. Es lo que hace que tu primera clase sea para ti y no una clase genérica: ${LINK}`,
  );
  const noName = inviteText({ version: "adultos", lang: "es", name: "", kid: null, trialEpoch: FRI_7PM, link: LINK })!;
  assert.ok(noName.startsWith("Listo, quedó tu clase el viernes"), noName);
  const noDate = inviteText({ version: "adultos", lang: "es", name: "", kid: null, trialEpoch: null, link: LINK })!;
  assert.ok(noDate.startsWith("Listo, quedó tu clase. Una cosa más"), noDate);
});

test("inviteText: kids names the child (or 'tu peque'); bfc says 2 minutos and 'a la 1:00'", () => {
  const kids = inviteText({ version: "kids", lang: "es", name: "Laura", kid: "Mateo", trialEpoch: FRI_7PM, link: LINK })!;
  assert.match(kids, /en 3 minutos para que tu coach reciba a Mateo sabiendo qué buscan ustedes/);
  assert.match(kids, /Es lo que hace que su primera clase sea para Mateo y no una clase genérica: /);
  const anon = inviteText({ version: "kids", lang: "es", name: "Laura", kid: null, trialEpoch: FRI_7PM, link: LINK })!;
  assert.match(anon, /reciba a tu peque sabiendo/);
  assert.match(anon, /sea para tu peque y no una clase genérica/);
  const bfc = inviteText({ version: "bfc", lang: "es", name: "", kid: "Sofi", trialEpoch: WED_1PM, link: LINK })!;
  assert.match(bfc, /^Listo, quedó tu clase el miércoles 14 de octubre a la 1:00 PM\./);
  assert.match(bfc, /en 2 minutos para que tu coach reciba a Sofi/);
  assert.ok(bfc.endsWith(LINK));
});

test("inviteText: EN copy and a missing template → null", () => {
  const en = inviteText({ version: "adultos", lang: "en", name: "Ann", kid: null, trialEpoch: FRI_7PM, link: LINK })!;
  assert.match(en, /^All set Ann, your class is booked for Friday, October 16 at 7:00 PM\./);
  assert.ok(en.endsWith(LINK));
  assert.match(inviteText({ version: "bfc", lang: "en", name: "", kid: null, trialEpoch: null, link: LINK })!, /2 minutes/);
  assert.equal(inviteText({ version: "adultos", lang: "es", name: "", kid: null, trialEpoch: null, link: LINK }, {}), null);
});

// ---- day-before reminder copy choice ------------------------------------------------

test("motivoPhrase: lowercase (acronyms kept), no final period, too long → null", () => {
  assert.equal(motivoPhrase("Bajar de peso."), "bajar de peso");
  assert.equal(motivoPhrase("¡Aprender a defenderme!!"), "aprender a defenderme");
  assert.equal(motivoPhrase("Competir en BJJ"), "competir en BJJ");
  assert.equal(motivoPhrase(["Disciplina", "Confianza"]), "disciplina, confianza");
  assert.equal(motivoPhrase("   "), null);
  assert.equal(motivoPhrase(null), null);
  assert.equal(motivoPhrase("a".repeat(141)), null);
});

test("dayBeforeMotivoText: Motivo principal wins, Meta 6 meses next, otherwise null (existing copy)", () => {
  const base = { lang: "es" as const, name: "Ana", trialEpoch: FRI_7PM };
  assert.equal(
    dayBeforeMotivoText({ ...base, motivoPrincipal: "Bajar de peso.", meta6Meses: "Correr 10k" }),
    "Hola Ana! Mañana a las 7:00 PM es tu clase. Ya le pasé al coach que buscas bajar de peso, te va a estar esperando. Av. México 49, 1º piso. Llega 10 min antes.",
  );
  assert.match(
    dayBeforeMotivoText({ ...base, motivoPrincipal: "", meta6Meses: "Que gane confianza" })!,
    /que buscas que gane confianza, te va/,
  );
  assert.equal(dayBeforeMotivoText({ ...base, motivoPrincipal: null, meta6Meses: undefined }), null);
  assert.equal(dayBeforeMotivoText({ ...base, trialEpoch: null, motivoPrincipal: "x y z", meta6Meses: null }), null);
  // No name → "Hola!"; 1 PM → "a la 1:00 PM".
  assert.equal(
    dayBeforeMotivoText({ lang: "es", name: "", trialEpoch: WED_1PM, motivoPrincipal: "Disciplina", meta6Meses: null }),
    "Hola! Mañana a la 1:00 PM es tu clase. Ya le pasé al coach que buscas disciplina, te va a estar esperando. Av. México 49, 1º piso. Llega 10 min antes.",
  );
  assert.match(
    dayBeforeMotivoText({ lang: "en", name: "Ann", trialEpoch: FRI_7PM, motivoPrincipal: "Lose weight", meta6Meses: null })!,
    /^Hi Ann! Your class is tomorrow at 7:00 PM\. I already told the coach you're looking for lose weight/,
  );
});

// ---- completion summary -----------------------------------------------------------

test("completionSummary: ≤ 4 lines; adults show cost, kids/bfc show the 6-month goal", () => {
  const fields = {
    "Motivo principal": "Bajar de peso",
    "Costo de seguir así": "Me siento sin energía",
    "Meta 6 meses": "Correr 10k",
    "Lesiones / cuidados": "Rodilla izquierda",
  };
  const adult = completionSummary({
    name: "Ana López",
    kid: null,
    version: "adultos",
    program: "Adultos",
    trialEpoch: FRI_7PM,
    phone: "+5215511112222",
    fields,
  });
  const lines = adult.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /Ana López.*Adultos.*viernes 16 de octubre 7:00 PM/);
  assert.equal(lines[1], "• Motivo principal: Bajar de peso");
  assert.equal(lines[2], "• Costo de seguir así: Me siento sin energía");
  assert.equal(lines[3], "• Lesiones / cuidados: Rodilla izquierda");
  const kid = completionSummary({
    name: "Laura",
    kid: "Mateo",
    version: "kids",
    program: null,
    trialEpoch: null,
    phone: null,
    fields: { "Meta 6 meses": "Más confianza" },
  });
  assert.match(kid, /\*Laura \(Mateo\)\* · Kids · sin fecha/);
  assert.match(kid, /• Meta 6 meses: Más confianza/);
  assert.match(kid, /• Motivo principal: —/);
});

// ---- Airtable PATCH drift tolerance -------------------------------------------------------

test("patchLeadAnswers: drops columns Airtable doesn't have yet and retries", async () => {
  const calls: Record<string, unknown>[] = [];
  const fake = async (_e: Env, _t: string, id: string, fields: Record<string, unknown>) => {
    calls.push({ ...fields });
    if ("Meses bebé" in fields) throw new AirtableWriteError('Unknown field name: "Meses bebé"', true, 422);
    return { id, fields };
  };
  const env = { AIRTABLE_TRIALS_TABLE: "Leads" } as unknown as Env;
  const r = await patchLeadAnswers(env, REC, { "Meses bebé": 18, "Quién lo trae": "Mamá" }, fake);
  assert.deepEqual(r.dropped, ["Meses bebé"]);
  assert.deepEqual(r.record?.fields, { "Quién lo trae": "Mamá" });
  assert.equal(calls.length, 2);

  const other = async () => {
    throw new AirtableWriteError("NOT_FOUND", false, 404);
  };
  await assert.rejects(() => patchLeadAnswers(env, REC, { "Quién lo trae": "Papá" }, other), /NOT_FOUND/);
});

// ---- sync-loop send gating (web-form bookings) ----------------------------------------

test("syncCuestionario: dark unless CUESTIONARIO_ENABLED=1 + secret; skips an already-stamped record", async () => {
  const untouchable = {
    prepare() {
      throw new Error("DB must not be touched");
    },
  };
  const note = async () => {};
  const off = { DB: untouchable, CUESTIONARIO_ENABLED: "0", CUESTIONARIO_SECRET: "s" } as unknown as Env;
  assert.equal(cuestionarioEnabled(off), false);
  assert.equal(await syncCuestionario(off, note, { id: REC }, "5215511112222"), null);
  const noSecret = { DB: untouchable, CUESTIONARIO_ENABLED: "1" } as unknown as Env;
  assert.equal(cuestionarioEnabled(noSecret), false);
  const on = { DB: untouchable, CUESTIONARIO_ENABLED: "1", CUESTIONARIO_SECRET: "s" } as unknown as Env;
  assert.equal(cuestionarioEnabled(on), true);
  assert.equal(await syncCuestionario(on, note, { id: REC, cuestionarioEnviado: "2026-10-14" }, "5215511112222", NOW), null);
  // A DB failure is swallowed (never throws into the sync loop).
  assert.equal(await syncCuestionario(on, note, { id: REC }, "5215511112222", NOW), null);
});

// ---- review round 2026-10-13 ------------------------------------------------------

/** Minimal in-memory kv over the SQL shapes db/queries.ts uses. */
function fakeKvDb(): { db: D1Database; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (/SELECT value FROM kv/.test(sql)) {
            const v = kv.get(String(args[0]));
            return (v === undefined ? null : { value: v }) as T | null;
          }
          return null;
        },
        async run() {
          const k = String(args[0]);
          if (/INSERT OR IGNORE INTO kv/.test(sql)) {
            if (kv.has(k)) return { results: [], meta: { changes: 0 } };
            kv.set(k, String(args[1]));
            return { results: [], meta: { changes: 1 } };
          }
          if (/DELETE FROM kv WHERE key = \?1/.test(sql)) {
            kv.delete(k);
            return { results: [], meta: { changes: 1 } };
          }
          if (/INSERT INTO kv/.test(sql)) {
            kv.set(k, String(args[1]));
            return { results: [], meta: { changes: 1 } };
          }
          throw new Error(`fake db: unsupported ${sql}`);
        },
        async all() {
          return { results: [], meta: {} };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, kv };
}

const LEAD_FIELDS = {
  "# de Teléfono": "+5215511112222",
  "Nombre de Lead": "Ana",
  "Fecha Clase Prueba": "2026-10-17T01:00:00.000Z",
  Programa: "Adultos",
};

function sendDeps(over: Partial<Parameters<typeof sendCuestionario>[1]> = {}) {
  const sent: string[] = [];
  const templates: { name: string; components: unknown[] }[] = [];
  const notes: string[] = [];
  const patches: Record<string, unknown>[] = [];
  const deps: Parameters<typeof sendCuestionario>[1] = {
    postNote: async (t) => {
      notes.push(t);
    },
    now: () => NOW,
    getRecord: async (_e, id) => ({ id, fields: { ...LEAD_FIELDS } }),
    getContact: async () => null,
    sendText: async (_e, _p, body) => {
      sent.push(body);
      return "wamid.1";
    },
    sendTemplate: async (_e, _p, name, _l, components) => {
      templates.push({ name, components: components ?? [] });
      return "wamid.t";
    },
    patch: async (_e, _id, fields) => {
      patches.push(fields);
    },
    ...over,
  };
  return { deps, sent, templates, notes, patches };
}

test("sendCuestionario: atomic claim — second send is already_sent; a failed send releases the claim", async () => {
  const { db, kv } = fakeKvDb();
  const env = { DB: db, CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  const ok = sendDeps();
  const r1 = await sendCuestionario(env, ok.deps, { recordId: REC });
  assert.equal(r1.ok, true);
  assert.equal(ok.sent.length, 1);
  assert.ok(kv.has(sentKey(REC)));
  assert.deepEqual(ok.patches[0], { "Cuestionario enviado": "2026-10-14", "Cuestionario versión": "adultos" });
  const r2 = await sendCuestionario(env, ok.deps, { recordId: REC });
  assert.deepEqual(r2, { ok: false, reason: "already_sent" });
  assert.equal(ok.sent.length, 1);
  // resend bypasses the claim
  assert.equal((await sendCuestionario(env, ok.deps, { recordId: REC, resend: true })).ok, true);

  const fresh = fakeKvDb();
  const env2 = { DB: fresh.db, CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  const boom = sendDeps({
    sendText: async () => {
      throw new Error("graph 500");
    },
  });
  const r3 = await sendCuestionario(env2, boom.deps, { recordId: REC });
  assert.equal(r3.ok, false);
  assert.equal(fresh.kv.has(sentKey(REC)), false, "claim released");
  assert.equal(boom.patches.length, 0);
  // …so a retry can send.
  assert.equal((await sendCuestionario(env2, sendDeps().deps, { recordId: REC })).ok, true);
});

test("sendCuestionario: closed window → invite template with the token as the button suffix; marker set", async () => {
  const { db, kv } = fakeKvDb();
  const env = { DB: db, CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  const t = sendDeps({
    sendText: async (_e, p) => {
      throw new WindowClosedError(p);
    },
    getRecord: async (_e, id) => ({
      id,
      fields: { ...LEAD_FIELDS, Programa: "Kids", "Nombre Del Niñ@": "mateo" },
    }),
  });
  const r = await sendCuestionario(env, t.deps, { recordId: REC });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.via, "template");
  assert.equal(t.templates[0]!.name, "cuestionario_invite_kids_es");
  const comps = t.templates[0]!.components as { type: string; parameters: { text: string }[] }[];
  assert.deepEqual(
    comps[0]!.parameters.map((p) => p.text),
    ["viernes 16 de octubre a las 7:00 PM", "Mateo", "Mateo"],
  );
  const token = comps[1]!.parameters[0]!.text;
  assert.deepEqual(await verifyToken(SECRET, token, NOW), {
    recordId: REC,
    version: "kids",
    exp: NOW + TOKEN_TTL_SEC,
  });
  assert.ok(kv.has(sentKey(REC)));
  assert.equal(t.patches.length, 1);
  assert.equal(t.notes.length, 0);
});

test("sendCuestionario: template also fails → no per-lead note, one ops note per day, claim released", async () => {
  const { db, kv } = fakeKvDb();
  const env = { DB: db, CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  const t = sendDeps({
    sendText: async (_e, p) => {
      throw new WindowClosedError(p);
    },
    sendTemplate: async () => {
      throw new Error("template not approved");
    },
  });
  const r1 = await sendCuestionario(env, t.deps, { recordId: REC });
  const r2 = await sendCuestionario(env, t.deps, { recordId: "recZZZZZZZZZZZZZZ" });
  assert.equal(r1.ok, false);
  assert.equal(!r1.ok && r1.reason, "window_closed");
  assert.equal(r2.ok, false);
  assert.equal(t.notes.length, 1, "one daily note, not one per lead");
  assert.equal(kv.has(sentKey(REC)), false);
  assert.equal(t.patches.length, 0);
});

test("invite template bodies: no link, no name, date + kid variables; button sample is a real link", () => {
  const { body, kidVars } = inviteTemplateBody("Listo{who}, quedó tu clase{cuando}. Para {kid} y {kid}: {link}", "es");
  assert.equal(body, "Listo, quedó tu clase el {{1}}. Para {{2}} y {{3}}.");
  assert.equal(kidVars, 2);
  const inputs = cuestionarioTemplateInputs();
  assert.deepEqual(
    inputs.map((i) => i.name),
    ["cuestionario_invite_es", "cuestionario_invite_en", "cuestionario_invite_kids_es", "cuestionario_invite_kids_en"],
  );
  for (const i of inputs) {
    assert.doesNotMatch(i.body, /\{link\}|https?:|\{who\}|\{kid\}|\{cuando\}/);
    assert.equal(i.category, "UTILITY");
    const vars = i.body.match(/\{\{\d\}\}/g) ?? [];
    assert.equal(vars.length, i.bodyExamples?.length);
  }
  assert.match(INVITE_URL_EXAMPLE, /^https:\/\/mdcondesa\.com\/cuestionario\/\?t=v1\./);
  const comps = inviteTemplateComponents("adultos", "es", WED_1PM, null, "tok", 0) as {
    parameters: { text: string }[];
  }[];
  assert.deepEqual(comps[0]!.parameters.map((p) => p.text), ["miércoles 14 de octubre a la 1:00 PM"]);
  assert.equal(comps[1]!.parameters[0]!.text, "tok");
});

test("slackEscape / completionSummary: lead text can't ping or smuggle links", () => {
  assert.equal(slackEscape("<!channel> & <https://evil|x>"), "&lt;!channel&gt; &amp; &lt;https://evil|x&gt;");
  const out = completionSummary({
    name: "<!channel>",
    kid: "<https://evil|x>",
    version: "kids",
    program: "<!here>",
    trialEpoch: null,
    phone: null,
    fields: { "Motivo principal": "<https://evil|x>", "Meta 6 meses": "<!channel>", "Lesiones / cuidados": "a & b" },
  });
  assert.doesNotMatch(out, /<!|<https/);
  assert.match(out, /&lt;!channel&gt;/);
  assert.match(out, /&lt;https:\/\/evil\|x&gt;/);
  assert.match(out, /a &amp; b/);
});

test("postCompletionOnce: a double __complete posts the summary once", async () => {
  const { db, kv } = fakeKvDb();
  let posts = 0;
  const post = async () => {
    posts++;
  };
  assert.equal(await postCompletionOnce(db, REC, post, NOW), true);
  assert.equal(await postCompletionOnce(db, REC, post, NOW), false);
  assert.equal(posts, 1);
  assert.ok(kv.has(doneKey(REC)));
});

test("patchLeadAnswers: at most fields+1 attempts; every column unknown → record null (not an error)", async () => {
  const env = { AIRTABLE_TRIALS_TABLE: "Leads" } as unknown as Env;
  let calls = 0;
  const allUnknown = async (_e: Env, _t: string, _id: string, fields: Record<string, unknown>) => {
    calls++;
    const first = Object.keys(fields)[0]!;
    throw new AirtableWriteError(`Unknown field name: "${first}"`, true, 422);
  };
  const r = await patchLeadAnswers(env, REC, { A: 1, B: 2 }, allUnknown);
  assert.deepEqual(r, { record: null, dropped: ["A", "B"] });
  assert.equal(calls, 2);
  // An unknown-field error naming a column we didn't send is rethrown, not looped.
  const odd = async () => {
    throw new AirtableWriteError('Unknown field name: "toString"', true, 422);
  };
  await assert.rejects(() => patchLeadAnswers(env, REC, { A: 1 }, odd), /toString/);
});

test("deriveVersion: a child name means kids when Programa is empty", () => {
  const m = leadsMap();
  assert.equal(deriveVersion({ [m.childName]: "Mateo" }, m), "kids");
  assert.equal(deriveVersion({}, m, null, "Sofi"), "kids");
  assert.equal(deriveVersion({ [m.childName]: "Mateo" }, m, "baby"), "bfc");
  assert.equal(deriveVersion({ [m.audience]: "Adultos", [m.childName]: "Mateo" }, m), "adultos");
  assert.equal(deriveVersion({}, m, null, "  "), "adultos");
});

test("day-before motivo reminder: adults vs parents; unknown child → generic", () => {
  const base = { lang: "es" as const, name: "Laura", trialEpoch: FRI_7PM, motivoPrincipal: "Más disciplina.", meta6Meses: null };
  assert.equal(
    dayBeforeMotivoText({ ...base, version: "kids", kid: "Mateo" }),
    "Hola Laura! Mañana a las 7:00 PM es la clase de Mateo. Ya le pasé al coach que buscan más disciplina, lo va a estar esperando. Av. México 49, 1º piso. Lleguen 10 min antes.",
  );
  assert.equal(dayBeforeMotivoText({ ...base, version: "bfc", kid: null }), null);
  assert.match(dayBeforeMotivoText({ ...base, version: "adultos", kid: "Mateo" })!, /que buscas más disciplina, te va/);
  assert.match(
    dayBeforeMotivoText({ ...base, lang: "en", version: "kids", kid: "Mateo", motivoPrincipal: "Discipline" })!,
    /^Hi Laura! Mateo's class is tomorrow at 7:00 PM\. I already told the coach you're looking for discipline/,
  );
  assert.deepEqual(reminderAudience({ cuestionarioVersion: "bfc", childName: "sofi" }), { version: "bfc", kid: "Sofi" });
  assert.deepEqual(reminderAudience({ cuestionarioVersion: null, childName: "Mateo" }), { version: "kids", kid: "Mateo" });
  assert.deepEqual(reminderAudience({ cuestionarioVersion: null, childName: null }), { version: "adultos", kid: null });
  assert.deepEqual(reminderAudience(null), { version: "adultos", kid: null });
});

test("syncCuestionario: quiet hours (21:00–08:00 CDMX) skip without claiming", async () => {
  const { db, kv } = fakeKvDb();
  const env = { DB: db, CUESTIONARIO_ENABLED: "1", CUESTIONARIO_SECRET: SECRET } as unknown as Env;
  const night = FRI_7PM + 4 * 3600; // 23:00 CDMX
  assert.equal(await syncCuestionario(env, async () => {}, { id: REC }, "5215511112222", night), null);
  assert.equal(kv.size, 0, "nothing claimed at night");
});

test("token: a non-canonical signature encoding (same bytes) is rejected", async () => {
  const t = await signToken(SECRET, { recordId: REC, version: "adultos" }, NOW);
  const [v, p, sig] = t.split(".") as [string, string, string];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(sig[sig.length - 1]!);
  // 16 bytes → 22 chars; the last char's low 4 bits are padding.
  const variant = sig.slice(0, -1) + alphabet[last ^ 1]!;
  assert.deepEqual([...b64urlDecode(variant)!], [...b64urlDecode(sig)!], "same decoded bytes");
  assert.deepEqual(await verifyToken(SECRET, `${v}.${p}.${variant}`, NOW), { error: "invalid" });
  assert.equal((await verifyToken(SECRET, t, NOW) as { recordId: string }).recordId, REC);
});

test("sanitizeAnswers: enum columns take only their options; multi-selects take only strings", () => {
  const { fields } = sanitizeAnswers("adultos", {
    answers: {
      "Días por semana": "4+",
      "Rápido o permanente": "Para siempre",
      Motivos: 7,
      "Horarios preferidos": true,
    },
  });
  assert.deepEqual(fields, { "Días por semana": "4+" });
  assert.deepEqual(sanitizeAnswers("adultos", { answers: { "Días por semana": 3 } }).fields, { "Días por semana": "3" });
  assert.deepEqual(sanitizeAnswers("adultos", { answers: { "Días por semana": "5" } }).fields, {});
  assert.deepEqual(sanitizeAnswers("adultos", { answers: { "Rápido o permanente": "Permanentes" } }).fields, {
    "Rápido o permanente": "Permanentes",
  });
  assert.deepEqual(sanitizeAnswers("kids", { answers: { "Días por semana": null } }).fields, { "Días por semana": null });
});
