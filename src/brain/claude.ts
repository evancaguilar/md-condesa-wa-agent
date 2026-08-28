// The brain: respond(ctx) → BrainResult, backed by the Anthropic Messages API
// (raw fetch, no SDK). Tool-use loop with book_trial validated + executed via an
// injected AirtablePort; usage cost accrued via an injected query closure.
//
// Wiring (workstream E) constructs it once with createBrain(deps) and hands the
// resulting BrainPort to the pipeline.

import type {
  AirtablePort,
  Audience,
  BookingFailureEvent,
  BookingFailureNotifier,
  BookTrialInput,
  BrainPort,
  BrainResult,
  Confidence,
  ConvoContext,
  Language,
  StoredMessage,
} from "../types.js";
import { buildSystem, buildContextBlock, type SystemBlock } from "./prompt.js";
import {
  TOOLS,
  disciplineNeverRunsAt,
  disciplineTimes,
  normalizeDiscipline,
  validateSlot,
  weekdayIndex,
} from "./tools.js";
import {
  CLAIMS_BOOKED,
  countDayTokens,
  parseAllDisciplines,
  parseAllTimes,
  parseBookingHints,
} from "../services/booking-claims.js";
import { CLIENT } from "../client.gen.js";

// ---- deps (injected at construction) -------------------------------------

/** Records daily usage/cost. Bound to D1 by the integrator (see queries.accrueUsage). */
export type AccrueUsage = (
  day: string,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
  costUsd: number,
) => Promise<void>;

export interface BrainDeps {
  apiKey: string;
  /** Compiled KB text (integrator passes src/kb.ts's KB). Kept out of this
   *  module so the brain doesn't import the *.md text module directly. */
  kb: string;
  airtable: AirtablePort;
  accrueUsage: AccrueUsage;
  /**
   * Returns the current overlay text (live-editable dashboard corrections) as a
   * second cached system block. Called once per respond() so edits take effect
   * without rebuilding the brain. Omit (or return "") for no overlay — the
   * system prompt stays a single block. Injected by makeOverlayLoader.
   */
  loadOverlay?: () => Promise<string>;
  /**
   * Called whenever book_trial fails to produce an Airtable record (rejected
   * slot or a bookTrial throw). Observability only: the tool_result handed back
   * to the model is identical with or without it, and any throw is swallowed —
   * a broken notifier must never break the tool loop. Omit in the sandbox.
   */
  onBookingFailure?: BookingFailureNotifier;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ---- Anthropic request constants (spec §Claude brain) --------------------

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";
// 4096: adaptive thinking spends from this same budget (replies stay short).
const MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ITERATIONS = 4;

// Intro pricing (per MTok): input $2, output $10, cache read $0.20, 1h cache write $4.
const PRICE_INPUT = 2 / 1_000_000;
const PRICE_OUTPUT = 10 / 1_000_000;
const PRICE_CACHE_READ = 0.2 / 1_000_000;
const PRICE_CACHE_WRITE_1H = 4 / 1_000_000;

// History budget: last 20 msgs / 48h, capped ~1000 tokens by truncation.
const HISTORY_MAX_MSGS = 20;
const HISTORY_MAX_AGE_S = 48 * 3600;
const HISTORY_TOKEN_CAP = 1000;

// ---- Anthropic wire types (minimal) --------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}
export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}
type AssistantContent = TextContent | ToolUseContent | ThinkingContent;
type UserContent = TextContent | ToolResultContent;

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | UserContent[] | AssistantContent[];
}

export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ApiResponse {
  content: AssistantContent[];
  stop_reason: string;
  usage?: ApiUsage;
}

// ---- brain factory -------------------------------------------------------

