// Student kit (QR + responsiva after "Se inscribió") — src/cron/student-kit.ts
// decision logic against a fake KitIo, and the one-shot template seed
// (src/cron/template-seed-student.ts) against a fake Graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALUMNO_MAX_ATTEMPTS,
  ERROR_MAX_ATTEMPTS,
  TEMPLATE_MAX_ATTEMPTS,
  TEMPLATE_RETRY_EVERY,
  alumnoFromFields,
  doneNote,
  encodeKitNote,
  firstLinkedId,
  kitGuardKey,
  parseKitNote,
  qrTemplateComponents,
  responsivaFallbackLink,
  responsivaTemplateComponents,
  runStudentKit,
  type AlumnoInfo,
  type KitIo,
} from "../src/cron/student-kit.js";
import {
  MAX_TRIES,
  RESPONSIVA_BUTTON_URL,
  SEED_KEY,
  seedStudentKitTemplates,
  stripLinkLine,
  studentKitTemplateInputs,
} from "../src/cron/template-seed-student.js";
import { isQuietHour } from "../src/cron/quiet.js";
import { cdmxToEpoch } from "../src/cron/time.js";
import { CLIENT } from "../src/client.gen.js";
import { renderCopy } from "../src/client-config.js";
import type { Env } from "../src/types.js";

const ALUMNO = "recJGBLgxBbsGqrf0";
const NOW = cdmxToEpoch(2026, 10, 13, 12, 0, 0);

class FakeWindowClosed extends Error {}
class FakeOptedOut extends Error {}

interface Scenario {
  alumnoIds?: string[];
  alumno?: Partial<AlumnoInfo> | null;
  kv?: Record<string, string>;
  windowOpen?: boolean;
  templateFails?: string[]; // template names that throw
  freeformError?: "image" | "text";
  uploadFails?: boolean;
  now?: number;
  /** Throw from leadAlumnoIds (Airtable down). */
  airtableFails?: boolean;
  /** contactOptedOut() answers true from this call number on (1-based). */
  optedOutFromCheck?: number;
  /** sendTemplate throws OptedOutError for these names. */
  templateOptedOut?: string[];
}

function harness(sc: Scenario) {
  const log: string[] = [];
  const kv = new Map(Object.entries(sc.kv ?? {}));
  const r = {
    log,
    kv,
    notes: [] as string[],
    marked: [] as string[],
    rescheduled: [] as { dueAt: number; note: string }[],
    templates: [] as { name: string; components: unknown[] }[],
    texts: [] as string[],
    images: [] as { mediaId: string; caption: string }[],
    qrShared: [] as string[],
    saved: [] as string[],
  };
  let optChecks = 0;
  const io: KitIo = {
    now: () => sc.now ?? NOW,
    async leadAlumnoIds() {
      if (sc.airtableFails) throw new Error("airtable GET Leads/recLEAD failed: HTTP 503");
      return sc.alumnoIds ?? [ALUMNO];
    },
    async alumno(id) {
      if (sc.alumno === null) return null;
      return {
        id,
        name: "Ana López",
        qrShared: false,
        responsivaSigned: false,
        responsivaLink: `https://responsiva.mdcondesa.com/?rid=${id}&n=Ana`,
        ...sc.alumno,
      };
    },
    async kvGet(k) {
      return kv.get(k) ?? null;
    },
    async kvSet(k, v) {
      kv.set(k, v);
    },
    async qrMediaId(id) {
      if (sc.uploadFails) throw new Error("WA media upload failed (500)");
      log.push(`upload:${id}`);
      return "MEDIA1";
    },
    async sendImage(mediaId, caption) {
      if (sc.freeformError === "image") throw new Error("WA send failed (500)");
      if (!sc.windowOpen) throw new FakeWindowClosed();
      r.images.push({ mediaId, caption });
      log.push("image");
    },
    async sendText(body) {
      if (sc.freeformError === "text") throw new Error("WA send failed (500)");
      if (!sc.windowOpen) throw new FakeWindowClosed();
      r.texts.push(body);
      log.push("text");
    },
    async sendTemplate(name, _lang, components) {
      if (sc.templateOptedOut?.includes(name)) throw new FakeOptedOut();
      if (sc.templateFails?.includes(name)) throw new Error("WA send failed (404) [132001]: template does not exist");
      r.templates.push({ name, components });
      log.push(`template:${name}`);
    },
    isWindowClosed: (err) => err instanceof FakeWindowClosed,
    isOptedOut: (err) => err instanceof FakeOptedOut,
    async contactOptedOut() {
      optChecks++;
      return sc.optedOutFromCheck !== undefined && optChecks >= sc.optedOutFromCheck;
    },
    async markQrShared(id) {
      r.qrShared.push(id);
      log.push("qrShared");
    },
    async saveProgress(note) {
      r.saved.push(note);
      log.push(`save:${note}`);
    },
    async reschedule(dueAt, note) {
      r.rescheduled.push({ dueAt, note });
    },
    async mark(status) {
      r.marked.push(status);
    },
    async postNote(t) {
      r.notes.push(t);
    },
  };
  return { io, r };
}

