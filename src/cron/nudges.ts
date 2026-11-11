// Lead-nudge drip. Day-1 (nudge_1h + nudge_8h, in the 24h window → free-form)
// plus the extended multi-day sequence (nudge_d2…d5, + nudge_d7 behind
// features.nudgeDay7) from sequences-v2. Both are armed together by armNudges
// on every bot reply; the extended chain resumes where the last one stopped.
// Which extended steps a lead gets depends on its engagement class (client.mjs
// `nudgePolicy`, ./nudge-policy.ts): chosen at arm time, re-checked at send time.
// Scheduling honors CDMX quiet hours (21:00–08:00): nudge 1 defers out of quiet,
// the closing nudge uses the window-aware placement rule, and the extended chain
// is quiet-shifted (see ./quiet.ts). The old +6h middle step is no longer
// scheduled (B3) but its kind survives for pending rows. gateOnOpenQuestion
// additionally holds any nudge back while the bot's own question is still fresh.
// Copy + program classification live in ./nudge-copy.ts.
//
// Pure math (computeNudgeTimes, computeDayOnePlan, computeExtendedChain,
// underNudgeCap) is unit-tested with fake clocks. armNudges/cancelNudges/
// maybeArmExtended touch the DB.

import type { Contact, Env, ProgramBand, Qualification } from "../types.js";
import {
  cancelFollowups,
  getContact,
  getPendingApprovals,
  kvClaimIfAbsentOrOlder,
  scheduleOrReviveFollowup,
  kvGet,
  kvSet,
  kvSetIfAbsent,
  kvDelete,
  recentMessages,
} from "../db/queries.js";
import { bookingRecordedKey, parseBookingRecordedMarker } from "../services/booking-core.js";
import { bandFromQualification, slotMatchesBand } from "../services/age-band.js";
import { SLOTS, type Slot } from "../brain/slots.gen.js";
import { nextBandSlot, type NextSlot } from "./next-slot.js";
import { ageConflictsWithProgram, hasBuyIntent, isDuplicateSend } from "./nudge-signals.js";
import {
  cancelFollowupsByKinds,
  hasAnyFollowupOfKind,
  hasScheduledFollowupOfKind,
  sentFollowupKinds,
} from "../db/queries-admin.js";
import { CLIENT } from "../client.gen.js";
import { greetingName } from "./display-name.js";
import {
  isTemplateMissingError,
  templateFirstName,
} from "../services/template-params.js";
import { DAY, cdmxDateStr, cdmxIso } from "./time.js";
import { shiftOutOfQuiet, placeNudge3, next8am } from "./quiet.js";
import {
  NUDGE_KINDS,
  SCHEDULED_NUDGE_KINDS,
  EXTENDED_NUDGE_KINDS,
  ALL_EXTENDED_KINDS,
  DAY7_KIND,
  ALL_NUDGE_KINDS,
  nudgeCopy,
  classifyProgram,
  extendedCopy,
  extendedTemplateName,
  isGenericExtendedStep,
  noShowCopy,
  parseQualification,
  programLink,
  slotCta,
  type NudgeKind,
  type ExtendedKind,
  type Program,
} from "./nudge-copy.js";
import { isKidsCampaign, leadDiscipline, weekdaySet, type CtaMode } from "./nudge-copy.js";
import { bandFromAgeMonths } from "../services/age-band.js";
import { conversationFacts, EMPTY_FACTS, type ConvoFacts, type ConvoMessage, type MinuteRange } from "./nudge-context.js";
import { DEFERRAL_HOLD_SECONDS } from "../pipeline/decline.js";
import {
  NUDGE_POLICY,
  SILENT,
  engagementClass,
  nudgeChainFor,
  policyIsUniform,
  remainingAfterSent,
  stepOffsets,
  type LeadEngagement,
  type NudgePolicy,
} from "./nudge-policy.js";
import { engagementByPhone } from "../db/nudge-engagement.js";
import { isDeclined } from "../services/decline-stop.js";

// Re-exported so followups.ts + tests keep a single import surface.
export {
  NUDGE_KINDS,
  SCHEDULED_NUDGE_KINDS,
  EXTENDED_NUDGE_KINDS,
  ALL_EXTENDED_KINDS,
  DAY7_KIND,
  ALL_NUDGE_KINDS,
  nudgeCopy,
  classifyProgram,
  extendedCopy,
  extendedTemplateName,
  isGenericExtendedStep,
  noShowCopy,
  programLink,
  slotCta,
  parseQualification,
};
export type { NudgeKind, ExtendedKind, Program };

// Kinds that mean "this lead already has a class booked" → suppress the drip.
export const BOOKING_KINDS = ["trial_confirm", "day_before", "same_day"] as const;

// Rolling cap: at most 3 day-1 nudges per contact per 7 days. NOT applied to the
// extended chain (each step goes once per 30 days — see EXTENDED_RESUME_WINDOW_SECONDS).
export const NUDGE_CAP = 3;
export const NUDGE_CAP_WINDOW_SECONDS = 7 * 86400;

// An extended step SENT within this window is not re-sent when the chain is
// re-armed: the lead's reply cancels the pending steps and the next arm resumes
// from the first step not yet sent (replaced the 30-day seq_done kv guard,
// which kept the chain from ever re-arming after a reply — 2026-11).
export const EXTENDED_RESUME_WINDOW_SECONDS = 30 * DAY;

const HOUR = 3600;

// Day-1 nudges keep at least this far apart (and two ticks racing the same row
// can never both send): kv `nudge_d1_gap:<phone>` holds the last day-1 send.
export const DAY1_MIN_GAP_SECONDS = 2 * HOUR;

// A draft waiting in Aprobar holds every nudge back this long (re-checked).
export const PENDING_APPROVAL_DEFER_SECONDS = 1 * HOUR;


// ---- program band → copy inputs (pure) ----
//
// nudge-copy.ts only knows three copy programs (adults | kids | baby) and picks
// one from the campaign name, which is how a 4-year-old from the Baby Fight
// Club ad got baby copy + BFC hours, and a baby lead with no qualification got
// the adults pitch (…0442, 2026-10). The AGE band (src/services/age-band.ts) is
// the truth when we have it; these helpers translate a band into the inputs
// nudge-copy expects, without touching that module:
//   baby          → baby copy, Baby Fight Club slots only
//   mini (3–5)    → kids copy ("tu peque" — the baby copy names Baby Fight
//                   Club), Mini Muay Thai slots only, never Kids
//   kids / teens  → kids copy, slots of exactly that group
//   adults        → adults copy, adult slots only

/** The lead's band: stored age/program first, campaign-name guess second. Pure. */
export function bandForContact(
  contact: Contact | null,
  campaignName: string | null = null,
): ProgramBand {
  return bandFromQualification(parseQualification(contact)) ?? classifyProgram(contact, campaignName);
}