export function createBrain(deps: BrainDeps): BrainPort {
  const doFetch = deps.fetchImpl ?? fetch;

  async function respond(ctx: ConvoContext): Promise<BrainResult> {
    // Assemble the system per call so live overlay edits take effect immediately.
    // No overlay loader (or an empty overlay) → single static block, unchanged.
    const overlay = deps.loadOverlay ? await deps.loadOverlay() : "";
    const system = buildSystem(deps.kb, overlay);
    const messages = buildInitialMessages(ctx);

    const usageAcc: Required<ApiUsage> = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    // EVERY successful book_trial of this turn, in call order. The model may
    // book a whole family in one turn (one call per person) — before slice 5
    // only the last one survived, so the earlier people got no Slack FYI and no
    // anti-no-show sequence.
    const pendingBookings: PendingBooking[] = [];
    let pendingFollowup: { hoursFromNow: number; note: string } | null = null;
    // One-shot recovery for the "wrote the reply as prose, skipped send_reply"
    // failure mode that appeared with adaptive thinking (2026-08-25): those
    // text-only turns become sureness-less low drafts that ALWAYS queue and
    // that best-bet can never rescue (the 2:15am no_tool_call card, 2026-08-28).
    let retriedNoTool = false;

    try {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const resp = await callAnthropic(
          doFetch,
          deps.apiKey,
          system,
          messages,
          TOOLS,
          MAX_TOKENS,
          // Adaptive thinking (owner-approved 2026-08-25): the audit's worst
          // model errors were slot math, weekday arithmetic and calibration —
          // exactly what thinking helps. Thinking tokens count against
          // max_tokens, hence the 4096 budget.
          { thinking: { type: "adaptive" }, effort: "medium" },
        );
        accumulate(usageAcc, resp.usage);

        const toolUses = resp.content.filter(
          (b): b is ToolUseContent => b.type === "tool_use",
        );

        // Terminal: send_reply ends the turn regardless of anything else.
        const sendReply = toolUses.find((t) => t.name === "send_reply");
        const escalate = toolUses.find((t) => t.name === "escalate_to_human");

        if (escalate && !sendReply) {
          await flushUsage(deps.accrueUsage, usageAcc);
          return escalateResult(escalate);
        }

        if (sendReply) {
          await flushUsage(deps.accrueUsage, usageAcc);
          // A booking that succeeded this turn + a send_reply → 'book' result
          // (types.ts union carries the followupMessage + recordId on 'book').
          if (pendingBookings.length) return bookResult(pendingBookings);
          return guardUnverifiedSlotClaim(
            guardUnbackedBookingClaim(
              sendResult(sendReply, pendingFollowup),
              ctx.recordedBooking,
            ),
            ctx,
          );
        }

        // No terminal tool yet — process the non-terminal tools, feed results
        // back, and loop. (book_trial / set_followup / escalate-without-send.)
        if (toolUses.length === 0) {
          // Model produced only text and no tool. Retry ONCE with an explicit
          // corrective nudge — recovering the tool call restores sureness and
          // the auto-send/best-bet lanes. A second miss still falls back to a
          // reviewable low draft.
          if (!retriedNoTool && iter < MAX_ITERATIONS - 1) {
            retriedNoTool = true;
            messages.push({ role: "assistant", content: resp.content });
            messages.push({
              role: "user",
              content:
                "[sistema] Tu turno DEBE terminar con una llamada a la herramienta send_reply (con sureness 0-100). Emite AHORA tu respuesta anterior como send_reply, sin cambiar el texto del mensaje.",
            });
            continue;
          }
          await flushUsage(deps.accrueUsage, usageAcc);
          return textFallback(resp, ctx);
        }

        messages.push({ role: "assistant", content: resp.content });
        const results: ToolResultContent[] = [];

        for (const tu of toolUses) {
          if (tu.name === "book_trial") {
            const outcome = await handleBookTrial(
              deps.airtable,
              ctx,
              tu,
              deps.onBookingFailure,
            );
            results.push(outcome.result);
            if (outcome.booking) pendingBookings.push(outcome.booking);
          } else if (tu.name === "set_followup") {
            // Capture the request; the pipeline persists it (the brain has no DB).
            // We still acknowledge so the model proceeds to send_reply.
            const fu = tu.input as { hours_from_now?: number; note?: string };
            const hours = Number(fu.hours_from_now);
            if (Number.isFinite(hours) && hours > 0) {
              pendingFollowup = { hoursFromNow: hours, note: fu.note ?? "" };
            }
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "ok: follow-up noted. Now end the turn with send_reply.",
            });
          } else if (tu.name === "escalate_to_human") {
            // escalate alongside other tools but no send_reply this turn:
            // treat as terminal escalation.
            await flushUsage(deps.accrueUsage, usageAcc);
            return escalateResult(tu);
          } else {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `error: unknown tool '${tu.name}'.`,
              is_error: true,
            });
          }
        }

        messages.push({ role: "user", content: results });
      }

      // Exhausted iterations without a terminal send_reply.
      await flushUsage(deps.accrueUsage, usageAcc);
      if (pendingBookings.length) return bookResult(pendingBookings);
      return {
        action: "draft",
        message: safeApology(ctx.contact.lang),
        language: ctx.contact.lang,
        confidence: "low",
        reason: "max_iterations",
      };
    } catch (err) {
      // callAnthropic already retried once. Return a safe apology draft.
      await flushUsage(deps.accrueUsage, usageAcc).catch(() => {});
      return {
        action: "draft",
        message: safeApology(ctx.contact.lang),
        language: ctx.contact.lang,
        confidence: "low",
        reason: "api_error",
      };
    }
  }

  return { respond };
}

