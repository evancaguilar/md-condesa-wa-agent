import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clickTimeIso,
  gclidColumnValue,
  googleClickFromAd,
  googleClickKey,
  googleRefKey,
  parseGoogleClickBeacon,
  parseGoogleClickCode,
  parseGoogleClickRef,
  parseStoredGoogleClick,
} from "../src/services/google-click.js";
import { buildLeadFields, DEFAULT_LEADS_MAP } from "../src/services/airtable.js";
import { gclidFromAdSweep } from "../src/services/metrics-airtable.js";
import type { Env } from "../src/types.js";
import { GREF_DAILY_CAP, handleGoogleClickBeacon } from "../src/routes/google-click.js";
import { matchCampaign, normalizeText } from "../src/pipeline/campaigns.js";
import type { AirtableLeadsMap } from "../src/client-config.js";
import type { Campaign } from "../src/types.js";

// The exact text the site's js/attribution.js prefills after a click on
// /jiu-jitsu/?gclid=TEST123 (md-condesa-site tools/test-attribution.js).
const SITE_TEXT = "Hola, vi su anuncio en Google [ref gclid:TEST123:1790251200]";
const SITE_TEXT_KW = "Hola, vi su anuncio en Google (kw: clases de box condesa) [ref gclid:TEST123:1790251200]";

test("parseGoogleClickRef: site prefill → click + body without the ref", () => {
  assert.deepEqual(parseGoogleClickRef(SITE_TEXT), {
    click: { kind: "gclid", id: "TEST123", ts: 1790251200 },
    body: "Hola, vi su anuncio en Google",
  });
  assert.deepEqual(parseGoogleClickRef(SITE_TEXT_KW).body, "Hola, vi su anuncio en Google (kw: clases de box condesa)");
});

test("parseGoogleClickRef: gbraid / wbraid / real-looking gclid", () => {
  const g = parseGoogleClickRef("Hola [ref gbraid:0AAAAAo-abc_XYZ:1790251200]").click;
  assert.deepEqual(g, { kind: "gbraid", id: "0AAAAAo-abc_XYZ", ts: 1790251200 });
  const w = parseGoogleClickRef("Hola\n[ref wbraid:CjkKCQjw:1790251200] y otra cosa");
  assert.equal(w.click?.kind, "wbraid");
  assert.equal(w.body, "Hola y otra cosa");
  const real = "Cj0KCQjw8a2b3c4d5e6f7g8h9EAIaIQobChMI_x-Y";
  assert.equal(parseGoogleClickRef(`Hola [ref gclid:${real}:1790251200]`).click?.id, real);
});

test("parseGoogleClickRef: no ref / malformed ref → body untouched", () => {
  for (const b of [
    "Hola, vi su anuncio en Google",
    "Hola [ref gclid:TEST123]", // no time
    "Hola [ref fbclid:TEST123:1790251200]", // not a Google id
    "Hola [ref gclid:bad]id:1790251200]",
    "Hola [ref gclid:abc:1790251200]", // id too short
    "",
  ]) {
    assert.deepEqual(parseGoogleClickRef(b), { click: null, body: b }, b);
  }
});

test("campaign trigger still matches once the ref is stripped (and even if it were not)", () => {
  const google: Campaign = {
    id: 9,
    name: "Google Search (anuncios Google)",
    trigger_phrase: "Hola, vi su anuncio en Google",
    trigger_norm: normalizeText("Hola, vi su anuncio en Google"),
    first_reply: null,
    status: "active",
  } as unknown as Campaign;
  assert.equal(matchCampaign(normalizeText(parseGoogleClickRef(SITE_TEXT_KW).body), [google]), 9);
  assert.equal(matchCampaign(normalizeText(SITE_TEXT_KW), [google]), 9);
});

test("gclidColumnValue / clickTimeIso: the shapes the site's form prefill uses", () => {
  assert.equal(gclidColumnValue({ kind: "gclid", id: "TEST123", ts: 0 }), "TEST123");
  assert.equal(gclidColumnValue({ kind: "gbraid", id: "0AAA", ts: 0 }), "gbraid:0AAA");
  assert.equal(gclidColumnValue({ kind: "wbraid", id: "CjkK", ts: 0 }), "wbraid:CjkK");
  // 2026-09-24T12:00:00Z — same instant as the site test → same string.
  assert.equal(clickTimeIso(1790251200), "2026-09-24T06:00:00-06:00");
  assert.equal(clickTimeIso(Date.parse("2026-10-13T03:00:00Z") / 1000), "2026-10-12T21:00:00-06:00");
});

test("parseStoredGoogleClick: round-trip, junk → null", () => {
  const c = { kind: "gclid" as const, id: "TEST123", ts: 1790251200 };
  assert.deepEqual(parseStoredGoogleClick(JSON.stringify(c)), c);
  assert.equal(parseStoredGoogleClick(null), null);
  assert.equal(parseStoredGoogleClick("{nope"), null);
  assert.equal(parseStoredGoogleClick(JSON.stringify({ ...c, kind: "fbclid" })), null);
  assert.equal(parseStoredGoogleClick(JSON.stringify({ ...c, ts: "x" })), null);
  assert.equal(googleClickKey("5215512345678"), "gclick:5215512345678");
});

