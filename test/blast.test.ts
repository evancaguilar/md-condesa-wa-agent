// Pure blast planning (v2): payload round-trip, parameter rendering, error
// classification, sending window, pasted-list parsing, audience builders,
// run registry parsing and progress folding.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLAST_HOUR_START,
  DEFAULT_DAILY_CAP,
  NAME_FALLBACK,
  blastDueAt,
  blastWindowOpen,
  buildListAudience,
  classifySendError,
  decodeBlastNote,
  encodeBlastNote,
  encodeRunMeta,
  foldRunCounts,
  parseContactList,
  parseRunMeta,
  planBlastAudience,
  renderParams,
  summarizeRuns,
  templateComponents,
  type BlastRunMeta,
} from "../src/services/blast.js";
import { cdmxParts, cdmxToEpoch } from "../src/cron/time.js";
import type { Contact } from "../src/types.js";

function contact(over: Partial<Contact> & { campaign_name?: string | null } = {}): Contact & {
  campaign_name?: string | null;
} {
  return {
    phone: "5215500000000",
    name: null,
    lang: "es",
    status: "lead",
    qualification: null,
    human_override_until: null,
    last_inbound_at: 1_787_000_000,
    campaign_id: null,
    ad_ref: null,
    airtable_lead_id: null,
    created_at: 1_787_000_000,
    updated_at: 1_787_000_000,
    campaign_name: null,
    ...over,
  };
}

const NOW = 1_787_900_000;

// ---- payload ----

test("blast note v2: params, header, name and error survive the round-trip", () => {
  const p = {
    t: "promo_octubre_es",
    l: "es",
    v: ["{nombre}", "15 de octubre"],
    h: { type: "image" as const, link: "https://x/y.jpg" },
    nm: "Ana",
    err: "boom",
    a: 2,
  };
  assert.deepEqual(decodeBlastNote(encodeBlastNote(p)), p);
});

test("blast note v1 still decodes (p2 shape) and junk is rejected", () => {
  const v1 = { t: "adult_follow_up", l: "es_MX", p2: "sábado 2 pm" };
  assert.deepEqual(decodeBlastNote(JSON.stringify(v1)), v1);
  const free = { t: "", l: "", p2: "", txt: "¡Hola! Mañana sábado hay clase 🙌" };
  assert.deepEqual(decodeBlastNote(encodeBlastNote(free)), { t: "", l: "", p2: "", txt: free.txt });
  assert.equal(decodeBlastNote("{not json"), null);
  assert.equal(decodeBlastNote(JSON.stringify({ t: "", l: "" })), null);
  assert.equal(decodeBlastNote(null), null);
});

// ---- params ----

test("renderParams fills {nombre} with a greeting-safe first name or the fallback", () => {
  assert.deepEqual(renderParams(["¡Hola {nombre}!", "sábado"], "María José López"), [
    "¡Hola María!",
    "sábado",
  ]);
  assert.deepEqual(renderParams(["{NAME}"], "ana@mail.com"), [NAME_FALLBACK]);
  assert.deepEqual(renderParams(["{nombre}", "  "], null), [NAME_FALLBACK, NAME_FALLBACK]);
});

test("templateComponents: header + body for v2, legacy 2-param body for v1, none for zero vars", () => {
  const v2 = templateComponents(
    { t: "x", l: "es", v: ["{nombre}"], h: { type: "image", link: "https://a/b.png" } },
    "Luis",
  );
  assert.deepEqual(v2, [
    { type: "header", parameters: [{ type: "image", image: { link: "https://a/b.png" } }] },
    { type: "body", parameters: [{ type: "text", text: "Luis" }] },
  ]);
  assert.equal(templateComponents({ t: "x", l: "es", v: [] }, "Luis"), undefined);
  assert.equal(templateComponents({ t: "x", l: "es", n: 0 }, "Luis"), undefined);
  assert.deepEqual(templateComponents({ t: "x", l: "es", p2: "hoy" }, null), [
    { type: "body", parameters: [{ type: "text", text: NAME_FALLBACK }, { type: "text", text: "hoy" }] },
  ]);
});

// ---- errors ----

