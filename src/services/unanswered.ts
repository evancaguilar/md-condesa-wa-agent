// «💬 Esperando respuesta» — conversations where the LEAD wrote last and
// nobody answered (2026-11-12).
//
// Three real chats from 2026-11-11 died silently and nothing in the panel
// listed them:
//   1. staff tapped «Tomar control» (override, no expiry); the lead later asked
//      «Hoy a la misma hora vdd?» — the bot is silenced, staff never answered;
//   2. «Si por favor» to a post-trial template: only the holding line went out,
//      the approval was DISCARDED (a discarded row never reaches «Sin
//      responder», which only lists EXPIRED approvals — owed-approvals.ts);
//   3. a student wrote «Buena noche. Una pregunta»: the student gate sends no
//      bot reply.
//
// Rules (all pure, unit-tested in test/unanswered.test.ts):
//   - Walk the chat newest → oldest. Holding lines (meta.holding, the exact
//     holding/student-ack texts) are NOT an answer from us: skipped.
//   - Inbound that does NOT need an answer is skipped too: reactions, stickers
//     alone, and pure closers (classifyInbound). A plain acknowledgement
//     ("ok", "va", "sí", 👍) counts as a closer ONLY when our last real message
//     was not a question — "¿Te aparto el jueves 5 pm?" → "Va" needs a reply.
//   - The first message that counts decides: an outbound (bot, staff panel,
//     WA Business echo) ⇒ answered; an inbound that needs an answer ⇒ waiting.
//     A baja/opt-out inbound ends the walk (it never qualifies by itself).
//   - Waiting since = the OLDEST unanswered inbound of that streak; it shows
//     once that is ≥ UNANSWERED_MIN_WAIT_SEC old and ≤ 7 days old.
//   - A pending approval for the phone hides the row (it is already in
//     Aprobaciones). Discarded / expired approvals never hide it — they are
//     shown as the reason. «Ya lo atendí» is a kv marker keyed by phone + the
//     newest unanswered inbound's wamid, so a NEW inbound brings the row back.
//
// The I/O half (four set-based D1 reads per computation, no per-row queries)
// lives in services/unanswered-db.ts.

import { normalizeText } from "../pipeline/campaigns.js";
import { isOptOut } from "../pipeline/opt-out.js";
import { isReminderConfirmText } from "../pipeline/reminder-reply.js";
import { HOLDING_LINE, HOLDING_LINE_EN } from "./slack-timeouts.js";
import { HOLDING_LINE_EN as HOLDING_LINE_EN_V2 } from "./holding-line.js";
import { cdmxParts } from "../cron/time.js";
import { OWED_MAX_AGE_SEC } from "./owed-approvals.js";

/** The lead must have waited this long before the row shows (live turn + approval flow first). */
export const UNANSWERED_MIN_WAIT_SEC = 20 * 60;
/** Only inbound from the last 7 days (older = re-engagement, not a reply). */
export const UNANSWERED_MAX_AGE_SEC = 7 * 86400;
/** Rows returned, newest first. */
export const UNANSWERED_LIMIT = 60;
/** Contacts examined per computation (rows-read bound on the candidate scan). */
export const UNANSWERED_CANDIDATE_LIMIT = 400;
/** Messages per chat read in the walk-back (second pass). */
export const UNANSWERED_TAIL_LIMIT = 12;
/** Slack: ping #wa-leads once a chat has waited this long… */
export const UNANSWERED_SLACK_AFTER_SEC = 60 * 60;
/** …inside 08:00–21:30 CDMX (minutes since midnight, end exclusive). */
export const UNANSWERED_SLACK_START_MIN = 8 * 60;
export const UNANSWERED_SLACK_END_MIN = 21 * 60 + 30;
/** The cron only looks back this far (a reminder is for fresh silences; keeps its scan small). */
export const UNANSWERED_SLACK_LOOKBACK_SEC = 24 * 3600;
/** Lines in one Slack reminder before "+N más". */
export const UNANSWERED_SLACK_MAX_LINES = 15;
/**
 * The panel's shared cache (kv) is reused for this long by every browser
 * (the UI polls every 2 min). A full 7-day computation is ~2–4k rows read, so
 * this caps the panel at ≤ 12 computations/h no matter how many tabs are open;
 * «Ya lo atendí» edits the cache in place, a reply clears within ≤ 5 min.
 */