const CTX = {
  leadRecordId: "recLEAD0000000001",
  lang: "es",
  who: "5215512345678",
  copy: { qr: "QR CAPTION", responsiva: "Firma aquí 👉 {link}" },
};

// ---- pure helpers ----

test("firstLinkedId / alumnoFromFields read Airtable's shapes", () => {
  assert.equal(firstLinkedId([ALUMNO, "recZZZZZZZZZZZZZZ"]), ALUMNO);
  assert.equal(firstLinkedId(undefined), null);
  assert.equal(firstLinkedId([]), null);
  assert.equal(firstLinkedId(["junk"]), null);
  const a = alumnoFromFields(ALUMNO, {
    Alumno: "Ana López",
    "QR Compartido": true,
    "Responsiva OK": "✅",
    "Link Responsiva": `https://responsiva.mdcondesa.com/?rid=${ALUMNO}&n=Ana%20L%C3%B3pez`,
  });
  assert.deepEqual(a, {
    id: ALUMNO,
    name: "Ana López",
    qrShared: true,
    responsivaSigned: true,
    responsivaLink: `https://responsiva.mdcondesa.com/?rid=${ALUMNO}&n=Ana%20L%C3%B3pez`,
  });
  // Unsigned + formula error object + unchecked box → rid-only fallback link.
  const b = alumnoFromFields(ALUMNO, { "Responsiva OK": "⚠️ Falta", "Link Responsiva": { error: "#ERROR" } });
  assert.equal(b.responsivaSigned, false);
  assert.equal(b.qrShared, false);
  assert.equal(b.responsivaLink, responsivaFallbackLink(ALUMNO));
  assert.equal(responsivaFallbackLink(ALUMNO), `https://responsiva.mdcondesa.com/?rid=${ALUMNO}`);
});

test("kit note round-trips and ignores the generic '|attempts:N' suffix", () => {
  const st = { alumno: 3, tpl: 1, err: 2, qr: true, resp: false };
  assert.deepEqual(parseKitNote(encodeKitNote(st)), st);
  assert.deepEqual(parseKitNote(`${encodeKitNote(st)}|attempts:2`), st);
  assert.deepEqual(parseKitNote(null), { alumno: 0, tpl: 0, err: 0, qr: false, resp: false });
  assert.deepEqual(parseKitNote("attempts:1"), { alumno: 0, tpl: 0, err: 0, qr: false, resp: false });
});

test("template components: header image by media id, URL button suffix = Alumno id", () => {
  assert.deepEqual(qrTemplateComponents("M1"), [
    { type: "header", parameters: [{ type: "image", image: { id: "M1" } }] },
  ]);
  assert.deepEqual(responsivaTemplateComponents(ALUMNO), [
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: ALUMNO }] },
  ]);
});

