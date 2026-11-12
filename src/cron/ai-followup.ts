// AI-written day-1 follow-ups (owner request 2026-11-11, features.aiFollowups).
//
// nudge_1h / nudge_8h go out inside the 24 h window, so free-form text is
// allowed. For a lead who wrote something real (the nudgePolicy "engaged"
// class — src/cron/nudge-policy.ts, D1 lookup src/db/nudge-engagement.ts) the
// brain now writes them as a CONTINUATION of the open thread instead of the
// fixed sentences of ./nudge-copy.ts. Silent leads keep the fixed copy.
//
// This module is the pure part: the per-turn instruction block (the cached
// system blocks are untouched — see brain/claude.ts writeFollowup), the
// validation of what came back (the same reply guards a normal turn runs, plus
// length / link / staff-note / duplicate / price checks), the timeout wrapper
// and the per-tick counters behind the one aggregated ops_log note. Every
// failure resolves to a fallback REASON: the caller (nudges.ts processNudge)
// then sends the EXISTING fixed copy — a follow-up never queues for approval
// and is never dropped because the AI failed.

import type { BrainResult, Contact, FollowupWrite, Language, ProgramBand } from "../types.js";
import type { CtaMode } from "./nudge-copy.js";
import type { MinuteRange } from "./nudge-context.js";
import type { NextSlot } from "./next-slot.js";
import { disciplineLabel, slotPhrase, time12h } from "./next-slot.js";
import { programLink } from "./nudge-copy.js";
import { isDuplicateSend } from "./nudge-signals.js";
import {
  guardBookingDateClaim,
  guardFactClaims,
  guardUnbackedBookingClaim,
  guardUnverifiedSlotClaim,
} from "../brain/claude.js";
import { looksInternalNote } from "../brain/followup-note.js";
import { CLIENT } from "../client.gen.js";

/** Day-1 kinds the brain may write. The legacy nudge_6h keeps its copy. */
export const AI_FOLLOWUP_KINDS = ["nudge_1h", "nudge_8h"] as const;
export type AiFollowupKind = (typeof AI_FOLLOWUP_KINDS)[number];

export function isAiFollowupKind(kind: string): kind is AiFollowupKind {
  return (AI_FOLLOWUP_KINDS as readonly string[]).includes(kind);
}

/** At most this many AI-written follow-ups per cron tick (cost + latency). */
export const AI_FOLLOWUPS_PER_TICK = 3;
/** A row over the per-tick cap waits this long (it is NOT downgraded to fixed copy). */
export const AI_FOLLOWUP_DEFER_SECONDS = 5 * 60;
/** Wall-clock budget for the brain call. */
export const AI_FOLLOWUP_TIMEOUT_MS = 20_000;
/** What the instruction asks for … */
export const AI_FOLLOWUP_TARGET_CHARS = 280;
/** … and the hard limit past which the fixed copy goes instead. */
export const AI_FOLLOWUP_MAX_CHARS = 320;

const WEEKDAYS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const WEEKDAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// ---- brief + instruction (pure) ----------------------------------------------

/** Everything the instruction block needs, computed by processNudge. */
export interface AiFollowupBrief {
  kind: AiFollowupKind;
  lang: Language;
  /** Whole hours since the lead's last message (≥ 1). */
  hoursSilent: number;
  /** Bodies WE sent after the lead's last message, oldest first (the open
   *  thread's last bot reply, and on nudge_8h the nudge_1h text too). */
  sentSinceLastInbound: string[];
  band: ProgramBand;
  /** Service key the lead chose ("muay"), or null. */
  discipline: string | null;
  /** 0=Mon … 6=Sun. */
  declinedWeekdays: number[];
  preferredWeekdays: number[] | null;
  timeRanges: readonly MinuteRange[] | null;
  excludeDates: string[];
  /** "YYYY-MM-DD HH:mm" already proposed by an earlier nudge. */
  proposedSlots: string[];
  /** planNudgeCopy's close + slot (the SAME constraints the fixed copy uses). */
  cta: CtaMode;
  nextSlot: NextSlot | null;
  /** Epoch s, to phrase nextSlot ("mañana miércoles…"). */
  now: number;
}

