// "The next class I can actually offer this lead" (B1 of the nudge overhaul).
//
// The ONLY source of schedule truth here is the generated SLOTS
// (src/brain/slots.gen.ts, weekday 0=Mon … 6=Sun) — never a hand-written table,
// never a guess. Slots flagged `trial: false` exist on the grid but never take a
// trial, so they are skipped. (Nothing in the generated grid carries the flag
// since the Muay Thai sparring hours reopened to trials — owner, 2026-08-25.)
//
// Ordering is SOONEST-FIRST, always (2026-09-21): trials booked for the same
// day show up 54% of the time vs ~29% for trials a day or more out, so the
// nearest valid class is the one worth proposing. The only thing that may
// outrank it is a configured "preferred block" (CLIENT.booking.preferredBlocks
// — the hours the owner is on the floor closing) and only inside the same 24h.
// With the default EMPTY block list the behavior is pure soonest-first.
//
// Everything is pure over (discipline, audience, nowEpoch, schedule) so the
// nudge copy can be unit-tested with a fake clock.

import { SLOTS, type Slot } from "../brain/slots.gen.js";
import { CLIENT } from "../client.gen.js";
import type { PreferredBlock } from "../client-config.js";
import { isKnownDiscipline, normalizeDiscipline, weekdayIndex } from "../brain/tools.js";
import { cdmxParts, cdmxToEpoch, DAY } from "./time.js";
import { slotMatchesBand, type ProgramBand } from "../services/age-band.js";

export interface NextSlot {
  /** 0=Mon … 6=Sun (the SLOTS convention). */
  weekday: number;
  /** CDMX calendar date, "YYYY-MM-DD". */
  date: string;
  /** CDMX wall clock, "HH:mm" 24h. */
  time: string;
  /** Service key ("muay", "jiu", "baby", …). */
  discipline: string;
  /** The class's own name when it isn't the program's ("Blindaje 8", booked
   *  as `jiu`). Copy must say THIS, never disciplineLabel(discipline). */
  name?: string;
  /** Human phrasing the copy splices in: "hoy a las 6:00 pm". */
  label: string;
}

/** A slot must be at least this far away to be proposed (no "in 20 minutes"). */
export const SLOT_LEAD_SECONDS = 2 * 3600;

/**
 * The buffer the PERSONA uses before it may say "hoy" (persona.md, "Flujo de
 * agendado"). The brain's per-turn slot list uses it so the hours the model is
 * handed are exactly the ones its own rule allows it to offer.
 */
export const TODAY_BUFFER_SECONDS = 1 * 3600; // was 4h — Evan 2026-09-22: a 2:46 pm lead must still be offered the 4 pm Kids class

/** How far ahead we look before giving up (a full grid is one week). */
const SEARCH_DAYS = 14;

/**
 * A preferred block may only outrank a sooner class inside this horizon — past
 * it, sooner always wins (a lead who waits three extra days mostly forgets).
 */
export const PREFERRED_HORIZON_SECONDS = 24 * 3600;

/** Candidates the preference tie-breaker scans (one day holds ~10 classes). */
const PREFERENCE_SCAN = 40;

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
  closedDates: readonly { date: string }[] = CLIENT.closedDates ?? [],
  preferredBlocks: readonly PreferredBlock[] = CLIENT.booking?.preferredBlocks ?? [],
): NextSlot | null {
  // No blocks configured ⇒ the first hit IS the answer; don't scan 40 of them.
  const limit = preferredBlocks.length > 0 ? PREFERENCE_SCAN : 1;
  const found = collectSlots(discipline, audience, nowEpoch, {
    schedule,
    closedDates,
    limit,
  });
  return pickPreferred(found, preferredBlocks)?.slot ?? null;
}

/**
 * The next `limit` bookable trial slots, SOONEST FIRST, deduped to one entry per
 * (date, time) — the brain only needs the hours, and the same hour repeated once
 * per discipline is noise. `leadSeconds` overrides the 2h minimum (the per-turn
 * brain list passes TODAY_BUFFER_SECONDS so it never hands the model an hour its
 * own persona rule forbids). Pure.
 */