test("classifySendError: template/account codes pause, rate limits retry, others skip", () => {
  assert.deepEqual(classifySendError("WA send failed (404) [132001]: Template name does not exist"), {
    cls: "pause",
    code: 132001,
  });
  assert.equal(classifySendError("WA send failed (400) [132012]: Parameter format mismatch").cls, "pause");
  assert.equal(classifySendError("WA send failed (400) [131042]: payment issue").cls, "pause");
  assert.equal(classifySendError("WA send failed (429) [130429]: Rate limit hit").cls, "retry");
  assert.equal(classifySendError("WA send failed (400) [131026]: Message undeliverable").cls, "skip");
  assert.equal(classifySendError("WA send failed (400) [131049]: healthy ecosystem").cls, "skip");
  // No code: prose fallback, then HTTP status.
  assert.equal(classifySendError("WA send failed (404): Template name does not exist in the translation").cls, "pause");
  assert.equal(classifySendError("WA send failed (502): bad gateway").cls, "retry");
  assert.equal(classifySendError("fetch failed").cls, "retry");
  assert.equal(classifySendError("WA send failed (400): something odd").cls, "skip");
});

// ---- window ----

test("blastWindowOpen: 09:00–20:59 CDMX only; blastDueAt clamps into it", () => {
  assert.equal(blastWindowOpen(cdmxToEpoch(2026, 9, 16, 8, 59, 0)), false);
  assert.equal(blastWindowOpen(cdmxToEpoch(2026, 9, 16, 9, 0, 0)), true);
  assert.equal(blastWindowOpen(cdmxToEpoch(2026, 9, 16, 20, 59, 0)), true);
  assert.equal(blastWindowOpen(cdmxToEpoch(2026, 9, 16, 21, 0, 0)), false);
  const early = cdmxToEpoch(2026, 9, 16, 6, 30, 15);
  assert.equal(blastDueAt(early), cdmxToEpoch(2026, 9, 16, BLAST_HOUR_START, 0, 0));
  const late = cdmxToEpoch(2026, 9, 16, 22, 10, 0);
  const p = cdmxParts(blastDueAt(late));
  assert.deepEqual([p.day, p.hour, p.minute], [17, BLAST_HOUR_START, 0]);
  const mid = cdmxToEpoch(2026, 9, 16, 12, 0, 0);
  assert.equal(blastDueAt(mid), mid);
});

// ---- audience (CRM) ----

test("planBlastAudience: splits by program and excludes booked / active / non-leads / recent", () => {
  const contacts = [
    contact({ phone: "5215500000001", campaign_name: "Reto Gladiador" }),
    contact({ phone: "5215500000002", campaign_name: "Kids" }),
    contact({ phone: "5215500000003", campaign_name: "baby fight club" }),
    contact({ phone: "5215500000004", campaign_name: "Reto Gladiador" }), // booked
    contact({ phone: "5215500000005", last_inbound_at: NOW - 3600 }), // in-window
    contact({ phone: "5215500000006", status: "student" }),
    contact({ phone: "5215500000007", status: "opted_out" }),
    contact({ phone: "5215500000008" }), // blasted last week
    contact({ phone: "5215500000008" }), // duplicate row
  ];
  const a = planBlastAudience(contacts, new Set(["5215500000004"]), NOW, {
    recentlyBlasted: new Set(["5215500000008"]),
  });
  assert.deepEqual(a.adults.map((c) => c.phone), ["5215500000001"]);
  assert.deepEqual(a.kids.map((c) => c.phone), ["5215500000002"]);
  assert.deepEqual(a.baby.map((c) => c.phone), ["5215500000003"]);
  assert.deepEqual(a.excluded, { booked: 1, inWindow: 1, notLead: 2, recentBlast: 1 });
  assert.deepEqual(a.inWindow.adults.map((c) => c.phone), ["5215500000005"]);
  // includeBooked keeps the booked lead.
  const b = planBlastAudience(contacts, new Set(["5215500000004"]), NOW, { includeBooked: true });
  assert.deepEqual(b.adults.map((c) => c.phone), ["5215500000001", "5215500000004", "5215500000008"]);
});

test("planBlastAudience: qualification audience=kid routes to kids without a campaign", () => {
  const a = planBlastAudience(
    [contact({ phone: "5215500000008", qualification: JSON.stringify({ audience: "kid" }) })],
    new Set(),
    NOW,
  );
  assert.equal(a.kids.length, 1);
  assert.equal(a.adults.length, 0);
});

// ---- audience (pasted list) ----

