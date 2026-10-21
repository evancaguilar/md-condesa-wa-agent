// What happens AFTER the trial class — the two biggest holes in the funnel
// until 2026-09-21 (163 people attended since July and never heard from us
// again; ~400 no-shows got exactly one message).
//
// v2 (2026-10-11, audit 2026-10-09). Two chains, both keyed per PHONE (a
// mother with two Airtable rows used to get two chains — …9448):
//   - Attended and did NOT sign up → post_trial_d0 (same evening, unchanged
//     timing) / post_trial_d3 / post_trial_d6 (11:00 CDMX). Armed by the
//     Airtable result watcher (cron/followups.ts processResult) on "Asistió".
//   - No-show → no_show_hoy at class start + 2 h (armed with the booking; it
//     only sends when `Resultado` is still empty or says "No asistió" at send
//     time — the record is re-read), then no_show_d2 / no_show_d7 at 11:00,
//     then a Slack TASK "Marcar Perdido" (the bot never writes Perdido).
//
// Copy is per PROGRAM (2026-10-15): adults → singular; kids (mini / kids /
// teens) → plural, to the parent; baby (Baby Fight Club, 6–36 months) → plural,
// to a parent who takes the class WITH the baby (never "tu cuerpo", never "what
// did the baby think" — a mother of an 11-month-old got the adult line) and per contact language, and every day word is
// computed at SEND time against the trial date ("hoy" / "ayer" / "el sábado"),
// so a row that a quiet-hours re-check pushed to the next morning can never
// say "hoy" again (post_trial_d0 "verte hoy" went out the next morning; the
// no-show template said "ayer" two hours after a 7 am class — …9340).
//
// Timing is pure (computePostTrialSequence / computeNoShowSequence, fake-clock
// unit tests) and always lands inside 08:00–21:00 CDMX. processPostTrial is the
// send-time half: it re-checks every stop condition against live state.
//
// Legacy kinds (post_trial_d2 / _d5, no_show_d3) armed before v2 still drain
// through here; no_show_d3 is sent as a d2-style touch (never the old "ayer"
// template).

import type { Contact, Env, ProgramBand } from "../types.js";
import { getContact, kvGet } from "../db/queries.js";
import { hasScheduledFollowupOfKind } from "../db/queries-admin.js";
import { CLIENT } from "../client.gen.js";
import { renderCopy } from "../client-config.js";
import { attributionFor, withAttribution } from "../services/booking-link.js";
import { greetingName } from "./display-name.js";
import { bodyParams, isTemplateMissingError, nameParam, templateFirstName } from "../services/template-params.js";
import { cdmxDateStr, cdmxParts, cdmxToEpoch, DAY } from "./time.js";
import { shiftOutOfQuiet } from "./quiet.js";
import {
  BOOKING_KINDS,
  bandForContact,
  bandProgram,
  bandSlot,
  bookingMarkerLive,
  parseQualification,
  programLink,
  slotCta,
} from "./nudges.js";
import { formatSlotLabel, disciplineLabel, type NextSlot } from "./next-slot.js";
import { bookingRecordedKey } from "../services/booking-core.js";
import { classifyResult, isLostResult, normalizeResult, type BookingRecord } from "../services/airtable.js";

const HOUR = 3600;

// ---- kinds ----

/** The attended-and-didn't-buy chain v2, in send order. */
export const POST_TRIAL_KINDS = ["post_trial_d0", "post_trial_d3", "post_trial_d6"] as const;
/** v1 steps still draining from rows armed before 2026-10-11. */
export const LEGACY_POST_TRIAL_KINDS = ["post_trial_d2", "post_trial_d5"] as const;
export type PostTrialKind =
  | (typeof POST_TRIAL_KINDS)[number]
  | (typeof LEGACY_POST_TRIAL_KINDS)[number];

/** The no-show chain v2, in send order. */
export const NO_SHOW_KINDS = ["no_show_hoy", "no_show_d2", "no_show_d7"] as const;
export type NoShowKind = (typeof NO_SHOW_KINDS)[number];

