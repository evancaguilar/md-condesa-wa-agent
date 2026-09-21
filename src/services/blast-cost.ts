// What a blast COSTS. Meta bills per delivered template message since
// 2025-07-01, at a rate that depends on the market (Mexico here) and the
// template's category (marketing vs utility). This module is pure: it turns
// "N messages of category C" into an estimate in USD, and folds the per-day
// counters the drain writes into a month-to-date total.
//
// The rates themselves are NEVER hardcoded here — they live in
// clients/<id>/client.mjs (`whatsappPricing`, from Meta's published USD rate
// card) and arrive as a parameter, so a quarterly Meta rate change is a config
// edit + `npm run build`.
//
// Why it is only ever an ESTIMATE (say "estimado" in every UI surface):
//   - we count rows we SENT (accepted by the Graph API), Meta bills DELIVERED;
//   - utility/authentication have volume tiers that lower the rate at scale;
//   - a template delivered inside an open 24h window can be free;
//   - an unknown template category is priced as marketing (the worst case).
// Reconcile against WhatsApp Manager → Insights (docs/blasts.md §7).

import type { WhatsAppPricing } from "../client-config.js";
import { cdmxParts } from "../cron/time.js";

/** kv key per CDMX day holding the category breakdown of what went out. */
export const KV_COST_DAY_PREFIX = "blast_cost:";
/** kv key per CDMX day holding the plain send count (predates the breakdown). */
export const KV_SENT_DAY_PREFIX = "blast_sent:";

/** The two categories the blast sender can send at (see checkTemplateForRun). */
export type PricedCategory = "marketing" | "utility";

export interface CategoryChoice {
  category: PricedCategory;
  /** False when the run carried no Meta category and we assumed marketing. */
  known: boolean;
}

/**
 * Pure. Map a Meta template category ("MARKETING" / "UTILITY" / …) to the rate
 * bucket. Anything unknown (old runs queued before the category was stored,
 * AUTHENTICATION, a skipCheck run) is priced as MARKETING — the dearer of the
 * two, so the estimate never flatters the bill — and flagged `known:false`.
 */
export function priceCategory(raw: string | null | undefined): CategoryChoice {
  const c = (raw ?? "").trim().toUpperCase();
  if (c === "UTILITY") return { category: "utility", known: true };
  if (c === "MARKETING") return { category: "marketing", known: true };
  return { category: "marketing", known: false };
}

/** Pure. The USD rate for a category, 0 when the client has no rate card. */
export function rateFor(
  pricing: WhatsAppPricing | null | undefined,
  category: PricedCategory,
): number {
  if (!pricing) return 0;
  const r = category === "utility" ? pricing.utility : pricing.marketing;
  return Number.isFinite(r) && r > 0 ? r : 0;
}

/** Round to whole cents for display (0.0305 × 7 = 0.2135 → 0.21). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RunCost {
  /** Messages actually sent (never queued / failed / skipped / cancelled). */
  sent: number;
  estCostUsd: number;
  rate: number;
  category: PricedCategory;
  /** False ⇒ the category was assumed (marketing); say so in the UI. */
  knownCategory: boolean;
  currency: string;
}

/** Pure. Cost of one run: sent × the rate of its template category. */
export function runCost(
  sent: number,
  rawCategory: string | null | undefined,
  pricing: WhatsAppPricing | null | undefined,
): RunCost {
  const { category, known } = priceCategory(rawCategory);
  const rate = rateFor(pricing, category);
  const n = Number.isFinite(sent) && sent > 0 ? Math.floor(sent) : 0;
  return {
    sent: n,
    estCostUsd: round2(n * rate),
    rate,
    category,
    knownCategory: known,
    currency: pricing?.currency ?? "USD",
  };
}

// ---- per-day counters --------------------------------------------------------

/** Messages sent on one CDMX day, split by rate bucket. */
export interface DayCost {
  marketing: number;
  utility: number;
  /** Sent under a run whose category we do not know ⇒ priced as marketing. */
  unknown: number;
}

export function emptyDayCost(): DayCost {
  return { marketing: 0, utility: 0, unknown: 0 };
}

export function dayCostTotal(d: DayCost): number {
  return d.marketing + d.utility + d.unknown;
}