// ---- request / response --------------------------------------------------

function buildInitialMessages(ctx: ConvoContext): ApiMessage[] {
  const history = trimHistory(ctx.history);
  const msgs: ApiMessage[] = history.map((m) => ({
    role: m.direction === "in" ? "user" : "assistant",
    content: m.body,
  }));

  // Ensure the conversation starts with a user turn (API requirement) and that
  // the <context> block rides on the latest user message.
  const contextBlock = buildContextBlock(ctx);

  if (msgs.length === 0 || msgs[msgs.length - 1]!.role !== "user") {
    msgs.push({ role: "user", content: contextBlock });
    return ensureUserFirst(msgs);
  }

  // Append the context to the last user message.
  const last = msgs[msgs.length - 1]!;
  last.content = `${String(last.content)}\n\n${contextBlock}`;
  return ensureUserFirst(msgs);
}

/** The Messages API requires the first message to be role 'user'. */
function ensureUserFirst(msgs: ApiMessage[]): ApiMessage[] {
  while (msgs.length > 0 && msgs[0]!.role !== "user") msgs.shift();
  if (msgs.length === 0) {
    msgs.push({ role: "user", content: "Hola" });
  }
  return msgs;
}

/** Last 20 msgs / 48h, then truncate oldest-first to ~1000 tokens (chars/3.5). */
function trimHistory(history: StoredMessage[]): StoredMessage[] {
  const nowS = Math.floor(Date.now() / 1000);
  let recent = history
    .filter((m) => nowS - m.ts <= HISTORY_MAX_AGE_S)
    .slice(-HISTORY_MAX_MSGS);

  // Drop from the front until under the token cap.
  const tokens = (s: string) => Math.ceil(s.length / 3.5);
  let total = recent.reduce((n, m) => n + tokens(m.body), 0);
  while (total > HISTORY_TOKEN_CAP && recent.length > 1) {
    const dropped = recent.shift()!;
    total -= tokens(dropped.body);
  }
  return recent;
}

/**
 * One Anthropic Messages call (with a single retry). Exported so the KB editor
 * can reuse the exact same transport/pricing. `tools` and `maxTokens` default to
 * the brain's TOOLS / 1024 so existing callers are unchanged; the KB editor
 * passes its proposal-only tools + a larger budget.
 */