// ---- the run ----

test("window open: QR image with caption + responsiva text with the Alumno's link", async () => {
  const { io, r } = harness({ windowOpen: true });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.images, [{ mediaId: "MEDIA1", caption: "QR CAPTION" }]);
  assert.deepEqual(r.texts, [`Firma aquí 👉 https://responsiva.mdcondesa.com/?rid=${ALUMNO}&n=Ana`]);
  assert.deepEqual(r.templates, []);
  assert.deepEqual(r.qrShared, [ALUMNO]);
  assert.equal(r.kv.get(kitGuardKey(ALUMNO)), "sent");
  assert.deepEqual(r.marked, ["sent"]);
  assert.deepEqual(r.notes, ["🎟️ QR y responsiva enviados a Ana López (5215512345678)"]);
});

test("window closed: student_qr + student_responsiva templates", async () => {
  const { io, r } = harness({ windowOpen: false });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.templates, [
    { name: "student_qr_es", components: qrTemplateComponents("MEDIA1") },
    { name: "student_responsiva_es", components: responsivaTemplateComponents(ALUMNO) },
  ]);
  assert.deepEqual(r.marked, ["sent"]);
});

test("English contact gets the _en templates", async () => {
  const { io, r } = harness({ windowOpen: false });
  await runStudentKit(io, { ...CTX, lang: "en" }, null);
  assert.deepEqual(r.templates.map((t) => t.name), ["student_qr_en", "student_responsiva_en"]);
});

test("responsiva already signed: QR only, note says so", async () => {
  const { io, r } = harness({ windowOpen: true, alumno: { responsivaSigned: true } });
  await runStudentKit(io, CTX, null);
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.texts, []);
  assert.deepEqual(r.notes, ["🎟️ QR enviado a Ana López (5215512345678); responsiva ya firmada"]);
});

test("QR Compartido already ticked by staff: no QR, responsiva only", async () => {
  const { io, r } = harness({ windowOpen: true, alumno: { qrShared: true } });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.images, []);
  assert.ok(!r.log.some((l) => l.startsWith("upload:"))); // not even uploaded
  assert.equal(r.texts.length, 1);
  assert.deepEqual(r.qrShared, []);
  assert.match(r.notes[0]!, /Responsiva enviada/);
});

test("nothing owed (QR shared + signed): silent cancel, guard set", async () => {
  const { io, r } = harness({ windowOpen: true, alumno: { qrShared: true, responsivaSigned: true } });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.marked, ["cancelled"]);
  assert.deepEqual(r.notes, []);
  assert.ok(r.kv.has(kitGuardKey(ALUMNO)));
});

test("kv guard: an Alumno that already got the kit is never sent it again", async () => {
  const { io, r } = harness({ windowOpen: true, kv: { [kitGuardKey(ALUMNO)]: "sent" } });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.marked, ["cancelled"]);
  assert.deepEqual(r.images, []);
  assert.deepEqual(r.texts, []);
});

test("Alumno not linked yet: +5 min retries, then ONE Slack note and failed", async () => {
  const { io, r } = harness({ alumnoIds: [] });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.rescheduled, [{ dueAt: NOW + 300, note: encodeKitNote({ alumno: 1, tpl: 0, err: 0, qr: false, resp: false }) }]);
  assert.deepEqual(r.notes, []);

  const last = harness({ alumnoIds: [] });
  await runStudentKit(
    last.io,
    CTX,
    encodeKitNote({ alumno: ALUMNO_MAX_ATTEMPTS - 1, tpl: 0, err: 0, qr: false, resp: false }),
  );
  assert.deepEqual(last.r.rescheduled, []);
  assert.deepEqual(last.r.marked, ["failed"]);
  assert.equal(last.r.notes.length, 1);
  assert.match(last.r.notes[0]!, /No encontré el Alumno de 5215512345678/);
});

