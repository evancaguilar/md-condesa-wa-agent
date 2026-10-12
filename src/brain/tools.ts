// Anthropic tool definitions for the brain, plus a pure slot validator used by
// the executor to reject nonexistent class slots (so the model can retry with a
// corrective tool_result). Pure module — safe to unit-test.

import { SLOTS, type Slot } from "./slots.gen.js";
import { CLIENT } from "../client.gen.js";
import type { ClosedDate } from "../client-config.js";
import { bandLabel, slotGroup, slotMatchesBand, type ProgramBand } from "../services/age-band.js";

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

// ---- tool definitions (spec §Model tools) --------------------------------

const sendReply: AnthropicTool = {
  name: "send_reply",
  description:
    "Terminal tool — end EVERY turn with exactly one call. Sends (or drafts) the reply to the lead on WhatsApp. Mirror the lead's language. Rate yourself with `sureness` (0–100): >=75 sends immediately, 25–74 waits for a human up to one hour and then sends anyway, <25 never auto-sends. Calibrate with the sureness checklist in the system prompt.",
  input_schema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "The WhatsApp reply text. Short, warm, light emoji, no walls of text. In the lead's language (es-MX default).",
      },
      language: { type: "string", enum: ["es", "en"] },
      sureness: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          "How sure you are the answer is correct and complete, 0–100. >=75 sends without review; 25–74 waits for a human up to 1 hour, then sends anyway; <25 never auto-sends. Calibrate with the checklist in the system prompt.",
      },
      confidence: {
        type: "string",
        enum: ["high", "low"],
        description:
          "Legacy field, DERIVED from `sureness` (>=75 ⇒ 'high', else 'low'). Set it to match your sureness; it is kept only for wire compatibility — `sureness` is what decides whether the reply sends, waits, or stays with a human.",
      },
      escalation_reason: {
        type: "string",
        description:
          "Optional short note for the human reviewer when confidence is 'low'. Start it with the literal token `opt_out` when the lead asks to stop receiving messages (nothing is sent; the baja is applied), or `complaint` when the lead complains / is upset (a human takes it; never sent automatically).",
      },
      awaiting_reply: {
        type: "boolean",
        description:
          "Is the lead left waiting for an answer? false ONLY when the lead is closing the conversation (thanks / ok / 'sería todo' / bye) and your message is a mere pleasantry — going silent after it would be natural. true whenever the lead asked something, is mid-scheduling, or expects information.",
      },
      lead_name: {
        type: "string",
        description:
          "ONLY when the lead TOLD you their name in this conversation ('soy Luis', 'me llamo Ana', 'mi nombre es…') and it differs from — or is missing in — the <context> name: their name as they gave it (first name is fine). This corrects the CRM, which otherwise keeps their WhatsApp profile name. Omit in every other case; never guess it from the profile name.",
      },
      child_name: {
        type: "string",
        description: "ONLY when the lead told you the child's name in this conversation. Omit otherwise.",
      },
      child_age_years: {
        type: "number",
        description:
          "ONLY when the lead told you the child's age: years, fractional allowed (18 meses = 1.5, 'casi 5' = 4.9). It decides the program. Omit otherwise — never guess.",
      },
      preferred_days: {
        type: "array",
        items: { type: "string", enum: ["lun", "mar", "mie", "jue", "vie", "sab", "dom"] },
        description: "Days the lead SAID work for them ('solo sábados' → [\"sab\"]). Omit if they said nothing.",
      },
      declined_days: {
        type: "array",
        items: { type: "string", enum: ["lun", "mar", "mie", "jue", "vie", "sab", "dom"] },
        description:
          "Days the lead SAID don't work ('entre semana no' → [\"lun\",\"mar\",\"mie\",\"jue\",\"vie\"]). Never offer them again. Omit if they said nothing.",
      },
    },
    required: ["message", "language", "sureness", "confidence", "awaiting_reply"],
    additionalProperties: false,
  },
};

