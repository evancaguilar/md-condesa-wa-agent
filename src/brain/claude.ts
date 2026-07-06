// The brain: respond(ctx) → BrainResult, backed by the Anthropic Messages API
// (raw fetch, no SDK). Tool-use loop with book_trial validated + executed via an
// injected AirtablePort; usage cost accrued via an injected query closure.
//
// Wiring (workstream E) constructs it once with createBrain(deps) and hands the
// resulting BrainPort to the pipeline.

import type {
  AirtablePort,
  Audience,
  BookTrialInput,
  BrainPort,
  BrainResult,
  Confidence,
  ConvoContext,
  Language,
  StoredMessage,
} from "../types.js";
import { buildSystem, buildContextBlock, type SystemBlock } from "./prompt.js";
import { TOOLS, normalizeDiscipline, validateSlot } from "./tools.js";

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
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ---- Anthropic request constants (spec §Claude brain) --------------------

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;
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

interface TextContent {
  type: "text";
  text: string;
}
interface ToolUseContent {
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
type AssistantContent = TextContent | ToolUseContent;
type UserContent = TextContent | ToolResultContent;

interface ApiMessage {
  role: "user" | "assistant";
  content: string | UserContent[] | AssistantContent[];
}

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ApiResponse {
  content: AssistantContent[];
  stop_reason: string;
  usage?: ApiUsage;
}

// ---- brain factory -------------------------------------------------------

export function createBrain(deps: BrainDeps): BrainPort {
  const doFetch = deps.fetchImpl ?? fetch;

  const system = buildSystem(deps.kb);

  async function respond(ctx: ConvoContext): Promise<BrainResult> {
    const messages = buildInitialMessages(ctx);

    const usageAcc: Required<ApiUsage> = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    let pendingBooking: {
      input: BookTrialInput;
      followupMessage: string;
      recordId: string;
    } | null = null;
    let pendingFollowup: { hoursFromNow: number; note: string } | null = null;

    try {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const resp = await callAnthropic(doFetch, deps.apiKey, system, messages);
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
          if (pendingBooking) return bookResult(pendingBooking);
          return sendResult(sendReply, pendingFollowup);
        }

        // No terminal tool yet — process the non-terminal tools, feed results
        // back, and loop. (book_trial / set_followup / escalate-without-send.)
        if (toolUses.length === 0) {
          // Model produced only text and no tool — synthesize a low-confidence
          // draft from any text so the pipeline still has something to review.
          await flushUsage(deps.accrueUsage, usageAcc);
          return textFallback(resp, ctx);
        }

        messages.push({ role: "assistant", content: resp.content });
        const results: ToolResultContent[] = [];

        for (const tu of toolUses) {
          if (tu.name === "book_trial") {
            const outcome = await handleBookTrial(deps.airtable, ctx, tu);
            results.push(outcome.result);
            if (outcome.booking) pendingBooking = outcome.booking;
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
      if (pendingBooking) return bookResult(pendingBooking);
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

async function callAnthropic(
  doFetch: typeof fetch,
  apiKey: string,
  system: SystemBlock[],
  messages: ApiMessage[],
): Promise<ApiResponse> {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "disabled" },
    system,
    tools: TOOLS,
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

interface BookOutcome {
  result: ToolResultContent;
  booking?: { input: BookTrialInput; followupMessage: string; recordId: string };
}

async function handleBookTrial(
  airtable: AirtablePort,
  ctx: ConvoContext,
  tu: ToolUseContent,
): Promise<BookOutcome> {
  const input = tu.input as {
    name?: string;
    discipline?: string;
    audience?: string;
    trial_date?: string;
    trial_time?: string;
    followup_message?: string;
  };

  const name = input.name ?? ctx.contact.name ?? "";
  const discipline = normalizeDiscipline(input.discipline ?? "");
  const audience = (input.audience === "kid" ? "kid" : "adult") as Audience;
  const trialDate = input.trial_date ?? "";
  const trialTime = input.trial_time ?? "";
  const followupMessage = input.followup_message ?? "";

  const check = validateSlot(trialDate, trialTime, audience, discipline);
  if (!check.ok) {
    return {
      result: {
        type: "tool_result",
        tool_use_id: tu.id,
        content: `error: ${check.reason} Do not book; propose a valid slot to the lead and end with send_reply.`,
        is_error: true,
      },
    };
  }

  const bookInput: BookTrialInput = {
    name,
    discipline,
    audience,
    trialDate,
    trialTime,
    phone: ctx.phone,
  };

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

export function sendResult(
  tu: ToolUseContent,
  followup?: { hoursFromNow: number; note: string } | null,
): BrainResult {
  const input = tu.input as {
    message?: string;
    language?: string;
    confidence?: string;
    escalation_reason?: string;
  };
  const language: Language = input.language === "en" ? "en" : "es";
  const confidence: Confidence = input.confidence === "high" ? "high" : "low";
  const message = input.message ?? "";
  const fu = followup ?? undefined;
  if (confidence === "high") {
    return { action: "send", message, language, confidence, followup: fu };
  }
  const reason = input.escalation_reason;
  return reason
    ? { action: "draft", message, language, confidence, reason, followup: fu }
    : { action: "draft", message, language, confidence, followup: fu };
}

function escalateResult(tu: ToolUseContent): BrainResult {
  const input = tu.input as { reason?: string; summary?: string };
  return {
    action: "escalate",
    reason: input.reason ?? "unspecified",
    summary: input.summary ?? "",
  };
}

function bookResult(b: {
  input: BookTrialInput;
  followupMessage: string;
  recordId: string;
}): BrainResult {
  return {
    action: "book",
    ...b.input,
    followupMessage: b.followupMessage,
    recordId: b.recordId,
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
    message: text || safeApology(ctx.contact.lang),
    language: ctx.contact.lang,
    confidence: "low",
    reason: "no_tool_call",
  };
}

function safeApology(lang: Language): string {
  return lang === "en"
    ? "Thanks for your message! 🙌 Give me a moment and I'll get right back to you."
    : "¡Gracias por escribir! 🙌 Dame un momento y te confirmo enseguida.";
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