// ---- buildLeadFields: Leads.gclid / gclid_time --------------------------

const MAP: AirtableLeadsMap = { ...DEFAULT_LEADS_MAP, gclid: "gclid", gclidTime: "gclid_time" };
const CLICK = { kind: "gclid" as const, id: "TEST123", ts: 1790251200 };

test("buildLeadFields writes gclid + gclid_time on a new lead", () => {
  const f = buildLeadFields(null, { phone: "5215500000000", googleClick: CLICK }, MAP);
  assert.equal(f["gclid"], "TEST123");
  assert.equal(f["gclid_time"], "2026-09-24T06:00:00-06:00");
});

test("buildLeadFields never overwrites a gclid (form-submitted or earlier), nor pairs its time", () => {
  const f = buildLeadFields({ gclid: "FROMFORM" }, { phone: "521", googleClick: CLICK }, MAP);
  assert.equal("gclid" in f, false);
  assert.equal("gclid_time" in f, false);
});

test("buildLeadFields: no click, or the map names no column → nothing written", () => {
  assert.equal("gclid" in buildLeadFields(null, { phone: "521" }, MAP), false);
  const f = buildLeadFields(null, { phone: "521", googleClick: CLICK }, DEFAULT_LEADS_MAP);
  assert.equal(Object.keys(f).some((k) => k.startsWith("gclid")), false);
});

// ---- form path: Google click folded into the `Ad` answer -----------------

test("googleClickFromAd: site's form Ad → gclid + time; gbraid/wbraid keep their kind", () => {
  assert.deepEqual(
    googleClickFromAd("google | kw: jiu jitsu condesa | ag: 178223344556 | camp: 24283317593 | gclid: TEST123 | t: 2026-10-12T14:46:10-06:00"),
    { gclid: "TEST123", time: "2026-10-12T14:46:10-06:00" },
  );
  assert.deepEqual(googleClickFromAd("google | gbraid: 0AAAAAo-abc_XYZ | t: 2026-10-12T14:46:10-06:00"), {
    gclid: "gbraid:0AAAAAo-abc_XYZ",
    time: "2026-10-12T14:46:10-06:00",
  });
  // Rows from before the site sent t: (the live 2026-10-05 lead) → id only.
  assert.deepEqual(
    googleClickFromAd("google | gclid: Cj0KCQjw8ofWBhCHARIsANBj4Lt5NKgC95CKFZgedT5Fhh5trQoK37mu-DSURXzagQgf13aXUb1aMngaAsfLEALw_wcB"),
    { gclid: "Cj0KCQjw8ofWBhCHARIsANBj4Lt5NKgC95CKFZgedT5Fhh5trQoK37mu-DSURXzagQgf13aXUb1aMngaAsfLEALw_wcB", time: null },
  );
});

test("googleClickFromAd: Meta / no id / junk → null; a bad time is dropped", () => {
  for (const ad of [null, "", "utm (120212345678901)", "google | kw: box", "google | camp: 1 | ag: 2", "gclid: TEST123"]) {
    assert.equal(googleClickFromAd(ad), null, String(ad));
  }
  assert.deepEqual(googleClickFromAd("google | gclid: TEST123 | t: ayer"), { gclid: "TEST123", time: null });
});

const fakeRes = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const SWEEP_ENV = { AIRTABLE_PAT: "pat", AIRTABLE_BASE_ID: "appX", AIRTABLE_TRIALS_TABLE: "Leads" } as unknown as Env;

test("gclidFromAdSweep: lists only blank-gclid Google rows, PATCHes gclid (+ time when the Ad has one)", async () => {
  const urls: string[] = [];
  const patched: unknown[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    urls.push(decodeURIComponent(String(url).replace(/\+/g, " ")));
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { records: { id: string; fields: unknown }[] };
      patched.push(...body.records);
      return fakeRes(200, { records: body.records });
    }
    return fakeRes(200, { records: [
      { id: "recNew", fields: { Ad: "google | gclid: TEST123 | t: 2026-10-12T14:46:10-06:00" } },
      { id: "recOld", fields: { Ad: "google | gclid: Cj0KCQjw_old" } },
      { id: "recBad", fields: { Ad: "google | gclid: x" } },
    ] });
  };
  try {
    const st = await gclidFromAdSweep(SWEEP_ENV, { limit: 10 }, { ad: "Ad", gclid: "gclid", gclidTime: "gclid_time" });
    assert.match(urls[0]!, /AND\(\{gclid\} = '', REGEX_MATCH\(\{Ad\} & '', '\(gclid\|gbraid\|wbraid\): '\)\)/);
    assert.deepEqual(patched, [
      { id: "recNew", fields: { gclid: "TEST123", gclid_time: "2026-10-12T14:46:10-06:00" } },
      { id: "recOld", fields: { gclid: "Cj0KCQjw_old" } },
    ]);
    assert.deepEqual({ scanned: st.scanned, matched: st.matched }, { scanned: 3, matched: 2 });
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});