export const UNANSWERED_CACHE_TTL_SEC = 5 * 60;
/** The cron reuses a panel-computed list this fresh instead of recomputing. */
export const UNANSWERED_CRON_CACHE_TTL_SEC = 5 * 60;
/** Truncation of the lead's message in the panel / Slack. */
export const UNANSWERED_BODY_MAX = 160;

export const UNANSWERED_CACHE_KEY = "unanswered_cache";

/** kv marker: staff tapped «Ya lo atendí» on this inbound. */
export function unansweredDoneKey(phone: string, wamid: string): string {
  return `unanswered_done:${phone}:${wamid}`;
}
/** kv marker: the Slack reminder already listed this inbound. */
export function unansweredPingKey(phone: string, wamid: string): string {
  return `unanswered_ping:${phone}:${wamid}`;
}

// ---------------------------------------------------------------------------
// Message classification
// ---------------------------------------------------------------------------

export interface TailMsg {
  wamid: string;
  direction: string; // in | out_bot | out_human | out_human_echo
  body: string | null;
  ts: number;
  meta: string | null;
}

/**
 * Outbound texts that are a "we'll answer you" placeholder, not an answer:
 * both holding lines (ES + the two EN variants in the tree) plus whatever
 * extra the caller passes (the client's student acknowledgement copy).
 */
export function holdingTexts(extra: ReadonlyArray<string | null | undefined> = []): Set<string> {
  const s = new Set<string>([HOLDING_LINE, HOLDING_LINE_EN, HOLDING_LINE_EN_V2]);
  for (const t of extra) if (t && t.trim()) s.add(t.trim());
  return s;
}

/** Pure. An outbound that is NOT an answer (holding line / ack placeholder). */
export function isHoldingMessage(m: TailMsg, holding: ReadonlySet<string>): boolean {
  if (m.direction === "in") return false;
  const meta = m.meta ?? "";
  if (/"holding"\s*:\s*(1|true)/.test(meta)) return true;
  return holding.has((m.body ?? "").trim());
}

/**
 * Closers that never need an answer: thanks / farewells / "ahí estaré".
 * Normalized (normalizeText: lowercase, no accents, no punctuation).
 * Exported for the report + tests.
 */
export const THANKS_PHRASES: readonly string[] = [
  "muchisimas gracias",
  "muchas gracias",
  "mil gracias",
  "gracias a ti",
  "gracias a usted",
  "gracias a ustedes",
  "gracias igualmente",
  "gracias",
  "grax",
  "igualmente",
  "de nada",
  "thank you",
  "thanks",
  "thx",
  "nos vemos manana",
  "nos vemos pronto",
  "nos vemos",
  "hasta manana",
  "hasta luego",
  "hasta pronto",
  "bye",
  "adios",
  "saludos",
  "bonito dia",
  "bonita tarde",
  "lindo dia",
  "excelente dia",
  "ahi estare",
  "alli estare",
  "ahi estaremos",
  "ahi nos vemos",
];

/**
 * Acknowledgements: a closer after a statement, but a YES (needs action) after
 * our question. Normalized.
 */
export const ACK_PHRASES: readonly string[] = [
  "de acuerdo",
  "muy bien",
  "sale y vale",
  "ok",
  "okay",
  "okey",
  "oki",
  "okis",
  "okas",
  "va",
  "vale",
  "sale",
  "perfecto",
  "perfect",
  "excelente",
  "entendido",
  "enterado",
  "listo",
  "genial",
  "super",
  "claro",
  "si",
];

/** Emoji that read as 👍 / thanks when they are the whole message. */
const ACK_EMOJI = new Set<number>(
  ["👍", "👌", "🙏", "❤", "♥", "🙌", "😊", "☺", "😁", "😀", "😃", "🤝", "✅", "💪", "👏", "🫡", "🥰", "😍", "💯", "🤗"].map(
    (e) => e.codePointAt(0)!,
  ),
);

export type InboundClass = "needs" | "thanks" | "ack" | "ignore" | "optout";

