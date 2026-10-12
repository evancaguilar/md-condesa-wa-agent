// Age → program band (2026-10-11). Pure, unit-tested.
//
// Why this exists: classifyProgram used to answer "baby" for ANY lead whose
// campaign name matched /baby/, before looking at the child's age — and the
// age was never stored anywhere. A 4-year-old from the Baby Fight Club ad
// (Joss, 2026-09) was therefore shown only BFC hours, booked into BFC, moved
// to Mini Muay Thai, booked into BFC again. Every age rule the persona states
// (persona.md "Routing por edad") now has ONE code home, and the slot grid
// carries the group each class is for (slots.gen.ts `group`), so a booking
// can be validated against the child's age instead of against a campaign.

import type { ProgramBand, Qualification } from "../types.js";
import type { Slot } from "../brain/slots.gen.js";

export type { ProgramBand };

/** Months of age → band. <12 months = Nivel 0 (no trial slot; treated as baby
 *  for copy/links, the brain escalates). */
export function bandFromAgeMonths(months: number): ProgramBand {
  if (!Number.isFinite(months) || months < 0) return "adults";
  if (months < 36) return "baby";
  if (months < 72) return "mini"; // 3–5
  if (months < 156) return "kids"; // 6–12
  if (months < 216) return "teens"; // 13–17
  return "adults";
}

export function bandFromAgeYears(years: number): ProgramBand {
  return bandFromAgeMonths(years * 12);
}

/** The group a slot is for, inferring it for slot grids built before `group`. */
export function slotGroup(slot: Slot): NonNullable<Slot["group"]> {
  if (slot.group) return slot.group;
  if (slot.discipline === "baby") return "baby";
  if (slot.pp) return "mini";
  return slot.audience === "kid" ? "kids" : "adult";
}

/** Does a slot belong to the band? Adults may also take any kid-free class;
 *  the grid has no "adult" band entries for minors, so kids/teens/mini/baby
 *  must match exactly. */
export function slotMatchesBand(slot: Slot, band: ProgramBand): boolean {
  const g = slotGroup(slot);
  if (band === "adults") return g === "adult";
  return g === band;
}

/** Booking audience for book_trial / Airtable: everyone under 18 is "kid". */
export function bandAudience(band: ProgramBand): "adult" | "kid" {
  return band === "adults" ? "adult" : "kid";
}

/** Spanish label used in the brain context and Slack cards. */
export function bandLabel(band: ProgramBand): string {
  switch (band) {
    case "baby":
      return "Baby Fight Club (12–36 meses)";
    case "mini":
      return "Mini Muay Thai (3–5 años)";
    case "kids":
      return "Kids (6–12 años)";
    case "teens":
      return "Teens (13–17 años)";
    default:
      return "adultos";
  }
}

/** Airtable `Programa` key (see client.mjs airtableLeads.audienceValues). */
export function bandAirtableKey(band: ProgramBand): "adult" | "kid" | "baby" | "mini" | "teens" {
  switch (band) {
    case "adults":
      return "adult";
    case "kids":
      return "kid";
    default:
      return band;
  }
}

/** The band a stored qualification points at, or null when it says nothing
 *  about age. Explicit `program` wins, then `child_age_months`, then the
 *  legacy discipline=baby / audience=kid signals. */
export function bandFromQualification(q: Qualification | null | undefined): ProgramBand | null {
  if (!q) return null;
  if (q.program) return q.program;
  if (typeof q.child_age_months === "number") return bandFromAgeMonths(q.child_age_months);
  const disc = (q.discipline ?? "").toLowerCase();
  if (disc.includes("baby")) return "baby";
  if (q.audience === "kid") return "kids";
  if (q.audience === "adult") return "adults";
  return null;
}

// ---- age extraction from free text (the lead's own words) ----

const NUM_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, dieciseis: 16, diecisiete: 17,
};

function num(s: string): number | null {
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const w = NUM_WORDS[s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")];
  return w ?? null;
}

const AGE_ANY = "(\\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete)";
/** "tiene 2 años y medio", "casi 5 años", "va a cumplir 3", "de 4 años", "cumplió 1 año" */
const YEARS_RE = new RegExp(
  `(?:\\b(?:tiene|tienen|cumpli[oó]|cumple|va\\s+a\\s+cumplir|casi|de|apenas)\\s+)?${AGE_ANY}\\s*(?:años|añitos|anos|a[ñn]o)(?:\\s+y\\s+medio)?(?![\\p{L}\\d])`,
  "iu",
);
/** "18 meses", "tiene 20 meses", "1 año 10 meses" */
const MONTHS_RE = new RegExp(`${AGE_ANY}\\s*mes(?:es)?(?![\\p{L}\\d])`, "iu");
const YEARS_MONTHS_RE = new RegExp(
  `${AGE_ANY}\\s*(?:años?|a[ñn]o)\\s*(?:y\\s*)?${AGE_ANY}\\s*mes(?:es)?`,
  "iu",
);
/** Adults talking about themselves: "tengo 25 años", "llevo 6 meses". */
const SELF_RE = /\b(tengo|llevo|entren[oé]|hace)\s+(\d{1,2}|\w+)\s*(años|meses)/i;
const BARE_RE = /^\s*(?:tiene\s+)?(\d{1,2})\s*$/;

/**
 * Child's age in months from one message, or null. Conservative: an age the
 * writer attributes to themselves ("tengo 25 años") never counts, and a bare
 * number ("5") counts only when `expectingAge` (the bot just asked for it).
 */
export function childAgeMonthsFromText(
  text: string | null | undefined,
  opts: { expectingAge?: boolean } = {},
): number | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (SELF_RE.test(t) && !/\b(hij[oa]|niñ[oa]|nin[oa]|beb[eé]|peque)/i.test(t)) return null;

  const ym = YEARS_MONTHS_RE.exec(t);
  if (ym) {
    const y = num(ym[1]!);
    const m = num(ym[2]!);
    if (y !== null && m !== null && y <= 17) return y * 12 + m;
  }
  const mo = MONTHS_RE.exec(t);
  if (mo && !/\bhace\b/i.test(t)) {
    const m = num(mo[1]!);
    if (m !== null && m >= 1 && m <= 48) return m;
  }
  const yr = YEARS_RE.exec(t);
  if (yr) {
    const y = num(yr[1]!);
    if (y !== null && y >= 1 && y <= 17) {
      const half = /y\s+medio/i.test(yr[0]) ? 6 : 0;
      return y * 12 + half;
    }
  }
  if (opts.expectingAge) {
    const b = BARE_RE.exec(t);
    if (b) {
      const y = Number(b[1]);
      if (y >= 1 && y <= 17) return y * 12;
    }
  }
  return null;
}

/** Years the model passes in book_trial.child_age → months. */
export function monthsFromYears(years: number | null | undefined): number | null {
  if (typeof years !== "number" || !Number.isFinite(years) || years < 0) return null;
  return Math.round(years * 12);
}