export function upcomingTrialSlots(
  discipline: string | null,
  audience: "adult" | "kid",
  nowEpoch: number,
  limit: number,
  schedule: readonly Slot[] = SLOTS,
  closedDates: readonly { date: string }[] = CLIENT.closedDates ?? [],
  leadSeconds: number = SLOT_LEAD_SECONDS,
  /**
   * true ⇒ ONLY the parent-participation rows of that audience (kid ⇒ Mini Muay
   * Thai). The brain's kids context lists them on their own line so a 3–5-year-
   * old gets "hoy 3:15 pm" computed for them (2026-09-28: a Kids lead with a
   * 3-year-old was sent to Wednesday while today's Mini class was 4h away —
   * the list only carried the 4 pm Kids row, so the model did the calendar
   * math itself, badly).
   */
  ppOnly = false,
): NextSlot[] {
  const seen = new Set<string>();
  const out: NextSlot[] = [];
  for (const c of collectSlots(discipline, audience, nowEpoch, {
    schedule,
    closedDates,
    leadSeconds,
    ppOnly,
    // Dedupe drops entries, so scan wider than the caller asked for.
    limit: Math.max(limit, 1) * 6,
  })) {
    const key = `${c.slot.date} ${c.slot.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.slot);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- age-band aware listing (2026-10-11) ----
//
// The age band (src/services/age-band.ts) decides which ROWS a lead may be
// offered: a 4-year-old only ever sees Mini Muay Thai, a 14-year-old only
// Teens, whatever campaign brought the parent in. These are the band twins of
// nextTrialSlot / upcomingTrialSlots; the audience-based ones stay for callers
// that have no band.

export interface BandSlotOpts {
  schedule?: readonly Slot[];
  closedDates?: readonly { date: string }[];
  /** Minimum distance from now (default SLOT_LEAD_SECONDS). */
  leadSeconds?: number;
  /** Weekdays (0=Mon … 6=Sun) the lead declined — never listed. */
  excludeWeekdays?: ReadonlySet<number>;
  /** Child's age in months when known (Nivel 0 vs regular Baby Fight Club). */
  ageMonths?: number | null;
}

/**
 * Soonest-first band slots, one entry per (date, time, discipline). With a
 * `discipline` the list is that discipline's rows of the band; when the band
 * has none of it (a kids lead who "wants Box") it falls back to every row of
 * the band rather than returning nothing. Pure.
 */
export function upcomingBandSlots(
  band: ProgramBand,
  discipline: string | null,
  nowEpoch: number,
  limit: number,
  opts: BandSlotOpts = {},
): NextSlot[] {
  const run = (disc: string | null): NextSlot[] => {
    const seen = new Set<string>();
    const out: NextSlot[] = [];
    for (const c of collectSlots(disc, "adult", nowEpoch, {
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
      ...(opts.closedDates ? { closedDates: opts.closedDates } : {}),
      ...(opts.leadSeconds !== undefined ? { leadSeconds: opts.leadSeconds } : {}),
      ...(opts.excludeWeekdays ? { excludeWeekdays: opts.excludeWeekdays } : {}),
      ...(typeof opts.ageMonths === "number" ? { ageMonths: opts.ageMonths } : {}),
      band,
      limit: Math.max(limit, 1) * 6,
    })) {
      const key = `${c.slot.date} ${c.slot.time} ${c.slot.discipline}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c.slot);
      if (out.length >= limit) break;
    }
    return out;
  };
  const first = run(discipline);
  if (first.length > 0 || discipline === null) return first;
  return run(null);
}

/** The single soonest band slot (nudges propose exactly one). */
export function nextBandSlot(
  band: ProgramBand,
  discipline: string | null,
  nowEpoch: number,
  opts: BandSlotOpts = {},
): NextSlot | null {
  return upcomingBandSlots(band, discipline, nowEpoch, 1, opts)[0] ?? null;
}

export interface BandDay {
  date: string;
  weekday: number;
  /** "hoy sábado" / "mañana sábado" / "lunes". */
  label: string;
  slots: NextSlot[];
}

/**
 * EVERY trial option of the band on the next `days` days that have at least
 * one (day-complete, so a lead who says "a las 9 no puedo" has the rest of
 * that day to fall back on), in clock order. Pure.
 */
