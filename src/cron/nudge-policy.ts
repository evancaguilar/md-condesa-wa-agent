// Engagement-driven cut of the extended lead-nudge drip (2026-11-09). Meta
// flagged the number for spam twice in a week; most of the marketing templates
// went to leads who never answered the bot at all (40% of unbooked leads only
// sent the ad's prefilled message, and those got all five paid templates).
//
// Which extended steps (d2, d3, d4, d5, d7) a lead gets now depends on its
// engagement class, read from client config (client.mjs → `nudgePolicy`):
//   engaged = sent at least one real inbound AFTER our first outbound to them
//             (reactions and the one-tap opt-out quick reply do not count);
//   silent  = nothing since our first outbound (only the ad prefill).
// The class is evaluated when the chain is ARMED (maybeArmExtended, catch-up)
// and RE-CHECKED when each row is SENT (processExtendedNudge): a row for a step
// the lead's current class no longer includes is closed quietly.
//
// Pure: no D1, clock passed in. The D1 lookup lives in src/db/nudge-engagement.ts.

import type { NudgePolicyConfig } from "../client-config.js";
import { CLIENT } from "../client.gen.js";
import { ALL_EXTENDED_KINDS, DAY7_KIND, EXTENDED_NUDGE_KINDS, type ExtendedKind } from "./nudge-copy.js";
import { DAY } from "./time.js";

export type NudgeEngagementClass = "engaged" | "silent";

/** What the engagement lookup knows about one lead. */
export interface LeadEngagement {
  engaged: boolean;
  /** Epoch s of the lead's first message (first inbound, else contact.created_at); null = unknown. */
  firstMessageAt: number | null;
}

/** The conservative answer: used whenever the lookup fails or finds nothing. */
export const SILENT: LeadEngagement = Object.freeze({ engaged: false, firstMessageAt: null });

/** Resolved, validated policy (kinds in chain order). */
export interface NudgePolicy {
  engaged: ExtendedKind[];
  silent: ExtendedKind[];
  /** Silent leads whose first message is < silentFreshDays old get the FULL chain. */
  silentFreshFull: boolean;
  silentFreshDays: number;
}

export const DEFAULT_SILENT_FRESH_DAYS = 7;

/** The lead's day each step lands on (d2 = day 2 …); the anchor is day 1 (+8h). */
export const EXTENDED_STEP_DAY: Readonly<Record<ExtendedKind, number>> = {
  nudge_d2: 2,
  nudge_d3: 3,
  nudge_d4: 4,
  nudge_d5: 5,
  nudge_d7: 7,
};

/** Chain order of a kind (index in ALL_EXTENDED_KINDS). */
function orderOf(kind: string): number {
  return (ALL_EXTENDED_KINDS as readonly string[]).indexOf(kind);
}

/** "d4" | "nudge_d4" → "nudge_d4"; anything else → null. Pure. */
export function parseStep(raw: unknown): ExtendedKind | null {
  const s = String(raw ?? "").trim().toLowerCase();
  const kind = s.startsWith("nudge_") ? s : `nudge_${s}`;
  return orderOf(kind) >= 0 ? (kind as ExtendedKind) : null;
}

/** Valid, de-duplicated, chain-ordered steps. Unknown entries are dropped. Pure. */
function steps(raw: unknown, fallback: readonly ExtendedKind[]): ExtendedKind[] {
  if (!Array.isArray(raw)) return [...fallback];
  const set = new Set<ExtendedKind>();
  for (const r of raw) {
    const k = parseStep(r);
    if (k) set.add(k);
  }
  return [...set].sort((a, b) => orderOf(a) - orderOf(b));
}

/**
 * Config → policy. Absent config = the legacy behaviour (every class gets the
 * full chain), so a client without `nudgePolicy` is unchanged. Pure.
 */
export function resolveNudgePolicy(cfg: NudgePolicyConfig | null | undefined): NudgePolicy {
  const full = [...ALL_EXTENDED_KINDS];
  const days = Number(cfg?.silentFreshDays);
  return {
    engaged: steps(cfg?.engaged, full),
    silent: steps(cfg?.silent, full),
    silentFreshFull: cfg?.silentFreshFull === true,
    silentFreshDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_SILENT_FRESH_DAYS,
  };
}

/** The shipped client's policy (client.gen.ts). */
export const NUDGE_POLICY: NudgePolicy = resolveNudgePolicy(CLIENT.nudgePolicy);