/** Greedy longest-phrase tokenization: every token must belong to a phrase. */
function consumeAll(words: string[], phrases: ReadonlyArray<{ w: string[]; kind: "thanks" | "ack" }>): "thanks" | "ack" | null {
  let i = 0;
  let sawAck = false;
  while (i < words.length) {
    let hit: { w: string[]; kind: "thanks" | "ack" } | null = null;
    for (const p of phrases) {
      if (p.w.length > words.length - i) continue;
      let ok = true;
      for (let k = 0; k < p.w.length; k++) if (words[i + k] !== p.w[k]) { ok = false; break; }
      if (ok && (!hit || p.w.length > hit.w.length)) hit = p;
    }
    if (!hit) return null;
    if (hit.kind === "ack") sawAck = true;
    i += hit.w.length;
  }
  return sawAck ? "ack" : "thanks";
}

const PHRASES: ReadonlyArray<{ w: string[]; kind: "thanks" | "ack" }> = [
  ...THANKS_PHRASES.map((p) => ({ w: p.split(" "), kind: "thanks" as const })),
  ...ACK_PHRASES.map((p) => ({ w: p.split(" "), kind: "ack" as const })),
];

/** Pure. True when the text is only emoji from ACK_EMOJI (modifiers allowed). */
function isAckEmojiOnly(raw: string): boolean {
  const s = raw.replace(/[\s️‍]/gu, "").replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  if (!s) return false;
  for (const ch of s) if (!ACK_EMOJI.has(ch.codePointAt(0)!)) return false;
  return true;
}

/**
 * Pure. Conservative: anything not clearly a closer NEEDS an answer.
 *  - "[reaccionó …]" / "[quitó su reacción]" / a bare sticker → ignore;
 *  - opt-out ("baja", "ya no me manden mensajes") → optout;
 *  - a "?" anywhere, or > 60 normalized chars → needs;
 *  - only THANKS phrases (or "ahí estaré") → thanks; any ACK phrase (or an
 *    ack emoji alone) → ack; any other word → needs.
 */
