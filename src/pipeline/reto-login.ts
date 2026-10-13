// Pure. Login to the Reto online courses (md-condesa-site, /reto/cursos/).
//
// A member taps "Entrar con WhatsApp" on mdcondesa.com/reto/entrar/, which opens
// this number with the prefill "Hola, quiero entrar a mis cursos del Reto [CURSOS]".
// The site owns everything else: it checks the Airtable tag for the sender's
// number and answers with the exact text to send back (a one-time login link, or
// "no encontramos el Reto en este número"). The bot only relays it.
//
// Because the member wrote first, the reply is a free-form message inside the
// 24 h service window — no authentication template.
//
// Contract with the site (functions/api/reto/wa-login.js):
//   POST RETO_LOGIN_URL  Authorization: Bearer RETO_BOT_SECRET  {"phone": "<wa_id>"}
//   → {"ok": bool, "member": true|false|null, "reply": "<text>"}

import { normalizeText } from "./campaigns.js";

/** The marker the site's prefill carries (tools/templates/curso.js WA_LOGIN_TEXT). */
export const RETO_LOGIN_MARKER = "[CURSOS]";

const MARKER_RE = /\[\s*cursos\s*\]/i;
const PHRASE = "entrar a mis cursos del reto";

/**
 * True when an inbound text is a course-login request: the site's "[CURSOS]"
 * marker, or the prefill phrase typed by hand. Deliberately narrow — a lead
 * asking about "cursos" in general must keep reaching the sales brain.
 */
export function isRetoLoginRequest(body: string): boolean {
  if (!body || body.length > 300) return false;
  return MARKER_RE.test(body) || normalizeText(body).includes(PHRASE);
}

/** Both settings present (the hook is inert until Evan sets them). */
export function retoLoginConfigured(env: { RETO_LOGIN_URL?: string; RETO_BOT_SECRET?: string }): boolean {
  return !!(env.RETO_LOGIN_URL && /^https:\/\//.test(env.RETO_LOGIN_URL) && env.RETO_BOT_SECRET);
}

/** Sent when the site can't be reached or answers without a reply. */
export const RETO_LOGIN_FALLBACK =
  "Tuvimos un problema para revisar tu acceso a los cursos. Inténtalo otra vez en unos minutos, " +
  "o entra con tu correo en mdcondesa.com/reto/entrar/";

export interface RetoLoginResult {
  /** Text to send back to the member (never empty). */
  reply: string;
  /** true = has the Reto tag, false = not found, null = unknown (error / rate limit). */
  member: boolean | null;
  /** The site answered with a usable reply. */
  ok: boolean;
}

/** Reads the site's response body; anything off falls back to RETO_LOGIN_FALLBACK. */
export function parseRetoLoginResponse(body: unknown): RetoLoginResult {
  const v = (body && typeof body === "object" ? body : {}) as { reply?: unknown; member?: unknown };
  const reply = typeof v.reply === "string" ? v.reply.trim() : "";
  if (!reply || reply.length > 1500) return { reply: RETO_LOGIN_FALLBACK, member: null, ok: false };
  const member = v.member === true ? true : v.member === false ? false : null;
  return { reply, member, ok: true };
}