/** The legacy full-chain policy (both classes get everything). */
export const FULL_CHAIN_POLICY: NudgePolicy = resolveNudgePolicy(null);

/**
 * True when the class cannot change the outcome (both lists equal, no fresh
 * override): callers then skip the engagement lookup entirely. Pure.
 */
export function policyIsUniform(p: NudgePolicy): boolean {
  return !p.silentFreshFull && p.engaged.length === p.silent.length && p.engaged.every((k, i) => p.silent[i] === k);
}

/** The class name of a lookup result. Pure. */
export function engagementClass(e: LeadEngagement): NudgeEngagementClass {
  return e.engaged ? "engaged" : "silent";
}

/** The base chain the d7 flag allows: d2–d5, + d7 when `day7`. Pure. */
function baseChain(day7: boolean): ExtendedKind[] {
  return day7 ? [...ALL_EXTENDED_KINDS] : [...EXTENDED_NUDGE_KINDS];
}

/**
 * Apply the d7 flag to a configured list. With the flag off d7 does not exist
 * and d5 carries the goodbye copy, so a list that ends in d7 ends in d5 instead
 * — the last step a lead receives is always the "último mensaje". Pure.
 */
function withDay7(list: readonly ExtendedKind[], day7: boolean): ExtendedKind[] {
  if (day7) return [...list];
  const out = list.filter((k) => k !== DAY7_KIND);
  if (list.includes(DAY7_KIND) && !out.includes("nudge_d5")) out.push("nudge_d5");
  return out.sort((a, b) => orderOf(a) - orderOf(b));
}

/**
 * The extended steps this lead gets right now, in chain order. Engaged → the
 * `engaged` list; silent → the `silent` list, or the full chain while
 * `silentFreshFull` is on and the lead's first message is younger than
 * `silentFreshDays` (an unknown first-message time is never "fresh"). Pure.
 */
export function nudgeChainFor(
  policy: NudgePolicy,
  engagement: LeadEngagement,
  now: number,
  day7: boolean,
): ExtendedKind[] {
  if (engagement.engaged) return withDay7(policy.engaged, day7);
  const first = engagement.firstMessageAt;
  if (policy.silentFreshFull && first !== null && now - first < policy.silentFreshDays * DAY) {
    return baseChain(day7);
  }
  return withDay7(policy.silent, day7);
}

/**
 * Resume: the chain steps not yet sent that come AFTER the latest step already
 * sent (chain order). Never goes back to an earlier step — so the goodbye (d7)
 * stays the last message even when a reply moves a lead to a longer list
 * (silent got d2 + d7, then wrote → engaged's d4 must not follow the goodbye). Pure.
 */
export function remainingAfterSent(chain: readonly ExtendedKind[], sent: readonly string[]): ExtendedKind[] {
  const latest = Math.max(-1, ...sent.map(orderOf));
  return chain.filter((k) => !sent.includes(k) && orderOf(k) > latest);
}

/** Gap before the FIRST remaining step, measured from the anchor: d7 48h, the rest 24h. */
export function firstStepGap(kind: ExtendedKind): number {
  return kind === DAY7_KIND ? 2 * DAY : DAY;
}

/**
 * Due times (before quiet shifting) of `kinds` off `anchor`: the first step one
 * gap after the anchor, every later step at its own day number relative to the
 * first (d4 after d2 = +2 days, d7 after d2 = +5 days). A fresh chain is thus
 * absolute from the anchor (dN = anchor + (N−1) days — the same times the old
 * +24h-each chain produced, so the full chain is unchanged) and gaps simply
 * leave the skipped days empty. Pure.
 */
export function stepOffsets(kinds: readonly ExtendedKind[]): number[] {
  const first = kinds[0];
  if (!first) return [];
  const gap = firstStepGap(first);
  return kinds.map((k) => gap + (EXTENDED_STEP_DAY[k] - EXTENDED_STEP_DAY[first]) * DAY);
}

/** ops_log text for the policy skips of one cron tick (null when none). Pure. */
export function policySkipNote(counts: ReadonlyMap<string, number>): string | null {
  let total = 0;
  const parts: string[] = [];
  for (const [key, n] of [...counts.entries()].sort()) {
    total += n;
    parts.push(`${key} ${n}`);
  }
  if (total === 0) return null;
  return `✂️ Drip por engagement (nudgePolicy): ${total} envío(s) omitidos en este tick — ${parts.join(", ")}.`;
}