/** The copy program a band reads in. Pure. */
export function bandProgram(band: ProgramBand): Program {
  if (band === "baby") return "baby";
  if (band === "adults") return "adults";
  return "kids";
}

/** True for every band whose messages go to a parent (plural copy). */
export function isMinorBand(band: ProgramBand): boolean {
  return band !== "adults";
}

/**
 * The slice of the grid a band may be offered. Mini Muay Thai rows are
 * parent-participation (pp) rows, which next-slot only proposes to an explicit
 * baby pick — stripping the flag here lets them be proposed to exactly the
 * band they belong to, and nobody else ever sees them through this list. Pure.
 */
export function bandSchedule(
  band: ProgramBand,
  schedule: readonly Slot[] = SLOTS,
  ageMonths?: number | null,
): Slot[] {
  const ageKnown = typeof ageMonths === "number" && Number.isFinite(ageMonths);
  return schedule
    .filter((s) => s.trial !== false && slotMatchesBand(s, band, ageMonths))
    .map((s) => {
      // Already filtered by the child's age (Nivel 0 Friday vs Wed / Sat):
      // drop the window so next-slot does not re-hide Nivel 0 as "age unknown".
      if (ageKnown && s.months) {
        const { months: _m, ...rest } = s;
        s = rest;
      }
      if (band !== "mini" || !s.pp) return s;
      const { pp: _pp, ...rest } = s;
      // …and say the program's own name ("Mini Muay Thai"), not "Muay Thai".
      return { ...rest, name: s.name ?? "Mini Muay Thai" };
    });
}

export interface BandCopyInputs {
  contact: Contact | null;
  campaignName: string | null;
  program: Program;
  schedule: Slot[];
}

/**
 * What to hand nudge-copy so it speaks to `band`: a contact whose qualification
 * classifies into the band's copy program, a campaign name that cannot drag it
 * back to another one (a /baby/ campaign for a 6-year-old is dropped — the only
 * cost is the utm tag on that one link), and the band's slice of the grid. Pure.
 */
export function copyInputsForBand(
  contact: Contact | null,
  campaignName: string | null,
  band: ProgramBand,
  schedule: readonly Slot[] = SLOTS,
): BandCopyInputs {
  const q = parseQualification(contact);
  const disc = (q.discipline ?? "").toLowerCase();
  const q2: Qualification = { ...q };
  if (band === "baby") {
    q2.discipline = "baby";
    q2.audience = "kid";
  } else {
    if (band === "mini" || disc.includes("baby")) delete q2.discipline;
    q2.audience = band === "adults" ? "adult" : "kid";
  }
  let campaign = campaignName;
  if (campaign != null && band !== "baby" && /baby/i.test(campaign)) campaign = null;
  if (campaign != null && band === "adults" && isKidsCampaign(campaign)) campaign = null;
  return {
    contact: contact ? { ...contact, qualification: JSON.stringify(q2) } : null,
    campaignName: campaign,
    program: bandProgram(band),
    schedule: bandSchedule(band, schedule, q.child_age_months),
  };
}

/** Conversation constraints on the slot a nudge may propose (nudge-context.ts). */
export interface SlotConstraints {
  facts?: ConvoFacts;
  /** "YYYY-MM-DD HH:mm" already proposed by an earlier nudge (never repeated). */
  proposedKeys?: ReadonlySet<string>;
  /** Default time-of-day when the lead stated none (a morning campaign). */
  defaultTimeRanges?: readonly MinuteRange[] | null;
}

/** ONE concrete, band-correct upcoming slot (soonest-first), or null. Pure. */
export function bandSlot(
  contact: Contact | null,
  campaignName: string | null,
  band: ProgramBand,
  nowEpoch: number,
  schedule: readonly Slot[] = SLOTS,
  constraints: SlotConstraints = {},
): NextSlot | null {
  // The copy program is the LEGACY bucket (mini/teens → kids) and the band
  // schedule keeps each slot's `group`, so the slot must be picked by the real
  // band — through copyInputsForBand a Mini lead asked nextBandSlot for a
  // "kids" row and got nothing (post-merge regression, 2026-10-11).
  const q = parseQualification(contact);
  const discipline =
    band === "baby" ? "baby" : band === "mini" ? "muay" : leadDiscipline(q, campaignName);
  const f = constraints.facts ?? EMPTY_FACTS;
  const excludeWeekdays = weekdaySet(q.declined_days);
  for (const d of f.declinedWeekdays) excludeWeekdays.add(d);
  const preferred = f.preferredWeekdays ?? (q.preferred_days?.length ? [...weekdaySet(q.preferred_days)] : null);
  const onlyWeekdays = preferred ? new Set(preferred.filter((d) => !excludeWeekdays.has(d))) : null;
  const timeRanges = f.timeRanges ?? constraints.defaultTimeRanges ?? null;
  const slot = nextBandSlot(band, discipline, nowEpoch, {
    schedule: bandSchedule(band, schedule, q.child_age_months),
    ...(excludeWeekdays.size ? { excludeWeekdays } : {}),
    ...(onlyWeekdays && onlyWeekdays.size ? { onlyWeekdays } : {}),
    ...(f.excludeDates.length ? { excludeDates: new Set(f.excludeDates) } : {}),
    ...(f.deferUntil !== null ? { notBefore: f.deferUntil } : {}),
    ...(timeRanges ? { timeRanges } : {}),
    ...(constraints.proposedKeys?.size ? { excludeKeys: constraints.proposedKeys } : {}),
    // An adult who CHOSE a discipline is never offered another one instead.
    ...(band === "adults" && f.discipline ? { strictDiscipline: true } : {}),
  });
  return slot;
}

// ---- conversation-aware plan (2026-11-11 quality review) ----

/** Morning-promo campaigns: nothing after noon unless the lead says otherwise. */
const MORNING_CAMPAIGN_RE = /matutin|ma[ñn]anas?\b|morning|temprano/i;
export function campaignTimeRanges(campaignName: string | null | undefined): MinuteRange[] | null {
  return campaignName && MORNING_CAMPAIGN_RE.test(campaignName) ? [[0, 12 * 60]] : null;
}

/**
 * The lead's band with the conversation in it. A stated child age wins (it is
 * what the routing trusts); without one, "Adultos" / "para mí" (after any
 * child signal) is an adult whatever the campaign said (A261, A31, A265), a
 * teenager is Teens (B79), then the stored qualification, then the campaign
 * (a Teens ad is Teens, B68). Pure.
 */
export function bandForConversation(
  contact: Contact | null,
  campaignName: string | null,
  facts: ConvoFacts,
): ProgramBand {
  const q = parseQualification(contact);
  if (typeof q.child_age_months === "number" && Number.isFinite(q.child_age_months)) {
    return bandFromAgeMonths(q.child_age_months);
  }
  if (facts.adultSelf) return "adults";
  const fromQ = bandFromQualification(q);
  if (facts.teen && (fromQ === null || fromQ === "kids")) return "teens";
  return fromQ ?? classifyProgram(contact, campaignName);
}

