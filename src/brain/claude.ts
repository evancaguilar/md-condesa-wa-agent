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
  FollowupWrite,
  Language,
  QualUpdate,
  StoredMessage,
} from "../types.js";
import { buildSystem, buildContextBlock, isNoReplySentinel, type SystemBlock } from "./prompt.js";
import {
  TOOLS,
  closedDateInfo,
  disciplineNeverRunsAt,
  disciplineTimes,
  isKnownDiscipline,
  normalizeDiscipline,
  validateSlot,
  validateSlotBand,
  type ValidateResult,
  weekdayIndex,
} from "./tools.js";
import {
  claimsBooking,
  countDayTokens,
  parseAllDisciplines,
  parseAllTimes,
  parseBookingHints,
} from "../services/booking-claims.js";
import {
  bandFromAgeMonths,
  bandFromQualification,
  monthsFromYears,
  slotGroup,
  teenAdultRow,
  type ProgramBand,
} from "../services/age-band.js";
import { SLOTS } from "./slots.gen.js";
import { classifyProgram, parseQualification } from "../cron/nudge-copy.js";
import { findSlotClaimIssues } from "./slot-claims.js";
import { capacityClaim, comboClaimIssues } from "./fact-guards.js";
import { INTERNAL_NOTE_ERROR, looksInternalNote } from "./followup-note.js";
import {
  confirmationDateIssues,
  leadRequestedDate,
  longDateEs,
  weekdayOfYmd,
  withDayOfMonth,
  WEEKDAY_NAMES_ES,
} from "./stated-date.js";
import { cleanDayKeys } from "../services/program-signal.js";
import { CLIENT } from "../client.gen.js";
import { classifyEscalation } from "../services/slack-timeouts.js";

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
// Long memory (kid leads / live booking): 7 days, ~3000 tokens (see trimHistory).
const HISTORY_LONG_MAX_AGE_S = 7 * 24 * 3600;
const HISTORY_LONG_TOKEN_CAP = 3000;

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
    // trial_dates book_trial refused for contradicting the lead's stated date
    // this turn; a second call with the same date books it with a warning.
    const dateRefused = new Set<string>();

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
          if (pendingBookings.length) return bookResult(pendingBookings, ctx, sendReply);
          return guardFactClaims(
            guardBookingDateClaim(
              guardUnverifiedSlotClaim(
                guardUnbackedBookingClaim(
                  sendResult(sendReply, pendingFollowup),
                  ctx.recordedBooking,
                ),
                ctx,
              ),
              ctx,
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
              dateRefused,
            );
            results.push(outcome.result);
            if (outcome.booking) addPendingBooking(pendingBookings, outcome.booking);
          } else if (tu.name === "set_followup") {
            // Capture the request; the pipeline persists it (the brain has no DB).
            // We still acknowledge so the model proceeds to send_reply.
            const fu = tu.input as { hours_from_now?: number; note?: string };
            const hours = Number(fu.hours_from_now);
            if (looksInternalNote(fu.note ?? "")) {
              // The note would reach the lead word for word (A90, 2026-11).
              results.push({ type: "tool_result", tool_use_id: tu.id, content: INTERNAL_NOTE_ERROR, is_error: true });
              continue;
            }
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
      if (pendingBookings.length) return bookResult(pendingBookings, ctx, null);
      return {
        action: "draft",
        message: safeApology(ctx.contact.lang),
        language: ctx.contact.lang,
        confidence: "low",
        reason: "max_iterations",
      };
    } catch (err) {
      // callAnthropic already retried once. Return a safe apology draft. The
      // cause rides in `reason` (shown on the Slack card) and in the logs —
      // 2026-09-22: every reply was the holding line for hours and nobody
      // could tell WHY from the dashboard (it was the Anthropic balance).
      await flushUsage(deps.accrueUsage, usageAcc).catch(() => {});
      const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160);
      console.error(`[brain] api_error for ${ctx.phone}: ${detail}`);
      return {
        action: "draft",
        message: safeApology(ctx.contact.lang),
        language: ctx.contact.lang,
        confidence: "low",
        reason: `api_error: ${detail}`,
      };
    }
  }

  /**
   * AI-written day-1 follow-up (src/cron/ai-followup.ts). Exactly ONE Messages
   * call with the SAME system blocks, tools and thinking config as respond(),
   * so the cached prefix is shared byte for byte; the follow-up instructions
   * ride in ctx.followupInstruction (end of the per-turn <context>). No tool
   * is ever executed: only a send_reply is read (parseFollowupResponse), and
   * any other tool call is refused → the caller sends the fixed copy.
   */
  async function writeFollowup(ctx: ConvoContext, opts: { timeoutMs?: number } = {}): Promise<FollowupWrite> {
    const usageAcc: Required<ApiUsage> = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    // One deadline for the whole call (both callAnthropic attempts).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    const timedFetch: typeof fetch = (input, init) => doFetch(input, { ...(init ?? {}), signal: ctrl.signal });
    try {
      const overlay = deps.loadOverlay ? await deps.loadOverlay() : "";
      const system = buildSystem(deps.kb, overlay);
      const messages = buildInitialMessages(ctx);
      const resp = await callAnthropic(timedFetch, deps.apiKey, system, messages, TOOLS, MAX_TOKENS, {
        thinking: { type: "adaptive" },
        effort: "medium",
      });
      accumulate(usageAcc, resp.usage);
      await flushUsage(deps.accrueUsage, usageAcc).catch(() => {});
      return parseFollowupResponse(resp);
    } catch (err) {
      await flushUsage(deps.accrueUsage, usageAcc).catch(() => {});
      if (ctrl.signal.aborted) return { ok: false, reason: "timeout" };
      const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160);
      console.error(`[brain] follow-up api_error for ${ctx.phone}: ${detail}`);
      return { ok: false, reason: "brain_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  return { respond, writeFollowup };
}

/**
 * Pure. The one response of an AI follow-up call → its text, or why not.
 * ONLY send_reply is accepted: book_trial / set_followup / escalate_to_human
 * (or any unknown tool) is refused, so a follow-up can never book, escalate or
 * schedule anything. A send_reply that flags an escalation or a decline, the
 * no-reply sentinel, or an empty message is refused too.
 */
export function parseFollowupResponse(resp: ApiResponse): FollowupWrite {
  const toolUses = resp.content.filter((b): b is ToolUseContent => b.type === "tool_use");
  const other = toolUses.find((t) => t.name !== "send_reply");
  if (other) return { ok: false, reason: `other_tool:${other.name}` };
  const reply = toolUses.find((t) => t.name === "send_reply");
  if (!reply) return { ok: false, reason: "no_send_reply" };
  const input = reply.input as { message?: unknown; escalation_reason?: unknown; lead_declined?: unknown };
  if (typeof input.escalation_reason === "string" && input.escalation_reason.trim()) {
    return { ok: false, reason: "escalation" };
  }
  if (input.lead_declined === true) return { ok: false, reason: "declined_signal" };
  const text = typeof input.message === "string" ? unescapeNewlines(input.message).trim() : "";
  if (!text) return { ok: false, reason: "empty" };
  if (isNoReplySentinel(text)) return { ok: false, reason: "no_reply_sentinel" };
  return { ok: true, text };
}

// ---- request / response --------------------------------------------------

function buildInitialMessages(ctx: ConvoContext): ApiMessage[] {
  const history = trimHistory(ctx.history, wantsLongHistory(ctx));
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

  // Append the context to the last user message, with the lead's text fenced
  // so a message that *contains* "<context>…" can never pass as pipeline state.
  const last = msgs[msgs.length - 1]!;
  last.content = `${wrapLeadMessage(String(last.content))}\n\n${contextBlock}`;
  return ensureUserFirst(msgs);
}

/** Opening/closing fence for the lead's own text on the turn that carries
 *  <context>. The system prompt tells the model the fenced text is DATA. */
export const LEAD_MESSAGE_TAG = "mensaje_del_lead";

/**
 * Fences the lead's text. Any literal fence or `<context>` tag typed by the
 * lead is neutralised (angle brackets swapped for full-width ones) so the
 * fence cannot be closed early and no fake context block parses as ours.
 */
export function wrapLeadMessage(body: string): string {
  const safe = body.replace(
    new RegExp(`</?\\s*(${LEAD_MESSAGE_TAG}|context)\\s*>`, "gi"),
    (m) => m.replace("<", "＜").replace(">", "＞"),
  );
  return `<${LEAD_MESSAGE_TAG}>\n${safe}\n</${LEAD_MESSAGE_TAG}>`;
}

/** Placeholder user turn when the window opens with our own message. Marked as
 *  a note so the model never reads it as something the lead wrote. */
export const HISTORY_OPENER = "[nota: sin mensajes del lead en las últimas 48 h — lo anterior es lo que le enviamos]";

/**
 * The Messages API requires the first message to be role 'user'. Leading
 * assistant turns are KEPT behind a placeholder user note: until 2026-09-29 they
 * were shifted off, so a lead answering a blast template weeks after their last
 * message ("Sí, por favor") reached the brain with the template gone and the
 * bot re-proposed or asked "¿a qué te refieres?".
 */
export function ensureUserFirst(msgs: ApiMessage[]): ApiMessage[] {
  if (msgs.length === 0) {
    msgs.push({ role: "user", content: "Hola" });
    return msgs;
  }
  if (msgs[0]!.role !== "user") msgs.unshift({ role: "user", content: HISTORY_OPENER });
  return msgs;
}

/**
 * Does this conversation get the LONG memory? Yes for a lead with a child
 * qualification (age, name and declined days were said once, days ago — Joss
 * re-explained "entre semana no" three times) or a live booking.
 */
export function wantsLongHistory(ctx: Pick<ConvoContext, "contact" | "recordedBooking">): boolean {
  if (ctx.recordedBooking) return true;
  const band = bandFromQualification(parseQualification(ctx.contact));
  return band !== null && band !== "adults";
}

/**
 * Last 20 msgs / 48h, then truncate oldest-first to ~1000 tokens (chars/3.5).
 * `long` (wantsLongHistory): 7 days / ~3000 tokens. Cost: ≤ +2000 uncached
 * input tokens per turn at $2/MTok ≈ +$0.004 per reply on those leads only
 * (history sits after the cached system blocks, so it is never cached).
 */
export function trimHistory(
  history: StoredMessage[],
  long = false,
  nowS: number = Math.floor(Date.now() / 1000),
): StoredMessage[] {
  const maxAge = long ? HISTORY_LONG_MAX_AGE_S : HISTORY_MAX_AGE_S;
  const cap = long ? HISTORY_LONG_TOKEN_CAP : HISTORY_TOKEN_CAP;
  let recent = history
    .filter((m) => nowS - m.ts <= maxAge)
    .slice(-HISTORY_MAX_MSGS);

  // Drop from the front until under the token cap.
  const tokens = (s: string) => Math.ceil(s.length / 3.5);
  let total = recent.reduce((n, m) => n + tokens(m.body), 0);
  while (total > cap && recent.length > 1) {
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
    /** Model override — the nightly auditor runs claude-opus-5-5 (owner
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
export interface PendingBooking {
  input: BookTrialInput;
  followupMessage: string;
  recordId: string;
  /** The lead pinned another date and the model insisted (second call with the
   *  same trial_date): booked, but the confirmation goes to Aprobar. */
  dateWarning?: string;
}

export interface BookOutcome {
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

/** Who a booking is for: the child when there is one, else the named adult. */
function personKey(b: BookTrialInput): string {
  return (b.childName || b.name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .split(/\s+/)[0] ?? "";
}

/**
 * One booking per person per turn (2026-10-11): a second book_trial for the
 * SAME phone and the same person (the model "fixing" the slot it just booked)
 * REPLACES the first in place — one confirmation, one video, one sequence.
 * Different names (a family booking) still append. Mutates and returns `list`.
 */
export function addPendingBooking(list: PendingBooking[], b: PendingBooking): PendingBooking[] {
  const who = personKey(b.input);
  const i = list.findIndex((p) => p.input.phone === b.input.phone && personKey(p.input) === who);
  if (i >= 0) list.splice(i, 1, b);
  else list.push(b);
  return list;
}

/** A finite number from a model field (number or numeric string), else null. */
function numberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pure. The age band a book_trial must respect, or null for "no band check":
 * the stated child_age wins; otherwise the stored qualification's band, but
 * only when this booking is for a child (kid audience, a child name, or a
 * non-adult row) — a parent booking their own adult class stays unchecked.
 */
export function bookingBand(
  ctx: Pick<ConvoContext, "contact">,
  b: {
    childAgeMonths: number | null;
    childName: string;
    audience: Audience;
    discipline: string;
    trialDate: string;
    trialTime: string;
  },
): ProgramBand | null {
  if (b.childAgeMonths !== null) return bandFromAgeMonths(b.childAgeMonths);
  const stored = bandFromQualification(parseQualification(ctx.contact));
  if (!stored || stored === "adults") return null;
  if (b.audience === "kid" || b.childName) return stored;
  const wd = weekdayIndex(b.trialDate);
  const adultRow = SLOTS.some(
    (s) =>
      s.weekday === wd &&
      s.time === b.trialTime.trim() &&
      s.discipline === b.discipline &&
      slotGroup(s) === "adult",
  );
  return adultRow ? null : stored;
}

/**
 * Pure. True when book_trial is for a child (kid audience, a child name, or a
 * non-adult band) and NO age is known — neither book_trial.child_age nor a
 * stated age in the stored qualification. A campaign-guessed band ("kids"
 * from a Kids ad) is not an age. A parent's own adult class (band null, adult
 * audience, no child name) is never a minor booking.
 */
export function minorBookingWithoutAge(
  ctx: Pick<ConvoContext, "contact">,
  b: { band: ProgramBand | null; audience: Audience; childName: string; childAgeMonths: number | null },
): boolean {
  const minor = b.audience === "kid" || !!b.childName || (b.band !== null && b.band !== "adults");
  if (!minor) return false;
  if (b.childAgeMonths !== null) return false;
  const stored = parseQualification(ctx.contact)?.child_age_months;
  return !(typeof stored === "number" && Number.isFinite(stored));
}

/** First failing check wins (validateSlot's existence check before the band's). */
function mergeChecks(a: ValidateResult, b: ValidateResult): ValidateResult {
  return a.ok ? b : a;
}

const WEEKDAY_KEYS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"] as const;

/**
 * Pure. Why this trial_date must not be booked, or null:
 *  1. `trial_weekday` (book_trial input) is not the calendar weekday of the date;
 *  2. the lead pinned another date in this turn (stated-date.leadRequestedDate):
 *     a day of the month / "el otro sábado" / an offer of ours they accepted;
 *  3. the lead's weekday and day of the month disagree ("sábado 17" = a Tuesday);
 *  4. the lead asked for "la próxima semana" and the date is outside it.
 */
export function bookingDateError(
  ctx: Pick<ConvoContext, "nowCdmx" | "history">,
  trialDate: string,
  trialWeekday?: string,
): string | null {
  const wd = weekdayIndex(trialDate);
  if (wd === null) return null; // validateSlot reports the bad format
  const statedKey = (trialWeekday ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 3);
  const statedIdx = WEEKDAY_KEYS.indexOf(statedKey as (typeof WEEKDAY_KEYS)[number]);
  if (statedIdx >= 0 && statedIdx !== wd) {
    return `trial_date ${trialDate} is a ${WEEKDAY_NAMES_ES[wd]}, not a ${WEEKDAY_NAMES_ES[statedIdx]}. Read the calendario line in <context>, pick the date the lead actually asked for, and call book_trial again.`;
  }
  const today = ctx.nowCdmx.slice(0, 10);
  const asked = leadRequestedDate(ctx.history ?? [], today);
  if (!asked) return null;
  if (asked.kind === "mismatch") {
    return `the lead wrote «${asked.text}», but that day of the month is a ${WEEKDAY_NAMES_ES[weekdayOfYmd(asked.ymd)]}. Do not book: ask the lead which date they mean (one short line) and end with send_reply.`;
  }
  if (asked.kind === "week") {
    if (trialDate < asked.start || trialDate > asked.end) {
      return `the lead asked for «${asked.text}» (${longDateEs(asked.start)} – ${longDateEs(asked.end)}), but trial_date ${trialDate} is outside that week. Book a class of their group inside that week.`;
    }
    return null;
  }
  // A closed / TBD-holiday date can't be booked anyway (validateSlot refuses
  // it): the model offers the nearest real day instead — don't block that.
  if (asked.ymd !== trialDate && !closedDateInfo(asked.ymd)) {
    const who = asked.source === "lead" ? "the lead asked for" : "the lead accepted our offer of";
    return `${who} «${asked.text}» = ${longDateEs(asked.ymd)} (${asked.ymd}), but trial_date is ${trialDate} (${longDateEs(trialDate)}). Book ${asked.ymd} — the nearest ${WEEKDAY_NAMES_ES[weekdayOfYmd(asked.ymd)]} is NOT what they asked for — and confirm with «${WEEKDAY_NAMES_ES[weekdayOfYmd(asked.ymd)]} ${Number(asked.ymd.slice(8, 10))}».`;
  }
  return null;
}

export async function handleBookTrial(
  airtable: AirtablePort,
  ctx: ConvoContext,
  tu: ToolUseContent,
  onFailure?: BookingFailureNotifier,
  dateRefused?: Set<string>,
): Promise<BookOutcome> {
  const input = tu.input as {
    name?: string;
    child_name?: string;
    child_age?: unknown;
    discipline?: string;
    audience?: string;
    trial_date?: string;
    trial_time?: string;
    trial_weekday?: string;
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
  // The CRM name we may hold is the push name (contact.name); the name the
  // lead gave for the booking replaces it there (see shouldWriteName).
  if (ctx.contact.name) bookInput.replaceName = ctx.contact.name;

  // Age band (2026-10-11): from book_trial.child_age, else the stored
  // qualification when this is a child's booking. An adult booking themselves
  // (no child name, adult row) is never band-checked — a parent may book their
  // own class in the same chat.
  const childAgeMonths = monthsFromYears(numberOrNull(input.child_age));
  const band = bookingBand(ctx, { childAgeMonths, childName, audience, discipline, trialDate, trialTime });
  if (band) {
    bookInput.program = band;
    if (childAgeMonths !== null) bookInput.childAgeMonths = childAgeMonths;
  }

  // A teen into an ADULT row they may take (teenAdultRow: 16–17 any adult
  // class; 13–15 adult Muay Thai, Saturday adult rows): the row's audience is
  // "adult", so validate existence against that audience even when the model
  // sent "kid".
  const bandAgeMonths = childAgeMonths ?? parseQualification(ctx.contact)?.child_age_months ?? null;
  const wdBooked = weekdayIndex(trialDate);
  const slotAudience: Audience =
    SLOTS.some(
      (s) =>
        s.weekday === wdBooked &&
        s.time === trialTime.trim() &&
        s.discipline === discipline &&
        s.trial !== false &&
        slotGroup(s) === "adult" &&
        teenAdultRow(s, band, bandAgeMonths),
    )
      ? "adult"
      : audience;

  // Date sanity (2026-11-11 grading, BOOKING_MISMATCH): the weekday the model
  // meant must be the calendar weekday of trial_date, and a date the lead
  // pinned ("sábado 14", "el 16", "la próxima semana") wins over the nearest
  // such weekday. Refused, not booked — the model re-calls with the right date.
  const dateError = bookingDateError(ctx, trialDate, input.trial_weekday);
  let dateWarning: string | undefined;
  if (dateError && dateRefused?.has(trialDate) && !/^trial_date /.test(dateError)) {
    // Second call with the same date: the model read something the extractor
    // missed (the lead changed their mind mid-message). Book, but a human
    // checks the confirmation.
    dateWarning = `⚠️ Fecha: el lead mencionó otra fecha (${dateError.slice(0, 160)}). Verifica la fecha antes de aprobar.`;
  } else if (dateError) {
    dateRefused?.add(trialDate);
    return {
      result: {
        type: "tool_result",
        tool_use_id: tu.id,
        content: `error: ${dateError} (If the lead clearly changed the date later in their own message, call book_trial again with the same trial_date — it then goes to human review.)`,
        is_error: true,
      },
    };
  }

  const check = band
    ? mergeChecks(
        validateSlot(trialDate, trialTime, slotAudience, discipline),
        validateSlotBand(trialDate, trialTime, discipline, band, undefined, bandAgeMonths),
      )
    : validateSlot(trialDate, trialTime, audience, discipline);
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

  // A minor's FIRST trial confirms directly like an adult's (owner, 2026-11-10)
  // — but only on a KNOWN age: without it the band above may be a campaign
  // guess, and the band check above cannot tell Kids from Mini Muay Thai.
  // Refused (not booked), so the model asks the age instead of confirming.
  // Runs after the slot checks so a slot that doesn't exist is reported (and
  // alerted) first.
  const ageUnknown = minorBookingWithoutAge(ctx, {
    band,
    audience,
    childName,
    childAgeMonths,
  });
  if (ageUnknown) {
    return {
      result: {
        type: "tool_result",
        tool_use_id: tu.id,
        content:
          "error: this booking is for a minor and the child's age is unknown. Do not book yet: ask the parent the child's age (it decides the program and the class), then call book_trial again with child_age. End this turn with send_reply.",
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
      booking: { input: bookInput, followupMessage, recordId, ...(dateWarning ? { dateWarning } : {}) },
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
    lead_name?: unknown;
    child_name?: unknown;
    child_age_years?: unknown;
    preferred_days?: unknown;
    declined_days?: unknown;
    lead_declined?: unknown;
    lead_interested?: unknown;
  };
  const language: Language = input.language === "en" ? "en" : "es";
  const leadName = cleanLeadName(input.lead_name);
  const qualUpdate = qualUpdateFromInput(input);
  // Decline / renewed-interest signals (pipeline/decline.ts). Only a literal
  // true counts; a decline wins over interest on the same turn.
  const leadDeclined = input.lead_declined === true;
  const leadInterested = !leadDeclined && input.lead_interested === true;
  const signals = {
    ...(leadDeclined ? { leadDeclined: true as const } : {}),
    ...(leadInterested ? { leadInterested: true as const } : {}),
  };
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
  // An opt_out / complaint reason is never a plain send, whatever the sureness
  // (pipeline/inbound routeResult handles both — WP3). Neither is a private-
  // class inquiry: a plain send would drop the reason, and with it the
  // #wa-leads task + owner alert routeResult opens for it (owner, 2026-11-10).
  if (
    confidence === "high" &&
    !/^\s*(?:opt[_ -]?out|complaint)\b/i.test(input.escalation_reason ?? "") &&
    classifyEscalation(input.escalation_reason) !== "private_class"
  ) {
    return {
      action: "send",
      message,
      language,
      confidence,
      ...(sureness !== undefined ? { sureness } : {}),
      followup: fu,
      awaitingReply,
      ...(leadName ? { leadName } : {}),
      ...(qualUpdate ? { qualUpdate } : {}),
      ...signals,
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
    ...(leadName ? { leadName } : {}),
    ...(qualUpdate ? { qualUpdate } : {}),
    ...signals,
  };
  return reason ? { ...base, reason } : base;
}

/**
 * Pure. send_reply's child_name / child_age_years / preferred_days /
 * declined_days → a QualUpdate, or undefined when the model reported nothing
 * usable. A missing or garbage age is simply absent (never "erase the age").
 */
export function qualUpdateFromInput(input: {
  child_name?: unknown;
  child_age_years?: unknown;
  preferred_days?: unknown;
  declined_days?: unknown;
}): QualUpdate | undefined {
  const u: QualUpdate = {};
  const childName = cleanLeadName(input.child_name);
  if (childName) u.child_name = childName;
  const years = numberOrNull(input.child_age_years);
  const months = years !== null && years > 0 && years < 18 ? monthsFromYears(years) : null;
  if (months !== null) u.child_age_months = months;
  const pref = cleanDayKeys(input.preferred_days);
  if (pref.length) u.preferred_days = pref;
  const decl = cleanDayKeys(input.declined_days);
  if (decl.length) u.declined_days = decl;
  return Object.keys(u).length ? u : undefined;
}

/**
 * Pure. send_reply.lead_name as a usable name or undefined: a string, trimmed,
 * collapsed, ≤ 60 chars, with at least one letter. Garbage (numbers only,
 * emoji, an empty string) is dropped so it can never overwrite a real name.
 */
export function cleanLeadName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  if (!s || s.length > 60) return undefined;
  if (!/\p{L}/u.test(s)) return undefined;
  return s;
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
  // claimsBooking (not the raw regex): a draft that ASKS for the booking data
  // ("¿me confirmas tu nombre para dejarlo agendado?") contains "agendado" but
  // proves the booking has NOT happened — guarding it stripped the sureness and
  // parked the hottest leads on a human (2026-09-17: #1462 waited 348 min).
  if (!claimsBooking(res.message)) return res;
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
    ...(res.qualUpdate ? { qualUpdate: res.qualUpdate } : {}),
    ...(res.leadDeclined ? { leadDeclined: true as const } : {}),
    ...(res.leadInterested ? { leadInterested: true as const } : {}),
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
  ctx: Pick<ConvoContext, "nowCdmx"> & Partial<Pick<ConvoContext, "contact" | "campaign">>,
  /** The booking's own band/age (bookResult): this turn's book_trial already
   *  validated them, and the stored qualification may not carry them yet. */
  booked?: { band?: ProgramBand | null; ageMonths?: number | null },
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

  // 3. (runs when tier 2 passes or cannot read the copy) Every explicit
  //    (day, hour) against the lead's AGE BAND (2026-10-11): "lunes 1:15 pm" to
  //    a Mini parent, "No hay Kids el sábado", Sunday mornings. Only pairs whose
  //    day is explicit (weekday / hoy / mañana).
  const bandCheck = (): BrainResult => {
    const evidence =
      booked?.band ??
      (ctx.contact
        ? (bandFromQualification(parseQualification(ctx.contact)) ??
          (ctx.campaign?.name ? classifyProgram(ctx.contact, ctx.campaign.name) : null))
        : null);
    const leadDisc = ctx.contact ? normalizeDiscipline(parseQualification(ctx.contact).discipline ?? "") : "";
    const ageMonths =
      booked?.ageMonths ?? (ctx.contact ? (parseQualification(ctx.contact).child_age_months ?? null) : null);
    const issues = findSlotClaimIssues(res.message, weekdayIdx, {
      band: evidence,
      discipline: isKnownDiscipline(leadDisc) ? leadDisc : null,
      ageMonths,
    });
    if (issues.length > 0) {
      return downgradeToDraft(
        res,
        `⚠️ Horario que no existe para este lead: ${issues.map((i) => i.note).join(" ")} Verifica antes de aprobar.`,
      );
    }
    return res;
  };

  // 2. Exact day+hour pairing. parseBookingHints reads the first day and the
  //    first hour INDEPENDENTLY, so on multi-offer copy it pairs the day of one
  //    offer with the hour of another and judges a slot nobody proposed — which
  //    cuts both ways (it flagged a phantom "miércoles 21:00 Box" above, and it
  //    would flag the perfectly real "hoy Box 9 pm, o Muay Thai mañana 7 am").
  //    So this tier only runs on copy that names ONE hour and at most one day.
  //    Multi-offer messages — now the norm, since the persona allows up to
  //    three slots — are covered by tier 1 instead, which needs no pairing.
  if (times.length > 1 || countDayTokens(res.message) > 1) return bandCheck();
  if (hints.confidence !== "full") return bandCheck();
  const trialDate = hints.trialDate!;
  const trialTime = hints.trialTime!;
  const discipline = hints.discipline!;

  // Both audiences must reject it before we flag anything.
  for (const audience of ["adult", "kid"] as const) {
    if (validateSlot(trialDate, trialTime, audience, discipline).ok) return bandCheck();
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
 * Pure. Fact-guard notes for outgoing copy (brain/fact-guards.ts): capacity
 * talk, and — for adult leads — a two-class combo the grid does not support.
 * Each note starts with "⚠️" so the approval is guarded (never best-bets).
 */
export function factGuardIssues(
  message: string,
  ctx: Pick<ConvoContext, "nowCdmx"> & Partial<Pick<ConvoContext, "contact" | "campaign">>,
): string[] {
  const out: string[] = [];
  const cap = capacityClaim(message);
  if (cap) {
    out.push(
      `⚠️ Cupo: el mensaje dice «${cap}». No existe un sistema de cupos — nunca afirmes que hay o que no hay lugar/cupo. Quítalo antes de aprobar.`,
    );
  }
  const band = ctx.contact
    ? (bandFromQualification(parseQualification(ctx.contact)) ?? classifyProgram(ctx.contact, ctx.campaign?.name ?? null))
    : "adults";
  if (band === "adults") {
    const combos = comboClaimIssues(message, ctx.nowCdmx.slice(0, 10));
    if (combos.length) {
      out.push(`⚠️ Combo que no existe: ${combos.join(" ")} Verifica antes de aprobar.`);
    }
  }
  return out;
}

/** Send/draft guard over factGuardIssues. */
export function guardFactClaims(
  res: BrainResult,
  ctx: Pick<ConvoContext, "nowCdmx"> & Partial<Pick<ConvoContext, "contact" | "campaign">>,
): BrainResult {
  if (res.action !== "send" && res.action !== "draft") return res;
  if (isNoReplySentinel(res.message)) return res;
  const issues = factGuardIssues(res.message, ctx);
  return issues.length ? downgradeToDraft(res, issues.join("\n")) : res;
}

/**
 * A plain reply that CLAIMS the lead's booking ("te esperamos mañana a las 9")
 * while the recorded booking is another date (A205: "mañana" for a Saturday
 * class written on a Thursday; A51: "mañana sábado" for a Sat-14 booking).
 * Downgraded to a draft with the dates spelled out. Pure.
 */
export function guardBookingDateClaim(
  res: BrainResult,
  ctx: Pick<ConvoContext, "nowCdmx"> & Partial<Pick<ConvoContext, "recordedBooking">>,
): BrainResult {
  if (res.action !== "send" && res.action !== "draft") return res;
  const booked = ctx.recordedBooking?.trialDate;
  if (!booked || !claimsBooking(res.message)) return res;
  const today = ctx.nowCdmx.slice(0, 10);
  if (booked < today) return res;
  const issues = confirmationDateIssues(res.message, [booked], today);
  if (issues.length === 0) return res;
  return downgradeToDraft(
    res,
    `⚠️ Fecha ≠ reserva registrada: ${issues.join(" ")} Corrige la fecha antes de aprobar.`,
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
    ...(res.qualUpdate ? { qualUpdate: res.qualUpdate } : {}),
    ...(res.leadDeclined ? { leadDeclined: true as const } : {}),
    ...(res.leadInterested ? { leadInterested: true as const } : {}),
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
export function bookResult(
  bs: PendingBooking[],
  ctx?: Pick<ConvoContext, "nowCdmx"> & Partial<Pick<ConvoContext, "contact" | "campaign">>,
  sendReply?: ToolUseContent | null,
): BrainResult {
  const first = bs[0]!;
  const last = bs[bs.length - 1]!;
  // What the closing send_reply said, and whether the confirmation text passes
  // the schedule guard: the auto-confirm decision (services/auto-confirm.ts)
  // keeps any of these on the human path.
  const reply = (sendReply?.input ?? {}) as { sureness?: unknown; escalation_reason?: unknown };
  const sureness = sendReply ? parseSureness(reply.sureness) : undefined;
  const reason = typeof reply.escalation_reason === "string" ? reply.escalation_reason.trim() : "";
  const warnings: string[] = [];
  let followupMessage = last.followupMessage;
  if (ctx) {
    const today = ctx.nowCdmx.slice(0, 10);
    const dates = [...new Set(bs.map((b) => b.input.trialDate))];
    // A class 2+ days out always carries its day of the month ("sábado 14"):
    // a bare "el sábado" is read as the nearest one (2026-11 BOOKING_MISMATCH).
    if (dates.length === 1) followupMessage = withDayOfMonth(followupMessage, dates[0]!, today);
    const probe = guardUnverifiedSlotClaim(
      { action: "send", message: followupMessage, language: "es", confidence: "high" },
      ctx,
      last.input.program ? { band: last.input.program, ageMonths: last.input.childAgeMonths ?? null } : undefined,
    );
    if (probe.action === "draft" && probe.reason) warnings.push(probe.reason);
    const dateIssues = confirmationDateIssues(followupMessage, dates, today, { requireDay: true });
    if (dateIssues.length) {
      warnings.push(`⚠️ Fecha de la confirmación ≠ reserva: ${dateIssues.join(" ")} Corrige la fecha antes de aprobar.`);
    }
    warnings.push(...factGuardIssues(followupMessage, ctx));
  }
  for (const b of bs) if (b.dateWarning) warnings.push(b.dateWarning);
  const warning = warnings.length ? [...new Set(warnings)].join("\n") : undefined;
  return {
    action: "book",
    ...first.input,
    followupMessage,
    recordId: first.recordId,
    bookings: bs.map((b) => ({ ...b.input, recordId: b.recordId })),
    ...(sureness !== undefined ? { replySureness: sureness } : {}),
    ...(reason ? { replyReason: reason } : {}),
    ...(sendReply === null ? { replyMissing: true } : {}),
    ...(warning ? { confirmationWarning: warning } : {}),
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