export async function callAnthropic(
  doFetch: typeof fetch,
  apiKey: string,
  system: SystemBlock[],
  messages: ApiMessage[],
  tools: readonly unknown[] = TOOLS,
  maxTokens: number = MAX_TOKENS,
  opts?: {
    /** Anthropic `thinking` config. Default stays disabled so the small
     *  utility callers (KB editor, capture parser, edit tuner, rewrite) keep
     *  their tight token budgets; the BRAIN passes adaptive (2026-08-25 —
     *  slot math / date arithmetic / sureness calibration all benefit). */
    thinking?: { type: "adaptive" } | { type: "disabled" };
    /** output_config.effort — only sent when provided. */
    effort?: "low" | "medium" | "high";
    /** Model override — the nightly auditor runs claude-opus-5 (owner
     *  directive 2026-08-28: "at least opus high"); everything else stays on
     *  the default MODEL. NOTE: opus-5 rejects thinking:{type:"disabled"}
     *  above effort high, and thinking-disabled on opus risks tool calls
     *  leaking into text — pass adaptive when overriding to opus. */
    model?: string;
  },
): Promise<ApiResponse> {
  const body = JSON.stringify({
    model: opts?.model ?? MODEL,
    max_tokens: maxTokens,
    thinking: opts?.thinking ?? { type: "disabled" },
    ...(opts?.effort ? { output_config: { effort: opts.effort } } : {}),
    system,
    tools,
    messages,
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const res = await doFetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`anthropic HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      return (await res.json()) as ApiResponse;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("anthropic request failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- book_trial execution ------------------------------------------------

/**
 * Builds an "headline (id)" attribution label from a contact's ad_ref JSON, or
 * null when there's no usable referral. Tolerant of malformed JSON.
 */
function adLabelFromRef(adRef: string | null): string | null {
  if (!adRef) return null;
  try {
    const r = JSON.parse(adRef) as { headline?: string | null; sourceId?: string | null };
    const headline = (r.headline ?? "").trim();
    const id = (r.sourceId ?? "").trim();
    if (headline && id) return `${headline} (${id})`;
    if (headline) return headline;
    if (id) return id;
    return null;
  } catch {
    return null;
  }
}

/** One book_trial call that actually produced an Airtable record. */
interface PendingBooking {
  input: BookTrialInput;
  followupMessage: string;
  recordId: string;
}

interface BookOutcome {
  result: ToolResultContent;
  booking?: PendingBooking;
}

/**
 * Fire-and-forget-but-awaited failure notification. Awaited because Workers kill
 * floating promises; try/caught because observability must never cost a reply.
 */
async function notifyBookingFailure(
  notify: BookingFailureNotifier | undefined,
  ev: BookingFailureEvent,
): Promise<void> {
  if (!notify) return;
  try {
    await notify(ev);
  } catch (err) {
    console.error("[booking-failure] notifier threw", err);
  }
}

async function handleBookTrial(
  airtable: AirtablePort,
  ctx: ConvoContext,
  tu: ToolUseContent,
  onFailure?: BookingFailureNotifier,
): Promise<BookOutcome> {
  const input = tu.input as {
    name?: string;
    child_name?: string;
    discipline?: string;
    audience?: string;
    trial_date?: string;
    trial_time?: string;
    followup_message?: string;
  };

  const name = input.name ?? ctx.contact.name ?? "";
  const childName = (input.child_name ?? "").trim();
  const discipline = normalizeDiscipline(input.discipline ?? "");
  const audience = (input.audience === "kid" ? "kid" : "adult") as Audience;
  const trialDate = input.trial_date ?? "";
  const trialTime = input.trial_time ?? "";
  const followupMessage = unescapeNewlines(input.followup_message ?? "");

  // Assembled BEFORE validation so a rejected slot can report exactly what the
  // model asked for (BookingFailureEvent.requested).
  const bookInput: BookTrialInput = {
    name,
    discipline,
    audience,
    trialDate,
    trialTime,
    phone: ctx.phone,
  };
  // Attribution: if the lead came via a click-to-WhatsApp ad, tag the booking
  // with "headline (id)" so Airtable can attribute the trial. bookTrial tolerates
  // the Ad field being absent (unknown-field 422 → core-fields retry).
  const ad = adLabelFromRef(ctx.contact.ad_ref);
  if (ad) bookInput.ad = ad;
  if (childName) bookInput.childName = childName;

  const check = validateSlot(trialDate, trialTime, audience, discipline);
  if (!check.ok) {
    await notifyBookingFailure(onFailure, {
      phone: ctx.phone,
      kind: "invalid_slot",
      requested: bookInput,
      reason: check.reason ?? "",
      ...(check.alternatives ? { alternatives: check.alternatives } : {}),
    });
    return {
      result: {
        type: "tool_result",
        tool_use_id: tu.id,
        content: `error: ${check.reason} Do not book; propose a valid slot to the lead and end with send_reply.`,
        is_error: true,
      },
    };
  }

  try {
    const recordId = await airtable.bookTrial(bookInput);
    return {
      result: {
        type: "tool_result",
        tool_use_id: tu.id,
        content: `ok: booked (record ${recordId}). Now end the turn with send_reply confirming to the lead.`,
      },
      booking: { input: bookInput, followupMessage, recordId },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await notifyBookingFailure(onFailure, {
      phone: ctx.phone,
      kind: "airtable_error",
      requested: bookInput,
      reason: msg,
    });
    return {
      result: {
        type: "tool_result",
        tool_use_id: tu.id,
        content: `error: booking failed (${msg.slice(0, 120)}). Apologize and offer the booking link; end with send_reply confidence low.`,
        is_error: true,
      },
    };
  }
}

// ---- result mapping ------------------------------------------------------

/**
 * The model sometimes copies literal "\n" sequences into its reply (e.g. when
 * campaign info stored in D1 contains them). WhatsApp copy never wants a
 * literal backslash-n, so normalize every escaped newline to a real one before
 * the message reaches the approval card / send path.
 */
export function unescapeNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

/** ≥ this much sureness and the reply needs no human before it goes out. */
export const SURENESS_SEND_MIN = 75;

/**
 * Reads the model's `sureness` (0–100) and clamps it into range. Returns
 * undefined when the field is absent or unparseable, so callers fall back to
 * the legacy `confidence` enum instead of inventing a number.
 */
export function parseSureness(raw: unknown): number | undefined {
  // Only a number or a numeric string counts. `Number(null)` is 0 and
  // `Number(false)` is 0 — reading either as "0% sure" would silently pin a
  // perfectly fine reply below the best-bet floor.
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function sendResult(
  tu: ToolUseContent,
  followup?: { hoursFromNow: number; note: string } | null,
): BrainResult {
  const input = tu.input as {
    message?: string;
    language?: string;
    sureness?: unknown;
    confidence?: string;
    escalation_reason?: string;
    awaiting_reply?: boolean;
  };
  const language: Language = input.language === "en" ? "en" : "es";
  // Sureness is the source of truth (owner directive 2026-08-25: "if it's at
  // least 75% sure it has the correct answer, it sends"). The high/low enum is
  // DERIVED from it and kept only so every downstream consumer — D1 column,
  // Slack chips, audit views — keeps working unchanged. A missing/garbage
  // sureness falls back to the old enum mapping.
  const sureness = parseSureness(input.sureness);
  const confidence: Confidence =
    sureness !== undefined
      ? sureness >= SURENESS_SEND_MIN
        ? "high"
        : "low"
      : input.confidence === "high"
        ? "high"
        : "low";
  const message = unescapeNewlines(input.message ?? "");
  const fu = followup ?? undefined;
  // Anything not an explicit false counts as waiting — the safe default.
  const awaitingReply = input.awaiting_reply !== false;
  if (confidence === "high") {
    return {
      action: "send",
      message,
      language,
      confidence,
      ...(sureness !== undefined ? { sureness } : {}),
      followup: fu,
      awaitingReply,
    };
  }
  const reason = input.escalation_reason;
  const base = {
    action: "draft" as const,
    message,
    language,
    confidence,
    ...(sureness !== undefined ? { sureness } : {}),
    followup: fu,
    awaitingReply,
  };
  return reason ? { ...base, reason } : base;
}

/**
 * A reply claiming a completed booking when book_trial did NOT succeed this
 * turn must never auto-send: seen live 2026-08-18 — baby-campaign leads were
 * told "ya quedó agendado" while validateSlot had rejected the slot, so no
 * Airtable record, no anti-no-show sequence. Downgrade to a low-confidence
 * draft with an explicit reason so the approver sees exactly what's wrong.
 * (Real bookings return 'book' before this runs, so they are unaffected.)
 *
 * The model's `sureness` is DROPPED on purpose: the number was its own read of
 * a message we just proved wrong, so it must not drive the 1h best-bet timeout
 * (services/slack-timeouts.ts). No sureness ⇒ the draft can only ever be
 * resolved by a human, or expire at 12h.
 */
export function guardUnbackedBookingClaim(
  res: BrainResult,
  recordedBooking?: ConvoContext["recordedBooking"],
): BrainResult {
  if (res.action !== "send" && res.action !== "draft") return res;
  if (!CLAIMS_BOOKED.test(res.message)) return res;
  // A recent REAL Airtable booking for this phone (kv marker, <72h — read in
  // the pipeline) backs the claim: post-booking acks like "¡nos vemos mañana!"
  // are exactly what a lead expects to hear and must not queue as low drafts.
  if (recordedBooking) return res;
  return {
    action: "draft",
    message: res.message,
    language: res.language,
    confidence: "low",
    reason:
      "⚠️ El texto afirma que la clase ya quedó agendada, pero NO se creó ningún booking en Airtable en este turno (book_trial no se ejecutó o falló). Verifica antes de aprobar.",
    followup: res.followup,
    awaitingReply: res.awaitingReply,
  };
}

const WEEKDAY_ES = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
];

/**
 * Second backstop, from the 2026-08 conversation audit: the model regularly
 * NAMES a day+hour that isn't on the grid at all (Friday-evening Muay Thai,
 * Sunday kids, Tuesday Mini Muay Thai) WITHOUT calling book_trial — so
 * validateSlot never runs and nothing catches it. Here we re-read the reply
 * deterministically (parseBookingHints) and, only when it yields a FULL parse
 * (date + time + discipline), check the claimed slot against the real
 * schedule for BOTH audiences — a message mixing adult and kid vocabulary
 * must not false-trigger. If neither audience has that class, the reply can't
 * auto-send.
 *
 * Sends become low-confidence drafts; drafts stay drafts but pick up the
 * reason so the approver sees why. Anything the parser can't read in full is
 * left completely untouched. Like guardUnbackedBookingClaim, the model's
 * `sureness` is dropped so the best-bet timeout can never fire on a draft we
 * already know names a slot that doesn't exist.
 */
export function guardUnverifiedSlotClaim(
  res: BrainResult,
  ctx: Pick<ConvoContext, "nowCdmx">,
): BrainResult {
  if (res.action !== "send" && res.action !== "draft") return res;

  const todayYmd = ctx.nowCdmx.slice(0, 10);
  const weekdayIdx = weekdayIndex(todayYmd);
  if (weekdayIdx === null) return res;

  const hints = parseBookingHints(res.message, ctx.nowCdmx, weekdayIdx);

  // 1. Impossible HOUR for the named discipline — day-independent, so it works
  //    on multi-offer copy the pairing check below can't read.
  //
  //    Seen live 2026-08-25: a Box lead was offered "hoy Box a las 9 pm, o
  //    mañana miércoles a las 7 u 8 am". Box runs Tue 9 pm, Thu 9 pm, Sat 2 pm
  //    and NOTHING else — 7/8 am is Jiu-Jitsu/Muay Thai. The pairing check
  //    below took the day from the SECOND offer and the hour from the FIRST,
  //    validated a phantom "miércoles 21:00 Box", and flagged the message for
  //    the wrong reason; had that crossed pair happened to be a real slot it
  //    would have passed the morning-Box offer straight through.
  //
  //    Only for copy naming exactly ONE discipline: "Box 9 pm o Muay Thai 7 am"
  //    is two offers, and 7 am is perfectly real for Muay Thai.
  const named = parseAllDisciplines(res.message);
  const times = parseAllTimes(res.message);
  if (named.length === 1) {
    const disc = named[0]!;
    const impossible = times.filter((t) => disciplineNeverRunsAt(disc, t));
    if (impossible.length > 0) {
      const label = CLIENT.services.find((s) => s.key === disc)?.label ?? disc;
      const real = [...disciplineTimes(disc)].sort();
      return downgradeToDraft(
        res,
        `⚠️ El mensaje ofrece ${label} a las ${impossible.join(", ")}, pero ${label} NUNCA se imparte a esa hora (ningún día). Horas reales de ${label}: ${real.join(", ")}. Verifica antes de aprobar.`,
      );
    }
  }

  // 2. Exact day+hour pairing. parseBookingHints reads the first day and the
  //    first hour INDEPENDENTLY, so on multi-offer copy it pairs the day of one
  //    offer with the hour of another and judges a slot nobody proposed — which
  //    cuts both ways (it flagged a phantom "miércoles 21:00 Box" above, and it
  //    would flag the perfectly real "hoy Box 9 pm, o Muay Thai mañana 7 am").
  //    So this tier only runs on copy that names ONE hour and at most one day.
  //    Multi-offer messages — now the norm, since the persona allows up to
  //    three slots — are covered by tier 1 instead, which needs no pairing.
  if (times.length > 1 || countDayTokens(res.message) > 1) return res;
  if (hints.confidence !== "full") return res;
  const trialDate = hints.trialDate!;
  const trialTime = hints.trialTime!;
  const discipline = hints.discipline!;

  // Both audiences must reject it before we flag anything.
  for (const audience of ["adult", "kid"] as const) {
    if (validateSlot(trialDate, trialTime, audience, discipline).ok) return res;
  }

  const wd = weekdayIndex(trialDate);
  const dayName = wd === null ? trialDate : (WEEKDAY_ES[wd] ?? trialDate);
  const label =
    CLIENT.services.find((s) => s.key === discipline)?.label ?? discipline;
  return downgradeToDraft(
    res,
    `⚠️ El mensaje propone ${dayName} ${trialTime} para ${label}, pero ese horario no existe en el calendario. Verifica antes de aprobar.`,
  );
}

/**
 * Turn a send/draft into a low-confidence draft carrying `reason`, without
 * duplicating a reason the draft already has. `sureness` is dropped on purpose
 * (see guardUnbackedBookingClaim) so the 1h best-bet timeout can never deliver
 * a message we have already proved wrong.
 */
function downgradeToDraft(
  res: Extract<BrainResult, { action: "send" | "draft" }>,
  reason: string,
): BrainResult {
  const merged =
    res.action === "draft" && res.reason
      ? res.reason.includes(reason)
        ? res.reason
        : `${res.reason}\n${reason}`
      : reason;
  return {
    action: "draft",
    message: res.message,
    language: res.language,
    confidence: "low",
    reason: merged,
    followup: res.followup,
    awaitingReply: res.awaitingReply,
  };
}

function escalateResult(tu: ToolUseContent): BrainResult {
  const input = tu.input as { reason?: string; summary?: string };
  return {
    action: "escalate",
    reason: input.reason ?? "unspecified",
    summary: input.summary ?? "",
  };
}

/**
 * Collapses every booking of the turn into ONE 'book' result.
 *
 * Deterministic split, deliberately:
 *  - flat fields + recordId = the FIRST booking (the lead who started the
 *    conversation; keeps single-booking results byte-identical and gives the
 *    Slack card / sandbox / chat-local a stable "the booking" to show);
 *  - followupMessage = the LAST booking's, because the model is told to put the
 *    confirmation covering EVERYONE in the final call's followup_message;
 *  - bookings[] = all of them, in call order — the pipeline fans out from here
 *    (a Slack FYI per person, an anti-no-show sequence per distinct slot).
 *
 * Never called with an empty array (both call sites check `.length`).
 */
function bookResult(bs: PendingBooking[]): BrainResult {
  const first = bs[0]!;
  const last = bs[bs.length - 1]!;
  return {
    action: "book",
    ...first.input,
    followupMessage: last.followupMessage,
    recordId: first.recordId,
    bookings: bs.map((b) => ({ ...b.input, recordId: b.recordId })),
  };
}

/** Model returned only text (no tool). Draft it for human review. */
function textFallback(resp: ApiResponse, ctx: ConvoContext): BrainResult {
  const text = resp.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  return {
    action: "draft",
    message: unescapeNewlines(text) || safeApology(ctx.contact.lang),
    language: ctx.contact.lang,
    confidence: "low",
    reason: "no_tool_call",
  };
}

function safeApology(lang: Language): string {
  return lang === "en"
    ? "Thanks for your message! 🙌 Give me a moment and I'll get right back to you."
    : "¡Gracias por escribir! 🙌 En un momento te respondemos por aquí.";
}

// ---- usage / cost --------------------------------------------------------

function accumulate(acc: Required<ApiUsage>, u: ApiUsage | undefined): void {
  if (!u) return;
  acc.input_tokens += u.input_tokens ?? 0;
  acc.output_tokens += u.output_tokens ?? 0;
  acc.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  acc.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
}

/** Cost in USD from accumulated usage, at intro pricing. Exported for tests. */
export function computeCost(u: Required<ApiUsage>): number {
  return (
    u.input_tokens * PRICE_INPUT +
    u.output_tokens * PRICE_OUTPUT +
    u.cache_read_input_tokens * PRICE_CACHE_READ +
    u.cache_creation_input_tokens * PRICE_CACHE_WRITE_1H
  );
}

function cdmxDay(): string {
  // YYYY-MM-DD in America/Mexico_City for the usage_log key.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function flushUsage(
  accrue: AccrueUsage,
  acc: Required<ApiUsage>,
): Promise<void> {
  const cost = computeCost(acc);
  // cachedTokens in the usage_log = cache reads (the cheap-served tokens).
  await accrue(
    cdmxDay(),
    acc.input_tokens,
    acc.cache_read_input_tokens,
    acc.output_tokens,
    cost,
  );
}
