// Pre-trial questionnaire — the PURE half (docs/cuestionario.md).
//
// Field whitelists per version, CORS origin check, answer sanitizing (browser
// → Airtable) and projection (Airtable → browser), version derivation from
// the CRM's Programa/Actividad, CDMX date/time wording, and every piece of
// copy the feature sends (invite, completion Slack summary, the day-before
// reminder variant). No I/O; unit-tested in test/cuestionario.test.ts.
//
// Field NAMES are the owner's Airtable Leads columns. He creates them; the
// worker never does. A PATCH naming a column that doesn't exist yet is
// retried without it (src/services/cuestionario.ts), so a half-built schema
// degrades to "that answer isn't stored" instead of losing the whole save.

import { CLIENT } from "../client.gen.js";
import type { AirtableLeadsMap } from "../client-config.js";
import type { Language, ProgramBand } from "../types.js";
import { CDMX_OFFSET_SECONDS, cdmxDateStr, cdmxParts } from "../cron/time.js";
import type { CuestionarioVersion } from "./cuestionario-token.js";

// ---- fields -----------------------------------------------------------------

/** Written ONLY by the send path (never from the browser). */
export const F_SENT = "Cuestionario enviado";
export const F_VERSION = "Cuestionario versión";
/** Written ONLY by the `__complete` flag (never as a raw browser field). */
export const F_DONE = "Cuestionario completado";
export const F_DONE_AT = "Cuestionario completado el";

export const F_MOTIVO = "Motivo principal";
export const F_COSTO = "Costo de seguir así";
export const F_META = "Meta 6 meses";
export const F_LESIONES = "Lesiones / cuidados";
/** EXISTING Leads column (the child's / baby's name) — bfc may write it. */
export const F_CHILD = "Nombre Del Niñ@";

/** Answer columns every version may write. */
export const SHARED_ANSWER_FIELDS: readonly string[] = [
  "Motivos",
  F_MOTIVO,
  "Situación actual",
  "Qué ha intentado",
  "Por qué no funcionó",
  F_COSTO,
  F_META,
  "Urgencia / evento",
  "Por qué ahora",
  "Días por semana",
  "Qué lo haría faltar",
  "Horarios preferidos",
  F_LESIONES,
  "Cómo nos encontró",
];

export const VERSION_ANSWER_FIELDS: Record<CuestionarioVersion, readonly string[]> = {
  adultos: [
    "Qué dejaría de sentir",
    "Tiempo queriendo esto",
    "Por qué esta vez sí",
    "Rápido o permanente",
    "Tamaño de grupo",
  ],
  kids: ["Cómo es el niño", "Actividades previas", "Impacto en casa", "Quiere venir", "Quién lo trae"],
  bfc: [F_CHILD, "Meses bebé", "Cómo es el niño", "Quién lo trae"],
};

/** Multi-select columns: a bare string is wrapped into a one-item array. */
export const MULTI_FIELDS: ReadonlySet<string> = new Set(["Motivos", "Horarios preferidos"]);

/** Single-select columns with a FIXED option list (the owner's Airtable
 *  schema): anything else is dropped rather than typecast into a new option. */
export const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "Días por semana": ["1", "2", "3", "4+"],
  "Rápido o permanente": ["Rápidos", "Permanentes"],
};

/** Columns the BROWSER may write for a version (PATCH whitelist). */
export function answerFields(version: CuestionarioVersion): string[] {
  return [...SHARED_ANSWER_FIELDS, ...VERSION_ANSWER_FIELDS[version]];
}

/** Columns the GET hands back as `answers` (answers + the completion state). */
export function readFields(version: CuestionarioVersion): string[] {
  return [...answerFields(version), F_DONE, F_DONE_AT];
}

export const MAX_TEXT = 2000;
const MAX_ITEMS = 30;

// ---- CORS -------------------------------------------------------------------

const PAGES_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.md-condesa-site\.pages\.dev$/;

