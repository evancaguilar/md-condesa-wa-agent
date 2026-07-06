// Anthropic tool definitions for the brain, plus a pure slot validator used by
// the executor to reject nonexistent class slots (so the model can retry with a
// corrective tool_result). Pure module — safe to unit-test.

import { SLOTS, type Slot } from "./slots.gen.js";

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
    "Terminal tool — end EVERY turn with exactly one call. Sends (or drafts) the reply to the lead on WhatsApp. Mirror the lead's language. Set confidence 'low' when unsure, when the answer requires a price/policy not in the KB, or when anything feels off — 'low' routes to human approval instead of auto-sending.",
  input_schema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "The WhatsApp reply text. Short, warm, light emoji, no walls of text. In the lead's language (es-MX default).",
      },
      language: { type: "string", enum: ["es", "en"] },
      confidence: {
        type: "string",
        enum: ["high", "low"],
        description:
          "'high' only when fully grounded in the KB and safe to auto-send. Otherwise 'low'.",
      },
      escalation_reason: {
        type: "string",
        description:
          "Optional short note for the human reviewer when confidence is 'low'.",
      },
    },
    required: ["message", "language", "confidence"],
    additionalProperties: false,
  },
};

const bookTrial: AnthropicTool = {
  name: "book_trial",
  description:
    "Book a trial class into Airtable. Only call when you have a concrete day AND time the lead agreed to, and a name. Resolve relative dates ('hoy', 'mañana', 'el sábado') using the <context> date before calling. The executor validates the slot against the real schedule and will tell you to retry if no such class exists. After a successful booking you still end the turn with send_reply — or the executor pairs the booking with your followupMessage.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Lead's first name (or full name)." },
      discipline: {
        type: "string",
        description:
          "One of: jiu, muay, mma, box, baby (Jiu-Jitsu, Muay Thai, MMA, Boxing, Baby Fight Club).",
        enum: ["jiu", "muay", "mma", "box", "baby"],
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

/** All tool definitions, in a stable order (stable for prompt caching). */
export const TOOLS: readonly AnthropicTool[] = [
  sendReply,
  bookTrial,
  escalateToHuman,
  setFollowup,
];

// ---- slot validation -----------------------------------------------------

/** Map a discipline label the model might emit to the compact schedule key. */
export function normalizeDiscipline(input: string): string {
  const s = input.trim().toLowerCase();
  if (/jiu|bjj|jitsu|grappl/.test(s)) return "jiu";
  if (/muay|thai/.test(s)) return "muay";
  if (/mma|mixed/.test(s)) return "mma";
  if (/box|boxe/.test(s)) return "box";
  if (/baby/.test(s)) return "baby";
  return s;
}

/**
 * Weekday index (0=Mon … 6=Sun) for a YYYY-MM-DD date, interpreted as a plain
 * calendar date in America/Mexico_City. We build the date at UTC noon to dodge
 * DST/offset edge cases, then read getUTCDay(); the day-of-week of a calendar
 * date is offset-independent, so this is safe and needs no timezone lib.
 */
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
 * True iff a class of `discipline`/`audience` runs on the weekday of `trialDate`
 * at `trialTime`. On failure, returns a corrective reason (+ same-day
 * alternatives) so the executor can hand the model a useful tool_result.
 *
 * `schedule` defaults to the generated SLOTS but is injectable for tests.
 */
export function validateSlot(
  trialDate: string,
  trialTime: string,
  audience: string,
  discipline: string,
  schedule: readonly Slot[] = SLOTS,
): ValidateResult {
  const wd = weekdayIndex(trialDate);
  if (wd === null) {
    return { ok: false, reason: `Invalid trial_date '${trialDate}' (expected YYYY-MM-DD).` };
  }
  const disc = normalizeDiscipline(discipline);
  const time = trialTime.trim();
  const aud = audience.trim().toLowerCase();

  const sameDayDisc = schedule.filter(
    (s) => s.weekday === wd && s.discipline === disc && s.audience === aud,
  );

  const exact = sameDayDisc.find((s) => s.time === time);
  if (exact) return { ok: true };

  const alternatives = [...new Set(sameDayDisc.map((s) => s.time))].sort();
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