export interface NudgeCopyPlan extends BandCopyInputs {
  band: ProgramBand;
  facts: ConvoFacts;
  slot: NextSlot | null;
  cta: CtaMode;
}

/**
 * Everything a nudge needs to speak to THIS conversation: band, the lead's
 * chosen discipline (beats the campaign default and the ad stamp), and ONE
 * slot that respects declined/preferred days, dates ruled out, a defer date,
 * a time-of-day window, and slots an earlier nudge already proposed — or a
 * different close: ask the age (minor, age unknown), keep our own offer (the
 * bot just proposed a time), or the link (nothing fits). Pure.
 */
export function planNudgeCopy(
  contact: Contact | null,
  campaignName: string | null,
  msgs: readonly ConvoMessage[],
  now: number,
  opts: { proposedKeys?: ReadonlySet<string>; schedule?: readonly Slot[]; noSlot?: boolean } = {},
): NudgeCopyPlan {
  const schedule = opts.schedule ?? SLOTS;
  const facts = conversationFacts(msgs, now);
  const band = bandForConversation(contact, campaignName, facts);
  const c = copyInputsForBand(contact, campaignName, band, schedule);
  let cContact = c.contact;
  if (cContact && facts.discipline && band !== "baby" && band !== "mini") {
    const q2 = parseQualification(cContact);
    q2.discipline = facts.discipline;
    cContact = { ...cContact, qualification: JSON.stringify(q2) };
  }
  const ageKnown = typeof parseQualification(contact).child_age_months === "number";
  let cta: CtaMode = "slot";
  if (opts.noSlot) cta = "link";
  else if ((band === "baby" || band === "kids") && !ageKnown) cta = "ask_age";
  else if (facts.botOfferedSlot) cta = "keep_offer";
  let slot: NextSlot | null = null;
  if (cta === "slot") {
    slot = bandSlot(cContact, c.campaignName, band, now, schedule, {
      facts,
      ...(opts.proposedKeys ? { proposedKeys: opts.proposedKeys } : {}),
      defaultTimeRanges: campaignTimeRanges(campaignName),
    });
    if (!slot) cta = "link";
  }
  return { ...c, contact: cContact, band, facts, slot, cta };
}

/** What a due nudge does about a deferral in the conversation. */
export type DeferralVerdict = { act: "send" } | { act: "cancel" } | { act: "defer"; until: number };

/** A deferral further out than this is not waited for: the chase just stops. */
export const MAX_DEFER_WAIT_SECONDS = 21 * DAY;

/**
 * Pure. Day-1 nudges never go out over a deferral ("la próxima semana",
 * "estoy de viaje", "les aviso"). Extended steps: after a SOFT deferral only
 * the chain's last step (the goodbye) is left, no sooner than
 * DEFERRAL_HOLD_SECONDS after it; after a dated deferral the step waits until
 * that date (10:00 CDMX), or is dropped when the date is > 21 days out.
 */
export function deferralVerdict(
  facts: ConvoFacts,
  step: { day1: boolean; isFinal: boolean },
  now: number,
): DeferralVerdict {
  const soft = facts.softDeferral;
  const until = facts.deferUntil;
  if (!soft && until === null) return { act: "send" };
  if (step.day1) return { act: "cancel" };
  if (soft) {
    if (!step.isFinal) return { act: "cancel" };
    const at = soft.ts + DEFERRAL_HOLD_SECONDS;
    if (now < at) return { act: "defer", until: shiftOutOfQuiet(at) };
  }
  if (until !== null && until > now) {
    if (until - now > MAX_DEFER_WAIT_SECONDS) return { act: "cancel" };
    return { act: "defer", until: shiftOutOfQuiet(until + 10 * HOUR) };
  }
  return { act: "send" };
}

/**
 * Pure. Arm-time twin of deferralVerdict: null ⇒ arm normally. Otherwise no
 * day-1 rows; `goodbyeAt` is when the single goodbye goes (soft deferral), or
 * null with `anchor` set ⇒ re-anchor the normal chain (dated deferral), or
 * both null ⇒ arm nothing (deferred > 21 days).
 */
export function armHold(
  facts: ConvoFacts,
  now: number,
): { goodbyeAt: number | null; anchor: number | null } | null {
  if (facts.softDeferral) {
    return { goodbyeAt: Math.max(now, facts.softDeferral.ts + DEFERRAL_HOLD_SECONDS), anchor: null };
  }
  if (facts.deferUntil !== null && facts.deferUntil > now) {
    if (facts.deferUntil - now > MAX_DEFER_WAIT_SECONDS) return { goodbyeAt: null, anchor: null };
    // First extended step lands one gap (24h) after the anchor = the defer date, 10:00.
    return { goodbyeAt: null, anchor: facts.deferUntil + 10 * HOUR - DAY };
  }
  return null;
}

/** Pure. Is `kind` the last step of the lead's chain (the goodbye)? */
export function isFinalStep(kind: ExtendedKind, chain: readonly ExtendedKind[]): boolean {
  return chain.length > 0 && chain[chain.length - 1] === kind;
}

// ---- proposed-slot memory (kv, one PK read per send) ----

/** kv `nudge_slots:<phone>`: the slots our nudges proposed, for 48h. */
export function proposedSlotsKey(phone: string): string {
  return `nudge_slots:${phone}`;
}
export const PROPOSED_SLOT_MEMORY_SECONDS = 48 * HOUR;

/** Pure. The keys still remembered at `now`. */
export function parseProposedSlots(raw: string | null, now: number): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  try {
    const list = JSON.parse(raw) as { k?: unknown; ts?: unknown }[];
    for (const e of Array.isArray(list) ? list : []) {
      if (typeof e.k === "string" && typeof e.ts === "number" && now - e.ts < PROPOSED_SLOT_MEMORY_SECONDS) out.add(e.k);
    }
  } catch {
    // corrupt → nothing remembered
  }
  return out;
}

/** Pure. The kv value after proposing `slot` at `now`. */
export function recordProposedSlot(raw: string | null, slot: NextSlot, now: number): string {
  let list: { k: string; ts: number }[] = [];
  try {
    const parsed = raw ? (JSON.parse(raw) as { k: string; ts: number }[]) : [];
    if (Array.isArray(parsed)) list = parsed.filter((e) => typeof e?.k === "string" && typeof e?.ts === "number");
  } catch {
    list = [];
  }
  list = list.filter((e) => now - e.ts < PROPOSED_SLOT_MEMORY_SECONDS);
  list.push({ k: `${slot.date} ${slot.time}`, ts: now });
  return JSON.stringify(list.slice(-6));
}

// ---- booking marker / one-nudge-a-day guards (pure) ----

/**
 * True while a `booking_recorded:<phone>` marker points at a class that has not
 * started yet — the lead is booked, so no drip may be armed or sent (…6197 got
 * a nudge one hour before the class it had booked). A legacy marker without a
 * slot counts for 72h after it was written. Pure.
 */