export function bandDayOptions(
  band: ProgramBand,
  nowEpoch: number,
  days = 2,
  opts: BandSlotOpts = {},
): BandDay[] {
  const all = upcomingBandSlots(band, null, nowEpoch, 80, opts);
  const out: BandDay[] = [];
  for (const s of all) {
    let day = out.find((d) => d.date === s.date);
    if (!day) {
      if (out.length >= days) break;
      day = { date: s.date, weekday: s.weekday, label: dayLabel(s, nowEpoch), slots: [] };
      out.push(day);
    }
    day.slots.push(s);
  }
  return out;
}

/**
 * "hoy lunes 12" / "mañana martes 13" / "jueves 15" — the day part of
 * formatSlotLabel. The day of the month rides along (2026-10-21 audit: the bot
 * and the nudges got weekdays wrong; "martes 13" can be checked against a
 * calendar, "martes" cannot).
 */
export function dayLabel(slot: { weekday: number; date: string }, nowEpoch: number): string {
  const days = daysAhead(slot.date, nowEpoch);
  const name = `${WEEKDAY_ES[slot.weekday] ?? ""} ${dayOfMonth(slot.date)}`.trim();
  if (days <= 0) return `hoy ${name}`;
  if (days === 1) return `mañana ${name}`;
  return name;
}

/** "a las 4:00 pm" / "a la 1:00 pm" (one o'clock is singular in Spanish). Pure. */
export function atClockEs(time: string): string {
  const clock = time12h(time);
  return /^1:/.test(clock) ? `a la ${clock}` : `a las ${clock}`;
}

/**
 * True when a slot starts inside one of the configured preferred blocks.
 * `from`/`to` are INCLUSIVE class start times, so 09:00–13:00 covers the 13:00
 * class. Pure — exported for the unit tests.
 */
export function inPreferredBlock(
  slot: { weekday: number; time: string },
  blocks: readonly PreferredBlock[],
): boolean {
  // "HH:mm" is zero-padded, so lexical comparison is chronological.
  return blocks.some(
    (b) => b.dow === slot.weekday && slot.time >= b.from && slot.time <= b.to,
  );
}

// ---- internals ----

/** A candidate slot plus the epoch it starts at (needed for the 24h horizon). */
interface DatedSlot {
  slot: NextSlot;
  at: number;
}

/**
 * Soonest-first walk over the grid: day offsets ascending, and inside each day
 * the slots sorted by clock time — so the list is chronological by construction,
 * never by the order rows happen to sit in SLOTS.
 */