const bookTrial: AnthropicTool = {
  name: "book_trial",
  description:
    "Book a trial class into Airtable. Only call when you have a concrete day AND time the lead agreed to, and a name. Resolve relative dates ('hoy', 'mañana', 'el sábado') using the <context> date before calling. The executor validates the slot against the real schedule and will tell you to retry if no such class exists. After a successful booking you still end the turn with send_reply — or the executor pairs the booking with your followupMessage. Call book_trial ONCE PER PERSON. Two people coming (mom + son, two friends) = two calls in the same turn, each with that person's name (and their own date/time if different). Put the confirmation covering EVERYONE in the followup_message of the LAST call.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Lead's first name (or full name). For kid/baby bookings this is the PARENT (the person writing)." },
      child_name: {
        type: "string",
        description:
          "REQUIRED for kid/baby bookings: the child's name. Ask for both the parent's and the child's name before booking a minor.",
      },
      child_age: {
        type: "number",
        description:
          "Kid/baby bookings: the child's age in YEARS as the lead stated it (fractional ok: 18 meses = 1.5). The executor checks the class belongs to that age group (Baby Fight Club <3, Mini Muay Thai 3–5, Kids 6–12, Teens 13–17).",
      },
      discipline: {
        type: "string",
        description: `One of: ${CLIENT.services.map((s) => s.key).join(", ")} (${CLIENT.services.map((s) => s.label).join(", ")}).`,
        enum: CLIENT.services.map((s) => s.key),
      },
      audience: { type: "string", enum: ["adult", "kid"] },
      trial_date: {
        type: "string",
        description: "YYYY-MM-DD in America/Mexico_City.",
      },
      trial_time: {
        type: "string",
        description: "HH:mm 24h in America/Mexico_City (e.g. 18:00).",
      },
      phone_confirmed: {
        type: "boolean",
        description: "True if the WhatsApp number is the booking contact.",
      },
      followup_message: {
        type: "string",
        description:
          "The confirmation message to send the lead after booking (their language).",
      },
    },
    required: [
      "name",
      "discipline",
      "audience",
      "trial_date",
      "trial_time",
      "followup_message",
    ],
    additionalProperties: false,
  },
};

const escalateToHuman: AnthropicTool = {
  name: "escalate_to_human",
  description:
    "Hand off to a human immediately. Use for complaints, refunds, injuries, anger, price negotiation, or anything outside the KB you shouldn't answer. This pauses the bot for this conversation.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Short reason (e.g. 'price negotiation', 'injury complaint').",
      },
      summary: {
        type: "string",
        description: "1-2 sentence summary of the conversation for the human.",
      },
    },
    required: ["reason", "summary"],
    additionalProperties: false,
  },
};

const setFollowup: AnthropicTool = {
  name: "set_followup",
  description:
    "Schedule a custom follow-up message for later (e.g. the lead says 'les escribo la próxima semana'). Does not send now.",
  input_schema: {
    type: "object",
    properties: {
      hours_from_now: {
        type: "number",
        description: "When to follow up, in hours from now.",
      },
      note: {
        type: "string",
        description: "What to say / remember for the follow-up.",
      },
    },
    required: ["hours_from_now", "note"],
    additionalProperties: false,
  },
};

/**
 * All tool definitions, in a stable order (stable for prompt caching).
 * book_trial only exists when the client has the booking feature — companion
 * clients (no scheduling) never see it.
 */
export const TOOLS: readonly AnthropicTool[] = CLIENT.features.booking
  ? [sendReply, bookTrial, escalateToHuman, setFollowup]
  : [sendReply, escalateToHuman, setFollowup];

// ---- slot validation -----------------------------------------------------

/**
 * Map a service label the model might emit to the compact schedule key, using
 * the client's per-service match patterns (clients/<id>/client.mjs).
 */
export function normalizeDiscipline(input: string): string {
  const s = input.trim().toLowerCase();
  for (const svc of CLIENT.services) {
    if (svc.match && new RegExp(svc.match).test(s)) return svc.key;
  }
  return s;
}

/** True iff `key` is one of the client's bookable service keys. */
export function isKnownDiscipline(key: string): boolean {
  return CLIENT.services.some((svc) => svc.key === key);
}

/**
 * Weekday index (0=Mon … 6=Sun) for a YYYY-MM-DD date, interpreted as a plain
 * calendar date in America/Mexico_City. We build the date at UTC noon to dodge
 * DST/offset edge cases, then read getUTCDay(); the day-of-week of a calendar
 * date is offset-independent, so this is safe and needs no timezone lib.
 */