/** v1 second no-show touch (legacy rows only — sent as a d2-style touch). */
export const NO_SHOW_KIND = "no_show_d3";

/** The delayed Slack card ("asistió y no se inscribió" + 🙋 button). */
export const POST_TRIAL_CARD_KIND = "post_trial_card";

/** Every kind this module owns — the cancellation surface. */
export const POST_TRIAL_ALL_KINDS = [
  ...POST_TRIAL_KINDS,
  ...LEGACY_POST_TRIAL_KINDS,
  ...NO_SHOW_KINDS,
  NO_SHOW_KIND,
  POST_TRIAL_CARD_KIND,
] as const;

/** The attended chain's message kinds (new + legacy) — the per-phone dedupe surface. */
export const ATTENDED_CHAIN_KINDS = [...POST_TRIAL_KINDS, ...LEGACY_POST_TRIAL_KINDS] as const;
/** The no-show chain's message kinds (new + legacy). */
export const NO_SHOW_CHAIN_KINDS = [...NO_SHOW_KINDS, NO_SHOW_KIND] as const;

/**
 * When the attended card ("asistió y no se inscribió" + 🙋) posts (Evan,
 * 2026-10-03): 3 h after class START, so a lead taking the second class back to
 * back is off the mat first. Night exceptions:
 *   - class at 19:00 or later (7, 8, 9 pm) → 09:00 the next morning;
 *   - otherwise, if +3 h reaches 21:00 (a 6 pm class) → 20:59 the same day.
 * Never before 09:00. Pure.
 */
export const CARD_AFTER_START = 3 * 60 * 60;
export const NIGHT_CLASS_FROM_MIN = 19 * 60;
export function postTrialCardTime(trialEpoch: number): number {
  const p = cdmxParts(trialEpoch);
  const day0 = cdmxToEpoch(p.year, p.month, p.day, 0, 0, 0);
  if (p.hour * 60 + p.minute >= NIGHT_CLASS_FROM_MIN) {
    return cdmxToEpoch(p.year, p.month, p.day + 1, 9, 0, 0);
  }
  const t = trialEpoch + CARD_AFTER_START;
  if (t >= day0 + 21 * 3600) return day0 + 21 * 3600 - 60; // 20:59
  if (t < day0 + 9 * 3600) return day0 + 9 * 3600;
  return t;
}

/** The lead's d0 WhatsApp goes this long after the card, so "🙋 Yo le escribo"
 *  can still stop it. */
export const D0_AFTER_CARD = 30 * 60;

/**
 * When the attended card should post (postTrialCardTime). Null when that moment
 * already passed (the result was marked late) — post it right away. Pure.
 */
