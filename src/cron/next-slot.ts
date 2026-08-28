// "The next class I can actually offer this lead" (B1 of the nudge overhaul).
//
// The ONLY source of schedule truth here is the generated SLOTS
// (src/brain/slots.gen.ts, weekday 0=Mon … 6=Sun) — never a hand-written table,
// never a guess. Slots flagged `trial: false` exist on the grid but never take a
// trial, so they are skipped. (Nothing in the generated grid carries the flag
// since the Muay Thai sparring hours reopened to trials — owner, 2026-08-25.)
//
// Everything is pure over (discipline, audience, nowEpoch, schedule) so the
// nudge copy can be unit-tested with a fake clock.

import { SLOTS, type Slot } from "../brain/slots.gen.js";
import { CLIENT } from "../client.gen.js";
import { isKnownDiscipline, normalizeDiscipline, weekdayIndex } from "../brain/tools.js";
import { cdmxParts, cdmxToEpoch, DAY } from "./time.js";

export interface NextSlot {
  /** 0=Mon … 6=Sun (the SLOTS convention). */
  weekday: number;
  /** CDMX calendar date, "YYYY-MM-DD". */
  date: string;
  /** CDMX wall clock, "HH:mm" 24h. */
  time: string;
  /** Service key ("muay", "jiu", "baby", …). */
  discipline: string;
  /** Human phrasing the copy splices in: "hoy a las 6:00 pm". */
  label: string;
}

/** A slot must be at least this far away to be proposed (no "in 20 minutes"). */
export const SLOT_LEAD_SECONDS = 2 * 3600;

/** How far ahead we look before giving up (a full grid is one week). */
const SEARCH_DAYS = 14;

const WEEKDAY_ES = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
] as const;

const WEEKDAY_EN = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/**
 * The soonest BOOKABLE trial slot for this lead, or null when the grid has none
 * in the next two weeks (copy then falls back to its generic form).
 *
 * - `discipline`: the lead's discipline (free text — "BJJ", "Muay Thai", "baby"
 *   are all fine). null, empty, or something that isn't a bookable service
 *   ("defensa personal" — taught through all four disciplines, never bookable
 *   by that name) ⇒ any discipline of that audience.
 * - `audience`: "adult" or "kid" — kids/baby leads must never be offered an
 *   adult class and vice versa.
 * - today counts only when the class is ≥ SLOT_LEAD_SECONDS away.
 */
export function nextTrialSlot(
  discipline: string | null,
  audience: "adult" | "kid",
  nowEpoch: number,
  schedule: readonly Slot[] = SLOTS,
): NextSlot | null {
  const wantKey = resolveDiscipline(discipline);
  const earliest = nowEpoch + SLOT_LEAD_SECONDS;
  const p = cdmxParts(nowEpoch);

  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    // Date.UTC normalizes day overflow, so `p.day + offset` rolls months/years.
    const midnight = cdmxToEpoch(p.year, p.month, p.day + offset, 0, 0, 0);
    const dp = cdmxParts(midnight);
    const date = `${dp.year}-${pad2(dp.month)}-${pad2(dp.day)}`;
    const wd = weekdayIndex(date);
    if (wd === null) continue;

    const candidates = schedule
      .filter(
        (s) =>
          s.weekday === wd &&
          s.audience === audience &&
          s.trial !== false &&
          // Parent-participation slots (baby / Mini Muay Thai) are dual-audience
          // so validateSlot accepts them, but proposing one to a generic lead is
          // wrong for BOTH audiences (an adult gets a toddler class; an
          // unknown-age kid probably belongs in Kids, not Mini). Only an
          // explicit baby pick may land on them.
          (s.pp !== true || wantKey === "baby") &&
          (wantKey === null || s.discipline === wantKey),
      )
      .slice()
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

    for (const s of candidates) {
      const at = slotEpoch(dp.year, dp.month, dp.day, s.time);
      if (at === null || at < earliest) continue;
      const base = { weekday: wd, date, time: s.time, discipline: s.discipline };
      return { ...base, label: formatSlotLabel(base, nowEpoch, "es") };
    }
  }
  return null;
}

/**
 * "hoy a las 6:00 pm" / "mañana miércoles 11:00 am" / "el sábado 9:00 am"
 * (and the English equivalents) for a slot, relative to `nowEpoch` in CDMX.
 * Pure — exported so the EN copy can relabel the same slot.
 */
export function formatSlotLabel(
  slot: { weekday: number; date: string; time: string },
  nowEpoch: number,
  lang: "es" | "en",
): string {
  const days = daysAhead(slot.date, nowEpoch);
  const clock = time12h(slot.time);
  const name =
    lang === "en"
      ? (WEEKDAY_EN[slot.weekday] ?? "")
      : (WEEKDAY_ES[slot.weekday] ?? "");
  if (lang === "en") {
    if (days <= 0) return `today at ${clock}`;
    if (days === 1) return `tomorrow ${name} at ${clock}`;
    return `on ${name} at ${clock}`;
  }
  if (days <= 0) return `hoy a las ${clock}`;
  if (days === 1) return `mañana ${name} ${clock}`;
  return `el ${name} ${clock}`;
}

/** Client-facing name of a service key ("muay" → "Muay Thai"). */
export function disciplineLabel(key: string): string {
  return CLIENT.services.find((s) => s.key === key)?.label ?? key;
}

/**
 * What the lead said they want, in copy-ready form: "muay"/"BJJ" → "Muay
 * Thai"/"Jiu-Jitsu", anything unrecognized kept verbatim (never invent a
 * program name for the lead).
 */
export function prettyDiscipline(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const key = normalizeDiscipline(text);
  return isKnownDiscipline(key) ? disciplineLabel(key) : text;
}

/** "15:15" → "3:15 pm". 12h clock, lowercase am/pm (Mexican WhatsApp style). */
export function time12h(time: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!m) return time;
  const h = Number(m[1]);
  const min = m[2] ?? "00";
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${suffix}`;
}

// ---- internals ----

/** Lead discipline → service key, or null for "any class of this audience". */
function resolveDiscipline(discipline: string | null): string | null {
  const raw = (discipline ?? "").trim();
  if (!raw) return null;
  const key = normalizeDiscipline(raw);
  return isKnownDiscipline(key) ? key : null;
}

function slotEpoch(
  year: number,
  month: number,
  day: number,
  time: string,
): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  return cdmxToEpoch(year, month, day, Number(m[1]), Number(m[2]), 0);
}

/** Whole CDMX days between today and the slot's date (0 = today). */
function daysAhead(date: string, nowEpoch: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 0;
  const p = cdmxParts(nowEpoch);
  const today = cdmxToEpoch(p.year, p.month, p.day, 0, 0, 0);
  const then = cdmxToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0);
  return Math.round((then - today) / DAY);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