export function bookingMarkerLive(raw: string | null, now: number): boolean {
  const m = parseBookingRecordedMarker(raw);
  if (!m) return false;
  if (m.trialDate && m.trialTime) {
    const at = Math.floor(Date.parse(cdmxIso(m.trialDate, m.trialTime)) / 1000);
    if (Number.isFinite(at)) return at > now;
  }
  return now - m.ts < 72 * HOUR;
}

/**
 * Every followup kind that only exists because this phone BOOKED a trial at
 * some point: the anti-no-show reminders, the no-show chain, the attended
 * chain and its card (src/cron/post-trial.ts POST_TRIAL_ALL_KINDS — listed
 * literally here because post-trial imports this module). A row of any of
 * these, in ANY status, means "todavía no has agendado" is false.
 */
export const PAST_BOOKING_KINDS = [
  "trial_confirm",
  "day_before",
  "same_day",
  "attendance_check",
  "no_show_1",
  "no_show_d3",
  "no_show_hoy",
  "no_show_d2",
  "no_show_d7",
  "post_trial_d0",
  "post_trial_d2",
  "post_trial_d3",
  "post_trial_d5",
  "post_trial_d6",
  "post_trial_card",
] as const;

/**
 * How far back a booking still silences the "todavía no has agendado" drips.
 * Past it, a lead who booked (or no-showed) long ago and comes back through a
 * new ad is a fresh lead again and gets the normal nudges.
 */
export const BOOKING_HISTORY_WINDOW_SECONDS = 60 * 86400;

/**
 * Pure. Booking history from the local signals: a `booking_recorded` marker
 * younger than BOOKING_HISTORY_WINDOW_SECONDS (a past class counts too —
 * leads whose trial date had passed, or who had attended, kept getting
 * "todavía no has agendado", audit 2026-10), or a recent booking-kind
 * followup row (`hasBookingRow`, already windowed by the query).
 */
export function hasBookingHistory(
  markerRaw: string | null,
  hasBookingRow: boolean,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  if (hasBookingRow) return true;
  const m = parseBookingRecordedMarker(markerRaw);
  return m !== null && now - m.ts < BOOKING_HISTORY_WINDOW_SECONDS;
}

/**
 * DB side of hasBookingHistory: one kv read + one indexed followups probe
 * (UNIQUE(phone, kind, …) autoindex). The followups probe fails SOFT — a
 * lookup error falls back to the marker alone, never blocks the drip outright.
 */
async function bookedBefore(env: Env, phone: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  let row = false;
  try {
    row = await hasAnyFollowupOfKind(
      env.DB,
      phone,
      PAST_BOOKING_KINDS,
      now - BOOKING_HISTORY_WINDOW_SECONDS,
    );
  } catch (err) {
    console.warn(`[nudges] booking-history lookup failed for ${phone}: ${String(err)}`);
  }
  return hasBookingHistory(await kvGet(env.DB, bookingRecordedKey(phone)), row, now);
}

/**
 * kv claim: at most ONE extended nudge (d2…d7) per phone per CDMX day. Day-1
 * kinds do not take it — they are ≥2h apart by construction and capped, and
 * taking it made nudge_8h lose to nudge_1h every normal day, so the chain that
 * hung off nudge_8h never armed (2026-10-28: 35% of non-booked leads got 0
 * follow-ups). A lost claim defers the row to the next 08:00, never cancels it.
 */
export function nudgeDayClaimKey(phone: string, now: number): string {
  return `nudge_day:${phone}:${cdmxDateStr(now)}`;
}

/** kv timestamp claim spacing day-1 sends by DAY1_MIN_GAP_SECONDS. */
export function day1GapKey(phone: string): string {
  return `nudge_d1_gap:${phone}`;
}

/** A due nudge that must wait: the row is rescheduled to `retryAt`, not cancelled. */
export interface NudgeDeferred {
  outcome: "deferred";
  retryAt: number;
}

/** When a nudge held back by a pending Aprobar draft comes back. Pure. */
export function pendingApprovalRetryAt(now: number): number {
  return shiftOutOfQuiet(now + PENDING_APPROVAL_DEFER_SECONDS);
}

/** True while the phone has a draft waiting in Aprobar (indexed on phone). */
async function hasPendingApproval(env: Env, phone: string): Promise<boolean> {
  return (await getPendingApprovals(env.DB, phone)).length > 0;
}

// ---- day-1 scheduling (pure) ----

export interface NudgeTime {
  kind: NudgeKind;
  dueAt: number; // epoch seconds
}

/**
 * The natural nudge send times relative to the lead's last inbound epoch: +1h
 * and +8h (before any quiet-hour shifting). The +6h middle step was dropped in
 * B3 — see SCHEDULED_NUDGE_KINDS. Pure.
 */
export function computeNudgeTimes(lastInboundEpoch: number): NudgeTime[] {
  return [
    { kind: "nudge_1h", dueAt: lastInboundEpoch + 1 * HOUR },
    { kind: "nudge_8h", dueAt: lastInboundEpoch + 8 * HOUR },
  ];
}

// ---- open-question guard (pure) ----

/** A bot question younger than this blocks a nudge from stomping it. */
export const OPEN_QUESTION_GUARD_SECONDS = 2 * HOUR;

/** The last thing the BOT said to this lead (body + epoch seconds). */
export interface LastBotMessage {
  body: string;
  ts: number;
}

/** Send now, or come back at `retryAt` (the row is rescheduled, never cancelled). */
export type NudgeGate = { send: true } | { send: false; retryAt: number };

/** Trailing whitespace, variation selectors, ZWJ and emoji — ignored by the "?" test. */
const TRAILING_DECOR = /[\s\u200d\ufe0f\p{Extended_Pictographic}]+$/u;

/**
 * True when the body reads as a QUESTION to the lead: its last meaningful
 * character is "?" once trailing emoji/whitespace are stripped ("¿Te late? 🙂").
 */
export function endsWithQuestion(body: string): boolean {
  return body.replace(TRAILING_DECOR, "").endsWith("?");
}

/**
 * Never stomp our own open question. The first day-1 nudge used to fire ~60 min
 * after the BOT's own unanswered question, which reads as nagging; when the last
 * outbound is a bot question less than 2h old the nudge is deferred (rescheduled
 * to the moment the guard lifts), not cancelled. Pure over (last, now).
 */
export function gateOnOpenQuestion(
  last: LastBotMessage | null,
  now: number,
): NudgeGate {
  if (!last || !endsWithQuestion(last.body)) return { send: true };
  const until = last.ts + OPEN_QUESTION_GUARD_SECONDS;
  return now >= until ? { send: true } : { send: false, retryAt: until };
}

/** A staff message younger than this holds every automatic nudge back. */
export const STAFF_REPLY_GUARD_SECONDS = 1 * HOUR;