export function computePostTrialCardAt(trialEpoch: number, now: number): number | null {
  if (!Number.isFinite(trialEpoch)) return null;
  const dueAt = postTrialCardTime(trialEpoch);
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

export type FollowUpKindHere = PostTrialKind | NoShowKind | typeof NO_SHOW_KIND;

// ---- chain rows: per-phone key + note codec (pure) ----

/**
 * airtable_record_id of a chain row: one chain per PHONE per trial DATE, so two
 * Airtable rows for one family (two kids, or a staff "copy" row) collapse onto
 * the same UNIQUE(phone, kind, record) slot instead of arming two chains.
 */
export function chainKey(family: "pt" | "ns", trialEpoch: number): string {
  return `${family}:${cdmxDateStr(trialEpoch)}`;
}

export interface ChainNote {
  /** The Airtable record the chain came from (re-read at send time). */
  rec: string | null;
  /** The trial start (epoch s) the chain was armed for. */
  trial: number | null;
}

/** Note on a chain row: `rec:<id>;trial:<epoch>`. */
export function encodeChainNote(n: { rec: string | null; trial: number }): string {
  return `rec:${n.rec ?? ""};trial:${n.trial}`;
}

/** Tolerates legacy notes (null, "ayer") and the "|attempts:N" retry suffix. */
export function decodeChainNote(note: string | null | undefined): ChainNote {
  const s = note ?? "";
  const rec = /(?:^|;)rec:([^;|]*)/.exec(s)?.[1] ?? "";
  const trial = /(?:^|;)trial:(\d+)/.exec(s)?.[1];
  return { rec: rec || null, trial: trial ? Number(trial) : null };
}

// ---- timing (pure) ----

export interface PostTrialStep {
  kind: PostTrialKind;
  dueAt: number; // epoch seconds, inside 09:00–21:00 CDMX
  /** Legacy: "ayer" marked a d0 that lands on a later day. v2 decides the day
   *  word at send time from the trial epoch in the note; kept for old rows. */
  note?: string;
}

/** Note on a v1 d0 row that fires on a later CDMX day than the trial. */
export const D0_AYER_NOTE = "ayer";

/** True when a row note marks the d0 "ayer" variant (tolerates a trailing
 *  "|attempts:N" appended by the send-retry bookkeeping). */
export function isAyerNote(note: string | null | undefined): boolean {
  return (note ?? "").startsWith(D0_AYER_NOTE);
}

function sameCdmxDate(a: number, b: number): boolean {
  return cdmxDateStr(a) === cdmxDateStr(b);
}

/** Past this age a trial is cold: nothing is armed at all. */
export const POST_TRIAL_MAX_AGE = 6 * DAY;
/** Marked later than this ⇒ the "same evening" touch is skipped as stale. */
export const POST_TRIAL_D0_MAX_AGE = 2 * DAY;

/**
 * Push an epoch into the 09:00–21:00 CDMX send window. Anything before 09:00 or
 * at/after 21:00 lands on the fallback time (09:30) — the same day for a
 * too-early epoch, the NEXT day for a too-late one.
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
export function morningAfter(trialEpoch: number, days: number): number {
  const p = cdmxParts(trialEpoch);
  // Date.UTC normalizes day overflow inside cdmxToEpoch.
  return cdmxToEpoch(p.year, p.month, p.day + days, 11, 0, 0);
}

/**
 * The post-trial touches to arm for a trial at `trialEpoch`, marked "Asistió"
 * at `now`. Pure.
 *
 *  - d0 = 30 min after the attended card (card ≈ class start + 3 h; see
 *    postTrialCardTime); anything that lands at/after 21:00 → 09:30 tomorrow.
 *    Dropped when the front desk marked the result more than 48h late.
 *  - d3 / d6 at 11:00 CDMX on the trial date + 3 / + 6 days, and only when that
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
    steps.push({ kind: "post_trial_d0", dueAt: placeInWindow(postTrialCardTime(trialEpoch) + D0_AFTER_CARD) });
  }
  for (const [kind, days] of [
    ["post_trial_d3", 3],
    ["post_trial_d6", 6],
  ] as const) {
    const dueAt = morningAfter(trialEpoch, days);
    if (dueAt > now) steps.push({ kind, dueAt });
  }
  return steps;
}

export interface NoShowStep {
  kind: NoShowKind;
  dueAt: number;
}

/** Past this, the first touch is dropped (d2 at 11:00 is about to cover it). */
const HOY_LATEST_BEFORE_D2 = 12 * HOUR;

/**
 * The no-show chain for a trial at `trialEpoch`, evaluated at `now`. Pure.
 *
 *  - no_show_hoy at class start + 2 h (quiet-shifted to 08:00 for a late
 *    class) — never before, so a lead still on the mat in an 11 am–1 pm class
 *    is not asked "¿qué pasó?" at 12:01 (…7571). Marked late, it still goes on
 *    the next tick (day-aware copy) unless d2 is less than 12 h away.
 *  - no_show_d2 / no_show_d7 at 11:00 CDMX, trial date + 2 / + 7 days, when
 *    still in the future.
 * Anchored on the TRIAL, so re-running it can never walk a date forward.
 */
export function computeNoShowSequence(trialEpoch: number, now: number): NoShowStep[] {
  if (!Number.isFinite(trialEpoch)) return [];
  const d2 = morningAfter(trialEpoch, 2);
  const d7 = morningAfter(trialEpoch, 7);
  const steps: NoShowStep[] = [];
  const hoy = shiftOutOfQuiet(trialEpoch + NO_SHOW_DELAY);
  if (now < d2 - HOY_LATEST_BEFORE_D2) steps.push({ kind: "no_show_hoy", dueAt: hoy });
  if (d2 > now) steps.push({ kind: "no_show_d2", dueAt: d2 });
  if (d7 > now) steps.push({ kind: "no_show_d7", dueAt: d7 });
  return steps;
}

/** How long after class START the first no-show touch waits. */
export const NO_SHOW_DELAY = 2 * HOUR;

/**
 * v1 second no-show touch (kept for callers/tests of the old chain): 11:00 CDMX
 * three days after the missed class, or null when already past. Pure.
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

// ---- day words (pure) ----

const WEEKDAY_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const WEEKDAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * How a message sent at `now` refers to the class at `trialEpoch`: "hoy" on the
 * same CDMX date, "ayer" the next date, "el sábado" further out (EN: today /
 * yesterday / on Saturday). Pure.
 */
export function dayWord(trialEpoch: number, now: number, lang: "es" | "en"): string {
  const t = cdmxDateStr(trialEpoch);
  if (t === cdmxDateStr(now)) return lang === "en" ? "today" : "hoy";
  if (t === cdmxDateStr(now - DAY)) return lang === "en" ? "yesterday" : "ayer";
  const p = cdmxParts(trialEpoch);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay();
  return lang === "en" ? `on ${WEEKDAY_EN[wd]}` : `el ${WEEKDAY_ES[wd]}`;
}

// ---- copy (pure) ----

/** Greeting name, qualification first (a name the lead TOLD us), push name second. */
export function postTrialName(contact: Contact | null): string {
  const q = parseQualification(contact);
  return greetingName(q.name) || greetingName(contact?.name);
}

/** How the parent's copy names the child: their name, else a band noun. */
export function kidNoun(contact: Contact | null, band: ProgramBand, lang: "es" | "en"): string {
  const child = greetingName(parseQualification(contact).child_name);
  if (child) return child;
  if (lang === "en") return band === "baby" ? "your baby" : band === "teens" ? "your teen" : "your little one";
  return band === "baby" ? "su bebé" : band === "teens" ? "su hijo o hija" : "su peque";
}

function langOf(contact: Contact | null): "es" | "en" {
  return contact?.lang === "en" ? "en" : "es";
}

type CopyKey = keyof typeof CLIENT.copy;

/** CLIENT.copy[key] — the first key present — with a fallback key (a client
 *  without the v2 / per-program lines). */
function line(key: string | string[], fallback: CopyKey): string {
  const c = CLIENT.copy as unknown as Record<string, string | undefined>;
  for (const k of Array.isArray(key) ? key : [key]) {
    if (c[k]) return c[k]!;
  }
  return CLIENT.copy[fallback] as string;
}

/** The three copy sequences of the post-trial / no-show chains. */
export type ChainVariant = "adults" | "kids" | "baby";

/** Pure. baby → Baby Fight Club copy; mini / kids / teens → kids; adults. */
export function chainVariant(band: ProgramBand): ChainVariant {
  const p = bandProgram(band);
  return p === "baby" ? "baby" : p === "adults" ? "adults" : "kids";
}

/** client.mjs copy keys to try, most specific first: base + Baby → Kids → base. */
function variantKeys(base: string, v: ChainVariant, sfx: "Es" | "En"): string[] {
  if (v === "adults") return [`${base}${sfx}`];
  if (v === "kids") return [`${base}Kids${sfx}`];
  return [`${base}Baby${sfx}`, `${base}Kids${sfx}`];
}

/** Template name suffix per variant: post_trial_d3 / _kids / _baby. */
export function variantTemplateSuffix(v: ChainVariant): string {
  return v === "adults" ? "" : `_${v}`;
}

/**
 * Body for one attended-chain touch. Adults read singular, parents plural
 * ("¿cómo les fue?"); d0 says hoy/ayer from the real send moment. Pure over
 * (contact, kind, now) — `band` defaults to the contact's.
 */
export function postTrialCopy(
  contact: Contact | null,
  kind: PostTrialKind,
  campaignName: string | null = null,
  ayer = false,
  opts: { band?: ProgramBand; trialEpoch?: number | null; now?: number } = {},
): string {
  const lang = langOf(contact);
  const en = lang === "en";
  const band = opts.band ?? bandForContact(contact, campaignName);
  const v = chainVariant(band);
  const who = nameSuffix(postTrialName(contact));
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const trial = opts.trialEpoch ?? null;
  const isAyer = trial !== null ? cdmxDateStr(trial) !== cdmxDateStr(now) : ayer;
  const day = trial !== null ? dayWord(trial, now, lang) : isAyer ? (en ? "yesterday" : "ayer") : en ? "today" : "hoy";
  const link = withAttribution(
    CLIENT.links.schedule ?? CLIENT.links.booking,
    attributionFor(contact, campaignName),
  );
  const kid = kidNoun(contact, band, lang);
  const sfx = en ? "En" : "Es";
  let template: string;
  switch (kind) {
    case "post_trial_d0":
      template = v !== "adults"
        ? line(variantKeys("postTrialD0", v, sfx), en ? "postTrialD0En" : "postTrialD0Es")
        : isAyer
          ? (en ? CLIENT.copy.postTrialD0AyerEn : CLIENT.copy.postTrialD0AyerEs)
          : (en ? CLIENT.copy.postTrialD0En : CLIENT.copy.postTrialD0Es);
      break;
    // Legacy d2 / d5 rows (armed before v2) read the d3 / d6 copy of the lead's
    // program — the old lines were adult-only ("¿cómo amaneció el cuerpo?").
    case "post_trial_d3":
    case "post_trial_d2":
      template = line(variantKeys("postTrialD3", v, sfx), en ? "postTrialD2En" : "postTrialD2Es");
      break;
    default:
      template = line(variantKeys("postTrialD6", v, sfx), en ? "postTrialD5En" : "postTrialD5Es");
  }
  const cta =
    kind === "post_trial_d3" || kind === "post_trial_d2"
      ? slotCta(
          bandProgram(band),
          lang,
          bandSlot(contact, campaignName, band, now),
          withAttribution(programLink(bandProgram(band)), attributionFor(contact, campaignName)),
          now,
        )
      : "";
  return renderCopy(fill(template, { day, kid }), { who, link, cta }).trim();
}

/**
 * Body for a no-show touch: day-aware ("hoy / ayer / el sábado") + ONE concrete
 * slot of the lead's band (never an adult slot for a minor, never Kids for a
 * mini/baby), singular for adults and plural for parents. d7 is the goodbye
 * (no slot). Pure over (contact, step, trial, now).
 */
export function noShowTouchCopy(
  contact: Contact | null,
  step: "hoy" | "d2" | "d7",
  trialEpoch: number | null,
  now: number,
  campaignName: string | null = null,
  band: ProgramBand = bandForContact(contact, campaignName),
): string {
  const lang = langOf(contact);
  const v = chainVariant(band);
  const sfx = lang === "en" ? "En" : "Es";
  const who = nameSuffix(postTrialName(contact));
  const day = trialEpoch !== null ? dayWord(trialEpoch, now, lang) : lang === "en" ? "recently" : "el otro día";
  const program = bandProgram(band);
  const link = withAttribution(programLink(program), attributionFor(contact, campaignName));
  // Since 2026-10-15 every no-show touch points at the booking page ({link});
  // {cta} stays only for a client whose copy still uses the slot proposal.
  const cta =
    step === "d7" ? "" : slotCta(program, lang, bandSlot(contact, campaignName, band, now), link, now);
  const fallback: CopyKey = lang === "en" ? "noShowEn" : "noShowEs";
  const base = step === "hoy" ? "noShowHoy" : step === "d2" ? "noShowD2" : "noShowD7";
  return renderCopy(fill(line(variantKeys(base, v, sfx), fallback), { day, kid: kidNoun(contact, band, lang) }), { who, cta, link }).trim();
}

/** "Muay Thai el sábado 18 a las 10:00 am" — the {{2}} of the slot templates. */
export function slotParam(slot: NextSlot | null, now: number, lang: "es" | "en"): string | null {
  if (!slot) return null;
  return `${slot.name ?? disciplineLabel(slot.discipline)} ${formatSlotLabel(slot, now, lang)}`;
}

/** The v2 placeholders renderCopy does not know: {day} and {kid}. */
function fill(template: string, vars: { day: string; kid: string }): string {
  return template.replaceAll("{day}", vars.day).replaceAll("{kid}", vars.kid);
}

/** " Nombre" (leading space) or "" — the shape every {who} placeholder expects. */
function nameSuffix(name: string): string {
  return name ? ` ${name}` : "";
}

/** Template base name for a kind (the sender appends _es / _en). Kids and baby
 *  leads take the `_kids` / `_baby` twins (docs/templates.md §11–§15, submitted
 *  by cron/template-seed-chains.ts). d0 for kids / baby has no `_ayer` twin
 *  (those bodies carry no day word). Legacy d2 / d5: adults keep the approved
 *  v1 templates; kids / baby get the d3 / d6 twin of their program. */
export function postTrialTemplateName(
  kind: FollowUpKindHere,
  note: string | null = null,
  band: ProgramBand = "adults",
): string {
  const v = chainVariant(band);
  const fam = variantTemplateSuffix(v);
  switch (kind) {
    case NO_SHOW_KIND:
    case "no_show_d2":
      return `no_show_d2${fam}`;
    case "no_show_hoy":
      return `no_show_hoy${fam}`;
    case "no_show_d7":
      return `no_show_d7${fam}`;
    case "post_trial_d3":
      return `post_trial_d3${fam}`;
    case "post_trial_d6":
      return `post_trial_d6${fam}`;
    case "post_trial_d0":
      if (v !== "adults") return `post_trial_d0${fam}`;
      return isAyerNote(note) ? "post_trial_d0_ayer" : "post_trial_d0";
    case "post_trial_d2":
      return v === "adults" ? "post_trial_d2" : `post_trial_d3${fam}`;
    case "post_trial_d5":
      return v === "adults" ? "post_trial_d5" : `post_trial_d6${fam}`;
    default:
      return kind;
  }
}

// ---- "🙋 Yo le escribo" claim (Slack card on the attended lead) ----
//
// Staff almost always follow up from their OWN phone, which the bot cannot see:
// no inbound arrives, so every send-time stop condition stays false and the bot
// writes on top of a human. The claim button IS that missing signal. It kills
// only the d0 touch — d3/d6 keep running under their normal stop conditions,
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

const TAIL = "+3d y +6d siguen si no responde ni se marca resultado.";

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
    `armado (hoy, +3d, +6d). Quien cerró: escríbele hoy.`
  );
}