test("deleted Alumno record behaves like 'not linked yet'", async () => {
  const { io, r } = harness({ alumno: null });
  await runStudentKit(io, CTX, null);
  assert.equal(r.rescheduled.length, 1);
});

test("template not approved: QR delivered, responsiva retried +6h without resending the QR", async () => {
  const { io, r } = harness({ windowOpen: false, templateFails: ["student_responsiva_es"] });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.templates.map((t) => t.name), ["student_qr_es"]);
  assert.equal(r.rescheduled.length, 1);
  const st = parseKitNote(r.rescheduled[0]!.note);
  assert.deepEqual(st, { alumno: 0, tpl: 1, err: 0, qr: true, resp: false });
  assert.equal(r.rescheduled[0]!.dueAt, NOW + TEMPLATE_RETRY_EVERY);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.marked, []);

  // Next pass: the QR is NOT sent again; responsiva now goes through.
  const next = harness({ windowOpen: false });
  await runStudentKit(next.io, CTX, r.rescheduled[0]!.note);
  assert.deepEqual(next.r.templates.map((t) => t.name), ["student_responsiva_es"]);
  assert.ok(!next.r.log.some((l) => l.startsWith("upload:")));
  assert.deepEqual(next.r.marked, ["sent"]);
  assert.deepEqual(r.qrShared, [ALUMNO]); // ticked the moment the QR landed
  assert.deepEqual(next.r.qrShared, []);
  assert.deepEqual(next.r.notes, ["🎟️ QR y responsiva enviados a Ana López (5215512345678)"]);
});

test("template retries land outside quiet hours", async () => {
  const evening = cdmxToEpoch(2026, 10, 13, 18, 0, 0); // +6h = 00:00 → 08:00
  const { io, r } = harness({ windowOpen: false, templateFails: ["student_qr_es"], now: evening });
  await runStudentKit(io, CTX, null);
  const due = r.rescheduled[0]!.dueAt;
  assert.ok(!isQuietHour(due));
  assert.equal(due, cdmxToEpoch(2026, 10, 14, 8, 0, 0));
});

test("template still missing after the last retry: ONE note naming what's undelivered, failed", async () => {
  const { io, r } = harness({ windowOpen: false, templateFails: ["student_qr_es", "student_responsiva_es"] });
  await runStudentKit(
    io,
    CTX,
    encodeKitNote({ alumno: 0, tpl: TEMPLATE_MAX_ATTEMPTS - 1, err: 0, qr: false, resp: false }),
  );
  assert.deepEqual(r.rescheduled, []);
  assert.deepEqual(r.marked, ["failed"]);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0]!, /su QR de acceso ni el link de la responsiva/);
  assert.match(r.notes[0]!, /WhatsApp Manager/);
  assert.ok(r.kv.has(kitGuardKey(ALUMNO)));
});

test("a non-window send error retries in 5 min (3 times), never via template", async () => {
  const { io, r } = harness({ windowOpen: true, freeformError: "text" });
  await runStudentKit(io, CTX, null);
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.templates, []);
  assert.deepEqual(parseKitNote(r.rescheduled[0]!.note), { alumno: 0, tpl: 0, err: 1, qr: true, resp: false });
  assert.equal(r.rescheduled[0]!.dueAt, NOW + 300);

  const last = harness({ windowOpen: true, uploadFails: true });
  await runStudentKit(last.io, CTX, encodeKitNote({ alumno: 0, tpl: 0, err: ERROR_MAX_ATTEMPTS - 1, qr: false, resp: true }));
  assert.deepEqual(last.r.marked, ["failed"]);
  assert.match(last.r.notes[0]!, /su QR de acceso \(error: Error: WA media upload failed/);
});