/**
 * Never talk over a human. A staff reply (dashboard `out_human` or WhatsApp-app
 * echo `out_human_echo`) less than 60 min old defers the nudge to the moment
 * the guard lifts — the human override does not always cover it (it can be
 * lifted while staff is still in the chat; audit 2026-10). Pure.
 */
export function gateOnStaffReply(lastStaffTs: number | null, now: number): NudgeGate {
  if (lastStaffTs === null) return { send: true };
  const until = lastStaffTs + STAFF_REPLY_GUARD_SECONDS;
  return now >= until ? { send: true } : { send: false, retryAt: until };
}

/** Both guards together: the LATER retry wins. Pure. */
export function gateNudge(
  lastBot: LastBotMessage | null,
  lastStaffTs: number | null,
  now: number,
): NudgeGate {
  const a = gateOnOpenQuestion(lastBot, now);
  const b = gateOnStaffReply(lastStaffTs, now);
  if (a.send && b.send) return { send: true };
  const retryAt = Math.max(a.send ? 0 : a.retryAt, b.send ? 0 : b.retryAt);
  return { send: false, retryAt };
}

export interface DayOnePlan {
  /** Nudges to insert (kind + quiet-adjusted dueAt), in order, all future. */
  scheduled: NudgeTime[];
  /** True when nudge 3 was dropped (R2) → the extended day-2 message covers it. */
  nudge3Dropped: boolean;
  /**
   * Anchor for the extended chain: the quiet-shifted natural +8h time, whether
   * or not nudge_8h is placed (the chain is armed with the day-1 plan, never off
   * nudge_8h's send — that hook rarely fired, 2026-10-28).
   */
  extendedAnchor: number;
}

/**
 * Quiet-aware day-1 schedule (R1 + R2, cadence trimmed in B3). Given the lead's
 * last-inbound `base` and the current `now`:
 *  - nudge 1 (+1h) defers out of quiet to the next 08:00 and drops if pushed
 *    past the 24h window;
 *  - the old middle step (+6h) is no longer scheduled at all;
 *  - the closing nudge (+8h) uses placeNudge3 (keep / pull-to-21:30 /
 *    defer-08:00 / drop), still ≥2h after nudge 1.
 * Times already in the past (≤ now) are omitted. Pure over (base, now).
 */
export function computeDayOnePlan(base: number, now: number): DayOnePlan {
  const windowEnd = base + 24 * HOUR;
  const scheduled: NudgeTime[] = [];
  let prev = -Infinity;

  const place = (kind: NudgeKind, natural: number): void => {
    let s = shiftOutOfQuiet(natural);
    // Enforce ≥2h after the previous placed nudge (re-shift if the bump lands
    // back in quiet hours).
    if (Number.isFinite(prev) && s < prev + 2 * HOUR) {
      s = shiftOutOfQuiet(prev + 2 * HOUR);
    }
    if (s >= windowEnd) return; // beyond the window → drop
    prev = s;
    if (s > now) scheduled.push({ kind, dueAt: s });
  };

  place("nudge_1h", base + 1 * HOUR);

  // ≥2h guard reference for the closing nudge: the placed nudge 1, else its
  // shifted natural time (covers the case where it was pushed past now).
  const nudge2Time =
    scheduled.find((p) => p.kind === "nudge_1h")?.dueAt ??
    shiftOutOfQuiet(base + 1 * HOUR);

  const natural3 = base + 8 * HOUR;
  const extendedAnchor = shiftOutOfQuiet(natural3);
  const p3 = placeNudge3(natural3, nudge2Time, windowEnd, now);
  if ("dueAt" in p3) {
    scheduled.push({ kind: "nudge_8h", dueAt: p3.dueAt });
    return { scheduled, nudge3Dropped: false, extendedAnchor };
  }
  // Dropped → the day-2 message takes over.
  return { scheduled, nudge3Dropped: true, extendedAnchor };
}

/**
 * Day-1 row token: `d1:<base>`, base = the last_inbound_at the plan hangs off.
 * Two arms off the SAME inbound still dedupe under UNIQUE(phone, kind, record);
 * a new inbound gets fresh rows. With the old '' token the first cancelled or
 * sent row blocked every later insert of that kind for the phone, so a lead who
 * replied before +1h never got a day-1 nudge again (2026-10-28). Pure.
 */
export function dayOneToken(base: number): string {
  return `d1:${base}`;
}

// ---- extended scheduling (pure) ----

export interface ExtendedTime {
  kind: ExtendedKind;
  dueAt: number;
}

/** The extended steps in send order: d2–d5, plus d7 when `day7` is on. Pure. */
export function extendedChainKinds(day7: boolean): ExtendedKind[] {
  return day7 ? [...ALL_EXTENDED_KINDS] : [...EXTENDED_NUDGE_KINDS];
}

/** Gap before a step, measured from the previous one: d7 waits 48h, the rest 24h. Pure. */
export function extendedGap(kind: ExtendedKind): number {
  return kind === DAY7_KIND ? 48 * HOUR : 24 * HOUR;
}

/**
 * The extended chain relative to its anchor. `kinds` is the subset still to
 * send (in chain order; the engagement policy may leave gaps): the first step
 * lands one gap after the anchor (d7 48h, the rest 24h), every later step on
 * its own day number relative to the first (nudge-policy stepOffsets) — so a
 * fresh chain is absolute from the anchor (dN = anchor + (N−1) days, exactly
 * the old +24h-each times for the full chain) and a skipped day stays empty.
 * Each time is quiet-shifted to the next 08:00, and kept strictly after the
 * previous step. Pure.
 */
export function computeExtendedChain(
  anchorSend: number,
  kinds: readonly ExtendedKind[] = EXTENDED_NUDGE_KINDS,
): ExtendedTime[] {
  const ordered = [...kinds].sort(
    (a, b) => ALL_EXTENDED_KINDS.indexOf(a) - ALL_EXTENDED_KINDS.indexOf(b),
  );
  const offsets = stepOffsets(ordered);
  const out: ExtendedTime[] = [];
  let prev = -Infinity;
  ordered.forEach((kind, i) => {
    let t = shiftOutOfQuiet(anchorSend + offsets[i]!);
    if (t <= prev) t = shiftOutOfQuiet(prev + 24 * HOUR);
    prev = t;
    out.push({ kind, dueAt: t });
  });
  return out;
}

/**
 * The chain steps not yet sent (resume semantics), in order — only steps AFTER
 * the latest one already sent, so the goodbye stays last (nudge-policy
 * remainingAfterSent). Pure.
 */
export function remainingExtendedKinds(
  chain: readonly ExtendedKind[],
  sent: readonly string[],
): ExtendedKind[] {
  return remainingAfterSent(chain, sent);
}

// ---- rolling cap (pure) ----

interface NudgeCountKv {
  sends: number[]; // epoch seconds of recent nudge sends
}