function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Pure. Decode a `blast_cost:<day>` kv value; garbage ⇒ zeros. */
export function parseDayCost(value: string | null | undefined): DayCost {
  if (!value) return emptyDayCost();
  try {
    const p = JSON.parse(value) as Partial<Record<keyof DayCost, unknown>>;
    return { marketing: count(p.marketing), utility: count(p.utility), unknown: count(p.unknown) };
  } catch {
    return emptyDayCost();
  }
}

export function encodeDayCost(d: DayCost): string {
  return JSON.stringify({ marketing: d.marketing, utility: d.utility, unknown: d.unknown });
}

/** Pure. Add `n` messages of a run's category to a day's breakdown. */
export function addDayCost(d: DayCost, rawCategory: string | null | undefined, n = 1): DayCost {
  const { category, known } = priceCategory(rawCategory);
  const out = { ...d };
  if (!known) out.unknown += n;
  else if (category === "utility") out.utility += n;
  else out.marketing += n;
  return out;
}

// ---- month to date -----------------------------------------------------------

/** Pure. "2026-09-" — the CDMX month `epoch` falls in, as a kv key fragment. */
export function cdmxMonthPrefix(epoch: number): string {
  const p = cdmxParts(epoch);
  return `${p.year}-${String(p.month).padStart(2, "0")}-`;
}

/**
 * Pure. A `[from, to)` key range for a kv prefix. Used instead of `LIKE
 * 'prefix%'` so the read is a plain index range scan on kv's PRIMARY KEY
 * (D1 rows-read rule, CLAUDE.md): ≤31 rows per prefix instead of a table scan.
 */
export function prefixRange(prefix: string): { from: string; to: string } {
  const last = prefix.charCodeAt(prefix.length - 1);
  return { from: prefix, to: prefix.slice(0, -1) + String.fromCharCode(last + 1) };
}

export interface KvRow {
  key: string;
  value: string | null;
}

/**
 * Pure. Fold the month's kv rows into one breakdown.
 *
 * `blast_cost:<day>` (the category breakdown) wins for a day it covers. The
 * older `blast_sent:<day>` total still counts whatever the breakdown misses —
 * days before this shipped, and the part of the deploy day that went out
 * before the drain started writing breakdowns — as `unknown`, so the month
 * total never under-reports. Rows of other months are ignored.
 */
export function foldMonthCounters(rows: KvRow[], monthPrefix: string): DayCost {
  const byDay = new Map<string, DayCost>();
  const sentByDay = new Map<string, number>();
  for (const r of rows) {
    if (r.key.startsWith(KV_COST_DAY_PREFIX)) {
      const day = r.key.slice(KV_COST_DAY_PREFIX.length);
      if (!day.startsWith(monthPrefix)) continue;
      byDay.set(day, parseDayCost(r.value));
    } else if (r.key.startsWith(KV_SENT_DAY_PREFIX)) {
      const day = r.key.slice(KV_SENT_DAY_PREFIX.length);
      if (!day.startsWith(monthPrefix)) continue;
      sentByDay.set(day, count(r.value));
    }
  }
  const out = emptyDayCost();
  const days = new Set<string>([...byDay.keys(), ...sentByDay.keys()]);
  for (const day of days) {
    const d = byDay.get(day) ?? emptyDayCost();
    const gap = (sentByDay.get(day) ?? 0) - dayCostTotal(d);
    out.marketing += d.marketing;
    out.utility += d.utility;
    out.unknown += d.unknown + (gap > 0 ? gap : 0);
  }
  return out;
}

export interface MonthCost {
  sent: number;
  estCostUsd: number;
  marketing: number;
  utility: number;
  /** Messages priced as marketing without a known category. */
  unknown: number;
  currency: string;
}

/** Pure. Price a month's breakdown. Unknown messages ride the marketing rate. */
export function monthCost(d: DayCost, pricing: WhatsAppPricing | null | undefined): MonthCost {
  const mkt = rateFor(pricing, "marketing");
  const util = rateFor(pricing, "utility");
  return {
    sent: dayCostTotal(d),
    estCostUsd: round2((d.marketing + d.unknown) * mkt + d.utility * util),
    marketing: d.marketing,
    utility: d.utility,
    unknown: d.unknown,
    currency: pricing?.currency ?? "USD",
  };
}