export function classifyInbound(m: Pick<TailMsg, "body" | "meta">): InboundClass {
  const raw = (m.body ?? "").trim();
  if (/^\[(reaccion|quit[oó] su reacci)/i.test(raw)) return "ignore";
  const meta = m.meta ?? "";
  const sticker = /"type"\s*:\s*"sticker"/.test(meta);
  if (sticker && (raw === "" || raw === "[sticker]")) return "ignore";
  if (!raw) return sticker ? "ignore" : "needs";
  if (isOptOut(raw)) return "optout";
  if (raw.includes("?") || raw.includes("¿")) return "needs";
  const norm = normalizeText(raw);
  if (!norm) return isAckEmojiOnly(raw) ? "ack" : "needs";
  if (norm.length > 60) return "needs";
  if (isReminderConfirmText(raw)) return "thanks";
  return consumeAll(norm.split(" "), PHRASES) ?? "needs";
}

/** Pure. Our message asks the lead something (so "va"/"ok"/👍 is an answer to act on). */
export function isQuestion(body: string | null): boolean {
  return /[?¿]/.test(body ?? "");
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export type TailVerdict =
  | { kind: "answered" }
  | { kind: "quiet" }
  | {
      kind: "waiting";
      /** Newest inbound that needs an answer (its wamid keys the markers). */
      last: TailMsg;
      /** Oldest unanswered inbound of the streak. */
      since: number;
    };

/**
 * Pure. `tail` newest first. "answered" = a real outbound came after the
 * lead's last message that needs one; "quiet" = nothing to answer in what was
 * read (closers only, a baja, or an empty tail). A "waiting" verdict on a
 * SHORT tail can understate `since`; the I/O layer re-reads a longer tail for
 * every chat that is not "answered".
 */
export function judgeTail(tail: readonly TailMsg[], holding: ReadonlySet<string>): TailVerdict {
  let last: TailMsg | null = null;
  let since: number | null = null;
  const acks: TailMsg[] = []; // skipped acknowledgements, newest first
  let answered = false;
  for (const m of tail) {
    if (m.direction !== "in") {
      if (isHoldingMessage(m, holding)) continue;
      // First real message from us. Acks right after our QUESTION are a yes
      // that needs action ("¿Te agendo el jueves?" → "Va").
      if (isQuestion(m.body) && acks.length) {
        if (!last) last = acks[0]!;
        const oldestAck = acks[acks.length - 1]!.ts;
        since = since === null ? oldestAck : Math.min(since, oldestAck);
      }
      answered = true;
      break;
    }
    const c = classifyInbound(m);
    if (c === "optout") break;
    if (c === "ignore" || c === "thanks") continue;
    if (c === "ack") {
      acks.push(m);
      continue;
    }
    // needs an answer
    if (!last) last = m;
    since = m.ts;
  }
  if (last && since !== null) return { kind: "waiting", last, since };
  return { kind: answered ? "answered" : "quiet" };
}

// ---------------------------------------------------------------------------
// Why the bot is not answering
// ---------------------------------------------------------------------------

export type UnansweredReason =
  | { code: "human_override"; until: number }
  | { code: "student" }
  | { code: "bot_off" }
  | { code: "approval_discarded"; approvalId: number }
  | { code: "approval_expired"; approvalId: number }
  | { code: "approval_other"; approvalId: number; status: string };

export interface ReasonFacts {
  now: number;
  botEnabled: boolean;
  status: string | null;
  overrideUntil: number | null;
  /** Newest approval for the phone, any status. */
  latestApproval: { id: number; status: string; createdAt: number } | null;
  /** Oldest unanswered inbound. */
  since: number;
}

/** Pure. Known reasons the bot is silent (empty = unknown: e.g. a dead turn). */
export function reasonsFor(f: ReasonFacts): UnansweredReason[] {
  const out: UnansweredReason[] = [];
  if (f.overrideUntil && f.overrideUntil > f.now) out.push({ code: "human_override", until: f.overrideUntil });
  if (f.status === "student") out.push({ code: "student" });
  if (!f.botEnabled) out.push({ code: "bot_off" });
  const a = f.latestApproval;
  // Only an approval queued for THIS silence explains it (not one from last week).
  if (a && a.createdAt >= f.since - 60) {
    if (a.status === "discarded") out.push({ code: "approval_discarded", approvalId: a.id });
    else if (a.status === "expired") out.push({ code: "approval_expired", approvalId: a.id });
    else if (a.status !== "pending") out.push({ code: "approval_other", approvalId: a.id, status: a.status });
  }
  return out;
}

/** Spanish label for the panel / Slack. */
export function reasonLabel(r: UnansweredReason): string {
  switch (r.code) {
    case "human_override":
      return "🙋 control humano activo";
    case "student":
      return "🎓 alumno (el bot no contesta)";
    case "bot_off":
      return "⏸ bot apagado";
    case "approval_discarded":
      return `🗑 aprobación #${r.approvalId} descartada`;
    case "approval_expired":
      return `⏱ aprobación #${r.approvalId} expirada`;
    case "approval_other":
      return `aprobación #${r.approvalId} (${r.status}) sin envío`;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface UnansweredItem {
  phone: string;
  name: string | null;
  status: string | null;
  /** Newest unanswered inbound (wamid keys «Ya lo atendí» + the Slack marker). */
  wamid: string;
  lastBody: string;
  lastTs: number;
  /** Oldest unanswered inbound of the streak = "esperando desde". */
  since: number;
  reasons: UnansweredReason[];
}

export interface CandidateFacts {
  phone: string;
  name: string | null;
  status: string | null;
  overrideUntil: number | null;
  verdict: TailVerdict;
  latestApproval: { id: number; status: string; createdAt: number } | null;
  hasPending: boolean;
  /** «Ya lo atendí» set for verdict.last.wamid. */
  handled: boolean;
}

/**
 * Pure. Dedupe against «⏱ Sin responder» (owed-approvals.ts lists the newest
 * EXPIRED approval per phone for 7 days until «Ya lo atendí»): when the newest
 * approval was queued for THIS silence and expired within that window, the
 * chat lives there (or was already marked handled there) — not here.
 */
export function isInOwedList(
  latest: { status: string; createdAt: number } | null,
  since: number,
  now: number,
): boolean {
  return (
    !!latest &&
    latest.status === "expired" &&
    latest.createdAt >= since - 60 &&
    now - latest.createdAt <= OWED_MAX_AGE_SEC
  );
}

export function truncateBody(s: string, max = UNANSWERED_BODY_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Pure. Final list, newest last-message first, capped. */
export function selectUnanswered(
  rows: readonly CandidateFacts[],
  o: { now: number; botEnabled: boolean; maxAgeSec?: number; minWaitSec?: number; limit?: number },
): UnansweredItem[] {
  const maxAge = o.maxAgeSec ?? UNANSWERED_MAX_AGE_SEC;
  const minWait = o.minWaitSec ?? UNANSWERED_MIN_WAIT_SEC;
  const out: UnansweredItem[] = [];
  for (const r of rows) {
    if (r.status === "opted_out") continue;
    if (r.verdict.kind !== "waiting") continue;
    if (r.hasPending || r.handled) continue;
    const { last, since } = r.verdict;
    if (o.now - since < minWait) continue;
    if (o.now - last.ts > maxAge) continue;
    out.push({
      phone: r.phone,
      name: r.name,
      status: r.status,
      wamid: last.wamid,
      lastBody: truncateBody(last.body ?? ""),
      lastTs: last.ts,
      since,
      reasons: reasonsFor({
        now: o.now,
        botEnabled: o.botEnabled,
        status: r.status,
        overrideUntil: r.overrideUntil,
        latestApproval: r.latestApproval,
        since,
      }),
    });
  }
  out.sort((a, b) => b.lastTs - a.lastTs || (a.phone < b.phone ? -1 : 1));
  return out.slice(0, o.limit ?? UNANSWERED_LIMIT);
}

// ---------------------------------------------------------------------------
// Cache + Slack reminder
// ---------------------------------------------------------------------------

export interface UnansweredCache {
  at: number;
  /** Look-back the list was computed with (the cron's 24 h list is a subset). */
  maxAgeSec: number;
  items: UnansweredItem[];
}

/** Pure. Parses the kv cache; null when missing/garbled/too old. */
export function parseCache(raw: string | null, now: number, ttlSec: number, needMaxAgeSec: number): UnansweredCache | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as UnansweredCache;
    if (typeof c?.at !== "number" || !Array.isArray(c.items)) return null;
    if (now - c.at > ttlSec || now < c.at - 5) return null;
    if ((c.maxAgeSec ?? 0) < needMaxAgeSec) return null;
    return c;
  } catch {
    return null;
  }
}

/** Pure. 08:00 ≤ CDMX time < 21:30. */
export function inReminderWindow(now: number): boolean {
  const p = cdmxParts(now);
  const min = p.hour * 60 + p.minute;
  return min >= UNANSWERED_SLACK_START_MIN && min < UNANSWERED_SLACK_END_MIN;
}

/** Pure. Items due for the Slack reminder (marker filtering is the caller's). */
export function dueForReminder(items: readonly UnansweredItem[], now: number): UnansweredItem[] {
  return items.filter(
    (it) => now - it.since >= UNANSWERED_SLACK_AFTER_SEC && now - it.lastTs <= UNANSWERED_SLACK_LOOKBACK_SEC,
  );
}

/** "45 min" / "1 h 20 min" / "2 d 3 h". */
export function waitedLabel(sec: number): string {
  const m = Math.max(0, Math.floor(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Pure. ONE aggregated #wa-leads message (no @here). */
export function reminderText(
  items: readonly UnansweredItem[],
  now: number,
  links: { panel: string; chat: (phone: string) => string | null },
): string {
  const shown = items.slice(0, UNANSWERED_SLACK_MAX_LINES);
  const lines = shown.map((it) => {
    const who = it.name && it.name.trim() ? `*${it.name.trim()}* (${it.phone})` : `*${it.phone}*`;
    const why = it.reasons.length ? ` — ${it.reasons.map(reasonLabel).join(", ")}` : "";
    const url = links.chat(it.phone);
    return `• ${who} — espera ${waitedLabel(now - it.since)} — «${truncateBody(it.lastBody, 100)}»${why}${url ? ` <${url}|💬 Abrir>` : ""}`;
  });
  const more = items.length > shown.length ? `\n…y ${items.length - shown.length} más.` : "";
  const n = items.length;
  return (
    `💬 *${n} ${n === 1 ? "chat espera" : "chats esperan"} respuesta* (el lead escribió último y nadie contestó en ≥ 1 h):\n` +
    lines.join("\n") +
    more +
    `\n<${links.panel}|Ver «Esperando respuesta» en Aprobaciones> — contesta o marca «Ya lo atendí».`
  );
}