// ---- send-time processing ----

export type PostTrialOutcome =
  /** `task` ⇒ post this text to the Slack TASK channel (end of the no-show chain). */
  | { outcome: "sent"; task?: string }
  /** `stopChain` ⇒ the remaining rows of this chain are pointless now. */
  | { outcome: "cancelled"; stopChain?: boolean; task?: string }
  | { outcome: "skipped_optout" }
  /** `missing` ⇒ Meta says the template does not exist (132001), i.e. it is not
   *  approved yet; anything else is our bug and `error` carries Graph's words.
   *  Only the v1 kinds report this (v2 kinds skip silently with a log line). */
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
  /** Re-read the Airtable record behind a no-show row. Absent ⇒ no record gate. */
  getRecord?: (env: Env, recordId: string) => Promise<BookingRecord | null>;
  /** Arm a row (the first no-show touch arms d2 / d7). Absent ⇒ nothing armed. */
  schedule?: (
    env: Env,
    input: { phone: string; kind: string; dueAt: number; airtableRecordId: string; note: string | null },
  ) => Promise<void>;
}

/**
 * Pure. May a no-show touch go out, given the Airtable record re-read at send
 * time and the trial the chain was armed for? Only an empty `Resultado` or a
 * plain "No asistió" lets it through: attended / enrolled / Reprogramó /
 * Perdido, a cleared date, a moved date, or a deleted record all stop it.
 */