test("gclidFromAdSweep: no gclid column in the client map → no request at all", async () => {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error("must not fetch"); };
  try {
    const st = await gclidFromAdSweep(SWEEP_ENV, { limit: 10 }, { ad: "Ad" });
    assert.equal(st.scanned, 0);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});

// ---- short code (attribution.js v8): "[K7M2QX]" + /g beacon ------------

test("parseGoogleClickCode: strips the bracketed code; ignores lowercase / ambiguous chars", () => {
  assert.deepEqual(parseGoogleClickCode("Hola, vi su anuncio en Google (kw: jiu jitsu) [K7M2QX]"), {
    code: "K7M2QX",
    body: "Hola, vi su anuncio en Google (kw: jiu jitsu)",
  });
  for (const b of ["Hola [k7m2qx]", "Hola [K7M2Q0]", "Hola [K7M2Q]", "Hola [K7M2QXZ]", "Hola"]) {
    assert.deepEqual(parseGoogleClickCode(b), { code: null, body: b }, b);
  }
});

const NOW = 1791841634;
const beacon = (o: Record<string, unknown>) =>
  JSON.stringify({ code: "K7M2QX", kind: "gclid", id: "EVANTEST1", ts: NOW * 1000, ...o });

test("parseGoogleClickBeacon: valid body → code + click (ts ms → s); anything off → null", () => {
  assert.deepEqual(parseGoogleClickBeacon(beacon({}), NOW), {
    code: "K7M2QX",
    click: { kind: "gclid", id: "EVANTEST1", ts: NOW },
  });
  for (const raw of [
    "",
    "nope",
    beacon({ code: "k7m2qx" }),
    beacon({ kind: "fbclid" }),
    beacon({ id: "bad id" }),
    beacon({ ts: "x" }),
    beacon({ ts: (NOW + 7200) * 1000 }), // future
    beacon({ ts: (NOW - 91 * 86400) * 1000 }), // past Google's 90 days
    "x".repeat(2000),
  ]) {
    assert.equal(parseGoogleClickBeacon(raw, NOW), null, raw.slice(0, 60));
  }
});

/** Just enough D1 for the kv statements the /g handler runs. */
function kvDb(kv: Map<string, string>): D1Database {
  const stmt = (sql: string, binds: unknown[]) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => (kv.has(String(binds[0])) ? { value: kv.get(String(binds[0])) } : null),
    run: async () => {
      const k = String(binds[0]);
      let changes = 0;
      if (sql.includes("INSERT OR IGNORE")) {
        if (!kv.has(k)) { kv.set(k, sql.includes("'0'") ? "0" : String(binds[1])); changes = 1; }
      } else if (sql.includes("+ 1")) {
        const n = Number(kv.get(k) ?? 0);
        if (n < Number(binds[1])) { kv.set(k, String(n + 1)); changes = 1; }
      }
      return { meta: { changes } };
    },
  });
  return { prepare: (sql: string) => stmt(sql, []) } as unknown as D1Database;
}

const post = (body: string, method = "POST") =>
  new Request("https://w.example/g", method === "POST" ? { method, body, headers: { "Content-Type": "text/plain" } } : { method });

test("/g: stores a valid click once, answers 204 + CORS to everything, drops junk", async () => {
  const kv = new Map<string, string>();
  const env = { DB: kvDb(kv) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  try {
    const r = await handleGoogleClickBeacon(post(beacon({})), env);
    assert.equal(r.status, 204);
    assert.equal(r.headers!.get("Access-Control-Allow-Origin"), "*");
    assert.deepEqual(JSON.parse(kv.get(googleRefKey("K7M2QX"))!), { kind: "gclid", id: "EVANTEST1", ts: NOW });
    // A re-send (or a collision) never overwrites, and doesn't spend the daily cap.
    await handleGoogleClickBeacon(post(beacon({ id: "OTHER123" })), env);
    assert.equal(JSON.parse(kv.get(googleRefKey("K7M2QX"))!).id, "EVANTEST1");
    assert.equal([...kv.keys()].filter((k) => k.startsWith("gref_day:")).map((k) => kv.get(k))[0], "1");
    assert.equal((await handleGoogleClickBeacon(post("junk"), env)).status, 204);
    assert.equal((await handleGoogleClickBeacon(post("", "OPTIONS"), env)).status, 204);
    assert.equal((await handleGoogleClickBeacon(post("", "GET"), env)).status, 405);
    assert.equal([...kv.keys()].filter((k) => k.startsWith("gref:")).length, 1);
  } finally {
    Date.now = realNow;
  }
});

test("/g: past the daily cap new codes are dropped silently", async () => {
  const kv = new Map<string, string>();
  const env = { DB: kvDb(kv) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  try {
    await handleGoogleClickBeacon(post(beacon({})), env);
    const dayKey = [...kv.keys()].find((k) => k.startsWith("gref_day:"))!;
    kv.set(dayKey, String(GREF_DAILY_CAP));
    await handleGoogleClickBeacon(post(beacon({ code: "ABCDEF" })), env);
    assert.equal(kv.has(googleRefKey("ABCDEF")), false);
  } finally {
    Date.now = realNow;
  }
});
