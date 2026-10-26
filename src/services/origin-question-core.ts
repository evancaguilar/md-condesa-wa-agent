// Pure half of the "¿cómo nos encontraste?" question (owner, 2026-10-21).
//
// A lead who reached us with NO attribution (no click-to-WhatsApp ad referral,
// no Google click ref, no campaign) books a trial; a few minutes AFTER the
// booking confirmation reached them, the bot asks once how they found us.
// Their answer lands in Leads.Canal (+ the raw text in "Cómo nos encontró"),
// which the Airtable `Origen` formula reads: Anuncio → Pagado (Meta ROAS),
// the rest → Orgánico. Unanswered = nothing happens, the booking is unaffected.
//
// No I/O here: eligibility, copy selection, answer classification, the kv
// state shape. The I/O half is ./origin-question.ts.

import type { Contact } from "../types.js";

/** Delay after the confirmation (video goes first; the cron tick adds 0–5 min). */
export const ORIGIN_ASK_DELAY_SEC = 3 * 60;
/** An answer is only read within this long after the question went out. */
export const ORIGIN_ANSWER_WINDOW_SEC = 48 * 3600;
/** Max deferrals (lead mid-conversation / pending approval) before giving up. */
export const ORIGIN_MAX_DEFERS = 24;
/** Deferral step while the conversation is still live. */
export const ORIGIN_DEFER_SEC = 10 * 60;

/** Canal values the question writes (must match the Leads `Canal` options). */
export type OriginCanal = "Anuncio" | "Post orgánico" | "Google Maps" | "Google" | "Referido" | "Local";

/** Numbered options, in the order the question lists them (owner's order). */
export const ORIGIN_OPTIONS: readonly OriginCanal[] = [
  "Anuncio",
  "Post orgánico",
  "Google Maps",
  "Google",
  "Referido",
  "Local",
];

/** kv: once-ever claim that the question was armed for this phone. */
export function originArmedKey(phone: string): string {
  return `origin_q_armed:${phone}`;
}

/** kv: question state for this phone (JSON OriginState). */
export function originStateKey(phone: string): string {
  return `origin_q:${phone}`;
}

export interface OriginState {
  /** When the question was sent (epoch s). */
  askedAt: number;
  /** When an answer was captured (epoch s); absent = still open. */
  answeredAt?: number;
  /** The Canal value written, when the answer was classifiable. */
  canal?: OriginCanal | null;
  /** Inbound messages read since the question that were NOT an answer. */
  misses?: number;
}

/** Only the first few messages after the question are read as a possible answer. */
export const ORIGIN_MAX_MISSES = 2;

export function parseOriginState(raw: string | null | undefined): OriginState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OriginState>;
    if (typeof v.askedAt !== "number") return null;
    return {
      askedAt: v.askedAt,
      ...(typeof v.answeredAt === "number" ? { answeredAt: v.answeredAt } : {}),
      ...(v.canal !== undefined ? { canal: v.canal ?? null } : {}),
      ...(typeof v.misses === "number" ? { misses: v.misses } : {}),
    };
  } catch {
    return null;
  }
}

/** True while an asked, unanswered question may still be answered. */
export function originAwaitingAnswer(state: OriginState | null, nowSec: number): boolean {
  return (
    !!state &&
    state.answeredAt === undefined &&
    (state.misses ?? 0) < ORIGIN_MAX_MISSES &&
    nowSec - state.askedAt <= ORIGIN_ANSWER_WINDOW_SEC
  );
}

export interface OriginEligibilityInput {
  contact: Pick<Contact, "status" | "ad_ref" | "campaign_id"> | null;
  /** The contact has a stored Google Ads click (kv gclick:<phone>). */
  hasGoogleClick: boolean;
}

/**
 * Ask only leads we know nothing about: an ad referral, a Google click or a
 * campaign tag already answers the question (the Origen formula reads them).
 * Students and opted-out contacts are never asked; no contact row (a web-form
 * booker who never wrote to us) → no.
 */
