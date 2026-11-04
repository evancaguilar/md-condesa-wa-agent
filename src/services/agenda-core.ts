// Agenda tab (docs/dashboard-plan.md §11) — pure helpers. Mirrors the Airtable
// Interface views reception used for trial classes ("Clases Prueba Hoy +
// Cuestionario", "Confirmar Clases En Turno", "Confirmar Clases Día Anterior",
// "No Llegaron A Clase Prueba", "Por Confirmar") inside /admin.
//
// Everything here is deterministic: Airtable rows in, grouped rows out. The
// Airtable read, the D1 contact join and the sends live in the route
// (src/routes/admin-api.ts) and in src/services/agenda.ts.

import type { AirtableLeadsMap } from "../client-config.js";
import { cdmxDateStr, cdmxParts, cdmxToEpoch, DAY } from "../cron/time.js";
import { classifyResult, isLostResult, normalizeMxPhone, type TrialResult } from "./airtable.js";
import { channelOf } from "./channel.js";
import type { AirtableRecord } from "./airtable.js";

export const AGENDA_VIEWS = ["hoy", "manana", "por_confirmar", "no_asistieron"] as const;
export type AgendaView = (typeof AGENDA_VIEWS)[number];

export function isAgendaView(v: unknown): v is AgendaView {
  return typeof v === "string" && (AGENDA_VIEWS as readonly string[]).includes(v);
}

/** Days the "Por confirmar" view looks ahead (today included). */
export const UPCOMING_DAYS = 7;
/** Days the "No asistieron" view looks back (today included). */
export const NO_SHOW_DAYS = 7;

/** One trial-class row as the dashboard shows it. */
export interface AgendaRow {
  recordId: string;
  /** Raw Airtable cell (ISO, usually UTC "…Z"). */
  trialIso: string | null;
  trialEpoch: number | null;
  /** CDMX "YYYY-MM-DD" of the class, null when the date is unreadable. */
  dateKey: string | null;
  /** The adult on WhatsApp (Nombre de Lead). */
  leadName: string | null;
  /** Nombre Del Niñ@ — the child, for kids/baby bookings. */
  childName: string | null;
  /** Who actually trains: the "Quién entrena" formula, else child, else lead. */
  whoTrains: string | null;
  /** Raw phone cell. */
  phoneRaw: string | null;
  /** normalizeMxPhone(phoneRaw) — the wa_id shape, or null without digits. */
  phone: string | null;
  programa: string | null;
  actividad: string[];
  /** "Respuestas cuestionario" formula text as staff see it in Airtable. */
  cuestionario: string | null;
  /** Resultado Clase Prueba, joined ("Asistió, Perdido"). */
  result: string | null;
  resultClass: TrialResult | null;
  lost: boolean;
  enrolled: boolean;
}

/** D1 contact facts joined by phone (one batched query per load). */
export interface AgendaContact {
  phone: string;
  name: string | null;
  status: string | null;
  lastInboundAt: number | null;
}

export interface AgendaRowOut extends AgendaRow {
  /** D1 contact matched by phone (wa_id) — null when the lead never wrote to the bot. */
  contact: AgendaContact | null;
  /** True when the 24h free-form window is open (last inbound < 24h ago). */
  windowOpen: boolean;
  /** kv `same_day_sent:<phone>:<date>` exists → today's reminder already went out. */
  sameDaySent: boolean;
}

export interface AgendaGroup {
  /** "YYYY-MM-DDTHH:mm" CDMX, the sort key; "sin-fecha" for undated rows. */
  key: string;
  dateKey: string | null;
  /** "7:00 am" — null for undated rows. */
  timeLabel: string | null;
  /** "Lun 26 oct" */
  dayLabel: string | null;
  rows: AgendaRowOut[];
}

// ---- Airtable window per view ----

export interface AgendaWindow {
  /** Inclusive CDMX start, epoch seconds. */
  fromEpoch: number;
  /** Exclusive CDMX end, epoch seconds. */
  toEpoch: number;
}

/** CDMX midnight of the day `now` falls in, shifted by `days`. */
export function cdmxMidnight(now: number, days = 0): number {
  const p = cdmxParts(now);
  return cdmxToEpoch(p.year, p.month, p.day) + days * DAY;
}

/**
 * The Airtable date window each view reads. Pure: the same `now` (CDMX wall
 * clock via the fixed offset) always yields the same window.
 */
