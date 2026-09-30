// What happens AFTER the trial class — the two biggest holes in the funnel
// until 2026-09-21 (163 people attended since July and never heard from us
// again; ~400 no-shows got exactly one message). Spec: docs/post-trial-sequence.md.
//
// Two chains, both armed by the Airtable result watcher (cron/followups.ts
// processResult) off `Resultado Clase Prueba`:
//   - "Asistió" (and NOT "Se inscribió") → post_trial_d0 / d2 / d4 / d7 / d14 /
//     d30: the same evening (or the next morning, saying "ayer"), then +2, +4,
//     +7, +14 and +30 days (goodbye). Six touches over a month — the first
//     version (d0/d2/d5) signed up two people on its first live day
//     (2026-09-30), so the arc got longer, not shorter.
//   - "No asistió" → the immediate rebook message (sent inline by the watcher)
//     plus a second touch, no_show_d3, ~3 days after the missed class.
//
// The timing is pure (computePostTrialSequence / computeNoShowRebook, fake-clock
// unit tests) and always lands inside 09:00–21:00 CDMX, so it can never collide
// with quiet hours (21:30–08:00). processPostTrial is the send-time half: it
// re-checks every stop condition against live state, because a row armed on
// Monday evening may only fire a month later.

import type { Contact, Env } from "../types.js";
import { getContact, recentMessages } from "../db/queries.js";
import { hasScheduledFollowupOfKind } from "../db/queries-admin.js";
import { CLIENT } from "../client.gen.js";
import { renderCopy } from "../client-config.js";
import { attributionFor, withAttribution } from "../services/booking-link.js";
import { greetingName } from "./display-name.js";
import { isTemplateMissingError, nameParam } from "../services/template-params.js";
import { cdmxParts, cdmxToEpoch, DAY } from "./time.js";
import { BOOKING_KINDS } from "./nudges.js";
import {
  classifyProgram,
  noShowCopy,
  parseQualification,
  programLink,
  type Program,
} from "./nudge-copy.js";

const HOUR = 3600;

// ---- kinds ----

/** The attended-and-didn't-buy chain, in send order. */
export const POST_TRIAL_KINDS = [
  "post_trial_d0",
  "post_trial_d2",
  "post_trial_d4",
  "post_trial_d7",
  "post_trial_d14",
  "post_trial_d30",
] as const;
/** The 2026-09-21 goodbye slot, retired on 2026-09-30 when the arc grew to
 *  +30d. Rows already armed keep draining (same copy + template as d30). */
export const LEGACY_POST_TRIAL_KINDS = ["post_trial_d5"] as const;
export type PostTrialKind =
  | (typeof POST_TRIAL_KINDS)[number]
  | (typeof LEGACY_POST_TRIAL_KINDS)[number];

/** Second (and last) no-show touch. */
export const NO_SHOW_KIND = "no_show_d3";

/** The delayed Slack card ("asistió y no se inscribió" + 🙋 button). */
export const POST_TRIAL_CARD_KIND = "post_trial_card";

/** Every kind this module owns — the cancellation surface. */
export const POST_TRIAL_ALL_KINDS = [
  ...POST_TRIAL_KINDS,
  ...LEGACY_POST_TRIAL_KINDS,
  NO_SHOW_KIND,
  POST_TRIAL_CARD_KIND,
] as const;

/** Assumed class length: adult/kids classes run ~1 h (Baby is 40 min — the card
 *  is a few minutes later there, which is harmless). */
export const CLASS_LENGTH = 60 * 60;
/** The card waits this long AFTER the class ends — the front desk closes in
 *  person first; a card saying "escríbele hoy" while the lead is still on the
 *  mat was the complaint (Evan, 2026-09-21). */
export const CARD_DELAY_AFTER_END = 30 * 60;

/**
 * When the attended card should post: class start + CLASS_LENGTH +
 * CARD_DELAY_AFTER_END. Null when that moment already passed (the result was
 * marked late) — post it right away. Pure.
 */