/** The origin to echo back in Access-Control-Allow-Origin, or null. */
export function allowedOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  if (origin === "https://mdcondesa.com" || origin === "https://www.mdcondesa.com") return origin;
  if (origin === "http://localhost:4173") return origin;
  if (PAGES_PREVIEW_RE.test(origin)) return origin;
  return null;
}

export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  const ok = allowedOrigin(origin);
  const h: Record<string, string> = { Vary: "Origin" };
  if (ok) {
    h["Access-Control-Allow-Origin"] = ok;
    h["Access-Control-Allow-Methods"] = "GET, PATCH, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

// ---- browser → Airtable -----------------------------------------------------

export interface SanitizedPatch {
  /** Airtable fields to PATCH (whitelisted, coerced). */
  fields: Record<string, unknown>;
  /** The body asked to mark the questionnaire complete. */
  complete: boolean;
}

function cleanString(s: string): string {
  return s.trim().slice(0, MAX_TEXT);
}

/**
 * Pure. Keep only whitelisted columns, coerce each value: strings trimmed and
 * capped; arrays → unique non-empty strings (multi-select); finite numbers;
 * booleans; `null`/"" clears the cell. Enum columns (ENUM_FIELDS) take only
 * their listed options (a number 1–3 is matched as its string); multi-selects
 * take only strings. Unknown keys and odd types are dropped, never an error.
 * `__complete: true` is honored at the top level of the body or inside `answers`.
 */
export function sanitizeAnswers(version: CuestionarioVersion, body: unknown): SanitizedPatch {
  const out: Record<string, unknown> = {};
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const answers =
    b.answers && typeof b.answers === "object" && !Array.isArray(b.answers)
      ? (b.answers as Record<string, unknown>)
      : {};
  const complete = b.__complete === true || answers.__complete === true;
  const allowed = new Set(answerFields(version));
  for (const [key, raw] of Object.entries(answers)) {
    if (!allowed.has(key)) continue;
    const multi = MULTI_FIELDS.has(key);
    const options = ENUM_FIELDS[key];
    if (options) {
      if (raw === null || raw === "") {
        out[key] = null;
      } else if (typeof raw === "string" || typeof raw === "number") {
        const v = String(raw).trim();
        if (options.includes(v)) out[key] = v;
      }
      continue;
    }
    if (multi && (typeof raw === "number" || typeof raw === "boolean")) continue;
    if (raw === null) {
      out[key] = multi ? [] : null;
    } else if (typeof raw === "string") {
      const s = cleanString(raw);
      out[key] = multi ? (s ? [s] : []) : s || null;
    } else if (Array.isArray(raw)) {
      const items = [
        ...new Set(raw.filter((x): x is string => typeof x === "string").map(cleanString).filter(Boolean)),
      ].slice(0, MAX_ITEMS);
      out[key] = multi ? items : items.join(", ").slice(0, MAX_TEXT) || null;
    } else if (typeof raw === "number") {
      if (Number.isFinite(raw)) out[key] = raw;
    } else if (typeof raw === "boolean") {
      out[key] = raw;
    }
  }
  return { fields: out, complete };
}

/** The two columns `__complete` sets. */
export function completionFields(nowSec: number): Record<string, unknown> {
  return { [F_DONE]: true, [F_DONE_AT]: cdmxDateStr(nowSec) };
}

// ---- Airtable → browser -----------------------------------------------------

/** Pure. Current values of the version's readable columns; empties omitted. */
export function answersFromFields(
  version: CuestionarioVersion,
  fields: Record<string, unknown>,
): Record<string, string | string[] | number | boolean> {
  const out: Record<string, string | string[] | number | boolean> = {};
  for (const key of readFields(version)) {
    const v = fields[key];
    if (typeof v === "string") {
      if (v.trim()) out[key] = v;
    } else if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
      if (items.length) out[key] = items;
    } else if (typeof v === "number") {
      if (Number.isFinite(v)) out[key] = v;
    } else if (v === true) {
      out[key] = true;
    }
  }
  return out;
}

/** First string of a text / select / multi-select / lookup cell. */
export function cellText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