test("doneNote without a name falls back to the contact label", () => {
  const a = { id: ALUMNO, name: "", qrShared: false, responsivaSigned: false, responsivaLink: "" };
  assert.equal(doneNote(a, CTX, { qr: true, resp: true }), "🎟️ QR y responsiva enviados a 5215512345678");
});

test("progress is saved (and QR Compartido ticked) right after the QR, before the responsiva", async () => {
  const { io, r } = harness({ windowOpen: true });
  await runStudentKit(io, CTX, null);
  const qrNote = encodeKitNote({ alumno: 0, tpl: 0, err: 0, qr: true, resp: false });
  const bothNote = encodeKitNote({ alumno: 0, tpl: 0, err: 0, qr: true, resp: true });
  assert.deepEqual(r.log.slice(1), ["image", `save:${qrNote}`, "qrShared", "text", `save:${bothNote}`]);
});

test("opted out before the QR: nothing sent, row cancelled, no note", async () => {
  const { io, r } = harness({ windowOpen: true, optedOutFromCheck: 1 });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.images, []);
  assert.deepEqual(r.texts, []);
  assert.deepEqual(r.marked, ["cancelled"]);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.rescheduled, []);
});

test("baja between the QR and the responsiva: no responsiva, cancelled, QR progress kept", async () => {
  const { io, r } = harness({ windowOpen: true, optedOutFromCheck: 2 });
  await runStudentKit(io, CTX, null);
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.texts, []);
  assert.deepEqual(r.marked, ["cancelled"]);
  assert.deepEqual(r.notes, []);
  assert.equal(r.saved.length, 1);
});

test("OptedOutError from a template send is terminal — no retries, no 'approved?' note", async () => {
  const { io, r } = harness({ windowOpen: false, templateOptedOut: ["student_responsiva_es"] });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.templates.map((t) => t.name), ["student_qr_es"]);
  assert.deepEqual(r.marked, ["cancelled"]);
  assert.deepEqual(r.rescheduled, []);
  assert.deepEqual(r.notes, []);
});

test("Airtable read error: +5 min via err:, then ONE 'mándaselos a mano' note and failed", async () => {
  const { io, r } = harness({ airtableFails: true });
  await runStudentKit(io, CTX, null);
  assert.deepEqual(r.rescheduled, [{ dueAt: NOW + 300, note: encodeKitNote({ alumno: 0, tpl: 0, err: 1, qr: false, resp: false }) }]);
  assert.deepEqual(r.notes, []);

  const last = harness({ airtableFails: true });
  await runStudentKit(last.io, CTX, encodeKitNote({ alumno: 0, tpl: 0, err: ERROR_MAX_ATTEMPTS - 1, qr: false, resp: false }));
  assert.deepEqual(last.r.rescheduled, []);
  assert.deepEqual(last.r.marked, ["failed"]);
  assert.equal(last.r.notes.length, 1);
  assert.match(last.r.notes[0]!, /No pude leer el Alumno de 5215512345678 en Airtable.*mándaselos a mano/);
});

// ---- the template seed ----