export function computePostTrialCardAt(trialEpoch: number, now: number): number | null {
  if (!Number.isFinite(trialEpoch)) return null;
  const dueAt = trialEpoch + CLASS_LENGTH + CARD_DELAY_AFTER_END;
  return dueAt > now ? dueAt : null;
}

/** note column of a post_trial_card row: the display name resolved at marking time. */
export function encodeCardNote(name: string): string {
  return JSON.stringify({ name });
}
export function decodeCardNote(note: string | null): string | null {
  if (!note) return null;
  try {
    const v = JSON.parse(note) as { name?: unknown };
    return typeof v.name === "string" && v.name ? v.name : null;
  } catch {
    return null;
  }
}

/**
 * note column of a post-trial chain row: the trial's epoch, so the send-time
 * half can say "hoy" or "ayer" from the CLASS date rather than from when the
 * front desk got around to marking the result.
 */
export function encodeChainNote(trialEpoch: number): string | null {
  return Number.isFinite(trialEpoch) ? JSON.stringify({ trial: trialEpoch }) : null;
}
export function decodeChainNote(note: string | null): number | null {
  if (!note) return null;
  try {
    const v = JSON.parse(note) as { trial?: unknown };
    return typeof v.trial === "number" && Number.isFinite(v.trial) ? v.trial : null;
  } catch {
    return null;
  }
}

export type FollowUpKindHere = PostTrialKind | typeof NO_SHOW_KIND;

// ---- timing (pure) ----

export interface PostTrialStep {
  kind: PostTrialKind;
  dueAt: number; // epoch seconds, inside 09:00–21:00 CDMX
}

/** Past this age a trial is cold: nothing is armed at all. The chain runs a
 *  month, so a result marked up to two weeks late still gets its tail. */
export const POST_TRIAL_MAX_AGE = 14 * DAY;
/** The Slack "asistió y no se inscribió" card stops making sense sooner than
 *  the chain does — "escríbele hoy" about a class from last week is noise. */
export const POST_TRIAL_CARD_MAX_AGE = 5 * DAY;
/** Marked later than this ⇒ the first touch is skipped as stale. */
export const POST_TRIAL_D0_MAX_AGE = 2 * DAY;
/** How long after the trial the first touch naturally lands. */
export const POST_TRIAL_D0_DELAY = 3 * HOUR;
/**
 * A lead who wrote in this recently is in a conversation (with the brain or a
 * human) — an automated touch on top of it is noise. Once they have been quiet
 * this long after we answered, the chain resumes: "replied, got the numbers,
 * went silent" is exactly the lead the later touches are for.
 */
export const CONVERSATION_GRACE = 3 * DAY;

/** The touches after the first one: calendar days after the trial + CDMX time. */
export const POST_TRIAL_STEPS: readonly {
  kind: Exclude<(typeof POST_TRIAL_KINDS)[number], "post_trial_d0">;
  days: number;
  hour: number;
}[] = [
  { kind: "post_trial_d2", days: 2, hour: 11 },
  { kind: "post_trial_d4", days: 4, hour: 18 },
  { kind: "post_trial_d7", days: 7, hour: 11 },
  { kind: "post_trial_d14", days: 14, hour: 18 },
  { kind: "post_trial_d30", days: 30, hour: 11 },
];

/**
 * Push an epoch into the 09:00–21:00 CDMX send window. Anything before 09:00 or
 * at/after 21:00 lands on the fallback time (09:30) — the same day for a
 * too-early epoch, the NEXT day for a too-late one. Unlike time.ts clampToWindow
 * this places the overflow at 09:30 rather than 09:00, so an evening class whose
 * thank-you spills past 21:00 arrives at a humane hour instead of on the dot.
 */
function placeInWindow(epoch: number, fallbackHour = 9, fallbackMinute = 30): number {
  const p = cdmxParts(epoch);
  const startOfDay = cdmxToEpoch(p.year, p.month, p.day, 0, 0, 0);
  const fallback = startOfDay + fallbackHour * HOUR + fallbackMinute * 60;
  if (epoch < startOfDay + 9 * HOUR) return fallback;
  if (epoch >= startOfDay + 21 * HOUR) return fallback + DAY;
  return epoch;
}

