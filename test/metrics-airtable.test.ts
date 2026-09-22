import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_METRICS_MAP,
  MetricsSchemaError,
  adRecords,
  adUnlinkedLeadsFormula,
  batchUpsert,
  campaignRecords,
  chunk,
  duplicateStudentCandidates,
  leadAdLinkPatch,
  leadLinkPatch,
  linkLeadsSweep,
  listRecords,
  monthOf,
  numOrNull,
  spendKey,
  spendRowFields,
  studentLinkDecision,
  twinAttribution,
  unattributedLeadsFormula,
  unlinkedLeadsFormula,
  unlinkedStudentsFormula,
} from "../src/services/metrics-airtable.js";
import type { InsightRow } from "../src/services/meta-insights.js";
import type { Env } from "../src/types.js";

const M = DEFAULT_METRICS_MAP;
const ENV = { AIRTABLE_PAT: "pat-test", AIRTABLE_BASE_ID: "appTEST", AIRTABLE_TRIALS_TABLE: "Leads" } as unknown as Env;

const ROW: InsightRow = {
  date: "2026-09-08",
  adId: "120249684011860518",
  adName: "Buscamos Personas Débiles!",
  adSetId: "111",
  adSetName: "cold 2mi",
  campaignId: "222",
  campaignName: "Reto Gladiador",
  spend: 123.45,
  impressions: 1000,
  clicks: 40,
  reach: 800,
  conversations: 7,
  currency: "MXN",
};

test("spendKey / monthOf / chunk", () => {
  assert.equal(spendKey("2026-09-08", "1"), "2026-09-08 · 1");
  assert.equal(monthOf("2026-09-08"), "2026-09");
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 10), []);
});

test("spendRowFields: key, numbers, links as primary-value strings, campaign link optional", () => {
  const f = spendRowFields(ROW, "act_1", "2026-09-09T11:32:00.000Z", M);
  assert.equal(f["Clave"], "2026-09-08 · 120249684011860518");
  assert.equal(f["Fecha"], "2026-09-08");
  assert.equal(f["Cuenta"], "act_1");
  assert.equal(f["Gasto"], 123.45);
  assert.equal(f["Conversaciones (Meta)"], 7);
  assert.deepEqual(f["Anuncio"], ["120249684011860518"]);
  assert.deepEqual(f["Campaña Meta"], ["222"]);
  assert.deepEqual(f["Día"], ["2026-09-08"]);
  assert.deepEqual(f["Mes"], ["2026-09"]);
  assert.equal(f["Actualizado"], "2026-09-09T11:32:00.000Z");
  const g = spendRowFields({ ...ROW, campaignId: "" }, "act_1", "x", M);
  assert.ok(!("Campaña Meta" in g));
});

test("adRecords / campaignRecords dedupe and skip blanks", () => {
  const rows = [ROW, { ...ROW, date: "2026-09-07" }, { ...ROW, adId: "2", campaignId: "" }];
  const ads = adRecords(rows, M);
  assert.equal(ads.length, 2);
  assert.deepEqual(ads[0]!["Campaña Meta"], ["222"]);
  assert.ok(!("Campaña Meta" in ads[1]!));
  const camps = campaignRecords(rows, M);
  assert.deepEqual(camps, [{ "Campaña ID": "222", Nombre: "Reto Gladiador" }]);
});

test("leadLinkPatch: day+month(+ad) links; blank day → null; month derived", () => {
  assert.deepEqual(
    leadLinkPatch({ "Día Lead": "2026-09-08", "Mes Lead": "2026-09", "Ad ID": "120249684011860518" }, M),
    { Día: ["2026-09-08"], Mes: ["2026-09"], Anuncio: ["120249684011860518"] },
  );
  assert.deepEqual(leadLinkPatch({ "Día Lead": "2026-09-08", "Mes Lead": "", "Ad ID": "" }, M), {
    Día: ["2026-09-08"],
    Mes: ["2026-09"],
  });
  assert.equal(leadLinkPatch({ "Día Lead": "", "Ad ID": "1" }, M), null);
  assert.equal(leadLinkPatch({ "Día Lead": { error: "#ERROR!" } }, M), null);
});

test("sweep formulas name the link, the text formula and the since bound", () => {
  const f = unlinkedLeadsFormula("2026-07-01T06:00:00.000Z", M);
  assert.equal(f, "AND({Día} = '', {Día Lead} != '', IS_AFTER(CREATED_TIME(), '2026-07-01T06:00:00.000Z'))");
  const s = unlinkedStudentsFormula("2026-07-01T06:00:00.000Z", M);
  assert.ok(s.includes("{Lead Original} = ''") && s.includes("{Teléfono} != ''"));
});

