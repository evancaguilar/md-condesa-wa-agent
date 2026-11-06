// One-shot catch-up for the lead-nudge drip (2026-11). The drip was broken for
// weeks (docs/STATUS.md "Lead-nudge drip revived"), so hundreds of recent leads
// got 0–1 follow-ups. This module picks the leads whose extended chain stopped
// early for a reason that is NOT theirs (booked, opted out, student, taken by a
// human, draft waiting, wrote recently, wants to pay) and plans the remaining
// extended steps, spread `perDay` leads per day, freshest first, first steps
// between 09:00 and 19:00 CDMX. The owner endpoint (/admin/api/nudges/catchup)
// only INSERTS followups rows; every send goes through the normal cron path
// (processExtendedNudge re-verifies eligibility, quiet hours, template
// fallback, one-per-day claim → defer).
//
// Pure: no D1, no fetch, clock passed in. The D1 layer is nudge-catchup-db.ts.

import type { Contact } from "../types.js";
import {
  BOOKING_HISTORY_WINDOW_SECONDS,
  BOOKING_KINDS,
  EXTENDED_RESUME_WINDOW_SECONDS,
  PAST_BOOKING_KINDS,
  ALL_EXTENDED_KINDS,
  bandForContact,
  bandProgram,
  computeExtendedChain,
  extendedChainKinds,
  extendedGap,
  hasBookingHistory,
  remainingExtendedKinds,
  type ExtendedKind,
} from "../cron/nudges.js";
import { hasBuyIntent } from "../cron/nudge-signals.js";
import { channelOf } from "./channel.js";
import { DAY, cdmxParts, cdmxToEpoch } from "../cron/time.js";

const HOUR = 3600;

/** First steps land between these CDMX hours of the assigned day. */
export const CATCHUP_DAY_START_HOUR = 9;
export const CATCHUP_DAY_END_HOUR = 19;
const DAY_WINDOW_SECONDS = (CATCHUP_DAY_END_HOUR - CATCHUP_DAY_START_HOUR) * HOUR;

/** Anyone we messaged (bot, staff, blast template, nudge) this recently is left alone. */
export const RECENT_OUTBOUND_SECONDS = 48 * HOUR;
/** Buy intent is read over the lead's inbound of this window (same as send time). */
export const BUY_INTENT_WINDOW_SECONDS = 7 * DAY;
/** A default startAt is at least this far in the future. */
export const START_MIN_LEAD_SECONDS = 10 * 60;

export const CATCHUP_DEFAULTS = { sinceDays: 21, perDay: 150, limit: 2000 } as const;
export const CATCHUP_MAX = { sinceDays: 45, perDay: 400, limit: 5000 } as const;

export interface CatchupOptions {
  dryRun: boolean;
  sinceDays: number;
  perDay: number;
  /** Normalized start (epoch s): inside 09:00–19:00 CDMX. Also the run id. */
  startAt: number;
  excludePhones: Set<string>;
  limit: number;
  /**
   * 2026-11-05 (Meta spam flag after ~164 cold nudge_d2 templates in a day):
   * keep only leads who wrote at least once AFTER our first outbound message
   * to them, i.e. people who actually talked to the bot, not just the ad
   * prefill. Default false (old behavior).
   */
  requireReplyToBot: boolean;
}

/** The token every row of a run carries (UNIQUE never blocks a new run). */
export function catchupToken(runId: number): string {
  return `seq:catchup:${runId}`;
}

/** kv key holding a run's JSON summary. */
export function catchupKvKey(runId: number): string {
  return `nudge_catchup:${runId}`;
}

/** 09:00 CDMX of the day `epoch` falls on. */
function nineAm(epoch: number): number {
  const p = cdmxParts(epoch);
  return cdmxToEpoch(p.year, p.month, p.day, CATCHUP_DAY_START_HOUR, 0, 0);
}

/**
 * Clamp a start into the daily sending window: before 09:00 → 09:00 that day,
 * at/after 19:00 → 09:00 the next day, otherwise unchanged. Pure.
 */
export function normalizeCatchupStart(epoch: number): number {
  const nine = nineAm(epoch);
  if (epoch < nine) return nine;
  if (epoch >= nine + DAY_WINDOW_SECONDS) return nine + DAY;
  return epoch;
}

/** Default start: the next 09:00 CDMX at least 10 min from now. Pure. */
export function defaultCatchupStart(now: number): number {
  const earliest = now + START_MIN_LEAD_SECONDS;
  const nine = nineAm(earliest);
  return earliest <= nine ? nine : nine + DAY;
}