/** `hour`:00 CDMX, `days` calendar days after the trial's CDMX date. */
function afterTrial(trialEpoch: number, days: number, hour: number): number {
  const p = cdmxParts(trialEpoch);
  // Date.UTC normalizes day overflow inside cdmxToEpoch, so p.day + days rolls
  // months and years on its own.
  return cdmxToEpoch(p.year, p.month, p.day + days, hour, 0, 0);
}

/** Whole CDMX calendar days from `from` to `to` (0 = same day, 1 = the next). */
export function cdmxDayOffset(from: number, to: number): number {
  const a = cdmxParts(from);
  const b = cdmxParts(to);
  return Math.round(
    (cdmxToEpoch(b.year, b.month, b.day, 0, 0, 0) - cdmxToEpoch(a.year, a.month, a.day, 0, 0, 0)) /
      DAY,
  );
}

/**
 * The post-trial touches to arm for a trial at `trialEpoch`, marked "Asistió"
 * at `now`. Pure.
 *
 *  - d0 ≈ 3h after the class STARTS (same evening); past 21:00 → 09:30 tomorrow,
 *    where the copy says "ayer". Dropped when it could only fire two or more
 *    calendar days after the class (the desk marked the result late) — a
 *    "¿qué te pareció la experiencia?" that late reads like a bot, and d2
 *    ("después de tu clase") is day-agnostic.
 *  - d2 / d4 / d7 / d14 / d30 at their CDMX hour on the trial date + N days,
 *    and only when that is still in the future.
 *  - A trial older than POST_TRIAL_MAX_AGE (or more than a day in the future,
 *    i.e. a nonsense record) arms nothing.
 */
export function computePostTrialSequence(
  trialEpoch: number,
  now: number,
): PostTrialStep[] {
  if (!Number.isFinite(trialEpoch)) return [];
  const age = now - trialEpoch;
  if (age < -DAY || age > POST_TRIAL_MAX_AGE) return [];

  const steps: PostTrialStep[] = [];
  const d0At = placeInWindow(trialEpoch + POST_TRIAL_D0_DELAY);
  // A past-due row fires on the next cron tick, i.e. at `now`, not at d0At.
  const firesAt = Math.max(d0At, now);
  if (age <= POST_TRIAL_D0_MAX_AGE && cdmxDayOffset(trialEpoch, firesAt) <= 1) {
    steps.push({ kind: "post_trial_d0", dueAt: d0At });
  }
  for (const step of POST_TRIAL_STEPS) {
    const dueAt = afterTrial(trialEpoch, step.days, step.hour);
    if (dueAt > now) steps.push({ kind: step.kind, dueAt });
  }
  return steps;
}

/**
 * The second no-show touch: 11:00 CDMX three days after the missed class, or
 * null when that moment has already passed (the front desk marked the no-show
 * very late) or the trial is too old to chase. Anchored on the TRIAL, not on the
 * marking, so re-running the watcher can never walk the date forward. Pure.
 */
export function computeNoShowRebook(
  trialEpoch: number,
  now: number,
): { kind: typeof NO_SHOW_KIND; dueAt: number } | null {
  if (!Number.isFinite(trialEpoch)) return null;
  const age = now - trialEpoch;
  if (age < -DAY || age > POST_TRIAL_MAX_AGE) return null;
  const dueAt = afterTrial(trialEpoch, 3, 11);
  return dueAt > now ? { kind: NO_SHOW_KIND, dueAt } : null;
}

// ---- copy (pure) ----

/** Greeting name, qualification first (a name the lead TOLD us), push name second. */
export function postTrialName(contact: Contact | null): string {
  const q = parseQualification(contact);
  return greetingName(q.name) || greetingName(contact?.name);
}