function parseNudgeKv(json: string | null): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Partial<NudgeCountKv>;
    if (Array.isArray(parsed.sends)) {
      return parsed.sends.filter((n): n is number => typeof n === "number");
    }
  } catch {
    // corrupt kv → treat as empty
  }
  return [];
}

function sendsInWindow(sends: number[], now: number): number[] {
  const cutoff = now - NUDGE_CAP_WINDOW_SECONDS;
  return sends.filter((t) => t > cutoff);
}

/** True if the contact is still under the day-1 nudge cap. Pure. */
export function underNudgeCap(kvJson: string | null, now: number): boolean {
  return sendsInWindow(parseNudgeKv(kvJson), now).length < NUDGE_CAP;
}

/** Record a nudge send in the rolling-cap kv; returns the JSON to persist. */
export function recordNudgeSend(kvJson: string | null, now: number): string {
  const sends = sendsInWindow(parseNudgeKv(kvJson), now);
  sends.push(now);
  return JSON.stringify({ sends } satisfies NudgeCountKv);
}

function nudgeCountKey(phone: string): string {
  return `nudge_count:${phone}`;
}

// ---- arming / cancelling (DB) ----

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Whether the drip may be armed for this contact now: status lead, no active
 * override, never booked (no active/future booking AND no past one — see
 * bookedBefore), not declined (kv `declined:<phone>`). The rolling cap is checked separately: it gates the day-1
 * kinds only, never the extended chain.
 */
async function canArm(env: Env, contact: Contact): Promise<boolean> {
  if (!CLIENT.features.nudges) return false;
  if (contact.status !== "lead") return false;
  const now = nowSec();
  if (contact.human_override_until && contact.human_override_until > now) {
    return false;
  }
  const hasBooking = await hasScheduledFollowupOfKind(
    env.DB,
    contact.phone,
    BOOKING_KINDS,
  );
  if (hasBooking) return false;
  if (await bookedBefore(env, contact.phone)) return false;
  // The lead declined / objected (src/pipeline/decline.ts): we answer, we
  // never chase. Only a booking, expressed interest or a staff reset lifts it.
  if (await isDeclined(env.DB, contact.phone)) return false;
  return true;
}

/**
 * Arm (or re-arm) the lead-nudge drip after a bot reply was SENT to a lead.
 * Clears every pending nudge row (day-1 + extended), then inserts the
 * quiet-aware day-1 schedule (computeDayOnePlan, under the rolling cap) AND the
 * extended chain anchored on the plan's quiet-shifted +8h time — resumed from
 * the first step not yet sent (maybeArmExtended). No-op when conditions aren't met.
 */
export async function armNudges(env: Env, phone: string): Promise<void> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return;

  // Always clear pending nudges first (re-arm / suppression). The extended
  // rows go too: the re-arm below reschedules the remaining steps off the new
  // anchor, so a second arm never leaves two chains running.
  await cancelFollowupsByKinds(env.DB, phone, ALL_NUDGE_KINDS);

  if (!(await canArm(env, contact))) return;

  const now = nowSec();
  const base = contact.last_inbound_at ?? now;
  const plan = computeDayOnePlan(base, now);

  // The lead deferred (nudge-context.ts): no day-1 nudges at all. A soft
  // deferral ("más adelante", "les aviso", "estoy de viaje") leaves only the
  // chain's goodbye, ≥ 7 days out; a dated one ("la próxima semana", "regreso
  // el 20") re-anchors the chain on that date, or arms nothing past 21 days.
  // One indexed read (idx_messages_phone_ts); a failure arms as before.
  let facts: ConvoFacts = EMPTY_FACTS;
  try {
    const recent = await recentMessages(env.DB, phone, 30, now - 7 * DAY);
    facts = conversationFacts(recent.map((m) => ({ direction: m.direction, body: m.body, ts: m.ts })), now);
  } catch (err) {
    console.warn(`[nudges] conversation read failed for ${phone}: ${String(err)}`);
  }
  const hold = armHold(facts, now);
  if (hold) {
    if (hold.goodbyeAt !== null) {
      await maybeArmExtended(env, phone, hold.goodbyeAt, undefined, undefined, { goodbyeOnly: true });
    } else if (hold.anchor !== null) {
      await maybeArmExtended(env, phone, Math.max(hold.anchor, now));
    }
    return;
  }

  if (underNudgeCap(await kvGet(env.DB, nudgeCountKey(phone)), now)) {
    const token = dayOneToken(base);
    for (const t of plan.scheduled) {
      await scheduleOrReviveFollowup(env.DB, {
        phone,
        kind: t.kind,
        dueAt: t.dueAt,
        airtableRecordId: token,
        note: null,
      });
    }
  }
  // A stale base (an old draft approved late) must not land the chain in the past.
  await maybeArmExtended(env, phone, Math.max(plan.extendedAnchor, now));
}

/**
 * The lead's engagement for the drip policy (one indexed statement). Fails
 * SOFT to SILENT, the conservative class (fewer paid templates).
 */
export async function lookupEngagement(env: Env, phone: string): Promise<LeadEngagement> {
  try {
    return (await engagementByPhone(env.DB, [phone])).get(phone) ?? SILENT;
  } catch (err) {
    console.warn(`[nudges] engagement lookup failed for ${phone}: ${String(err)} — treated as silent`);
    return SILENT;
  }
}

/**
 * Schedule the extended chain anchored at `anchorSend`: the steps the lead's
 * engagement class gets under `policy` (client.mjs `nudgePolicy`, see
 * ./nudge-policy.ts; d7 only with `features.nudgeDay7`), RESUMING: a step
 * already sent in the last 30 days is not scheduled again, nor anything before
 * it; the remaining ones follow the anchor (first +24h, d7-first +48h, later
 * steps on their own day number, quiet-shifted). Rows carry the token
 * `seq:<anchor>` so the followups UNIQUE index never blocks a re-arm. A failed
 * history lookup arms nothing — re-sending d2 to someone who already got it is
 * worse than one missed arm. A failed engagement lookup arms the silent list.
 */
export async function maybeArmExtended(
  env: Env,
  phone: string,
  anchorSend: number,
  day7: boolean = CLIENT.features.nudgeDay7 === true,
  policy: NudgePolicy = NUDGE_POLICY,
  /** goodbyeOnly: schedule ONLY the chain's last remaining step, AT `anchorSend`
   *  (soft deferral — armHold). */
  mode: { goodbyeOnly?: boolean } = {},
): Promise<void> {
  if (!CLIENT.features.nudges) return;
  const now = nowSec();
  const engagement = policyIsUniform(policy) ? SILENT : await lookupEngagement(env, phone);
  const chain = nudgeChainFor(policy, engagement, now, day7);
  if (chain.length === 0) return;
  let sent: string[];
  try {
    // Every extended kind, not only this class's list: a d3 sent under the old
    // daily chain still counts for "nothing before the latest sent step".
    sent = await sentFollowupKinds(env.DB, phone, extendedChainKinds(true), now - EXTENDED_RESUME_WINDOW_SECONDS);
  } catch (err) {
    console.warn(`[nudges] extended resume lookup failed for ${phone}: ${String(err)}`);
    return;
  }
  const token = `seq:${anchorSend}`;
  const remaining = remainingExtendedKinds(chain, sent);
  if (mode.goodbyeOnly) {
    const last = remaining[remaining.length - 1];
    if (!last) return;
    await scheduleOrReviveFollowup(env.DB, {
      phone,
      kind: last,
      dueAt: shiftOutOfQuiet(anchorSend),
      airtableRecordId: `defer:${anchorSend}`,
      note: null,
    });
    return;
  }
  for (const t of computeExtendedChain(anchorSend, remaining)) {
    await scheduleOrReviveFollowup(env.DB, {
      phone,
      kind: t.kind,
      dueAt: t.dueAt,
      airtableRecordId: token,
      note: null,
    });
  }
}

