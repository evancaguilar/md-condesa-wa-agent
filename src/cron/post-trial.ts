// What happens AFTER the trial class — the two biggest holes in the funnel
// until 2026-09-21 (163 people attended since July and never heard from us
// again; ~400 no-shows got exactly one message).
//
// Two chains, both armed by the Airtable result watcher (cron/followups.ts
// processResult) off `Resultado Clase Prueba`:
//   - "Asistió" (and NOT "Se inscribió") → post_trial_d0 / _d2 / _d5: the same
//     evening, +2 days and +5 days (goodbye).
//   - "No asistió" → the immediate rebook message (sent inline by the watcher)
//     plus a second touch, no_show_d3, ~3 days after the missed class.
//
// The timing is pure (computePostTrialSequence / computeNoShowRebook, fake-clock
// unit tests) and always lands inside 09:00–21:00 CDMX, so it can never collide
// with quiet hours (21:30–08:00). processPostTrial is the send-time half: it
// re-checks every stop condition against live state, because a row armed on
// Monday evening may only fire on Saturday.

import type { Contact, Env } from "../types.js";
import { getContact } from "../db/queries.js";
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
  "post_trial_d5",
] as const;
export type PostTrialKind = (typeof POST_TRIAL_KINDS)[number];

/** Second (and last) no-show touch. */
export const NO_SHOW_KIND = "no_show_d3";

/** The delayed Slack card ("asistió y no se inscribió" + 🙋 button). */
export const POST_TRIAL_CARD_KIND = "post_trial_card";

/** Every kind this module owns — the cancellation surface. */
export const POST_TRIAL_ALL_KINDS = [...POST_TRIAL_KINDS, NO_SHOW_KIND, POST_TRIAL_CARD_KIND] as const;

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

export type FollowUpKindHere = PostTrialKind | typeof NO_SHOW_KIND;

// ---- timing (pure) ----

export interface PostTrialStep {
  kind: PostTrialKind;
  dueAt: number; // epoch seconds, inside 09:00–21:00 CDMX
}

/** Past this age a trial is cold: nothing is armed at all. */
export const POST_TRIAL_MAX_AGE = 5 * DAY;
/** Marked later than this ⇒ the "same evening" touch is skipped as stale. */
export const POST_TRIAL_D0_MAX_AGE = 2 * DAY;
/** How long after the trial the d0 touch naturally lands. */
export const POST_TRIAL_D0_DELAY = 3 * HOUR;

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

/** 11:00 CDMX, `days` calendar days after the trial's CDMX date. */
function morningAfter(trialEpoch: number, days: number): number {
  const p = cdmxParts(trialEpoch);
  // Date.UTC normalizes day overflow inside cdmxToEpoch, so p.day + days rolls
  // months and years on its own.
  return cdmxToEpoch(p.year, p.month, p.day + days, 11, 0, 0);
}

/**
 * The post-trial touches to arm for a trial at `trialEpoch`, marked "Asistió"
 * at `now`. Pure.
 *
 *  - d0 ≈ 3h after the class STARTS (same evening); past 21:00 → 09:30 tomorrow.
 *    Dropped when the front desk marked the result more than 48h late — a
 *    "¿cómo te sentiste hoy?" two days after the fact reads like a bot.
 *  - d2 / d5 at 11:00 CDMX on the trial date + 2 / + 5 days, and only when that
 *    is still in the future.
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
  if (age <= POST_TRIAL_D0_MAX_AGE) {
    steps.push({
      kind: "post_trial_d0",
      dueAt: placeInWindow(trialEpoch + POST_TRIAL_D0_DELAY),
    });
  }
  for (const [kind, days] of [
    ["post_trial_d2", 2],
    ["post_trial_d5", 5],
  ] as const) {
    const dueAt = morningAfter(trialEpoch, days);
    if (dueAt > now) steps.push({ kind, dueAt });
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
  const dueAt = morningAfter(trialEpoch, 3);
  return dueAt > now ? { kind: NO_SHOW_KIND, dueAt } : null;
}

// ---- copy (pure) ----

/** Greeting name, qualification first (a name the lead TOLD us), push name second. */
export function postTrialName(contact: Contact | null): string {
  const q = parseQualification(contact);
  return greetingName(q.name) || greetingName(contact?.name);
}

/**
 * Body for one post-trial touch. d0/d2 are pure conversation (a question, no
 * link — they just came to the academy, they know where it is); d5 is the
 * goodbye and carries the public schedule. Pure over (contact, kind).
 */
export function postTrialCopy(
  contact: Contact | null,
  kind: PostTrialKind,
  campaignName: string | null = null,
): string {
  const en = contact?.lang === "en";
  const who = nameSuffix(postTrialName(contact));
  const c = CLIENT.copy;
  const template =
    kind === "post_trial_d0"
      ? en
        ? c.postTrialD0En
        : c.postTrialD0Es
      : kind === "post_trial_d2"
        ? en
          ? c.postTrialD2En
          : c.postTrialD2Es
        : en
          ? c.postTrialD5En
          : c.postTrialD5Es;
  const link = withAttribution(
    CLIENT.links.schedule ?? CLIENT.links.booking,
    attributionFor(contact, campaignName),
  );
  return renderCopy(template, { who, link });
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

/** Template base name for a kind (the sender appends _es / _en). */
export function postTrialTemplateName(kind: FollowUpKindHere): string {
  return kind === NO_SHOW_KIND ? "no_show_followup" : kind;
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

const TAIL = "+2d y +5d siguen si no responde ni se marca resultado.";

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
    `armado (hoy, +2d, +5d). Quien cerró: escríbele hoy.`
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
 * moves between the two: the lead may have signed up, opted out, written in
 * (then the brain and the humans own the conversation), been taken over by a
 * human, or booked a NEW class.
 *
 * Free-form first — most of these leads are inside the 24h window, having just
 * been in the gym — with the per-kind template as the closed-window fallback.
 * A missing/unapproved template returns `template_missing` so the caller can
 * post its once-a-day Slack note instead of retrying forever.
 */
export async function processPostTrial(
  env: Env,
  row: { phone: string; kind: FollowUpKindHere; created_at: number },
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
  // The lead wrote in after we armed the chain: they are in a real conversation
  // now, and an automated "¿cómo te sentiste?" on top of it is noise.
  if ((contact.last_inbound_at ?? 0) > row.created_at) {
    return { outcome: "cancelled", stopChain: true };
  }
  // A new class on the calendar makes the whole chain obsolete — the anti-no-show
  // sequence takes over from here.
  if (await hasScheduledFollowupOfKind(env.DB, row.phone, BOOKING_KINDS)) {
    return { outcome: "cancelled", stopChain: true };
  }

  const campaign =
    contact.campaign_id !== null && deps.campaignName
      ? await deps.campaignName(env, contact.campaign_id)
      : null;
  const body =
    row.kind === NO_SHOW_KIND
      ? noShowD3Copy(contact, classifyProgram(contact, campaign), nowEpoch, campaign)
      : postTrialCopy(contact, row.kind, campaign);

  try {
    await deps.sendText(env, row.phone, body);
    return { outcome: "sent" };
  } catch (err) {
    if (!deps.isWindowClosed(err)) throw err;
  }

  const lang = contact.lang === "en" ? "en" : "es";
  const template = deps.templateName(postTrialTemplateName(row.kind), lang);
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