test("leadAdLinkPatch: Anuncio only, for a late ad id; never overwrites; junk ids → null", () => {
  assert.deepEqual(leadAdLinkPatch({ "Ad ID": "120249684011860518" }, M), { Anuncio: ["120249684011860518"] });
  // Airtable returns numeric formula cells as numbers.
  assert.deepEqual(leadAdLinkPatch({ "Ad ID": 120249684011 }, M), { Anuncio: ["120249684011"] });
  assert.deepEqual(leadAdLinkPatch({ "Ad ID": "120249684011860518", Anuncio: [] }, M), {
    Anuncio: ["120249684011860518"],
  });
  assert.equal(leadAdLinkPatch({ "Ad ID": "120249684011860518", Anuncio: ["recHAND"] }, M), null);
  assert.equal(leadAdLinkPatch({ "Ad ID": "123" }, M), null);
  assert.equal(leadAdLinkPatch({ "Ad ID": "utm (120249684011860518)" }, M), null);
  assert.equal(leadAdLinkPatch({ "Ad ID": { error: "#ERROR!" } }, M), null);
  assert.equal(leadAdLinkPatch({}, M), null);
});

test("adUnlinkedLeadsFormula: day-linked, ad-less link, linkable ad id, since bound", () => {
  assert.equal(
    adUnlinkedLeadsFormula("2026-07-01T06:00:00.000Z", M),
    "AND({Anuncio} = '', {Día} != '', LEN({Ad ID} & '') >= 10, IS_AFTER(CREATED_TIME(), '2026-07-01T06:00:00.000Z'))",
  );
});

test("studentLinkDecision: exactly-one rule and lead-predates-student rule", () => {
  const lead = (id: string, createdTime: string) => ({ id, createdTime, fields: {} });
  assert.deepEqual(studentLinkDecision("2026-09-05T10:00:00.000Z", []), { reason: "none" });
  assert.deepEqual(studentLinkDecision("2026-09-05T10:00:00.000Z", [lead("a", "2026-09-01T00:00:00Z"), lead("b", "2026-09-02T00:00:00Z")]), {
    reason: "ambiguous",
  });
  assert.deepEqual(studentLinkDecision("2026-09-05T10:00:00.000Z", [lead("a", "2026-09-06T00:00:00Z")]), {
    reason: "lead_after_student",
  });
  assert.deepEqual(studentLinkDecision("2026-09-05T10:00:00.000Z", [lead("a", "2026-09-01T00:00:00Z")]), { leadId: "a" });
  assert.deepEqual(studentLinkDecision(undefined, [lead("a", "2026-09-06T00:00:00Z")]), { leadId: "a" });
});

test("duplicateStudentCandidates: same name within 120s of a lead-linked twin, nearest wins", () => {
  const unlinked = [
    { id: "dup1", name: "Luna Escalante (bebe) / Kne ✨", createdTime: "2026-09-09T19:55:36.000Z", leadId: null },
    { id: "dup2", name: "Alvaro Alarcon", createdTime: "2026-09-08T02:19:10.000Z", leadId: null },
    { id: "far", name: "Erik Olvera", createdTime: "2026-09-05T17:55:50.000Z", leadId: null },
    { id: "noname", name: "", createdTime: "2026-09-05T17:55:50.000Z", leadId: null },
  ];
  const linked = [
    { id: "twin1", name: "luna escalante (bebe) / kne ✨", createdTime: "2026-09-09T19:55:37.000Z", leadId: "recLead1" },
    { id: "twinOld", name: "Alvaro Alarcón", createdTime: "2026-09-08T02:10:00.000Z", leadId: "recOld" },
    { id: "twin2", name: "Álvaro  Alarcon", createdTime: "2026-09-08T02:19:11.000Z", leadId: "recLead2" },
    { id: "erik", name: "Erik Olvera", createdTime: "2026-09-05T17:45:50.000Z", leadId: "recErik" },
    { id: "nolead", name: "", createdTime: "2026-09-05T17:55:50.000Z", leadId: null },
  ];
  const c = duplicateStudentCandidates(unlinked, linked);
  assert.deepEqual(
    c.map((x) => [x.dupId, x.twinId, x.leadId, x.secondsApart]),
    [
      ["dup1", "twin1", "recLead1", 1],
      ["dup2", "twin2", "recLead2", 1],
    ],
  );
});