/** Cancel all pending nudge rows (day-1 + extended) for a phone. */
export async function cancelNudges(
  env: Env,
  phone: string,
  status: string = "cancelled",
): Promise<void> {
  await cancelFollowupsByKinds(env.DB, phone, ALL_NUDGE_KINDS, status);
}

/**
 * Send-time processing for a due DAY-1 nudge. Re-verifies eligibility (lead / not
 * opted / not overridden / no booking / under cap), sends the free-form nudge,
 * and records the send in the rolling cap. A closed window → cancel (no template
 * for day-1 nudges; they are in-window by construction). A pending Aprobar
 * draft or a day-1 send < 2h ago → `deferred` (the caller reschedules the row).
 */
export async function processNudge(
  env: Env,
  phone: string,
  kind: NudgeKind,
  deps: {
    sendText: (env: Env, phone: string, body: string) => Promise<string>;
    isWindowClosed: (err: unknown) => boolean;
    /** Optional so existing callers/tests keep working; without it a
     *  campaign-only lead falls back to the adults copy (the old behavior). */
    campaignName?: (env: Env, campaignId: number) => Promise<string | null>;
    /** Called when the nudge is dropped because the lead wants to pay/enrol. */
    onBuyIntent?: (env: Env, phone: string) => Promise<void>;
  },
): Promise<"sent" | "cancelled" | "skipped_optout" | NudgeDeferred> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return "cancelled";
  if (contact.status === "opted_out") return "skipped_optout";
  if (contact.status !== "lead") return "cancelled";

  const now = nowSec();
  if (contact.human_override_until && contact.human_override_until > now) {
    return "cancelled";
  }
  if (await hasScheduledFollowupOfKind(env.DB, phone, BOOKING_KINDS)) {
    return "cancelled";
  }
  // Booked at any point (a passed trial, an attended one): "todavía no has
  // agendado" would be false.
  if (await bookedBefore(env, phone)) {
    return "cancelled";
  }
  // A draft for this lead is waiting in Aprobar: a nudge now would talk over
  // the reply staff is about to approve. Wait, don't cancel.
  if (await hasPendingApproval(env, phone)) {
    return { outcome: "deferred", retryAt: pendingApprovalRetryAt(now) };
  }
  const kvKey = nudgeCountKey(phone);
  const kv = await kvGet(env.DB, kvKey);
  if (!underNudgeCap(kv, now)) return "cancelled";

  const campaignName =
    contact.campaign_id !== null && deps.campaignName
      ? await deps.campaignName(env, contact.campaign_id)
      : null;

  // Send-time signals from the lead's own words (src/cron/nudge-signals.ts).
  const recent = await recentMessages(env.DB, phone, 30, now - 7 * DAY);
  const inbound = recent.filter((m) => m.direction === "in").map((m) => m.body ?? "");
  if (hasBuyIntent(inbound)) {
    // Wants to pay / enrol: a class push is the wrong message. Hand to a human.
    await deps.onBuyIntent?.(env, phone);
    return "cancelled";
  }
  // Copy by AGE band (mini/teens included) and by what the lead SAID
  // (discipline, adult/teen, days, time of day, deferrals — nudge-context.ts);
  // the campaign name is only the last fallback.
  const convo = recent.map((m) => ({ direction: m.direction, body: m.body, ts: m.ts }));
  const slotsKey = proposedSlotsKey(phone);
  const slotsRaw = await kvGet(env.DB, slotsKey);
  const pre = planNudgeCopy(contact, campaignName, convo, now, { proposedKeys: parseProposedSlots(slotsRaw, now) });
  // The lead deferred ("la próxima semana", "estoy de viaje", "les aviso"):
  // a day-1 nudge would read as spam (A271: 4 minutes after "salgo de viaje").
  if (deferralVerdict(pre.facts, { day1: true, isFinal: false }, now).act !== "send") return "cancelled";
  const c = ageConflictsWithProgram(pre.program, inbound) ? { ...pre, slot: null, cta: "link" as const } : pre;
  const body = nudgeCopy(c.contact, kind, c.campaignName, now, c.schedule, { slot: c.slot, cta: c.cta });
  const outbound = recent.filter((m) => m.direction !== "in").map((m) => ({ body: m.body ?? "", ts: m.ts }));
  if (isDuplicateSend(body, outbound, now)) return "cancelled";

  // Claim BEFORE sending, but NOT the one-per-day extended claim (that made
  // nudge_8h lose to nudge_1h every day). A 2h timestamp claim instead: two
  // ticks (or two rows) racing in the same minute can never both send
  // (…3373, …5417), and the loser is deferred to the end of the gap.
  const gapKey = day1GapKey(phone);
  if (!(await kvClaimIfAbsentOrOlder(env.DB, gapKey, now, DAY1_MIN_GAP_SECONDS))) {
    const held = Number(await kvGet(env.DB, gapKey));
    const from = Number.isFinite(held) && held > 0 ? held : now;
    return { outcome: "deferred", retryAt: shiftOutOfQuiet(Math.max(from + DAY1_MIN_GAP_SECONDS, now + 60)) };
  }
  try {
    await deps.sendText(env, phone, body);
  } catch (err) {
    await kvDelete(env.DB, gapKey); // nothing went out — free the gap again
    if (deps.isWindowClosed(err)) return "cancelled";
    throw err;
  }
  await kvSet(env.DB, kvKey, recordNudgeSend(kv, now));
  // Remember the slot so the next nudge proposes a different one (nudge_8h
  // repeated nudge_1h's slot in ~105 conversations).
  if (c.slot) await kvSet(env.DB, slotsKey, recordProposedSlot(slotsRaw, c.slot, now));
  return "sent";
}

/**
 * Send-time processing for a due EXTENDED nudge (d2–d5, d7). Re-verifies
 * eligibility (NO cap check — the extended chain is not capped). Tries free-form
 * first (CTWA 72h windows make this common); on a closed window falls back to
 * the per-program template. When the template is missing/unapproved the caller
 * is told to skip so it can post the throttled Slack note. A pending Aprobar
 * draft (+60 min) or a lost one-per-day claim (next 08:00) → `deferred`.
 */