export function noShowRecordGate(
  rec: BookingRecord | null,
  armedTrial: number | null,
): { send: boolean; why: string } {
  if (!rec) return { send: false, why: "record_gone" };
  if (!rec.trialDateTimeIso) return { send: false, why: "date_cleared" };
  const t = Math.floor(Date.parse(rec.trialDateTimeIso) / 1000);
  if (armedTrial !== null && Number.isFinite(t) && Math.abs(t - armedTrial) > 60) {
    return { send: false, why: "moved" };
  }
  const action = classifyResult(rec.result);
  if (action === "attended" || action === "enrolled") return { send: false, why: action };
  if (isLostResult(rec.result)) return { send: false, why: "lost" };
  if (normalizeResult(rec.result).includes("reprogram")) return { send: false, why: "rescheduled" };
  return { send: true, why: "ok" };
}

function isNoShowKind(kind: FollowUpKindHere): boolean {
  return kind === NO_SHOW_KIND || (NO_SHOW_KINDS as readonly string[]).includes(kind);
}

/** Strip the "|attempts:N" retry suffix so a note can be copied to new rows. */
function bareNote(note: string | null | undefined): string | null {
  const s = (note ?? "").replace(/\s*\|?attempts:\d+$/, "");
  return s || null;
}

/**
 * Send-time processing for a due post-trial / no-show row. Every stop condition
 * is re-checked here rather than at arming time, because the world moves
 * between the two: the lead may have signed up, opted out, written in (then
 * the brain and the humans own the conversation), been taken over by a human,
 * or booked a NEW class — and for the no-show chain, the front desk may have
 * marked the class after all (the Airtable record is re-read).
 *
 * Free-form first; the per-kind template is the closed-window fallback. A v2
 * template Meta does not know yet is skipped with a log line (never loudly,
 * never the old "ayer" template on the wrong day).
 */