test("numOrNull handles Airtable's number, string and error-object cells", () => {
  assert.equal(numOrNull(12), 12);
  assert.equal(numOrNull("12.5"), 12.5);
  assert.equal(numOrNull(""), null);
  assert.equal(numOrNull({ specialValue: "NaN" }), null);
  assert.equal(numOrNull({ error: "#ERROR!" }), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
});

// ---- batch upsert over a stubbed fetch ----

interface Call {
  url: string;
  method: string | undefined;
  body: Record<string, unknown>;
}

function stubFetch(handler: (call: Call, i: number) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; body?: string },
  ): Promise<unknown> => {
    const call: Call = { url, method: init?.method, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
    calls.push(call);
    const r = handler(call, calls.length - 1);
    return {
      ok: r.status < 300,
      status: r.status,
      async json() {
        return r.body;
      },
      async text() {
        return "";
      },
    };
  };
  return calls;
}

test("batchUpsert: ≤10 per call, performUpsert + typecast, tallies, one failure continues", async () => {
  const records = Array.from({ length: 23 }, (_, i) => ({ Clave: `2026-09-0${(i % 9) + 1} · ${i}` }));
  const calls = stubFetch((call, i) => {
    const n = (call.body.records as unknown[]).length;
    if (i === 1) return { status: 500, body: { error: { message: "boom" } } };
    return {
      status: 200,
      body: { createdRecords: Array.from({ length: n - 1 }, (_, k) => `recC${k}`), updatedRecords: ["recU"], records: [] },
    };
  });
  const st = await batchUpsert(ENV, "Ad Spend Diario", ["Clave"], records, { paceMs: 0 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => (c.body.records as unknown[]).length <= 10));
  assert.ok(calls.every((c) => c.method === "PATCH"));
  assert.deepEqual(calls[0]!.body.performUpsert, { fieldsToMergeOn: ["Clave"] });
  assert.equal(calls[0]!.body.typecast, true);
  assert.ok(calls[0]!.url.endsWith("/appTEST/Ad%20Spend%20Diario"));
  assert.equal(st.created, 9 + 2);
  assert.equal(st.updated, 2);
  assert.equal(st.errors.length, 1);
  assert.match(st.errors[0]!, /boom/);
});