export function shouldAskOrigin(input: OriginEligibilityInput): boolean {
  const c = input.contact;
  if (!c) return false;
  if (c.status !== "lead") return false;
  if (c.ad_ref) return false;
  if (c.campaign_id !== null) return false;
  if (input.hasGoogleClick) return false;
  return true;
}

/** Bot-written Canal values the answer may replace. Anything else is a human's call. */
const CANAL_OVERWRITABLE = new Set(["", "wa", "ig", "fb"]);

/** True when Leads.Canal may be set from the answer (empty or a bot channel value). */
export function canalWritable(current: unknown): boolean {
  const v =
    typeof current === "string"
      ? current
      : current && typeof current === "object" && "name" in current
        ? String((current as { name: unknown }).name ?? "")
        : current === null || current === undefined
          ? ""
          : null;
  return v !== null && CANAL_OVERWRITABLE.has(v.trim().toLowerCase());
}

/** True when the Leads row already says where the lead came from (skip asking). */
export function leadAlreadyAttributed(fields: Record<string, unknown> | null | undefined, canalField: string): boolean {
  if (!fields) return false;
  if (!canalWritable(fields[canalField])) return true;
  const adq = fields["Adquisición"];
  if (typeof adq === "string" && adq.trim() !== "") return true;
  const vio = fields["Vio anuncio"];
  if (Array.isArray(vio) && vio.some((x) => typeof x === "string" && /^s[ií]/i.test(x))) return true;
  return false;
}

/** The question in the contact's language; null when the client has no copy (feature off). */
export function originQuestionCopy(
  lang: string,
  copy: { originQuestionEs?: string; originQuestionEn?: string },
): string | null {
  const t = lang === "en" ? copy.originQuestionEn ?? copy.originQuestionEs : copy.originQuestionEs;
  return t && t.trim() ? t : null;
}