/** Pure. The closure row for a CDMX date, or null when the business is open. */
export function closedDateInfo(
  dateYmd: string,
  closedDates: readonly ClosedDate[] = CLIENT.closedDates ?? [],
): ClosedDate | null {
  const d = dateYmd.trim().slice(0, 10);
  return closedDates.find((c) => c.date === d) ?? null;
}

export function weekdayIndex(dateYmd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  if (Number.isNaN(dt.getTime())) return null;
  // getUTCDay: 0=Sun … 6=Sat → convert to 0=Mon … 6=Sun.
  return (dt.getUTCDay() + 6) % 7;
}

export interface ValidateResult {
  ok: boolean;
  /** Corrective message for the model when ok=false. */
  reason?: string;
  /** Alternative times for the same discipline+audience on that weekday. */
  alternatives?: string[];
}

/**
 * True iff a BOOKABLE class of `discipline`/`audience` runs on the weekday of
 * `trialDate` at `trialTime`. On failure, returns a corrective reason (+
 * same-day alternatives) so the executor can hand the model a useful
 * tool_result. Slots flagged `trial: false` exist in the schedule but never take
 * a trial — they get their own reason instead of a misleading "no such class",
 * and never show up as an alternative. (No generated slot carries the flag since
 * the owner reopened the Muay Thai sparring hours to trials on 2026-08-25; the
 * branch below stays as the generic handler for any future closed class.)
 *
 * `schedule` defaults to the generated SLOTS but is injectable for tests.
 */
/**
 * Every clock time a discipline runs at ANY point in the week (both audiences).
 * Box, for instance, is only ever 14:00 and 21:00 — never a morning hour.
 */
export function disciplineTimes(
  discipline: string,
  schedule: readonly Slot[] = SLOTS,
): Set<string> {
  const disc = normalizeDiscipline(discipline);
  const out = new Set<string>();
  for (const s of schedule) if (s.discipline === disc) out.add(s.time);
  return out;
}

/**
 * Does this discipline NEVER run at this clock time, on any day, for anyone?
 *
 * A day-independent check, which is the point: pairing a day with an hour out
 * of free-form copy is unreliable (see guardUnverifiedSlotClaim), but "Box at
 * 7 am" is wrong no matter which day it was attached to. Unknown disciplines
 * and unparseable times are never flagged.
 */
export function disciplineNeverRunsAt(
  discipline: string,
  time: string,
  schedule: readonly Slot[] = SLOTS,
): boolean {
  const disc = normalizeDiscipline(discipline);
  if (!isKnownDiscipline(disc)) return false;
  const times = disciplineTimes(disc, schedule);
  return times.size > 0 && !times.has(time.trim());
}

export function validateSlot(
  trialDate: string,
  trialTime: string,
  audience: string,
  discipline: string,
  schedule: readonly Slot[] = SLOTS,
  closedDates: readonly ClosedDate[] = CLIENT.closedDates ?? [],
): ValidateResult {
  const wd = weekdayIndex(trialDate);
  if (wd === null) {
    return { ok: false, reason: `Invalid trial_date '${trialDate}' (expected YYYY-MM-DD).` };
  }
  const closed = closedDateInfo(trialDate, closedDates);
  if (closed) {
    return {
      ok: false,
      reason: `The academy is CLOSED on ${trialDate}${closed.reason ? ` (${closed.reason})` : ""} — no classes at all that day. Offer the next open day from the schedule in the KB.`,
    };
  }
  const disc = normalizeDiscipline(discipline);
  const time = trialTime.trim();
  const aud = audience.trim().toLowerCase();

  if (!isKnownDiscipline(disc)) {
    // "defensa personal" is the recurring one: it's a benefit of every
    // discipline, not a class on the grid, and the model sometimes books it.
    const keys = CLIENT.services.map((s) => s.key);
    const selfDefense =
      keys.includes("jiu") && keys.includes("muay")
        ? ` Self-defense ("defensa personal", incl. para mujeres) is taught through ALL our disciplines — they are the foundations of MMA, the best self-defense there is. Pick jiu, muay, mma or box and retry.`
        : "";
    return {
      ok: false,
      reason: `'${discipline}' is not a bookable discipline. Valid: ${keys.join(", ")}.${selfDefense}`,
    };
  }

  const sameDayDisc = schedule.filter(
    (s) => s.weekday === wd && s.discipline === disc && s.audience === aud,
  );
  const bookable = sameDayDisc.filter((s) => s.trial !== false);

  const exact = bookable.find((s) => s.time === time);
  if (exact) return { ok: true };

  const alternatives = [...new Set(bookable.map((s) => s.time))].sort();

  // The requested hour exists but is closed to trials — say so, or the model
  // just re-proposes it (the KB lists it) or tells the lead it doesn't exist.
  // Live since 2026-10-03: sáb 11 Muay Thai sparring and mié 20 MMA sparring.
  if (sameDayDisc.some((s) => s.time === time && s.trial === false)) {
    const tail = alternatives.length
      ? ` Same-day trial options: ${alternatives.join(", ")} CDMX.`
      : ` Offer a different day or discipline from the schedule in the KB.`;
    return {
      ok: false,
      reason: `The ${disc} class at ${time} on ${trialDate} is a SPARRING session — never book a trial there.${tail}`,
      ...(alternatives.length ? { alternatives } : {}),
    };
  }

  if (alternatives.length === 0) {
    return {
      ok: false,
      reason: `No ${disc} (${aud}) class on ${trialDate}. Offer a different day or discipline from the schedule in the KB.`,
    };
  }
  return {
    ok: false,
    reason: `No ${disc} (${aud}) class at ${time} on ${trialDate}. Same-day options: ${alternatives.join(", ")} CDMX.`,
    alternatives,
  };
}