test("studentKitTemplateInputs: six Utility templates; bodies mirror the free-form copy", () => {
  const inputs = studentKitTemplateInputs("4::H");
  assert.deepEqual(inputs.map((i) => `${i.name}/${i.language}/${i.category}`), [
    "student_welcome_es/es/UTILITY",
    "student_welcome_en/en/UTILITY",
    "student_qr_es/es/UTILITY",
    "student_qr_en/en/UTILITY",
    "student_responsiva_es/es/UTILITY",
    "student_responsiva_en/en/UTILITY",
  ]);
  const by = Object.fromEntries(inputs.map((i) => [i.name, i]));
  // §10: welcome with links baked in, no variables.
  const welcomeEs = renderCopy(CLIENT.copy.welcomeEs, { link: CLIENT.links.welcome, group: CLIENT.links.group });
  assert.equal(by.student_welcome_es!.body, welcomeEs);
  assert.doesNotMatch(welcomeEs, /\{\{|\{link\}|\{group\}/);
  assert.match(welcomeEs, /https:\/\/chat\.whatsapp\.com\//);
  // §11: IMAGE header, body = the caption.
  assert.deepEqual(by.student_qr_es!.header, { type: "IMAGE", handle: "4::H" });
  assert.equal(by.student_qr_es!.body, CLIENT.copy.studentQrEs);
  // §12: responsiva body without the link line; the link is the button.
  const resp = by.student_responsiva_es!;
  assert.doesNotMatch(resp.body, /👉|\{link\}/);
  assert.match(resp.body, /📝$/);
  assert.deepEqual(resp.buttons, [
    {
      type: "URL",
      text: "Firmar responsiva",
      url: RESPONSIVA_BUTTON_URL,
      example: ["https://responsiva.mdcondesa.com/?rid=recJGBLgxBbsGqrf0"],
    },
  ]);
  assert.equal((by.student_responsiva_en!.buttons![0] as { text: string }).text, "Sign waiver");
  // No sample handle → the QR pair is left out.
  assert.ok(!studentKitTemplateInputs(null).some((i) => i.name.startsWith("student_qr")));
});

test("stripLinkLine drops the link line and the blank line before it", () => {
  assert.equal(stripLinkLine("Último paso 📝\n\n👉 {link}"), "Último paso 📝");
});

function seedDb(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const make = (sql: string): D1PreparedStatement => {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) { binds = v; return stmt; },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM kv")) {
          const v = store.get(String(binds[0]));
          return (v === undefined ? null : ({ value: v } as unknown as T)) as T | null;
        }
        return null;
      },
      async run() {
        if (sql.includes("INTO kv")) store.set(String(binds[0]), String(binds[1]));
        return { results: [], meta: { changes: 1 } };
      },
      async all() { return { results: [], meta: {} }; },
    };
    return stmt;
  };
  return { db: { prepare: make } as D1Database, store };
}

