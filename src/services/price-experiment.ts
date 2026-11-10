// Price-on-first-ask A/B test (owner-approved 2026-11-10). Pure, unit-tested.
//
// Variant A = today's script (persona "Manejo de precios": the first price ask
// gets a positive reframe + a trial offer, the approved range only if they
// insist). Variant B = the approved figure at the FIRST ask, in the same
// message as the trial invitation with a concrete day and time.
//
// Assignment is a pure function of the normalized phone + a salt, so it is
// stable per lead, needs no D1 column, and can be recomputed offline for the
// analysis (booked / attended per variant among leads who asked a price):
//
//   variant = fmix32(fnv1a32(`${salt}:${normalizeMxPhone(phone)}`)) % 2 === 0 ? "A" : "B"
//
// (FNV-1a alone is NOT enough: its lowest bit is just the parity of the input
// bytes, so the salt could never re-split. murmur3's fmix32 finalizer mixes
// every input bit into the bit we read.)
//
// Outside the [start, end) CDMX window, or with the test disabled, EVERYONE is
// variant A — the context block then carries nothing new and the turn is
// byte-identical to today's.

import { normalizeMxPhone } from "./airtable.js";
import type { PriceExperimentConfig } from "../client-config.js";

export type PriceVariant = "A" | "B";

/** 32-bit FNV-1a over the UTF-16 code units (ASCII here: salt + digits). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** murmur3 32-bit finalizer (avalanche). */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The arm a phone is ASSIGNED to (ignores the window and the switch). */
export function assignedPriceVariant(phone: string, salt: string): PriceVariant {
  return fmix32(fnv1a32(`${salt}:${normalizeMxPhone(phone)}`)) % 2 === 0 ? "A" : "B";
}

/** Is the test running on this CDMX calendar date ("YYYY-MM-DD")? end is exclusive. */
export function priceTestActive(
  cfg: PriceExperimentConfig | null | undefined,
  cdmxDate: string,
): boolean {
  if (!cfg || !cfg.enabled) return false;
  const d = cdmxDate.slice(0, 10);
  return d >= cfg.start && d < cfg.end;
}

/**
 * campaign.info that carries its own price or promo ("$999", "promo", "precio",
 * "descuento", "mensualidad", "membresía", "inscripción"): those leads keep the
 * campaign's own rules and are left out of the test. "gratis" alone does not
 * count — every campaign offers the free trial.
 */
export function campaignHasOwnPrice(info: string | null | undefined): boolean {
  const t = (info ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (!t.trim()) return false;
  return /\$\s?\d|\bmxn\b|\bpromo|\bprecio|\bcosto|\bdescuento|\bmensualidad|\bmembresia|\binscripcion/.test(t);
}

export type PriceTestExclusion = "inactive" | "student" | "campaign_price";

/**
 * The variant this TURN runs under. `excluded` says why a lead assigned to B
 * still gets today's script (A). Students are not leads; a campaign with its
 * own price/promo keeps its rules.
 */
export function priceVariantForTurn(input: {
  cfg: PriceExperimentConfig | null | undefined;
  phone: string;
  cdmxDate: string;
  status?: string | null;
  campaignInfo?: string | null;
}): { variant: PriceVariant; assigned: PriceVariant | null; excluded?: PriceTestExclusion } {
  const { cfg } = input;
  if (!cfg || !priceTestActive(cfg, input.cdmxDate)) {
    return { variant: "A", assigned: null, excluded: "inactive" };
  }
  const assigned = assignedPriceVariant(input.phone, cfg.salt);
  if (input.status === "student") return { variant: "A", assigned, excluded: "student" };
  if (campaignHasOwnPrice(input.campaignInfo)) return { variant: "A", assigned, excluded: "campaign_price" };
  return { variant: assigned, assigned };
}

/**
 * The <experimento_precio> lines for variant B (variant A gets nothing). The
 * figures are copied VERBATIM from the persona/KB ("Manejo de precios" +
 * intake.md "Respuesta sugerida cuando insisten"): no new number, no rewording.
 * Baby Fight Club already gives its price at the first ask in both arms.
 */
export const PRICE_VARIANT_B_LINES: readonly string[] = [
  "<experimento_precio>",
  "Este lead está en la variante B de una prueba de precios: si en su ÚLTIMO mensaje pregunta el precio (costo, mensualidad, cuánto cuesta) y es la PRIMERA vez que lo pregunta en la conversación, esta regla REEMPLAZA el reencuadre de «Manejo de precios» y la regla de no dar los números de Mini Muay Thai a la primera:",
  "- Da la cifra aprobada A LA PRIMERA, en el MISMO mensaje que la invitación a su clase de prueba gratis con UN día y hora concretos de SU programa.",
  "- Adultos, Kids (6–12) y Teens (13–17): \"el rango más común de nuestros planes va de $1,996 a $2,996 cada 4 semanas\".",
  "- Mini Muay Thai (3–5): \"$1,500 cada 4 semanas con 1 clase por semana, o $1,996 con las 3 clases\".",
  "- Baby Fight Club: igual que siempre (su respuesta del KB).",
  "- Usa la cifra tal cual: nunca otro número, nunca la tabla de planes. Si es para un peque y no sabes su edad, pregúntala primero (define programa y precio).",
  "- Ejemplo: \"Para darte una idea: el rango más común de nuestros planes va de $1,996 a $2,996 cada 4 semanas. Ya en tu día de prueba gratis platicamos cuál te conviene según tu objetivo 💪 ¿Te queda bien [día] a las [hora]?\"",
  "- Esa cifra cumple la casilla 3 (Precios) del checklist: no bajes tu sureness por darla.",
  "Si ya preguntó el precio antes, o pregunta por un plan, frecuencia o descuento concreto, sigue las reglas normales.",
  "</experimento_precio>",
];

/** Max phones per owner read (GET /admin/api/experiments/price-first-ask). */
export const PRICE_REPORT_MAX_PHONES = 500;

/**
 * Pure. The owner read's payload: the test config, whether it runs today, and
 * the ASSIGNED arm per phone (campaign-price exclusions are per turn — the
 * analysis applies them from the lead's campaign). `phones` is the raw
 * comma/space-separated query value.
 */
export function priceExperimentReport(
  cfg: PriceExperimentConfig | null | undefined,
  phonesRaw: string,
  cdmxDate: string,
): {
  config: PriceExperimentConfig | null;
  activeToday: boolean;
  assignments: { phone: string; normalized: string; variant: PriceVariant }[];
} {
  const phones = [...new Set(phonesRaw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean))].slice(
    0,
    PRICE_REPORT_MAX_PHONES,
  );
  return {
    config: cfg ?? null,
    activeToday: priceTestActive(cfg, cdmxDate),
    assignments: cfg
      ? phones.map((phone) => ({
          phone,
          normalized: normalizeMxPhone(phone),
          variant: assignedPriceVariant(phone, cfg.salt),
        }))
      : [],
  };
}