/** Lowercase, accent-free, keycap emojis → digits. */
export function normalizeAnswer(text: string): string {
  return text
    .replace(/([0-9])️?⃣/g, "$1")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface OriginAnswer {
  /** Canal value, or null when the answer names a source we can't place
   *  (e.g. "Instagram" — ad or organic post?). */
  canal: OriginCanal | null;
}

const DIGIT_ONLY_RE = /^(?:(?:la|el|opcion|numero|num|no\.?|#|option|number)\s*)?([1-6])\s*[.)!]*\s*$/;

/**
 * Classify a reply to the question. Returns null when the text does not look
 * like an answer at all (the lead is talking about something else) — the
 * question then simply stays open. A bare digit 1–6 maps to the numbered
 * option; otherwise keywords, with "anuncio" winning (it decides Meta ROAS)
 * unless negated ("no fue anuncio"). Social-network names alone are an answer
 * with canal null (raw text recorded, nobody guesses ad vs post).
 */
export function classifyOriginAnswer(text: string): OriginAnswer | null {
  const t = normalizeAnswer(text);
  if (!t || t.length > 200) return null;

  const digit = DIGIT_ONLY_RE.exec(t);
  if (digit) return { canal: ORIGIN_OPTIONS[Number(digit[1]) - 1] ?? null };
  // A question back ("¿tienen estacionamiento?", "¿la ubicación en maps?") is
  // the lead talking about something else, not an answer.
  if (/[?¿]/.test(text)) return null;

  const negatedAd = /\bno\b[^.!]{0,20}\b(anuncio|publicidad|ad)\b/.test(t);
  if (!negatedAd && /\b(anuncio|anuncios|publicidad|patrocinad\w*|promocionad\w*|sponsored|ads?|advert\w*)\b/.test(t)) {
    return { canal: "Anuncio" };
  }
  if (/\b(google maps|maps|mapa|mapas)\b/.test(t)) return { canal: "Google Maps" };
  const friend = /\b(amig[oa]s?)\b/.test(t) && !/\bcon (un|una|mi|mis|unos|unas) amig/.test(t);
  // "mi hermana entrena con ustedes" — family + a sign they know the academy
  // (never just "mi esposo también quiere ir").
  const family =
    /\bmi (hermana|hermano|mama|papa|esposa|esposo|novia|novio|prima|primo|tia|tio|jefe|jefa|vecina|vecino|cunada|cunado|companer[oa])\b/.test(t) &&
    /\b(entrena|entrenaba|es alumn\w*|toma clases|tomaba clases|va a clases|iba a clases|me (dijo|recomendo|platico|paso))\b/.test(t);
  if (
    friend ||
    family ||
    /\b(recomend\w*|recomiend\w*|referid\w*|me dijo|me dijeron|me pasaron|me platico|recommend\w*|word of mouth|a friend|my friend)\b/.test(t)
  ) {
    return { canal: "Referido" };
  }
  if (/\b(pase por|pasando por|pasaba por|caminando|camine|enfrente|vivo cerca|vivo por|trabajo cerca|letrero|lona|walked by|walking by|passed by|passing by|live nearby|work nearby)\b/.test(t)) {
    return { canal: "Local" };
  }
  if (/\b(google|busque|buscando|busqueda|internet|search\w*|googl\w*)\b/.test(t)) return { canal: "Google" };
  if (negatedAd || /\b(publicacion|publicaciones|post|posts|reel|reels|organico)\b/.test(t)) {
    return { canal: "Post orgánico" };
  }
  if (/\b(instagram|insta|ig|facebook|fb|tiktok|tik tok|redes|redes sociales|social media)\b/.test(t)) {
    return { canal: null };
  }
  return null;
}

/** A message as the send gate sees it (newest first). */
export interface GateMessage {
  direction: "in" | "out_bot" | "out_human_echo" | "out_human";
  body: string;
  ts: number;
}

/**
 * Pure send-time gate: never talk over a live exchange. Defer when
 *  - the lead spoke last less than 15 min ago (a brain turn / approval may
 *    still answer it; an older unanswered "gracias" is a closed exchange);
 *  - a bot question ("…?") since the lead's last message is < 2 h old
 *    (e.g. the confirmation asked "¿vienes solo o acompañado?");
 *  - a staff message went out < 60 min ago.
 * `messages` newest first.
 */
export function originSendGate(
  messages: readonly GateMessage[],
  nowSec: number,
): "send" | "defer" {
  // Newest first whatever the caller passed: recentMessages() is oldest-first,
  // and reading [0] as the newest let the question go out over …1122's
  // unanswered message (2026-10-22 10:02).
  const byNewest = [...messages].sort((a, b) => b.ts - a.ts);
  const newest = byNewest[0];
  if (!newest) return "send";
  if (newest.direction === "in" && nowSec - newest.ts < 15 * 60) return "defer";
  for (const m of byNewest) {
    if (m.direction === "in") break;
    if ((m.direction === "out_human" || m.direction === "out_human_echo") && nowSec - m.ts < 3600) return "defer";
    if (m.direction === "out_bot" && /\?\s*\S{0,3}\s*$/u.test(m.body.trim()) && nowSec - m.ts < 2 * 3600) {
      return "defer";
    }
  }
  return "send";
}

/** Deferral counter kept in the followup note ("defers:N"). */
export function readDefers(note: string | null | undefined): number {
  const m = /defers:(\d+)/.exec(note ?? "");
  return m ? Number(m[1]) : 0;
}

/** Answer captured this recently still steers the brain turn (burst debounce). */
export const ORIGIN_HINT_SEC = 5 * 60;

/** The just-captured answer, for the brain hint, when it landed in the last few minutes. */
export function recentOriginAnswer(state: OriginState | null, nowSec: number): { canal: OriginCanal | null } | null {
  if (!state || state.answeredAt === undefined) return null;
  if (nowSec - state.answeredAt > ORIGIN_HINT_SEC) return null;
  return { canal: state.canal ?? null };
}