function minutesLabel(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = String(m % 60).padStart(2, "0");
  return time12h(`${String(h).padStart(2, "0")}:${mm}`);
}

function rangesLabel(ranges: readonly MinuteRange[], lang: Language): string {
  const between = lang === "en" ? "between" : "entre";
  const and = lang === "en" ? "and" : "y";
  const end = (m: number) => (m >= 24 * 60 ? (lang === "en" ? "midnight" : "medianoche") : minutesLabel(m));
  return ranges.map(([a, b]) => `${between} ${minutesLabel(a)} ${and} ${end(b)}`).join(lang === "en" ? " or " : " o ");
}

function dayNames(days: readonly number[], lang: Language): string {
  const names = lang === "en" ? WEEKDAYS_EN : WEEKDAYS_ES;
  return [...new Set(days)].sort((a, b) => a - b).map((d) => names[d] ?? String(d)).join(", ");
}

/** The booking link for a band (adults page, else the kids page). */
export function bandBookingLink(band: ProgramBand): string {
  return programLink(band === "adults" ? "adults" : "kids");
}

/** Pure. The slot constraint lines, in the instruction's language. */
function constraintLines(b: AiFollowupBrief): string[] {
  const es = b.lang !== "en";
  const out: string[] = [];
  if (b.discipline) out.push(es ? `Disciplina que eligió: ${disciplineLabel(b.discipline)}.` : `Discipline they chose: ${disciplineLabel(b.discipline)}.`);
  if (b.declinedWeekdays.length) {
    out.push(es ? `Días que NO puede (nunca los propongas): ${dayNames(b.declinedWeekdays, "es")}.` : `Days they CANNOT do (never offer them): ${dayNames(b.declinedWeekdays, "en")}.`);
  }
  if (b.preferredWeekdays?.length) {
    out.push(es ? `Días que prefiere: ${dayNames(b.preferredWeekdays, "es")}.` : `Days they prefer: ${dayNames(b.preferredWeekdays, "en")}.`);
  }
  if (b.timeRanges?.length) {
    out.push(es ? `Horario que le acomoda: ${rangesLabel(b.timeRanges, "es")}.` : `Time of day that works: ${rangesLabel(b.timeRanges, "en")}.`);
  }
  if (b.excludeDates.length) {
    out.push(es ? `Fechas que descartó: ${b.excludeDates.join(", ")}.` : `Dates they ruled out: ${b.excludeDates.join(", ")}.`);
  }
  if (b.proposedSlots.length) {
    out.push(es ? `Clases que ya le propusimos (no las repitas): ${b.proposedSlots.join(", ")}.` : `Classes we already proposed (do not repeat): ${b.proposedSlots.join(", ")}.`);
  }
  const link = bandBookingLink(b.band);
  switch (b.cta) {
    case "slot":
      if (b.nextSlot) {
        const phrase = slotPhrase(b.nextSlot, b.now, es ? "es" : "en");
        const key = `${b.nextSlot.date} ${b.nextSlot.time}`;
        out.push(
          es
            ? `Siguiente clase REAL que respeta todo lo anterior: ${phrase} (${key}). Si propones una clase, que sea ésta u otra que esté en el horario de la base de conocimiento y respete estas mismas reglas.`
            : `Next REAL class that respects all of the above: ${phrase} (${key}). If you propose a class, use this one or another one from the knowledge-base schedule that respects these same rules.`,
        );
      }
      break;
    case "keep_offer":
      out.push(
        es
          ? "Nuestro último mensaje ya le propuso un horario: no le ofrezcas uno distinto que lo contradiga; retómalo o resuelve lo que lo frena."
          : "Our last message already proposed a time: do not offer a different one that contradicts it; pick it back up or address what is holding them back.",
      );
      break;
    case "ask_age":
      out.push(
        es
          ? "Es para un menor y NO sabemos su edad: no propongas día ni hora; pregunta la edad (de ella depende la clase)."
          : "It is for a minor and we do NOT know the age: do not propose a day or time; ask the age (the class depends on it).",
      );
      break;
    case "link":
      out.push(
        es
          ? `Ningún horario encaja con lo que dijo: no propongas día ni hora; si cierras con algo, que sea el link para agendar: ${link}`
          : `No class fits what they said: do not propose a day or time; if you close with something, make it the booking link: ${link}`,
      );
      break;
  }
  return out;
}