/** True when a cell holds anything (the `Cuestionario enviado` skip check). */
export function cellFilled(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// ---- version ----------------------------------------------------------------

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function values(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** ProgramBand (contacts.qualification, age-band.ts) → questionnaire version. */
export function versionFromBand(band: ProgramBand | null | undefined): CuestionarioVersion | null {
  if (!band) return null;
  if (band === "baby") return "bfc";
  if (band === "adults") return "adultos";
  return "kids"; // mini, kids, teens
}

/**
 * Pure. Which questionnaire a lead gets, from the CRM first:
 *  1. `Programa` (audience) — mapped back through the client's audienceValues
 *     (Adultos → adultos; Kids / Mini Muay Thai / Teens → kids; BFC → bfc);
 *  2. `Actividad` — a Baby Fight Club or a `*:kid` discipline option;
 *  3. the contact's stored age band when it names a minor (baby → bfc);
 *  4. a child name (`Nombre Del Niñ@` on the record, or the contact's
 *     qualification.child_name) → kids — a parent booked, not an adult;
 *  5. adultos.
 */
export function deriveVersion(
  fields: Record<string, unknown>,
  map: Pick<AirtableLeadsMap, "audience" | "discipline" | "audienceValues" | "disciplineValues" | "childName">,
  band: ProgramBand | null = null,
  contactChildName: string | null = null,
): CuestionarioVersion {
  const byAudience = new Map<string, string>();
  for (const [k, label] of Object.entries(map.audienceValues)) byAudience.set(norm(label), k);
  for (const val of values(fields[map.audience])) {
    const key = byAudience.get(norm(val)) ?? norm(val);
    if (key === "baby" || /baby|bfc/.test(key)) return "bfc";
    if (key === "kid" || key === "mini" || key === "teens" || /kid|mini|teen|nin/.test(key)) return "kids";
    if (key === "adult" || /adult/.test(key)) return "adultos";
  }
  const babyOpt = map.disciplineValues.baby ? norm(map.disciplineValues.baby) : null;
  const kidOpts = new Set(
    Object.entries(map.disciplineValues)
      .filter(([k]) => k.endsWith(":kid"))
      .map(([, v]) => norm(v)),
  );
  const acts = values(fields[map.discipline]).map(norm);
  if (acts.some((a) => a === babyOpt)) return "bfc";
  if (acts.some((a) => kidOpts.has(a))) return "kids";
  const fromBand = versionFromBand(band);
  if (fromBand && fromBand !== "adultos") return fromBand;
  if (cellText(fields[map.childName]) || contactChildName?.trim()) return "kids";
  return "adultos";
}

// ---- CDMX wording -------------------------------------------------------------

const WEEKDAY_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const WEEKDAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const MONTH_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function cdmxWeekday(epoch: number): number {
  return new Date((epoch + CDMX_OFFSET_SECONDS) * 1000).getUTCDay();
}

/** "jueves 16 de octubre" / "Thursday, October 16" (CDMX). */
export function cdmxDia(epoch: number, lang: Language = "es"): string {
  const p = cdmxParts(epoch);
  const wd = cdmxWeekday(epoch);
  return lang === "en"
    ? `${WEEKDAY_EN[wd]}, ${MONTH_EN[p.month - 1]} ${p.day}`
    : `${WEEKDAY_ES[wd]} ${p.day} de ${MONTH_ES[p.month - 1]}`;
}

/** "7:00 PM" / "9:30 AM" (CDMX). */
export function cdmxHora(epoch: number): string {
  const p = cdmxParts(epoch);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** Airtable dateTime cell → epoch seconds, or null. */
export function isoToEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Spanish "a las 1:00" → "a la 1:00" (the baby class is at 1 PM). */
function fixSpanishOne(s: string): string {
  return s.replace(/\ba las 1:/g, "a la 1:");
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

// ---- invite -------------------------------------------------------------------

export interface InviteInput {
  version: CuestionarioVersion;
  lang: Language;
  /** Greeting-safe first name ("" = none). */
  name: string;
  /** Child's name for kids/bfc, when known. */
  kid: string | null;
  trialEpoch: number | null;
  link: string;
}

/** Pure. The WhatsApp invite, or null when the client has no copy for it. */
export function inviteText(i: InviteInput, copy: Partial<typeof CLIENT.copy> = CLIENT.copy): string | null {
  const en = i.lang === "en";
  const tpl =
    i.version === "adultos"
      ? en ? copy.cuestionarioEn : copy.cuestionarioEs
      : i.version === "kids"
        ? en ? copy.cuestionarioKidsEn : copy.cuestionarioKidsEs
        : en ? copy.cuestionarioBfcEn : copy.cuestionarioBfcEs;
  if (!tpl) return null;
  const cuando =
    i.trialEpoch === null
      ? ""
      : en
        ? ` for ${cdmxDia(i.trialEpoch, "en")} at ${cdmxHora(i.trialEpoch)}`
        : ` el ${cdmxDia(i.trialEpoch, "es")} a las ${cdmxHora(i.trialEpoch)}`;
  const kid = i.kid?.trim() || (en ? "your little one" : "tu peque");
  const text = fill(tpl, { who: i.name ? ` ${i.name}` : "", cuando, kid, link: i.link });
  return en ? text : fixSpanishOne(text);
}

// ---- the booking confirmation (ONE text + the video; owner copy 2026-10-16) -----

/**
 * THE page the one link points at: the personalized "tu primera clase"
 * confirmation on mdcondesa.com (name, day, time, calendar, questionnaire
 * card). One page per version — the kids and baby pages already carry their
 * own "qué traer / así va a ser" copy, so the token picks the page instead of
 * swapping blocks inside the adults page.
 */
export function firstClassUrl(version: CuestionarioVersion): string {
  return version === "bfc"
    ? "https://mdcondesa.com/tu-primera-clase-bebes/"
    : version === "kids"
      ? "https://mdcondesa.com/tu-primera-clase-ninos/"
      : "https://mdcondesa.com/tu-primera-clase/";
}

/** Any first-class page link in a text: with or without scheme / www, any of
 *  the three pages, an existing `?t=` included (the brain writes the bare one). */
const FIRST_CLASS_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?mdcondesa\.com\/tu-primera-clase(?:-ninos|-bebes)?\/?(?:\?t=[A-Za-z0-9._-]*)?/giu;

/** The signed token inside a first-class link, or null. */
export function firstClassTokenIn(text: string | null | undefined): string | null {
  const m = /mdcondesa\.com\/tu-primera-clase(?:-ninos|-bebes)?\/\?t=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/iu.exec(text ?? "");
  return m ? m[1]! : null;
}

/** The required closing paragraph (friend invite + "cualquier duda"). */
export function confirmClosing(lang: Language, copy: Partial<typeof CLIENT.copy> = CLIENT.copy): string {
  return (lang === "en" ? copy.confirmClosingEn : copy.confirmClosingEs) ?? "";
}

/**
 * The closing is there when the text already invites someone along. The brain
 * paraphrases the standard line ("Si quieren invitar a otra familia…", "si
 * quieres traer a un amigo", "compártelo con alguien…"), and the old
 * `invitar a (un|una|tu) amig` test missed those, so personalizeConfirmation
 * appended the stock closing a SECOND time (2026-10-20, Cinthya …4526).
 * Shape: an invite/bring/share verb, then within the same clause "a"/"con"
 * + optional determiners + a person noun. The person noun must follow
 * "a/con" so "ser parte de la familia MD" or "trae ropa cómoda" never count.
 */
export const CLOSING_RE = new RegExp(
  [
    // Spanish: invitar / invita(n) / invítalo / traer / trae(n) / traigan / compartir / comparte…
    String.raw`\b(?:inv[ií]t\w*|tra(?:er\w*|e|en|igan?|igas)\b|comp[aá]rt\w*)` +
      String.raw`[^.!?\n]{0,30}?\b(?:a|al|con)\s+` +
      String.raw`(?:(?:un|una|unos|unas|tu|tus|su|sus|otro|otra|otros|otras|alg[uú]n|alguna|algunos|algunas|m[aá]s|esa|ese)\s+)*` +
      String.raw`(?:amig\w*|famili\w*|alguien|personas?|conocid\w*|parientes?|compa\w*|herman\w*|primos?|primas?|vecin\w*|novi[oa]s?|pareja)`,
    // "invitar amigos" / "traer familiares" (bare plural, no "a").
    String.raw`\b(?:invitar|invita|traer|trae|traigan)\s+(?:amig\w*|familiares)`,
    // "Si conoces a alguien que quiera entrenar, ¡invítalo!"
    String.raw`\bconoc\w*\s+a\s+alguien\b[^.!?\n]{0,40}?\b(?:inv[ií]t|tr[aá]e)`,
    // English: invite / bring / share … friend / family / someone
    String.raw`\b(?:invite|bring|share)\b[^.!?\n]{0,30}?\b(?:friends?|family|someone|anyone|buddy|partner)\b`,
  ].join("|"),
  "iu",
);

/** The confirmation copy for a version (free-form text and template seeding). */
export function confirmationCopy(
  version: CuestionarioVersion,
  lang: Language,
  copy: Partial<typeof CLIENT.copy> = CLIENT.copy,
): string | undefined {
  const en = lang === "en";
  return version === "adultos"
    ? en ? copy.primeraClaseEn : copy.primeraClaseEs
    : version === "kids"
      ? en ? copy.primeraClaseKidsEn : copy.primeraClaseKidsEs
      : en ? copy.primeraClaseBfcEn : copy.primeraClaseBfcEs;
}

/**
 * Pure. The whole booking confirmation (web-form path): the version's copy
 * with name, day/time, child and link filled, a blank line, the closing.
 * Null when the client has no copy for it (caller keeps its old text).
 */
export function confirmationText(i: InviteInput, copy: Partial<typeof CLIENT.copy> = CLIENT.copy): string | null {
  const tpl = confirmationCopy(i.version, i.lang, copy);
  if (!tpl) return null;
  const en = i.lang === "en";
  const cuando =
    i.trialEpoch === null
      ? ""
      : en
        ? ` on ${cdmxDia(i.trialEpoch, "en")} at ${cdmxHora(i.trialEpoch)}`
        : ` el ${cdmxDia(i.trialEpoch, "es")} a las ${cdmxHora(i.trialEpoch)}`;
  const kid = i.kid?.trim() || (en ? "your little one" : "tu peque");
  const closing = confirmClosing(i.lang, copy);
  const text = fill(tpl, { who: i.name ? ` ${i.name}` : "", cuando, kid, link: i.link }) + (closing ? `\n\n${closing}` : "");
  return en ? text : fixSpanishOne(text);
}

/**
 * Pure. The brain's (or a human-edited) booking confirmation, made to carry
 * `link` — the signed first-class page:
 *  - every mdcondesa.com/tu-primera-clase(-ninos|-bebes)/ link in it becomes
 *    `link` (the record's version picks the page, not the brain's choice);
 *  - no such link at all → `link` goes at the end of the paragraph before the
 *    closing (or at the end);
 *  - the closing paragraph is appended when missing; an old "súper 💪" → 👊.
 * `link` null (signing failed / feature off) ⇒ the text keeps whatever link
 * it had; only the closing is ensured.
 */
export function personalizeConfirmation(
  text: string,
  link: string | null,
  lang: Language,
  copy: Partial<typeof CLIENT.copy> = CLIENT.copy,
): string {
  let out = text.trim();
  if (link) {
    const replaced = out.replace(FIRST_CLASS_URL_RE, () => link);
    if (replaced !== out) {
      out = replaced;
    } else {
      const lines = out.split("\n");
      const at = lines.findIndex((l) => CLOSING_RE.test(l));
      if (at > 0) {
        const head = lines.slice(0, at).join("\n").trimEnd();
        out = `${head} ${link}\n\n${lines.slice(at).join("\n").trim()}`;
      } else {
        out = `${out} ${link}`;
      }
    }
  }
  out = out.replace(/(estaría súper|that'd be awesome|that would be awesome) 💪/gu, "$1 👊");
  const closing = confirmClosing(lang, copy);
  if (closing && !CLOSING_RE.test(out)) out = `${out}\n\n${closing}`;
  return lang === "en" ? out : fixSpanishOne(out);
}

// ---- closed-window confirmation template (primera_clase[_kids|_bfc]_es/_en) ----

/** One template per page (the URL button's base differs per version). */
export function confirmTemplateBase(version: CuestionarioVersion): string {
  return version === "adultos" ? "primera_clase" : version === "kids" ? "primera_clase_kids" : "primera_clase_bfc";
}

/** URL button of a version's template: its page + the token suffix. */
export function confirmButtonUrl(version: CuestionarioVersion): string {
  return `${firstClassUrl(version)}?t={{1}}`;
}

export type ConfirmTemplateParam = "cuando" | "kid";

/**
 * Pure. A template body from the confirmation copy: NO name ({who} → "", so
 * "Listo, ya tienes tu lugar!" — Meta rejects an empty parameter and no filler
 * reads right in that slot), no link (it is the button), {cuando} → " el
 * {{n}}" / " on {{n}}", each {kid} → {{n}} in order, then the closing.
 * `params` = what each {{n}} carries, in order.
 */
export function confirmTemplateBody(
  copy: string,
  lang: Language,
  closing: string,
): { body: string; params: ConfirmTemplateParam[] } {
  const params: ConfirmTemplateParam[] = [];
  let body = copy
    .replaceAll("{who}", "")
    .replace(/\s*\{link\}\s*$/u, "")
    .replaceAll("{link}", "");
  body = body.replace(/\{(cuando|kid)\}/g, (_m, k: ConfirmTemplateParam) => {
    params.push(k);
    const v = `{{${params.length}}}`;
    return k === "cuando" ? (lang === "en" ? ` on ${v}` : ` el ${v}`) : v;
  });
  body = body.replace(/ {2,}/g, " ").trim();
  return { body: closing ? `${body}\n\n${closing}` : body, params };
}

/** Pure. Graph components for a primera_clase* send (body params + URL button suffix). */
export function confirmTemplateComponents(
  lang: Language,
  trialEpoch: number,
  kid: string | null,
  token: string,
  params: readonly ConfirmTemplateParam[],
): unknown[] {
  const kidText = kid?.trim() || (lang === "en" ? "your little one" : "tu peque");
  const values = params.map((p) => (p === "cuando" ? inviteWhenParam(trialEpoch, lang) : kidText));
  return [
    { type: "body", parameters: values.map((text) => ({ type: "text", text })) },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: token }] },
  ];
}

// ---- day-before reminder ------------------------------------------------------

/**
 * Pure. A questionnaire answer as it reads inside "buscas {motivo}":
 * lowercased (acronyms like BJJ/MMA kept), no final period/emoji-less
 * punctuation, no leading ¡¿. null when empty or too long to read naturally
 * inside the sentence (> 140 chars — a paragraph, not a goal).
 */
export function motivoPhrase(raw: unknown): string | null {
  const s = cellText(raw);
  if (!s) return null;
  let t = s.replace(/\s+/g, " ").trim();
  t = t.replace(/^[¡¿\s]+/, "").replace(/[\s.!?¡¿…;,:]+$/u, "");
  if (!t || t.length > 140) return null;
  return t
    .split(" ")
    .map((w) => (w.length >= 2 && w === w.toUpperCase() && /\p{Lu}/u.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

export interface MotivoReminderInput {
  lang: Language;
  name: string;
  /** Questionnaire version; kids/bfc use the parent copy with {kid}. Default adultos. */
  version?: CuestionarioVersion | null;
  /** Child's name (kids/bfc). Unknown ⇒ null (generic reminder). */
  kid?: string | null;
  trialEpoch: number | null;
  motivoPrincipal: unknown;
  meta6Meses: unknown;
}

/**
 * Pure. The day-before FREE-FORM reminder when the questionnaire told us what
 * the lead is after ("Ya le pasé al coach que buscas …"); null ⇒ the caller
 * keeps its existing copy. Motivo principal wins over Meta 6 meses. Adults get
 * reminderMotivo*; kids/bfc get reminderMotivoKids* ("es la clase de {kid}"),
 * and null when the child's name is unknown.
 */
export function dayBeforeMotivoText(
  i: MotivoReminderInput,
  copy: Partial<typeof CLIENT.copy> = CLIENT.copy,
): string | null {
  if (i.trialEpoch === null) return null;
  const motivo = motivoPhrase(i.motivoPrincipal) ?? motivoPhrase(i.meta6Meses);
  if (!motivo) return null;
  const family = i.version === "kids" || i.version === "bfc";
  const kid = (i.kid ?? "").trim();
  if (family && !kid) return null;
  const tpl = family
    ? i.lang === "en" ? copy.reminderMotivoKidsEn : copy.reminderMotivoKidsEs
    : i.lang === "en" ? copy.reminderMotivoEn : copy.reminderMotivoEs;
  if (!tpl) return null;
  const text = fill(tpl, { who: i.name ? ` ${i.name}` : "", hora: cdmxHora(i.trialEpoch), motivo, kid });
  return i.lang === "en" ? text : fixSpanishOne(text);
}

// ---- completion summary (Slack, #wa-leads) --------------------------------------

export interface CompletionSummaryInput {
  name: string | null;
  kid: string | null;
  version: CuestionarioVersion;
  /** Airtable `Programa` value, when set ("Mini Muay Thai"). */
  program: string | null;
  trialEpoch: number | null;
  phone: string | null;
  /** The record's fields AFTER the final save. */
  fields: Record<string, unknown>;
}

const VERSION_LABEL: Record<CuestionarioVersion, string> = {
  adultos: "Adultos",
  kids: "Kids",
  bfc: "Baby Fight Club",
};

/** Slack mrkdwn control characters → entities, so lead text can't ping
 *  (`<!channel>`) or smuggle links (`<https://evil|x>`). */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(s: string, n = 220): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Pure. ≤ 4 lines: who · program · class, then motivo, cost/meta, lesiones. */
export function completionSummary(i: CompletionSummaryInput): string {
  const e = slackEscape;
  const who = [e(i.name?.trim() || "Lead sin nombre"), i.kid ? `(${e(i.kid)})` : ""].filter(Boolean).join(" ");
  const when = i.trialEpoch === null ? "sin fecha" : `${cdmxDia(i.trialEpoch)} ${cdmxHora(i.trialEpoch)}`;
  const head = [`📝 Cuestionario: *${who}*`, e(i.program || VERSION_LABEL[i.version]), when, i.phone ? e(i.phone) : null]
    .filter(Boolean)
    .join(" · ");
  const second = i.version === "adultos" ? F_COSTO : F_META;
  const line = (label: string): string => `• ${label}: ${e(clip(cellText(i.fields[label]) ?? "—"))}`;
  return [head, line(F_MOTIVO), line(second), line(F_LESIONES)].join("\n");
}

// ---- closed-window template (cuestionario_invite[_kids]_es/_en) -----------------

/** Template base names: adults, and kids+bfc (one body for both). */
export function inviteTemplateBase(version: CuestionarioVersion): string {
  return version === "adultos" ? "cuestionario_invite" : "cuestionario_invite_kids";
}

/** The URL button: the token is the dynamic suffix. */
export const INVITE_BUTTON_URL = "https://mdcondesa.com/cuestionario/?t={{1}}";

/**
 * Pure. A template body from the free-form invite copy: no name ({who} → ""),
 * the date phrase becomes {{1}}, each {kid} the next variable, and the trailing
 * ": {link}" becomes a period (the link is the button). Returns the body and
 * how many {kid} variables it carries.
 */
export function inviteTemplateBody(copy: string, lang: Language): { body: string; kidVars: number } {
  let n = 1;
  let kidVars = 0;
  let body = copy
    .replaceAll("{who}", "")
    .replaceAll("{cuando}", lang === "en" ? " for {{1}}" : " el {{1}}")
    .replace(/[\s:]*\{link\}\s*$/u, ".")
    .replaceAll("{link}", "");
  body = body.replace(/\{kid\}/g, () => {
    kidVars++;
    n++;
    return `{{${n}}}`;
  });
  return { body: body.replace(/ {2,}/g, " ").trim(), kidVars };
}

/** Pure. "{{1}}" value: "viernes 16 de octubre a las 7:00 PM" / "Friday, October 16 at 7:00 PM". */
export function inviteWhenParam(epoch: number, lang: Language): string {
  return lang === "en"
    ? `${cdmxDia(epoch, "en")} at ${cdmxHora(epoch)}`
    : fixSpanishOne(`${cdmxDia(epoch, "es")} a las ${cdmxHora(epoch)}`);
}

/** Pure. Graph components for the invite template (body params + URL button suffix). */
export function inviteTemplateComponents(
  version: CuestionarioVersion,
  lang: Language,
  trialEpoch: number,
  kid: string | null,
  token: string,
  kidVars: number,
): unknown[] {
  const kidText = kid?.trim() || (lang === "en" ? "your little one" : "tu peque");
  const params = [inviteWhenParam(trialEpoch, lang)];
  if (version !== "adultos") for (let i = 0; i < kidVars; i++) params.push(kidText);
  return [
    { type: "body", parameters: params.map((text) => ({ type: "text", text })) },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: token }] },
  ];
}

// ---- calendar file (.ics) -------------------------------------------------------

/** iCalendar text escaping (RFC 5545 §3.3.11). */
function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsUtc(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** RFC 5545 content lines are at most 75 octets; longer ones fold with CRLF + space. */
function icsFold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 73) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n");
}

export const ICS_LOCATION = "Av. México 49, 1º piso, Condesa, CDMX";
export const ICS_MAPS_URL = "https://maps.app.goo.gl/CFsQeXTGNjYbd2fE7";
export const ICS_WA_URL = "https://wa.me/525641992274";

export interface IcsInput {
  recordId: string;
  version: CuestionarioVersion;
  /** Class start (epoch seconds, UTC instant). */
  trialEpoch: number;
  /** Child's name for kids/bfc, when known. */
  kid: string | null;
  nowSec: number;
}

/**
 * Pure. The "Clase de prueba — MD Condesa" event: 60 min, address + Maps link
 * + the bot's WhatsApp link in the description, alarms 24 h and 2 h before.
 * UID is stable per record so re-importing updates instead of duplicating.
 */
export function icsText(i: IcsInput): string {
  const who = i.version === "adultos" ? "" : ` de ${i.kid?.trim() || "tu peque"}`;
  const summary = i.version === "bfc" ? "Clase de prueba Baby Fight Club — MD Condesa" : "Clase de prueba — MD Condesa";
  const desc =
    `Tu clase de prueba${who} en MD Condesa. Llega 10 minutos antes; es en el primer piso.\n` +
    `Cómo llegar: ${ICS_MAPS_URL}\n` +
    `Dudas: ${ICS_WA_URL}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MD Condesa//Primera clase//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:clase-prueba-${i.recordId}@mdcondesa.com`,
    `DTSTAMP:${icsUtc(i.nowSec)}`,
    `DTSTART:${icsUtc(i.trialEpoch)}`,
    `DTEND:${icsUtc(i.trialEpoch + 3600)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `LOCATION:${icsEscape(ICS_LOCATION)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    `URL:${ICS_MAPS_URL}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Mañana es tu clase de prueba en MD Condesa",
    "TRIGGER:-P1D",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Tu clase de prueba en MD Condesa es en 2 horas",
    "TRIGGER:-PT2H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