export async function processExtendedNudge(
  env: Env,
  phone: string,
  kind: ExtendedKind,
  deps: {
    sendText: (env: Env, phone: string, body: string) => Promise<string>;
    sendTemplate: (
      env: Env,
      phone: string,
      name: string,
      lang: string,
      components?: unknown[],
    ) => Promise<string>;
    templateName: (base: string, lang: string) => string;
    isWindowClosed: (err: unknown) => boolean;
    campaignName: (env: Env, campaignId: number) => Promise<string | null>;
    /** Engagement for the policy re-check: the cron passes its per-tick batch;
     *  absent ⇒ one indexed lookup (lookupEngagement). */
    engagement?: (phone: string) => Promise<LeadEngagement>;
    /** Drip policy; absent ⇒ the shipped client.mjs `nudgePolicy`. */
    policy?: NudgePolicy;
  },
): Promise<
  | { outcome: "sent" }
  | { outcome: "cancelled" }
  | { outcome: "skipped_optout" }
  /** The lead's CURRENT engagement class no longer includes this step
   *  (nudge-policy). The caller closes the row quietly and counts it. */
  | { outcome: "policy_skip"; engagement: "engaged" | "silent" }
  | NudgeDeferred
  /** The template send failed. `missing` ⇒ it is not approved yet (132001),
   *  which is Evan's to fix; anything else is OURS, so `error` carries the
   *  Graph text verbatim into the Slack note instead of being laundered. */
  | { outcome: "template_missing"; template: string; missing: boolean; error: string }
> {
  const contact = await getContact(env.DB, phone);
  if (!contact) return { outcome: "cancelled" };
  if (contact.status === "opted_out") return { outcome: "skipped_optout" };
  if (contact.status !== "lead") return { outcome: "cancelled" };
  const now = nowSec();
  if (contact.human_override_until && contact.human_override_until > now) {
    return { outcome: "cancelled" };
  }
  if (await hasScheduledFollowupOfKind(env.DB, phone, BOOKING_KINDS)) {
    return { outcome: "cancelled" };
  }
  if (await bookedBefore(env, phone)) {
    return { outcome: "cancelled" };
  }
  // A d7 row armed while the flag was on, after it was switched off: drop it.
  const day7 = CLIENT.features.nudgeDay7 === true;
  if (kind === DAY7_KIND && !day7) return { outcome: "cancelled" };
  // Engagement re-check (nudge-policy): rows armed under the old daily chain,
  // or before the lead's class changed, close here. Later allowed steps keep
  // their own rows, so skipping never strands the chain. Fails soft to silent.
  const policy = deps.policy ?? NUDGE_POLICY;
  let chainNow = nudgeChainFor(policy, SILENT, now, day7);
  if (!policyIsUniform(policy)) {
    let engagement: LeadEngagement;
    try {
      engagement = deps.engagement ? await deps.engagement(phone) : await lookupEngagement(env, phone);
    } catch {
      engagement = SILENT;
    }
    chainNow = nudgeChainFor(policy, engagement, now, day7);
    if (!chainNow.includes(kind)) {
      return { outcome: "policy_skip", engagement: engagementClass(engagement) };
    }
  }
  if (await hasPendingApproval(env, phone)) {
    return { outcome: "deferred", retryAt: pendingApprovalRetryAt(now) };
  }

  const campaignName =
    contact.campaign_id !== null
      ? await deps.campaignName(env, contact.campaign_id)
      : null;
  const recent = await recentMessages(env.DB, phone, 30, now - 7 * DAY);
  if (hasBuyIntent(recent.filter((m) => m.direction === "in").map((m) => m.body ?? ""))) {
    return { outcome: "cancelled" };
  }
  const convo = recent.map((m) => ({ direction: m.direction, body: m.body, ts: m.ts }));
  const slotsKey = proposedSlotsKey(phone);
  const slotsRaw = await kvGet(env.DB, slotsKey);
  const c = planNudgeCopy(contact, campaignName, convo, now, { proposedKeys: parseProposedSlots(slotsRaw, now) });
  // Deferral (nudge-context.ts): after "les aviso" only the goodbye is left,
  // ≥ 7 days later; after "la próxima semana" the step waits for that date.
  const isFinal = isFinalStep(kind, chainNow);
  const dv = deferralVerdict(c.facts, { day1: false, isFinal }, now);
  if (dv.act === "cancel") return { outcome: "cancelled" };
  if (dv.act === "defer") return { outcome: "deferred", retryAt: dv.until };
  const program = c.program;
  const body = extendedCopy(c.contact, kind, program, now, c.schedule, c.campaignName, day7, { slot: c.slot, cta: c.cta });
  const outbound = recent.filter((m) => m.direction !== "in").map((m) => ({ body: m.body ?? "", ts: m.ts }));
  if (isDuplicateSend(body, outbound, now)) return { outcome: "cancelled" };

  // One extended nudge per CDMX day. Losing the claim used to cancel the row
  // for good; now it just waits for tomorrow's 08:00.
  const claim = nudgeDayClaimKey(phone, now);
  if (!(await kvSetIfAbsent(env.DB, claim, String(now)))) {
    return { outcome: "deferred", retryAt: next8am(now) };
  }
  try {
    await deps.sendText(env, phone, body); // free-form (window open)
    if (c.slot) await kvSet(env.DB, slotsKey, recordProposedSlot(slotsRaw, c.slot, now));
    return { outcome: "sent" };
  } catch (err) {
    if (!deps.isWindowClosed(err)) {
      await kvDelete(env.DB, claim);
      throw err;
    }
  }

  // Window closed → per-program template fallback.
  const lang = contact.lang === "en" ? "en" : "es";
  const base = extendedTemplateName(kind, program, day7);
  const template = deps.templateName(base, lang);
  // The 12 nudge_d2..d5 templates declare {{1}} = first name. Sending ZERO
  // parameters to them (the bug until 2026-09-21) fails at Graph with 132000,
  // and the bare `catch` then reported it as "not approved yet". The generic
  // steps (d7, and d5 → nudge_d5v2_* with the flag on) declare NO placeholder,
  // and a parameter there fails with the same 132000 — so they send none.
  const components = isGenericExtendedStep(kind, day7)
    ? []
    : [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: templateFirstName(
                greetingName(parseQualification(contact).name) || greetingName(contact.name),
                lang,
              ),
            },
          ],
        },
      ];
  try {
    await deps.sendTemplate(env, phone, template, lang, components);
    return { outcome: "sent" };
  } catch (err) {
    await kvDelete(env.DB, claim);
    const error = err instanceof Error ? err.message : String(err);
    return {
      outcome: "template_missing",
      template,
      missing: isTemplateMissingError(error),
      error,
    };
  }
}

// Re-exported for the pipeline opt-out path convenience.
export { cancelFollowups };