/** Caps one quoted message so a long bot reply can't bloat the block. */
function quote(s: string, max = 600): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Pure. The `<seguimiento>` block appended LAST to the per-turn context
 * (ConvoContext.followupInstruction). Spanish for Spanish leads, English for
 * English ones. Everything a follow-up must obey lives here — never in the
 * cached system blocks.
 */
export function buildFollowupInstruction(b: AiFollowupBrief): string {
  const es = b.lang !== "en";
  const n = Math.max(1, Math.round(b.hoursSilent));
  const second = b.kind === "nudge_8h";
  const sent = b.sentSinceLastInbound.map((s) => s.trim()).filter(Boolean);
  const constraints = constraintLines(b);
  const lines: string[] = [];
  if (es) {
    lines.push(
      "<seguimiento>",
      `Este turno NO responde un mensaje nuevo: es un SEGUIMIENTO automático (${second ? "el 2º y último de hoy" : "el 1º de hoy"}) a un lead que dejó de contestar hace ~${n} h. Escribe el mensaje que le enviaremos ahora, en español.`,
      "Reglas:",
      "- Continúa el hilo que quedó abierto (lo último que se habló), como si siguieras la misma plática. No vuelvas a saludar ni a presentarte, y nada de muletillas como \"solo paso a…\", \"solo quería…\", \"¿sigues ahí?\" o \"¿pudiste ver mi mensaje?\".",
      "- UNA sola pregunta o UNA propuesta concreta. Máximo 2 frases cortas y 280 caracteres en total.",
      "- Sin presión ni urgencia falsa (nada de \"últimos lugares\", \"se acaba hoy\", \"no te lo pierdas\").",
      "- Solo datos que estén en la base de conocimiento o en este contexto: no inventes precios, horarios, promociones, cupos ni nada nuevo. Si mencionas un precio, que sea uno que ya le dimos en esta conversación. Sin links, salvo el de agendar de su programa.",
      "- Es un seguimiento: NO agendes ni confirmes ninguna clase (no llames book_trial), no programes recordatorios (set_followup) y no escales (escalate_to_human). Llama SOLO send_reply con el texto en message, language \"es\" y tu sureness; deja escalation_reason vacío.",
    );
    if (sent.length) {
      lines.push(
        second
          ? "Desde su último mensaje ya le enviamos esto (incluido el seguimiento de hace unas horas):"
          : "Desde su último mensaje ya le enviamos esto:",
        "---",
        ...sent.map((s) => quote(s)),
        "---",
        second
          ? "NO lo repitas ni lo parafrasees: usa un ángulo DIFERENTE — otro horario real, o resuelve la duda que probablemente lo frena (precio, horario, venir solo/a, ser principiante)."
          : "No lo repitas tal cual: retómalo y llévalo un paso adelante.",
      );
    }
    if (constraints.length) lines.push("Si propones una clase:", ...constraints.map((c) => `- ${c}`));
    lines.push("</seguimiento>");
  } else {
    lines.push(
      "<seguimiento>",
      `This turn does NOT answer a new message: it is an automatic FOLLOW-UP (${second ? "the 2nd and last one today" : "the 1st one today"}) to a lead who went quiet ~${n} h ago. Write the message we will send now, in English.`,
      "Rules:",
      "- Continue the thread that was left open (the last thing you talked about), as if you were picking the same chat back up. Do not greet or introduce yourself again, and no filler like \"just checking in…\", \"just wanted to…\", \"are you still there?\" or \"did you see my message?\".",
      "- ONE question or ONE concrete proposal. At most 2 short sentences and 280 characters in total.",
      "- No pressure and no fake urgency (no \"last spots\", \"ends today\", \"don't miss out\").",
      "- Only facts that are in the knowledge base or in this context: do not invent prices, schedules, promotions, capacity or anything new. If you mention a price, it must be one we already gave them in this conversation. No links, except their program's booking link.",
      "- It is a follow-up: do NOT book or confirm any class (no book_trial), do not schedule reminders (set_followup) and do not escalate (escalate_to_human). Call ONLY send_reply with the text in message, language \"en\" and your sureness; leave escalation_reason empty.",
    );
    if (sent.length) {
      lines.push(
        second
          ? "Since their last message we already sent this (including the follow-up from a few hours ago):"
          : "Since their last message we already sent this:",
        "---",
        ...sent.map((s) => quote(s)),
        "---",
        second
          ? "Do NOT repeat or paraphrase it: use a DIFFERENT angle — another real class time, or address what is probably holding them back (price, schedule, coming alone, being a beginner)."
          : "Do not repeat it as is: pick it back up and move it one step forward.",
      );
    }
    if (constraints.length) lines.push("If you propose a class:", ...constraints.map((c) => `- ${c}`));
    lines.push("</seguimiento>");
  }
  return lines.join("\n");
}