test("parseContactList: phone/name in any column, MX normalization, dedupe, header skipped", () => {
  const text = [
    "Nombre,Teléfono,Suscrito",
    "Ana López,55 1234 5678,2026-01-01",
    '"Beto",+52 1 55 8765 4321,x',
    "5215512345678,Ana otra vez",
    "solo texto sin numero",
    "",
    "+1 (415) 555-0100\tSam",
    "52 55 0000 1111;Ceci",
  ].join("\n");
  const r = parseContactList(text);
  assert.deepEqual(r.entries, [
    { phone: "5215512345678", name: "Ana López" },
    { phone: "5215587654321", name: "Beto" },
    { phone: "14155550100", name: "Sam" },
    { phone: "5215500001111", name: "Ceci" },
  ]);
  assert.equal(r.invalid, 2);
  assert.equal(r.duplicates, 1);
});

test("buildListAudience: drops opted-out (always), students (default), recent blasts; CRM name fills gaps", () => {
  const entries = [
    { phone: "5215500000001", name: null },
    { phone: "5215500000002", name: "Beto" },
    { phone: "5215500000003", name: null },
    { phone: "5215500000004", name: null },
    { phone: "5215500000005", name: "Eva" },
  ];
  const known = new Map<string, Pick<Contact, "status" | "name">>([
    ["5215500000001", { status: "lead", name: "Ana" }],
    ["5215500000002", { status: "opted_out", name: null }],
    ["5215500000003", { status: "student", name: null }],
  ]);
  const a = buildListAudience(entries, known, { recentlyBlasted: new Set(["5215500000004"]) });
  assert.deepEqual(a.candidates.map((c) => [c.phone, c.name]), [
    ["5215500000001", "Ana"],
    ["5215500000005", "Eva"],
  ]);
  assert.deepEqual(a.excluded, { optedOut: 1, student: 1, recentBlast: 1 });
  const b = buildListAudience(entries, known, { excludeStudents: false });
  assert.equal(b.candidates.length, 4);
});

// ---- run registry ----

function meta(over: Partial<BlastRunMeta> = {}): BlastRunMeta {
  return {
    id: "b2609161200abcd",
    name: "Promo octubre",
    mode: "template",
    template: "promo_octubre_es",
    lang: "es",
    params: ["{nombre}"],
    header: null,
    text: null,
    total: 3,
    status: "active",
    createdAt: NOW,
    startAt: NOW,
    dailyCap: DEFAULT_DAILY_CAP,
    by: "Evan",
    pausedReason: null,
    updatedAt: NOW,
    ...over,
  };
}

test("run meta: JSON round-trip, legacy epoch value, garbage", () => {
  const m = meta({ status: "paused", pausedReason: "132001" });
  assert.deepEqual(parseRunMeta(m.id, encodeRunMeta(m)), m);
  const legacy = parseRunMeta("aug28", "1787000000");
  assert.equal(legacy?.status, "active");
  assert.equal(legacy?.startAt, 1_787_000_000);
  assert.equal(legacy?.name, "aug28");
  assert.equal(parseRunMeta("x", "{}"), null);
  assert.equal(parseRunMeta("x", null), null);
});

test("foldRunCounts + summarizeRuns: progress per run, done when nothing is left", () => {
  const counts = foldRunCounts([
    { rid: "blast:r1", status: "sent", n: 2 },
    { rid: "blast:r1", status: "failed", n: 1 },
    { rid: "blast:r2", status: "scheduled", n: 4 },
    { rid: "blast:r2", status: "paused", n: 1 },
    { rid: "blast:r2", status: "skipped_optout", n: 1 },
    { rid: "later:xyz", status: "scheduled", n: 9 },
    { rid: null, status: "sent", n: 9 },
  ]);
  assert.deepEqual(counts.get("r1"), { scheduled: 0, paused: 0, sent: 2, failed: 1, skipped: 0, cancelled: 0 });
  assert.deepEqual(counts.get("r2"), { scheduled: 4, paused: 1, sent: 0, failed: 0, skipped: 1, cancelled: 0 });
  const views = summarizeRuns(
    [meta({ id: "r1", total: 3, createdAt: 1 }), meta({ id: "r2", total: 6, createdAt: 2, status: "paused" })],
    counts,
  );
  assert.deepEqual(views.map((v) => [v.id, v.status, v.remaining]), [
    ["r2", "paused", 5],
    ["r1", "done", 0],
  ]);
});