export function agendaWindow(view: AgendaView, now: number): AgendaWindow {
  const today = cdmxMidnight(now);
  switch (view) {
    case "hoy":
      return { fromEpoch: today, toEpoch: today + DAY };
    case "manana":
      return { fromEpoch: today + DAY, toEpoch: today + 2 * DAY };
    case "por_confirmar":
      return { fromEpoch: today, toEpoch: today + UPCOMING_DAYS * DAY };
    case "no_asistieron":
      return { fromEpoch: today - (NO_SHOW_DAYS - 1) * DAY, toEpoch: today + DAY };
  }
}

function isoUtc(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

/**
 * filterByFormula for a window: the trial column inside [from, to). Airtable
 * compares the cell's instant, so UTC ISO strings are exact regardless of the
 * base's display timezone. Field names are quoted for the formula.
 */
export function agendaFormula(trialField: string, w: AgendaWindow): string {
  const f = `{${trialField.replace(/[{}]/g, "")}}`;
  return `AND(${f}, IS_AFTER(${f}, '${isoUtc(w.fromEpoch - 1)}'), IS_BEFORE(${f}, '${isoUtc(w.toEpoch)}'))`;
}

// ---- cell coercion ----

function cellStr(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function cellList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  const s = cellStr(v);
  return s ? [s] : [];
}

function cellBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(1|true|sí|si|yes|checked)$/i.test(v.trim());
  return false;
}

/** The Airtable cell → epoch seconds, null when unreadable. */
export function trialEpochOf(iso: string | null): number | null {
  if (!iso) return null;
  const t = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(t) ? t : null;
}

/** Child if present, else the lead — the same rule as the "Quién entrena" formula. */
export function resolveWhoTrains(input: {
  whoTrains?: string | null;
  childName?: string | null;
  leadName?: string | null;
}): string | null {
  return input.whoTrains?.trim() || input.childName?.trim() || input.leadName?.trim() || null;
}

/** Leads record → AgendaRow. `resultField` = resultFieldName(env). */
export function rowFromRecord(r: AirtableRecord, map: AirtableLeadsMap, resultField: string): AgendaRow {
  const f = r.fields;
  const trialIso = cellStr(f[map.trialDateTime]);
  const trialEpoch = trialEpochOf(trialIso);
  const leadName = cellStr(f[map.name]);
  const childName = cellStr(f[map.childName]);
  const phoneRaw = cellStr(f[map.phone]);
  const result = cellStr(f[resultField]);
  let phone: string | null = null;
  if (phoneRaw) {
    const n = normalizeMxPhone(phoneRaw);
    phone = channelOf(n) === "wa" && /^\d{8,15}$/.test(n) ? n : null;
  }
  return {
    recordId: r.id,
    trialIso,
    trialEpoch,
    dateKey: trialEpoch === null ? null : cdmxDateStr(trialEpoch),
    leadName,
    childName,
    whoTrains: resolveWhoTrains({
      whoTrains: map.whoTrains ? cellStr(f[map.whoTrains]) : null,
      childName,
      leadName,
    }),
    phoneRaw,
    phone,
    programa: cellStr(f[map.audience]),
    actividad: cellList(f[map.discipline]),
    cuestionario: map.cuestionarioStatus ? cellStr(f[map.cuestionarioStatus]) : null,
    result,
    resultClass: classifyResult(result),
    lost: isLostResult(result),
    enrolled: map.enrolled ? cellBool(f[map.enrolled]) : classifyResult(result) === "enrolled",
  };
}

// ---- view filters ----

/**
 * Which rows of the window a view keeps. Pure.
 * - hoy / manana: every class on that CDMX day (results included — reception
 *   marks them right here).
 * - por_confirmar: upcoming classes (today onwards) with no outcome yet and
 *   not marked Perdido.
 * - no_asistieron: last NO_SHOW_DAYS days whose outcome is a plain no-show
 *   (not re-marked Asistió / Se inscribió, not Perdido).
 */
export function filterForView(rows: readonly AgendaRow[], view: AgendaView, now: number): AgendaRow[] {
  switch (view) {
    case "hoy":
    case "manana":
      return rows.slice();
    case "por_confirmar":
      return rows.filter(
        (r) => r.trialEpoch !== null && r.trialEpoch >= now && r.resultClass === null && !r.lost && !r.enrolled,
      );
    case "no_asistieron":
      return rows.filter((r) => r.resultClass === "no_show" && !r.lost && !r.enrolled);
  }
}

// ---- contact join ----

/** True when the lead wrote less than 24h ago (free-form allowed). */
export function windowOpenAt(lastInboundAt: number | null | undefined, now: number): boolean {
  return typeof lastInboundAt === "number" && lastInboundAt > 0 && now - lastInboundAt < DAY;
}