// ---- validation (pure) -------------------------------------------------------

export interface AiFollowupCheckCtx {
  /** "YYYY-MM-DDTHH:mm" CDMX (cdmxHintContext(now).iso). */
  nowCdmx: string;
  now: number;
  /** The band-adjusted contact planNudgeCopy produced (the guards read its band). */
  contact: Contact;
  campaignName: string | null;
  lang: Language;
  /** Our recent outbound (body + ts): duplicate + previously-quoted prices. */
  recentOutbound: readonly { body: string; ts: number }[];
}

/** Fallback reasons that are validateAiFollowup guards (not brain refusals / errors). */
export const AI_FOLLOWUP_GUARD_REASONS: readonly string[] = [
  "empty",
  "too_long",
  "url_not_allowed",
  "internal_note",
  "markup",
  "duplicate",
  "booking_claim",
  "slot_claim",
  "booking_date",
  "fact_claim",
  "price",
];

export type AiFollowupCheck = { ok: true; text: string } | { ok: false; reason: string; detail?: string };

/** composeAiFollowup's result: the check, plus the brain's raw text when it wrote one (preview). */
export type AiFollowupOutcome = AiFollowupCheck & { draft?: string };

const URL_RE = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|mx|net|org|io|app|link|ly|me|co)(?:\/[^\s<>()]*)?/gi;
const PRICE_RE = /\$\s?\d[\d,.]*/g;

function stripUrl(u: string): string {
  return u
    .replace(/[.,;:!?)\]»"']+$/u, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** The links a follow-up may carry: every client link + both booking pages. */
export function allowedFollowupLinks(): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(CLIENT.links ?? {})) if (typeof v === "string" && v) out.add(stripUrl(v));
  out.add(stripUrl(programLink("adults")));
  out.add(stripUrl(programLink("kids")));
  out.delete("");
  return out;
}

/** Pure. URLs in `text` that are not on the allowed list. */
export function disallowedUrls(text: string, allowed: ReadonlySet<string> = allowedFollowupLinks()): string[] {
  return (text.match(URL_RE) ?? []).filter((u) => !allowed.has(stripUrl(u)));
}

function normPrice(p: string): string {
  return p.replace(/\s+/g, "").replace(/[.,]+$/, "");
}

/** Pure. Currency figures in `text` we never quoted to this lead before. */
export function unquotedPrices(text: string, priorOutbound: readonly string[]): string[] {
  const said = new Set(priorOutbound.flatMap((b) => (b.match(PRICE_RE) ?? []).map(normPrice)));
  return (text.match(PRICE_RE) ?? []).map(normPrice).filter((p) => !said.has(p));
}

/**
 * Pure. Runs the generated text through everything a normal reply goes
 * through before it may auto-send — guardUnbackedBookingClaim (booking claim
 * without a booking), guardUnverifiedSlotClaim (slot-claims: impossible hour /
 * class that is not on the band's grid), guardBookingDateClaim, guardFactClaims
 * (capacity + adult combo) — plus the follow-up-only checks. The first problem
 * found is the fallback reason; ok ⇒ the (trimmed) text is safe to send.
 */