function clampInt(raw: unknown, def: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Parse + validate the endpoint body. A past / unparsable startAt is an error. Pure. */
export function parseCatchupBody(
  body: Record<string, unknown> | null | undefined,
  now: number,
  normalizePhone: (p: string) => string = (p) => p.replace(/\D/g, ""),
): { ok: true; opts: CatchupOptions } | { ok: false; error: string } {
  const b = body ?? {};
  let startAt: number;
  if (b.startAt === undefined || b.startAt === null || b.startAt === "") {
    startAt = defaultCatchupStart(now);
  } else {
    const ms = Date.parse(String(b.startAt));
    if (!Number.isFinite(ms)) return { ok: false, error: "startAt: fecha ISO inválida" };
    const raw = Math.floor(ms / 1000);
    if (raw < now + START_MIN_LEAD_SECONDS) {
      return { ok: false, error: "startAt debe ser al menos 10 min en el futuro" };
    }
    startAt = normalizeCatchupStart(raw);
  }
  const excludePhones = new Set<string>();
  if (Array.isArray(b.excludePhones)) {
    for (const p of b.excludePhones.slice(0, 1000)) {
      const n = normalizePhone(String(p ?? ""));
      if (n) excludePhones.add(n);
    }
  }
  return {
    ok: true,
    opts: {
      dryRun: b.dryRun !== false,
      sinceDays: clampInt(b.sinceDays, CATCHUP_DEFAULTS.sinceDays, 1, CATCHUP_MAX.sinceDays),
      perDay: clampInt(b.perDay, CATCHUP_DEFAULTS.perDay, 1, CATCHUP_MAX.perDay),
      startAt,
      excludePhones,
      limit: clampInt(b.limit, CATCHUP_DEFAULTS.limit, 1, CATCHUP_MAX.limit),
      requireReplyToBot: b.requireReplyToBot === true,
    },
  };
}

// ---- cancel -----------------------------------------------------------------

export interface CatchupCancelOptions {
  dryRun: boolean;
  /** One run's exact token (seq:catchup:<runId>), or null = every catch-up run. */
  token: string | null;
}

/**
 * Parse POST /admin/api/nudges/catchup/cancel. Exactly one of `runId` (the
 * number, or the full "seq:catchup:<n>" token) or `all: true`. `status` may
 * only be "cancelled" (the default). dryRun defaults to true. Pure.
 */
export function parseCatchupCancelBody(
  body: Record<string, unknown> | null | undefined,
): { ok: true; opts: CatchupCancelOptions } | { ok: false; error: string } {
  const b = body ?? {};
  if (b.status !== undefined && b.status !== "cancelled") {
    return { ok: false, error: 'status: solo "cancelled"' };
  }
  const hasRun = b.runId !== undefined && b.runId !== null && b.runId !== "";
  const all = b.all === true;
  if (hasRun === all) return { ok: false, error: "manda runId o all: true (uno de los dos)" };
  let token: string | null = null;
  if (hasRun) {
    const m = /^(?:seq:catchup:)?(\d{9,11})$/.exec(String(b.runId).trim());
    if (!m) return { ok: false, error: "runId inválido (número o seq:catchup:<n>)" };
    token = catchupToken(Number(m[1]));
  }
  return { ok: true, opts: { dryRun: b.dryRun !== false, token } };
}

// ---- selection --------------------------------------------------------------

export const SKIP_REASONS = [
  "excluded",
  "notWa",
  "optedOut",
  "student",
  "noInbound",
  "english",
  "override",
  "booked",
  "pendingApproval",
  "inChain",
  "chainDone",
  "recentOutbound",
  "buyIntent",
  "noReplyToBot",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** The contacts columns the scan reads. */
export type CatchupContactRow = Pick<
  Contact,
  | "phone"
  | "name"
  | "lang"
  | "status"
  | "qualification"
  | "human_override_until"
  | "last_inbound_at"
  | "campaign_id"
  | "created_at"
>;

export interface ProbeFollowup {
  kind: string;
  status: string;
  due_at: number;
}

export interface ProbeMessage {
  direction: string;
  body: string | null;
  ts: number;
}

/** Everything the batched probes found for one phone. */
export interface CatchupProbes {
  pendingApproval: boolean;
  bookingMarker: string | null;
  /** Rows of booking kinds (PAST_BOOKING_KINDS) and extended kinds, any status. */
  followups: readonly ProbeFollowup[];
  /** Messages of the last 7 days (outbound bodies may be null). */
  messages: readonly ProbeMessage[];
}

/** Checks that need only the contact row (run before any probe). Pure. */
export function rowSkipReason(
  row: CatchupContactRow,
  now: number,
  excluded: ReadonlySet<string>,
): SkipReason | null {
  if (excluded.has(row.phone)) return "excluded";
  if (channelOf(row.phone) !== "wa") return "notWa";
  if (row.status === "opted_out") return "optedOut";
  if (row.status !== "lead") return "student";
  if (row.last_inbound_at === null || row.last_inbound_at === undefined) return "noInbound";
  if (row.lang === "en") return "english"; // no _en nudge templates exist
  if (row.human_override_until && row.human_override_until > now) return "override";
  return null;
}

export type CatchupVerdict =
  | { skip: SkipReason }
  | { skip: null; sentKinds: string[]; nextKinds: ExtendedKind[] };

/**
 * Full verdict for one lead given its probes. Mirrors the send-time checks of
 * processExtendedNudge plus the catch-up's own rules (48h quiet period, live
 * chain, chain already done). Pure.
 */
export function classifyCatchupLead(
  row: CatchupContactRow,
  probes: CatchupProbes,
  now: number,
  chain: readonly ExtendedKind[],
  excluded: ReadonlySet<string> = new Set(),
): CatchupVerdict {
  const early = rowSkipReason(row, now, excluded);
  if (early) return { skip: early };

  const fus = probes.followups;
  const bookingSet = new Set<string>(PAST_BOOKING_KINDS);
  const liveBooking = fus.some(
    (f) => (BOOKING_KINDS as readonly string[]).includes(f.kind) && f.status === "scheduled",
  );
  const bookingRow = fus.some(
    (f) => bookingSet.has(f.kind) && f.due_at >= now - BOOKING_HISTORY_WINDOW_SECONDS,
  );
  if (liveBooking || hasBookingHistory(probes.bookingMarker, bookingRow, now)) return { skip: "booked" };
  if (probes.pendingApproval) return { skip: "pendingApproval" };

  const extended = new Set<string>(ALL_EXTENDED_KINDS);
  // A paused row (an owner hold, e.g. the 2026-11-05 catch-up pause) is a live
  // chain too: a new run must not stack a second chain on top of it.
  if (fus.some((f) => extended.has(f.kind) && (f.status === "scheduled" || f.status === "paused"))) {
    return { skip: "inChain" };
  }
  const sentKinds = [
    ...new Set(
      fus
        .filter((f) => extended.has(f.kind) && f.status === "sent" && f.due_at >= now - EXTENDED_RESUME_WINDOW_SECONDS)
        .map((f) => f.kind),
    ),
  ];
  const nextKinds = remainingExtendedKinds(chain, sentKinds);
  if (nextKinds.length === 0) return { skip: "chainDone" };

  if (probes.messages.some((m) => m.direction !== "in" && m.ts >= now - RECENT_OUTBOUND_SECONDS)) {
    return { skip: "recentOutbound" };
  }
  const inbound = probes.messages
    .filter((m) => m.direction === "in" && m.ts >= now - BUY_INTENT_WINDOW_SECONDS)
    .map((m) => m.body ?? "");
  if (hasBuyIntent(inbound)) return { skip: "buyIntent" };

  return { skip: null, sentKinds, nextKinds };
}

// ---- planning ---------------------------------------------------------------

export interface CatchupLead {
  row: CatchupContactRow;
  sentKinds: string[];
  nextKinds: ExtendedKind[];
}

export interface PlannedLead extends CatchupLead {
  /** 0-based schedule day (0 = startAt's day). */
  day: number;
  rows: { kind: ExtendedKind; dueAt: number }[];
}

/**
 * Day capacities: a full day holds `perDay` first steps over 10h; day 0 holds
 * its share of the window left after startAt, so the send RATE never exceeds
 * perDay/10h (every due row runs in one cron tick, and each template fallback
 * costs Graph subrequests). Pure.
 */
function dayCapacity(day: number, perDay: number, day0Start: number): number {
  if (day > 0) return perDay;
  const left = nineAm(day0Start) + DAY_WINDOW_SECONDS - day0Start;
  return Math.floor((perDay * left) / DAY_WINDOW_SECONDS);
}

/**
 * Assign each lead (freshest created_at first) a day and a first-step time,
 * spread evenly over 09:00–19:00 CDMX (day 0: from startAt), then lay the rest
 * of its chain out with computeExtendedChain from an anchor one gap before the
 * first step (+24h each, d7 +48h, quiet-shifted). Pure.
 */
export function planCatchup(
  leads: readonly CatchupLead[],
  perDay: number,
  startAt: number,
): PlannedLead[] {
  const start = normalizeCatchupStart(startAt);
  const sorted = [...leads].sort(
    (a, b) => (b.row.created_at ?? 0) - (a.row.created_at ?? 0) || a.row.phone.localeCompare(b.row.phone),
  );
  // Bucket into days.
  const days: CatchupLead[][] = [];
  let i = 0;
  for (let d = 0; i < sorted.length; d++) {
    const cap = dayCapacity(d, perDay, start);
    days.push(sorted.slice(i, i + cap));
    i += cap;
  }
  const out: PlannedLead[] = [];
  days.forEach((bucket, d) => {
    if (bucket.length === 0) return;
    const winStart = d === 0 ? start : nineAm(start) + d * DAY;
    const winEnd = nineAm(start) + d * DAY + DAY_WINDOW_SECONDS;
    const span = winEnd - winStart;
    bucket.forEach((lead, j) => {
      const first = winStart + Math.floor((j * span) / bucket.length);
      const anchor = first - extendedGap(lead.nextKinds[0]!);
      out.push({ ...lead, day: d, rows: computeExtendedChain(anchor, lead.nextKinds) });
    });
  });
  return out;
}

// ---- summary ----------------------------------------------------------------

export type AgeBucket = "0-7d" | "7-14d" | "14-21d" | "21+";

export function ageBucket(createdAt: number, now: number): AgeBucket {
  const days = (now - createdAt) / DAY;
  if (days < 7) return "0-7d";
  if (days < 14) return "7-14d";
  if (days < 21) return "14-21d";
  return "21+";
}

/** The three copy programs (bandProgram folds mini/teens into kids). */
export type CopyProgram = "adults" | "kids" | "baby";

/** Copy program of a lead (age band first, campaign name second). Pure. */
export function catchupProgram(row: CatchupContactRow, campaignName: string | null): CopyProgram {
  const c = {
    ad_ref: null,
    airtable_lead_id: null,
    updated_at: 0,
    ...row,
  } as Contact;
  return bandProgram(bandForContact(c, campaignName)) as CopyProgram;
}

export interface CatchupSummary {
  candidates: number;
  rows: number;
  byAge: Record<AgeBucket, number>;
  byProgram: Record<CopyProgram, number>;
  byNextStep: Record<string, number>;
  estTemplateSends: number;
  days: number;
  firstDueAt: string | null;
  lastDueAt: string | null;
  sample: {
    phone: string;
    name: string | null;
    createdAt: string;
    lastInboundAt: string | null;
    sentKinds: string[];
    nextKinds: string[];
    firstDueAt: string;
  }[];
}

const iso = (s: number): string => new Date(s * 1000).toISOString();

/** Counts + sample over a plan. `days` = schedule days that hold first steps. Pure. */
export function summarizeCatchup(
  plan: readonly PlannedLead[],
  now: number,
  campaignNames: ReadonlyMap<number, string> = new Map(),
): CatchupSummary {
  const byAge: Record<AgeBucket, number> = { "0-7d": 0, "7-14d": 0, "14-21d": 0, "21+": 0 };
  const byProgram: Record<CopyProgram, number> = { adults: 0, kids: 0, baby: 0 };
  const byNextStep: Record<string, number> = {};
  let rows = 0;
  let first = Infinity;
  let last = -Infinity;
  const dayset = new Set<number>();
  for (const p of plan) {
    byAge[ageBucket(p.row.created_at ?? now, now)]++;
    const cn = p.row.campaign_id != null ? (campaignNames.get(p.row.campaign_id) ?? null) : null;
    byProgram[catchupProgram(p.row, cn)]++;
    const next = p.nextKinds[0]!;
    byNextStep[next] = (byNextStep[next] ?? 0) + 1;
    rows += p.rows.length;
    dayset.add(p.day);
    for (const r of p.rows) {
      first = Math.min(first, r.dueAt);
      last = Math.max(last, r.dueAt);
    }
  }
  return {
    candidates: plan.length,
    rows,
    byAge,
    byProgram,
    byNextStep,
    // Every window is closed by now (the leads wrote days ago): assume each
    // send falls back to a paid template.
    estTemplateSends: rows,
    days: dayset.size,
    firstDueAt: Number.isFinite(first) ? iso(first) : null,
    lastDueAt: Number.isFinite(last) ? iso(last) : null,
    sample: plan.slice(0, 20).map((p) => ({
      phone: p.row.phone,
      name: p.row.name,
      createdAt: iso(p.row.created_at ?? 0),
      lastInboundAt: p.row.last_inbound_at != null ? iso(p.row.last_inbound_at) : null,
      sentKinds: p.sentKinds,
      nextKinds: p.nextKinds,
      firstDueAt: iso(p.rows[0]!.dueAt),
    })),
  };
}

export function emptySkipCounts(): Record<SkipReason, number> {
  return Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;
}

export { extendedChainKinds };