function graph(existing: string[], opts: { failCreate?: string[]; appIdFails?: boolean } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const res = (status: number, data: unknown) =>
      ({ ok: status < 300, status, async json() { return data; }, async text() { return ""; } }) as unknown as Response;
    if (url.includes("/message_templates?")) {
      return res(200, {
        data: existing.map((n) => ({ id: `id_${n}`, name: n, language: n.endsWith("_en") ? "en" : "es", status: "APPROVED", components: [] })),
      });
    }
    if (url.includes("/debug_token?")) {
      return opts.appIdFails ? res(400, { error: { message: "nope" } }) : res(200, { data: { app_id: "987654321" } });
    }
    if (url.includes("/987654321/uploads?")) return res(200, { id: "upload:SESSION?sig=abc" });
    if (url.includes("/upload:SESSION")) return res(200, { h: "4::HANDLE" });
    if (url.endsWith("/message_templates") && init?.method === "POST") {
      const name = (body as { name: string }).name;
      if (opts.failCreate?.includes(name)) return res(400, { error: { code: 100, message: `bad ${name}` } });
      return res(200, { id: `new_${name}`, status: "PENDING", category: "UTILITY" });
    }
    return res(404, { error: { message: `unexpected ${url}` } });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

function seedEnv(db: D1Database, over: Partial<Env> = {}): Env {
  return { DB: db, WA_WABA_ID: "1717538906028335", WA_ACCESS_TOKEN: "tok", ...over } as unknown as Env;
}

test("seed: creates only the missing templates, uploads the QR sample once, one note, guard set", async () => {
  const { db, store } = seedDb();
  const { doFetch, calls } = graph(["student_welcome_es", "student_welcome_en"]);
  const notes: string[] = [];
  await seedStudentKitTemplates(seedEnv(db), { postNote: async (t) => { notes.push(t); } }, doFetch);
  const creates = calls.filter((c) => c.url.endsWith("/message_templates") && c.method === "POST");
  assert.deepEqual(
    creates.map((c) => (c.body as { name: string }).name),
    ["student_qr_es", "student_qr_en", "student_responsiva_es", "student_responsiva_en"],
  );
  const qr = creates[0]!.body as { components: Record<string, unknown>[] };
  assert.deepEqual(qr.components[0], { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::HANDLE"] } });
  // Resumable upload: session on the discovered app, then raw PNG bytes with OAuth + file_offset.
  const open = calls.find((c) => c.url.includes("/uploads?"))!;
  assert.match(open.url, /\/987654321\/uploads\?file_length=\d+&file_type=image%2Fpng$/);
  assert.equal(open.headers.Authorization, "Bearer tok");
  const push = calls.find((c) => c.url.includes("/upload:SESSION"))!;
  assert.equal(push.headers.Authorization, "OAuth tok");
  assert.equal(push.headers.file_offset, "0");
  const bytes = push.body as Uint8Array;
  assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  assert.equal(store.get("meta_app_id"), "987654321");
  assert.equal(store.get(SEED_KEY), "ok");
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /enviadas a revisión: student_qr_es \(PENDING\)/);
  assert.match(notes[0]!, /ya existían: student_welcome_es, student_welcome_en/);

  // Guarded: a second tick does nothing.
  const again = graph([]);
  await seedStudentKitTemplates(seedEnv(db), { postNote: async (t) => { notes.push(t); } }, again.doFetch);
  assert.equal(again.calls.length, 0);
  assert.equal(notes.length, 1);
});

test("seed: everything already there → no upload, no creates, note lists them as existing", async () => {
  const { db, store } = seedDb();
  const all = ["student_welcome_es", "student_welcome_en", "student_qr_es", "student_qr_en", "student_responsiva_es", "student_responsiva_en"];
  const { doFetch, calls } = graph(all);
  const notes: string[] = [];
  await seedStudentKitTemplates(seedEnv(db), { postNote: async (t) => { notes.push(t); } }, doFetch);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.equal(store.get(SEED_KEY), "ok");
  assert.match(notes[0]!, /ya existían: student_welcome_es, .*student_responsiva_en/);
});

test("seed: META_APP_ID skips /debug_token; no WABA → nothing at all", async () => {
  const { db } = seedDb();
  const { doFetch, calls } = graph([]);
  await seedStudentKitTemplates(seedEnv(db, { META_APP_ID: "987654321" } as Partial<Env>), { postNote: async () => {} }, doFetch);
  assert.ok(!calls.some((c) => c.url.includes("debug_token")));

  const empty = seedDb();
  const g = graph([]);
  await seedStudentKitTemplates(seedEnv(empty.db, { WA_WABA_ID: "" } as Partial<Env>), { postNote: async () => {} }, g.doFetch);
  assert.equal(g.calls.length, 0);
  assert.equal(empty.store.size, 0);
});

test("seed: failures retry silently for MAX_TRIES ticks, then ONE note with created + failed", async () => {
  const { db, store } = seedDb();
  const notes: string[] = [];
  const post = { postNote: async (t: string) => { notes.push(t); } };
  // Tick 1: responsiva_en fails; the others are created.
  await seedStudentKitTemplates(seedEnv(db), post, graph([], { failCreate: ["student_responsiva_en"] }).doFetch);
  assert.equal(notes.length, 0);
  assert.equal(store.get(SEED_KEY), undefined);
  // Ticks 2..MAX: what tick 1 created now exists on the WABA.
  const created = ["student_welcome_es", "student_welcome_en", "student_qr_es", "student_qr_en", "student_responsiva_es"];
  for (let i = 2; i <= MAX_TRIES; i++) {
    await seedStudentKitTemplates(seedEnv(db), post, graph(created, { failCreate: ["student_responsiva_en"] }).doFetch);
  }
  assert.equal(notes.length, 1);
  assert.equal(store.get(SEED_KEY), "error");
  assert.match(notes[0]!, /^⚠️/);
  assert.match(notes[0]!, /enviadas a revisión: student_welcome_es \(PENDING\)/);
  assert.doesNotMatch(notes[0]!, /ya existían/); // our own creations are not "existing"
  assert.match(notes[0]!, /fallaron: student_responsiva_en: Graph 400 \[100\]: bad student_responsiva_en/);
});

test("seed: catalog unreachable → retry next tick, no note, no guard", async () => {
  const { db, store } = seedDb();
  const notes: string[] = [];
  const doFetch = (async () => ({ ok: false, status: 500, async json() { return { error: { message: "down" } }; } })) as unknown as typeof fetch;
  await seedStudentKitTemplates(seedEnv(db), { postNote: async (t) => { notes.push(t); } }, doFetch);
  assert.equal(notes.length, 0);
  assert.equal(store.size, 0);
});

test("seed: app id unknown → QR pair reported failed, the rest still created", async () => {
  const { db } = seedDb();
  const notes: string[] = [];
  const { doFetch, calls } = graph([], { appIdFails: true });
  for (let i = 0; i < MAX_TRIES; i++) {
    await seedStudentKitTemplates(seedEnv(db), { postNote: async (t) => { notes.push(t); } }, doFetch);
  }
  const names = calls
    .filter((c) => c.url.endsWith("/message_templates") && c.method === "POST")
    .map((c) => (c.body as { name: string }).name);
  assert.ok(!names.some((n) => n.startsWith("student_qr")));
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /student_qr \(muestra de imagen: no pude averiguar el app id de Meta \(pon META_APP_ID\)\)/);
});

// ---- Slack routing (2026-10-22): hand-overs → #wa-leads, success → ops_log ----

function withTask(sc: Scenario) {
  const h = harness(sc);
  const tasks: string[] = [];
  h.io.postTaskNote = async (t) => {
    tasks.push(t);
  };
  return { ...h, tasks };
}

test("routing: every 'mándaselo a mano' note goes to postTaskNote, never postNote", async () => {
  const noAlumno = withTask({ alumnoIds: [] });
  await runStudentKit(
    noAlumno.io,
    CTX,
    encodeKitNote({ alumno: ALUMNO_MAX_ATTEMPTS - 1, tpl: 0, err: 0, qr: false, resp: false }),
  );
  assert.equal(noAlumno.tasks.length, 1);
  assert.match(noAlumno.tasks[0]!, /No encontré el Alumno/);
  assert.deepEqual(noAlumno.r.notes, []);

  const airtable = withTask({ airtableFails: true });
  await runStudentKit(
    airtable.io,
    CTX,
    encodeKitNote({ alumno: 0, tpl: 0, err: ERROR_MAX_ATTEMPTS - 1, qr: false, resp: false }),
  );
  assert.equal(airtable.tasks.length, 1);
  assert.match(airtable.tasks[0]!, /No pude leer el Alumno/);
  assert.deepEqual(airtable.r.notes, []);

  const tpl = withTask({ windowOpen: false, templateFails: ["student_qr_es", "student_responsiva_es"] });
  await runStudentKit(
    tpl.io,
    CTX,
    encodeKitNote({ alumno: 0, tpl: TEMPLATE_MAX_ATTEMPTS - 1, err: 0, qr: false, resp: false }),
  );
  assert.equal(tpl.tasks.length, 1);
  assert.match(tpl.tasks[0]!, /Mándaselo a mano/);
  assert.deepEqual(tpl.r.notes, []);
});

test("routing: the success FYI ('QR y responsiva enviados') stays on postNote (ops_log)", async () => {
  const ok = withTask({ windowOpen: true });
  await runStudentKit(ok.io, CTX, null);
  assert.deepEqual(ok.tasks, []);
  assert.deepEqual(ok.r.notes, ["🎟️ QR y responsiva enviados a Ana López (5215512345678)"]);
});