export function validateAiFollowup(raw: string, ctx: AiFollowupCheckCtx): AiFollowupCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > AI_FOLLOWUP_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (disallowedUrls(text).length) return { ok: false, reason: "url_not_allowed" };
  if (looksInternalNote(text)) return { ok: false, reason: "internal_note" };
  if (/<\/?[a-z_]+>/i.test(text)) return { ok: false, reason: "markup" };
  if (isDuplicateSend(text, ctx.recentOutbound, ctx.now)) return { ok: false, reason: "duplicate" };
  const probe: BrainResult = { action: "send", message: text, language: ctx.lang, confidence: "high" };
  const gctx = {
    nowCdmx: ctx.nowCdmx,
    contact: ctx.contact,
    ...(ctx.campaignName ? { campaign: { name: ctx.campaignName, info: "" } } : {}),
  };
  const guards: [string, (r: BrainResult) => BrainResult][] = [
    ["booking_claim", (r) => guardUnbackedBookingClaim(r, undefined)],
    ["slot_claim", (r) => guardUnverifiedSlotClaim(r, gctx)],
    ["booking_date", (r) => guardBookingDateClaim(r, gctx)],
    ["fact_claim", (r) => guardFactClaims(r, gctx)],
  ];
  for (const [reason, guard] of guards) {
    const r = guard(probe);
    if (r.action !== "send") {
      return { ok: false, reason, ...(r.action === "draft" && r.reason ? { detail: r.reason } : {}) };
    }
  }
  if (unquotedPrices(text, ctx.recentOutbound.map((m) => m.body)).length) return { ok: false, reason: "price" };
  return { ok: true, text };
}

// ---- the call (timeout + validation) -----------------------------------------

/**
 * Asks the writer once, bounded by `timeoutMs`, and validates the answer.
 * Never throws: a throw is "brain_error", the deadline is "timeout", a brain
 * refusal carries its own reason (brain/claude.ts parseFollowupResponse).
 */
export async function composeAiFollowup(opts: {
  write: () => Promise<FollowupWrite>;
  check: (text: string) => AiFollowupCheck;
  timeoutMs?: number;
}): Promise<AiFollowupOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<FollowupWrite>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), opts.timeoutMs ?? AI_FOLLOWUP_TIMEOUT_MS);
  });
  let res: FollowupWrite;
  try {
    res = await Promise.race([
      opts.write().catch((err: unknown): FollowupWrite => {
        console.warn(`[ai-followup] writer threw: ${String(err)}`);
        return { ok: false, reason: "brain_error" };
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!res.ok) return res;
  return { ...opts.check(res.text), draft: res.text };
}

// ---- per-tick accounting -----------------------------------------------------

/** One cron tick's AI follow-up budget and outcome counts. */
export interface AiFollowupTick {
  limit: number;
  /** Brain calls started this tick. */
  started: number;
  written: number;
  /** Fallback reason → count (the fixed copy went instead). */
  fallbacks: Map<string, number>;
  /** Rows pushed back because the tick's budget was spent. */
  deferred: number;
}

export function newAiFollowupTick(limit: number = AI_FOLLOWUPS_PER_TICK): AiFollowupTick {
  return { limit, started: 0, written: 0, fallbacks: new Map(), deferred: 0 };
}

export function aiTickHasRoom(t: AiFollowupTick): boolean {
  return t.started < t.limit;
}

export function recordAiFallback(t: AiFollowupTick, reason: string): void {
  t.fallbacks.set(reason, (t.fallbacks.get(reason) ?? 0) + 1);
}

/** Pure. ONE ops_log line for the tick (null when nothing happened). */
export function aiFollowupNote(t: AiFollowupTick): string | null {
  const fb = [...t.fallbacks.entries()].sort(([a], [b]) => a.localeCompare(b));
  const fbTotal = fb.reduce((n, [, c]) => n + c, 0);
  if (t.written + fbTotal + t.deferred === 0) return null;
  const parts = [`${t.written} escrito(s) por la IA`];
  if (fbTotal) parts.push(`${fbTotal} con copy fijo (${fb.map(([r, c]) => `${r} ${c}`).join(", ")})`);
  if (t.deferred) parts.push(`${t.deferred} pospuesto(s) por el tope de ${t.limit}/tick`);
  return `✍️ Seguimientos día 1 con IA: ${parts.join(", ")}.`;
}

/** Pure. The aggregated note's structured meta. */
export function aiFollowupNoteMeta(t: AiFollowupTick): Record<string, unknown> {
  return { written: t.written, deferred: t.deferred, fallbacks: Object.fromEntries(t.fallbacks) };
}