function collectSlots(
  discipline: string | null,
  audience: "adult" | "kid",
  nowEpoch: number,
  opts: {
    schedule?: readonly Slot[];
    closedDates?: readonly { date: string }[];
    leadSeconds?: number;
    /** Only parent-participation rows (see upcomingTrialSlots). */
    ppOnly?: boolean;
    /** Age band (2026-10-11): when set it REPLACES the audience/pp filter —
     *  only rows whose `group` is this band (slotMatchesBand). */
    band?: ProgramBand;
    /** Child's age in months when known: rows with a `months` window outside
     *  it are skipped (Nivel 0 vs regular Baby Fight Club). */
    ageMonths?: number | null;
    /** 0=Mon … 6=Sun weekdays the lead said don't work: never proposed. */
    excludeWeekdays?: ReadonlySet<number>;
    limit: number;
  },
): DatedSlot[] {
  const schedule = opts.schedule ?? SLOTS;
  const closed = new Set((opts.closedDates ?? CLIENT.closedDates ?? []).map((c) => c.date));
  const wantKey = resolveDiscipline(discipline);
  const earliest = nowEpoch + (opts.leadSeconds ?? SLOT_LEAD_SECONDS);
  const p = cdmxParts(nowEpoch);
  const out: DatedSlot[] = [];

  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    // Date.UTC normalizes day overflow, so `p.day + offset` rolls months/years.
    const midnight = cdmxToEpoch(p.year, p.month, p.day + offset, 0, 0, 0);
    const dp = cdmxParts(midnight);
    const date = `${dp.year}-${pad2(dp.month)}-${pad2(dp.day)}`;
    const wd = weekdayIndex(date);
    if (wd === null) continue;
    if (closed.has(date)) continue; // holiday / closure: never propose that day
    if (opts.excludeWeekdays?.has(wd)) continue; // the lead said this day doesn't work

    const band = opts.band;
    const ageKnown = typeof opts.ageMonths === "number";
    const candidates = schedule
      .filter((s) =>
        // Nivel 0 (Baby Fight Club 6–11 months, Friday 12 pm) is only PROPOSED
        // when the baby's age is known to fit: with the age unknown the regular
        // Wed / Sat class is the default (most BFC babies are 12–36 months).
        !(s.months && s.months[1] <= 12 && !ageKnown) &&
        (band !== undefined
          ? s.weekday === wd &&
            s.trial !== false &&
            slotMatchesBand(s, band, opts.ageMonths) &&
            (wantKey === null || (s.discipline === wantKey && !s.name))
          :
          s.weekday === wd &&
          s.audience === audience &&
          s.trial !== false &&
          // Parent-participation slots (baby / Mini Muay Thai) are dual-audience
          // so validateSlot accepts them, but proposing one to a generic lead is
          // wrong for BOTH audiences (an adult gets a toddler class; an
          // unknown-age kid probably belongs in Kids, not Mini). Only an
          // explicit baby pick may land on them.
          (opts.ppOnly
            ? s.pp === true && s.discipline !== "baby" // Mini MT, not the BFC mirror
            : (s.pp !== true || wantKey === "baby") &&
              // A renamed class (Blindaje 8 on the sáb 12:00 `jiu` row) is
              // not what a lead who asked for that program wants.
              (wantKey === null || (s.discipline === wantKey && !s.name)))),
      )
      .slice()
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

    for (const s of candidates) {
      const at = slotEpoch(dp.year, dp.month, dp.day, s.time);
      if (at === null || at < earliest) continue;
      const base = {
        weekday: wd,
        date,
        time: s.time,
        discipline: s.discipline,
        ...(s.name ? { name: s.name } : {}),
      };
      out.push({ slot: { ...base, label: formatSlotLabel(base, nowEpoch, "es") }, at });
      if (out.length >= opts.limit) return out;
    }
  }
  return out;
}

/**
 * Soonest-first with ONE exception: when a later candidate still starts inside
 * PREFERRED_HORIZON_SECONDS of the soonest one AND falls in a preferred block,
 * it wins (same-ish day either way, but the owner is on the floor to close).
 * With no blocks configured this is the identity on `found[0]`.
 */
function pickPreferred(
  found: readonly DatedSlot[],
  blocks: readonly PreferredBlock[],
): DatedSlot | undefined {
  const first = found[0];
  if (!first || blocks.length === 0) return first;
  const cutoff = first.at + PREFERRED_HORIZON_SECONDS;
  return found.find((c) => c.at <= cutoff && inPreferredBlock(c.slot, blocks)) ?? first;
}

/**
 * "hoy a las 6:00 pm" / "mañana miércoles 13 a las 11:00 am" / "el sábado 16
 * a las 9:00 am" (and the English equivalents) for a slot, relative to
 * `nowEpoch` in CDMX. Every non-today label carries the day of the month (see
 * dayLabel). Pure — exported so the EN copy can relabel the same slot.
 */
export function formatSlotLabel(
  slot: { weekday: number; date: string; time: string },
  nowEpoch: number,
  lang: "es" | "en",
): string {
  const days = daysAhead(slot.date, nowEpoch);
  const clock = time12h(slot.time);
  const dom = dayOfMonth(slot.date);
  const name =
    lang === "en"
      ? (WEEKDAY_EN[slot.weekday] ?? "")
      : (WEEKDAY_ES[slot.weekday] ?? "");
  const named = dom ? `${name} ${dom}` : name;
  if (lang === "en") {
    if (days <= 0) return `today at ${clock}`;
    if (days === 1) return `tomorrow ${named} at ${clock}`;
    return `on ${named} at ${clock}`;
  }
  const at = atClockEs(slot.time);
  if (days <= 0) return `hoy ${at}`;
  if (days === 1) return `mañana ${named} ${at}`;
  return `el ${named} ${at}`;
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

/** "2026-10-13" → "13" ("" when unparseable). */
function dayOfMonth(date: string): string {
  const m = /^\d{4}-\d{2}-(\d{2})$/.exec(date);
  return m ? String(Number(m[1])) : "";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