/** The {when} word of the first touch for a class `dayOffset` days ago. */
export function firstTouchWhen(dayOffset: number, lang: string): string {
  const en = lang === "en";
  return dayOffset >= 1 ? (en ? "yesterday" : "ayer") : en ? "today" : "hoy";
}

/**
 * Body for one post-trial touch. d0/d2/d4/d7 are pure conversation (a question,
 * no link — they just came to the academy, they know where it is); d14 and the
 * goodbye (d30, and the retired d5) carry the public schedule. `dayOffset` only
 * matters for d0: 0 says "hoy", 1 says "ayer". Pure over its inputs.
 */
export function postTrialCopy(
  contact: Contact | null,
  kind: PostTrialKind,
  campaignName: string | null = null,
  dayOffset = 0,
): string {
  const en = contact?.lang === "en";
  const who = nameSuffix(postTrialName(contact));
  const c = CLIENT.copy;
  const pick = (es: string, enCopy: string): string => (en ? enCopy : es);
  const template =
    kind === "post_trial_d0"
      ? pick(c.postTrialD0Es, c.postTrialD0En)
      : kind === "post_trial_d2"
        ? pick(c.postTrialD2Es, c.postTrialD2En)
        : kind === "post_trial_d4"
          ? pick(c.postTrialD4Es, c.postTrialD4En)
          : kind === "post_trial_d7"
            ? pick(c.postTrialD7Es, c.postTrialD7En)
            : kind === "post_trial_d14"
              ? pick(c.postTrialD14Es, c.postTrialD14En)
              : pick(c.postTrialD5Es, c.postTrialD5En); // d30 + legacy d5
  const link = withAttribution(
    CLIENT.links.schedule ?? CLIENT.links.booking,
    attributionFor(contact, campaignName),
  );
  return renderCopy(template, {
    who,
    link,
    when: firstTouchWhen(dayOffset, en ? "en" : "es"),
  });
}

/** Body for the second no-show touch (one real slot, like the first one). */
export function noShowD3Copy(
  contact: Contact | null,
  program: Program,
  nowEpoch: number,
  campaignName: string | null = null,
): string {
  const link = withAttribution(
    programLink(program),
    attributionFor(contact, campaignName),
  );
  return noShowCopy(contact, program, "d3", nameSuffix(postTrialName(contact)), link, nowEpoch);
}

/** " Nombre" (leading space) or "" — the shape every {who} placeholder expects. */
function nameSuffix(name: string): string {
  return name ? ` ${name}` : "";
}

/**
 * Template base name for a kind (the sender appends _es / _en). The first touch
 * has two templates — `post_trial_d0` says "hoy", `post_trial_d1` says "ayer" —
 * and the goodbye reuses the already-approved `post_trial_d5` body.
 */
export function postTrialTemplateName(kind: FollowUpKindHere, dayOffset = 0): string {
  if (kind === NO_SHOW_KIND) return "no_show_followup";
  if (kind === "post_trial_d0") return dayOffset >= 1 ? "post_trial_d1" : "post_trial_d0";
  if (kind === "post_trial_d30") return "post_trial_d5";
  return kind;
}

// ---- "🙋 Yo le escribo" claim (Slack card on the attended lead) ----
//
// Staff almost always follow up from their OWN phone, which the bot cannot see:
// no inbound arrives, so every send-time stop condition stays false and the bot
// writes on top of a human. The claim button IS that missing signal. It kills
// only the d0 touch — d2/d5 keep running under their normal stop conditions,
// because "I'll message them today" is a promise about today.

/** Slack action verb on the card's button: `posttrial_claim|<phone>`. */
export const POST_TRIAL_CLAIM_VERB = "posttrial_claim";

/** kv: who claimed this lead (JSON PostTrialClaim). */
export function postTrialClaimKey(phone: string): string {
  return `post_trial_claim:${phone}`;
}

/** kv: the Slack ts of the card, so a click can update the right message. */
export function postTrialCardKey(phone: string): string {
  return `post_trial_card:${phone}`;
}

export interface PostTrialClaim {
  /** Slack username/display name of whoever clicked. */
  user: string;
  /** Epoch seconds of the click. */
  ts: number;
}