/** kv key the same_day reminder claims (cron/followups.sameDaySentKey, mirrored). */
export function sameDayKeyFor(phone: string, dateKey: string): string {
  return `same_day_sent:${phone}:${dateKey}`;
}

/** Distinct wa_ids the rows resolve to (for the one batched D1 lookup). */
export function phonesOf(rows: readonly AgendaRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.phone) seen.add(r.phone);
  return [...seen];
}

/** kv keys to probe for "reminder already sent today" (rows with a date + phone). */
export function sameDayKeysOf(rows: readonly AgendaRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.phone && r.dateKey) seen.add(sameDayKeyFor(r.phone, r.dateKey));
  return [...seen];
}

export function joinContacts(
  rows: readonly AgendaRow[],
  contacts: ReadonlyMap<string, AgendaContact>,
  sentKeys: ReadonlySet<string>,
  now: number,
): AgendaRowOut[] {
  return rows.map((r) => {
    const c = r.phone ? (contacts.get(r.phone) ?? null) : null;
    return {
      ...r,
      contact: c,
      windowOpen: windowOpenAt(c?.lastInboundAt, now),
      sameDaySent: !!(r.phone && r.dateKey && sentKeys.has(sameDayKeyFor(r.phone, r.dateKey))),
    };
  });
}

// ---- grouping ----

const DAYS_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "7:00 am" / "3:15 pm" from a CDMX epoch. */
export function timeLabel12h(epoch: number): string {
  const p = cdmxParts(epoch);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "lun 26 oct" from a CDMX epoch. */
export function dayLabelEs(epoch: number): string {
  const p = cdmxParts(epoch);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay();
  return `${DAYS_ES[dow]} ${p.day} ${MONTHS_ES[p.month - 1]}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Group rows by class slot (CDMX date + time), soonest first; undated rows
 * last. Inside a group: who trains, alphabetically (stable for equal names).
 */
export function groupByClassTime(rows: readonly AgendaRowOut[]): AgendaGroup[] {
  const groups = new Map<string, AgendaGroup>();
  for (const r of rows) {
    let key = "sin-fecha";
    let timeLabel: string | null = null;
    let dayLabel: string | null = null;
    if (r.trialEpoch !== null) {
      const p = cdmxParts(r.trialEpoch);
      key = `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
      timeLabel = timeLabel12h(r.trialEpoch);
      dayLabel = dayLabelEs(r.trialEpoch);
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, dateKey: r.dateKey, timeLabel, dayLabel, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const out = [...groups.values()];
  out.sort((a, b) => {
    if (a.key === "sin-fecha") return 1;
    if (b.key === "sin-fecha") return -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const coll = (s: string | null): string => (s ?? "").toLocaleLowerCase("es");
  for (const g of out) g.rows.sort((a, b) => coll(a.whoTrains).localeCompare(coll(b.whoTrains), "es"));
  return out;
}

// ---- attendance write-back ----

export const RESULT_ATTENDED = "Asistió";
export const RESULT_NO_SHOW = "No asistió";

export type MarkResult = "attended" | "no_show" | "clear";

/**
 * The new value of the multi-select `Resultado Clase Prueba` after reception
 * marks attendance from the dashboard. Keeps every other tick ("Reprogramó",
 * "Perdido", "Se inscribió", …) and swaps only the Asistió / No asistió pair;
 * "clear" removes that pair and nothing else. Pure.
 */
export function nextResultValue(current: unknown, mark: MarkResult): string[] {
  const keep = cellList(current).filter((v) => v !== RESULT_ATTENDED && v !== RESULT_NO_SHOW);
  if (mark === "attended") keep.push(RESULT_ATTENDED);
  if (mark === "no_show") keep.push(RESULT_NO_SHOW);
  return keep;
}

export function isMarkResult(v: unknown): v is MarkResult {
  return v === "attended" || v === "no_show" || v === "clear";
}

// ---- manual reminder (Enviar confirmación) ----

export type ReminderKind = "same_day" | "day_before";

/**
 * Which reminder "Enviar confirmación" sends for a class at `trialEpoch`:
 * the day-of copy when the class is today (or already past — reception may
 * still confirm a late arrival), the night-before copy when it is tomorrow,
 * null for anything further out (no copy exists for that). Pure.
 */
export function reminderKindFor(trialEpoch: number, now: number): ReminderKind | null {
  const day = cdmxDateStr(trialEpoch);
  if (day === cdmxDateStr(now)) return "same_day";
  if (day === cdmxDateStr(now + DAY)) return "day_before";
  return null;
}