test("batchUpsert: an unknown field aborts with MetricsSchemaError", async () => {
  stubFetch(() => ({
    status: 422,
    body: { error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Gasto"' } },
  }));
  let caught: unknown = null;
  try {
    await batchUpsert(ENV, "Ad Spend Diario", ["Clave"], [{ Clave: "x" }], { paceMs: 0 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MetricsSchemaError, String(caught));
  assert.match((caught as Error).message, /Gasto/);
});

test("listRecords: fields[] + formula on the URL, offset pagination, maxRecords honored", async () => {
  const calls = stubFetch((_call, i) =>
    i === 0
      ? { status: 200, body: { records: [{ id: "r1", fields: {} }, { id: "r2", fields: {} }], offset: "itrNext" } }
      : { status: 200, body: { records: [{ id: "r3", fields: {} }] } },
  );
  const rows = await listRecords(ENV, "Leads", {
    filterByFormula: "{Día} = ''",
    fields: ["Día Lead", "Ad ID"],
    maxRecords: 3,
    sort: { field: "Fecha de creación", direction: "desc" },
  });
  assert.equal(rows.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.url.includes("filterByFormula=") && calls[0]!.url.includes("fields%5B%5D=D"));
  assert.ok(calls[0]!.url.includes("maxRecords=3"));
  assert.ok(calls[0]!.url.includes("sort%5B0%5D%5Bdirection%5D=desc"));
  assert.ok(calls[1]!.url.includes("offset=itrNext"));
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("twinAttribution copies the EARLIEST same-phone lead that carries an ad label", () => {
  const lm = { ad: "Ad", campaign: "Campaña" };
  const twins = [
    { id: "self", createdTime: "2026-09-09T17:27:07.000Z", fields: { Ad: "" } },
    { id: "late", createdTime: "2026-09-10T10:00:00.000Z", fields: { Ad: "Otro (120200000000000001)", Campaña: "Kids" } },
    { id: "bot", createdTime: "2026-09-09T17:23:47.000Z", fields: { Ad: "¡Agenda tu Día Gratis! (120249684011870518)", Campaña: "Reto Gladiador" } },
    { id: "noad", createdTime: "2026-09-01T00:00:00.000Z", fields: { Ad: "headline without id" } },
  ];
  assert.deepEqual(twinAttribution(twins, "self", lm), {
    ad: "¡Agenda tu Día Gratis! (120249684011870518)",
    campaign: "Reto Gladiador",
  });
  assert.equal(twinAttribution([twins[0]!, twins[3]!], "self", lm), null);
  assert.equal(twinAttribution([twins[2]!], "bot", lm), null); // never itself
  assert.equal(unattributedLeadsFormula("2026-07-01T06:00:00.000Z", { phone: "# de Teléfono", ad: "Ad" }),
    "AND({Ad} = '', {# de Teléfono} != '', IS_AFTER(CREATED_TIME(), '2026-07-01T06:00:00.000Z'))");
});

// ---- lead link sweep: the late-ad pass (twin sweep fills `Ad` after the day link) ----

const SINCE = "2026-07-01T06:00:00.000Z";
const formulaOf = (c: Call) => new URL(c.url).searchParams.get("filterByFormula") ?? "";
const okPatch = (c: Call) => ({
  status: 200,
  body: { records: (c.body.records as unknown[]).map((_, k) => ({ id: `rec${k}` })) },
});

test("linkLeadsSweep: second pass writes ONLY Anuncio on day-linked leads with a late ad", async () => {
  const calls = stubFetch((c) => {
    if (c.method === "PATCH") return okPatch(c);
    if (formulaOf(c) === unlinkedLeadsFormula(SINCE, M)) {
      return {
        status: 200,
        body: { records: [{ id: "recNEW", fields: { "Día Lead": "2026-09-20", "Mes Lead": "2026-09", "Ad ID": "" } }] },
      };
    }
    return {
      status: 200,
      body: {
        records: [
          { id: "recTWIN", fields: { "Ad ID": "120249684011860518" } },
          { id: "recJUNK", fields: { "Ad ID": "not-an-ad-id" } },
        ],
      },
    };
  });
  const st = await linkLeadsSweep(ENV, { limit: 40, sinceIso: SINCE, paceMs: 0 }, M);
  assert.deepEqual(st, { scanned: 3, linked: 2, adLinked: 1, errors: [] });
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH", "GET", "PATCH"]);
  assert.equal(formulaOf(calls[2]!), adUnlinkedLeadsFormula(SINCE, M));
  // The remaining budget, not a fresh one: both passes share `limit`.
  assert.equal(new URL(calls[2]!.url).searchParams.get("maxRecords"), "39");
  assert.deepEqual(calls[3]!.body.records, [{ id: "recTWIN", fields: { Anuncio: ["120249684011860518"] } }]);
});

test("linkLeadsSweep: a full first page leaves no room — no second list (subrequest cap)", async () => {
  const calls = stubFetch((c) => {
    if (c.method === "PATCH") return okPatch(c);
    return {
      status: 200,
      body: { records: Array.from({ length: 10 }, (_, i) => ({ id: `rec${i}`, fields: { "Día Lead": "2026-09-20" } })) },
    };
  });
  const st = await linkLeadsSweep(ENV, { limit: 10, sinceIso: SINCE, paceMs: 0 }, M);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH"]);
  assert.deepEqual(st, { scanned: 10, linked: 10, adLinked: 0, errors: [] });
});

test("linkLeadsSweep: late-ad pass fails soft on a transient error, loud on base drift", async () => {
  const dayRows = { records: [{ id: "recNEW", fields: { "Día Lead": "2026-09-20" } }] };
  stubFetch((c, i) => {
    if (c.method === "PATCH") return okPatch(c);
    return i === 0 ? { status: 200, body: dayRows } : { status: 503, body: { error: { message: "busy" } } };
  });
  const soft = await linkLeadsSweep(ENV, { limit: 40, sinceIso: SINCE, paceMs: 0 }, M);
  assert.equal(soft.linked, 1);
  assert.equal(soft.adLinked, 0);
  assert.equal(soft.errors.length, 1);
  assert.match(soft.errors[0]!, /ad links: .*503/);

  stubFetch((c, i) => {
    if (c.method === "PATCH") return okPatch(c);
    return i === 0
      ? { status: 200, body: dayRows }
      : { status: 422, body: { error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Anuncio"' } } };
  });
  let caught: unknown = null;
  try {
    await linkLeadsSweep(ENV, { limit: 40, sinceIso: SINCE, paceMs: 0 }, M);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MetricsSchemaError, String(caught));
});