export async function processPostTrial(
  env: Env,
  row: { phone: string; kind: FollowUpKindHere; created_at: number; note?: string | null },
  deps: PostTrialDeps,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<PostTrialOutcome> {
  const noShow = isNoShowKind(row.kind);
  const chain = decodeChainNote(row.note);

  const contact = await getContact(env.DB, row.phone);
  if (!contact) return { outcome: "cancelled" };
  if (contact.status === "opted_out") return { outcome: "skipped_optout" };
  // Enrolled since the row was armed (student sync, Airtable, or a human).
  if (contact.status === "student") return { outcome: "cancelled", stopChain: true };
  if (contact.human_override_until && contact.human_override_until > nowEpoch) {
    // A human is on this conversation right now — skip this touch only.
    return { outcome: "cancelled" };
  }
  // The lead wrote in: they are in a real conversation now. For the first
  // no-show touch (armed together with the booking) only messages since the
  // class started count — "ok, ahí nos vemos" the night before is not a stop.
  const since = row.kind === "no_show_hoy" && chain.trial !== null ? chain.trial : row.created_at;
  if ((contact.last_inbound_at ?? 0) > since) {
    return { outcome: "cancelled", stopChain: true };
  }
  // A new class on the calendar makes the whole chain obsolete.
  if (await hasScheduledFollowupOfKind(env.DB, row.phone, BOOKING_KINDS)) {
    return { outcome: "cancelled", stopChain: true };
  }
  if (bookingMarkerLive(await kvGet(env.DB, bookingRecordedKey(row.phone)), nowEpoch)) {
    return { outcome: "cancelled", stopChain: true };
  }
  // No-show chain: Airtable is the truth about whether they came.
  if (noShow && chain.rec && /^rec/.test(chain.rec) && deps.getRecord) {
    const rec = await deps.getRecord(env, chain.rec.split("#")[0] ?? chain.rec);
    const gate = noShowRecordGate(rec, chain.trial);
    if (!gate.send) {
      console.log(`[post-trial] ${row.kind} ${row.phone} stopped: ${gate.why}`);
      return { outcome: "cancelled", stopChain: true };
    }
  }

  const campaign =
    contact.campaign_id !== null && deps.campaignName
      ? await deps.campaignName(env, contact.campaign_id)
      : null;
  const band = bandForContact(contact, campaign);
  const lang = langOf(contact);
  const step: "hoy" | "d2" | "d7" | null = !noShow
    ? null
    : row.kind === "no_show_hoy"
      ? "hoy"
      : row.kind === "no_show_d7"
        ? "d7"
        : "d2";
  const body = step
    ? noShowTouchCopy(contact, step, chain.trial, nowEpoch, campaign, band)
    : postTrialCopy(contact, row.kind as PostTrialKind, campaign, isAyerNote(row.note), {
        band,
        trialEpoch: chain.trial,
        now: nowEpoch,
      });

  const finish = async (sent: boolean): Promise<PostTrialOutcome> => {
    // The first touch hands over to d2 / d7 (keyed per phone + trial date, so
    // a re-run or a second Airtable row never arms a second chain).
    if (row.kind === "no_show_hoy" && chain.trial !== null && deps.schedule) {
      for (const s of computeNoShowSequence(chain.trial, nowEpoch)) {
        if (s.kind === "no_show_hoy") continue;
        await deps.schedule(env, {
          phone: row.phone,
          kind: s.kind,
          dueAt: s.dueAt,
          airtableRecordId: chainKey("ns", chain.trial),
          note: bareNote(row.note),
        });
      }
    }
    const task =
      row.kind === "no_show_d7"
        ? `Marcar Perdido: ${(contact.name ?? "").trim() || postTrialName(contact) || "Lead"} · ${row.phone}`
        : undefined;
    const base: PostTrialOutcome = sent ? { outcome: "sent" } : { outcome: "cancelled" };
    return task ? { ...base, task } : base;
  };

  try {
    await deps.sendText(env, row.phone, body);
    return await finish(true);
  } catch (err) {
    if (!deps.isWindowClosed(err)) throw err;
  }

  // ---- window closed: template fallback ----
  const variant = chainVariant(band);
  // v1 templates Meta approved long ago: a failure there is loud. Everything
  // else is a v2 / per-program twin that may still be pending → quiet skip.
  const v1 =
    variant === "adults" &&
    (row.kind === "post_trial_d2" || row.kind === "post_trial_d5" || row.kind === "post_trial_d0");
  const name = templateFirstName(postTrialName(contact), lang);
  let base: string;
  let params: string[] = [name];
  if (row.kind === "post_trial_d0" && variant === "adults") {
    const later = chain.trial !== null ? !sameCdmxDate(chain.trial, nowEpoch) : isAyerNote(row.note);
    base = later ? "post_trial_d0_ayer" : "post_trial_d0";
  } else {
    base = postTrialTemplateName(row.kind, row.note ?? null, band);
    if (step === "hoy" && (chain.trial === null || !sameCdmxDate(chain.trial, nowEpoch))) {
      // no_show_hoy says "hoy": on any other day there is no right template.
      console.log(`[post-trial] ${row.kind} ${row.phone}: window closed, not the class day — skipped`);
      return finish(false);
    }
    if (step === "hoy" || step === "d2") {
      // {{2}} = the program's booking page (adults vs kids / baby), 2026-10-15.
      params = [name, withAttribution(programLink(bandProgram(band)), attributionFor(contact, campaign))];
    }
    // post_trial_d3 / d6 (and kids / baby legacy d2 / d5): name only since
    // 2026-10-15 — no slot offer, no schedule link.
  }
  const template = deps.templateName(base, lang);
  try {
    await deps.sendTemplate(
      env,
      row.phone,
      template,
      lang,
      params.length === 1 ? [nameParam(postTrialName(contact), lang)] : [bodyParams(params, lang)],
    );
    return await finish(true);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (v1) {
      return { outcome: "template_missing", template, missing: isTemplateMissingError(error), error };
    }
    // v2 templates are drafts until Meta approves them (docs/templates.md):
    // skip quietly, never fail loudly.
    console.log(`[post-trial] ${row.kind} ${row.phone}: template ${template} not sent (${error}) — skipped`);
    return finish(false);
  }
}