// ---- age-band validation (2026-10-11) -------------------------------------

const DAY_SHORT_ES = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"] as const;

function groupLabel(g: NonNullable<Slot["group"]>): string {
  return g === "adult" ? "adultos" : bandLabel(g);
}

/**
 * Every trial row of a band across the week, as "lun 15:15 muay" strings in
 * weekday/clock order (deduped over the dual-audience pp mirrors). Pure.
 */
export function bandWeekOptions(band: ProgramBand, schedule: readonly Slot[] = SLOTS): string[] {
  const rows = schedule
    .filter((s) => s.trial !== false && slotMatchesBand(s, band))
    .slice()
    .sort((a, b) => a.weekday - b.weekday || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const out: string[] = [];
  for (const s of rows) {
    const label = `${DAY_SHORT_ES[s.weekday]} ${s.time} ${s.name ?? s.discipline}`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Does the booked class belong to the child's AGE BAND? validateSlot only
 * knows "adult" vs "kid", so a 3-year-old booked into the 4 pm Kids class (or a
 * 4-year-old into Baby Fight Club) sailed through (Liliana / Joss, 2026-09/10).
 * Rows that don't exist at all are validateSlot's job — they pass here.
 * On a mismatch the reason names the band's REAL options (same day first,
 * then the whole week) so the model can re-propose in one go. Pure.
 */
export function validateSlotBand(
  trialDate: string,
  trialTime: string,
  discipline: string,
  band: ProgramBand,
  schedule: readonly Slot[] = SLOTS,
): ValidateResult {
  const wd = weekdayIndex(trialDate);
  if (wd === null) return { ok: true };
  const disc = normalizeDiscipline(discipline);
  const time = trialTime.trim();
  const rows = schedule.filter(
    (s) => s.weekday === wd && s.time === time && s.discipline === disc && s.trial !== false,
  );
  if (rows.length === 0) return { ok: true };
  if (rows.some((s) => slotMatchesBand(s, band))) return { ok: true };

  const booked = groupLabel(slotGroup(rows[0]!));
  const sameDay = [
    ...new Set(
      schedule
        .filter((s) => s.weekday === wd && s.trial !== false && slotMatchesBand(s, band))
        .map((s) => s.time),
    ),
  ].sort();
  const week = bandWeekOptions(band, schedule);
  const tail = sameDay.length
    ? ` Same-day ${bandLabel(band)} options: ${sameDay.join(", ")} CDMX.`
    : "";
  return {
    ok: false,
    reason: `The ${disc} ${time} class on ${trialDate} is for ${booked}, but this child is ${bandLabel(band)} — never book a group outside the child's age.${tail} ${bandLabel(band)} trial classes: ${week.length ? week.join(" · ") : "none on the grid (share the booking link)"}.`,
    ...(sameDay.length ? { alternatives: sameDay } : {}),
  };
}