/** Pure. Read a claim back out of kv, tolerating junk. */
export function parsePostTrialClaim(json: string | null): PostTrialClaim | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Partial<PostTrialClaim>;
    if (typeof p.user !== "string" || typeof p.ts !== "number") return null;
    return { user: p.user, ts: p.ts };
  } catch {
    return null;
  }
}

/** What the d0 row looked like when the click arrived. */
export type D0State =
  /** Still scheduled — this click cancels it. */
  | { state: "pending" }
  /** Already went out (epoch seconds, ±one 5-min tick). */
  | { state: "sent"; at: number }
  /** No row at all: cancelled earlier, or never armed. */
  | { state: "gone" };

export interface ClaimDecision {
  /** false when someone already claimed this lead — the first claim stands. */
  record: boolean;
  /** The card's new text. */
  text: string;
}

/** "18:05" in CDMX. */
function hhmm(epoch: number): string {
  const p = cdmxParts(epoch);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const TAIL = "El resto de la secuencia (+2d … +30d) sigue si no responde ni se marca resultado.";

/**
 * Pure. What a click on "🙋 Yo le escribo" means, given who clicked, whether
 * anyone already claimed this lead, and what the d0 row was doing.
 *
 * Idempotent by construction: a second click (by anyone) never re-records and
 * never re-cancels — it just reports who got there first.
 */
export function decideClaim(input: {
  name: string;
  phone: string;
  user: string;
  existing: PostTrialClaim | null;
  d0: D0State;
}): ClaimDecision {
  const who = input.user || "Alguien del equipo";
  const lead = `${input.name} (${input.phone})`;
  if (input.existing) {
    return {
      record: false,
      text:
        `🙋 ${input.existing.user} ya se lo había apartado (${hhmm(input.existing.ts)}) — ` +
        `${lead}. El bot no manda el mensaje de hoy. ${TAIL}`,
    };
  }
  if (input.d0.state === "sent") {
    // Too late to stop it, but the claim still matters: it tells the next person
    // who owns this lead, and it is recorded.
    return {
      record: true,
      text:
        `🙋 ${who} le escribe a ${lead}. El mensaje de hoy ya había salido a las ` +
        `${hhmm(input.d0.at)}. ${TAIL}`,
    };
  }
  return {
    record: true,
    text: `🙋 ${who} le escribe hoy a ${lead} — el bot NO manda el mensaje de hoy. ${TAIL}`,
  };
}

/** The card text posted when a lead is marked attended-without-enrollment. */
export function attendedCardText(name: string, phone: string): string {
  return (
    `🔥 ${name} (${phone}) asistió y no se inscribió — seguimiento automático ` +
    `armado (hoy, +2d, +4d, +7d, +14d, +30d). Quien cerró: escríbele hoy.`
  );
}

// ---- send-time processing ----

export type PostTrialOutcome =
  | { outcome: "sent" }
  /** `stopChain` ⇒ the remaining rows of this chain are pointless now. */
  | { outcome: "cancelled"; stopChain?: boolean }
  | { outcome: "skipped_optout" }
  /** `missing` ⇒ Meta says the template does not exist (132001), i.e. it is not
   *  approved yet; anything else is our bug and `error` carries Graph's words. */
  | { outcome: "template_missing"; template: string; missing: boolean; error: string };

export interface PostTrialDeps {
  sendText: (env: Env, phone: string, body: string) => Promise<string>;
  sendTemplate: (
    env: Env,
    phone: string,
    name: string,
    lang: string,
    components?: unknown[],
  ) => Promise<string>;
  /** Language-suffixing helper (followups.ts `tpl`). */
  templateName: (base: string, lang: string) => string;
  isWindowClosed: (err: unknown) => boolean;
  campaignName?: (env: Env, campaignId: number) => Promise<string | null>;
}

/**
 * Send-time processing for a due post-trial / no-show-d3 row. Every stop
 * condition is re-checked here rather than at arming time, because the world
 * moves between the two: the lead may have signed up, opted out, written in,
 * been taken over by a human, or booked a NEW class.
 *
 * A reply is NOT the end of the chain any more (2026-09-30). It pauses it:
 * while the lead wrote within CONVERSATION_GRACE, or their message is the last
 * word in the thread (a human owes the answer), the due touch is skipped. Once
 * we answered and they have been quiet for the grace period, the next touch
 * goes out — the lead who asked for prices and vanished is the one these
 * messages exist for.
 *
 * Free-form first — most of these leads are inside the 24h window, having just
 * been in the gym — with the per-kind template as the closed-window fallback.
 * A missing/unapproved template returns `template_missing` so the caller can
 * post its once-a-day Slack note instead of retrying forever.
 */
export async function processPostTrial(
  env: Env,
  row: { phone: string; kind: FollowUpKindHere; created_at: number; note?: string | null },
  deps: PostTrialDeps,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<PostTrialOutcome> {
  const contact = await getContact(env.DB, row.phone);
  if (!contact) return { outcome: "cancelled" };
  if (contact.status === "opted_out") return { outcome: "skipped_optout" };
  // Enrolled since the row was armed (student sync, Airtable, or a human).
  if (contact.status === "student") return { outcome: "cancelled", stopChain: true };
  if (contact.human_override_until && contact.human_override_until > nowEpoch) {
    // A human is on this conversation right now — skip this touch only; the
    // next one re-checks and may well be fine.
    return { outcome: "cancelled" };
  }
  const lastInbound = contact.last_inbound_at ?? 0;
  if (lastInbound > row.created_at) {
    // They wrote after we armed the chain: a real conversation happened.
    if (nowEpoch - lastInbound < CONVERSATION_GRACE) return { outcome: "cancelled" };
    // Quiet for a while — but if THEIR message is the last one in the thread,
    // nobody answered them, and a bot nudge on top of an unanswered question
    // is the worst thing we could send. Skip; a human owes the reply.
    const [last] = await recentMessages(env.DB, row.phone, 1);
    if (last && last.direction === "in") return { outcome: "cancelled" };
    // Otherwise we answered and they went silent: the chain resumes.
  }
  // A new class on the calendar makes the whole chain obsolete — the anti-no-show
  // sequence takes over from here.
  if (await hasScheduledFollowupOfKind(env.DB, row.phone, BOOKING_KINDS)) {
    return { outcome: "cancelled", stopChain: true };
  }

  // The first touch says "hoy" or "ayer" from the CLASS date (the row's note).
  // A row with no note predates the note (armed before 2026-09-30): the arming
  // moment is the best stand-in. Two or more days after the class the touch is
  // stale — d2 ("después de tu clase") does not name the day.
  let dayOffset = 0;
  if (row.kind === "post_trial_d0") {
    const trial = decodeChainNote(row.note ?? null) ?? row.created_at;
    dayOffset = Math.max(0, cdmxDayOffset(trial, nowEpoch));
    if (dayOffset > 1) return { outcome: "cancelled" };
  }

  const campaign =
    contact.campaign_id !== null && deps.campaignName
      ? await deps.campaignName(env, contact.campaign_id)
      : null;
  const body =
    row.kind === NO_SHOW_KIND
      ? noShowD3Copy(contact, classifyProgram(contact, campaign), nowEpoch, campaign)
      : postTrialCopy(contact, row.kind, campaign, dayOffset);

  try {
    await deps.sendText(env, row.phone, body);
    return { outcome: "sent" };
  } catch (err) {
    if (!deps.isWindowClosed(err)) throw err;
  }

  const lang = contact.lang === "en" ? "en" : "es";
  const template = deps.templateName(postTrialTemplateName(row.kind, dayOffset), lang);
  try {
    await deps.sendTemplate(env, row.phone, template, lang, [
      nameParam(postTrialName(contact), lang),
    ]);
    return { outcome: "sent" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      outcome: "template_missing",
      template,
      missing: isTemplateMissingError(error),
      error,
    };
  }
}
