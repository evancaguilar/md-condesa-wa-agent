// Pre-trial questionnaire — the I/O half (docs/cuestionario.md).
//
//  - sendCuestionario   : read the Leads record, sign a 14-day link, send ONE
//                         WhatsApp text, stamp `Cuestionario enviado/versión`.
//                         Used by the bot hook, POST /api/cuestionario/send
//                         (Airtable automation) and the owner's admin trigger.
//  - afterBookingConfirmed : what runs right after a booking confirmation
//                         reached the lead — the booking video (R4, unchanged)
//                         and then, when CUESTIONARIO_ENABLED=1, the invite.
//  - getLeadRecord / patchLeadAnswers : the Airtable reads/writes the public
//                         /api/cuestionario route uses.
//
// Pure logic (whitelists, copy, version) lives in cuestionario-core.ts.

import type { Contact, Env, Language } from "../types.js";
import {
  airtableFetch,
  AirtableWriteError,
  baseUrl,
  extractUnknownFieldName,
  findLeadByPhone,
  leadsMap,
  normalizeMxPhone,
  updateRecord,
  type AirtableRecord,
} from "./airtable.js";
import { sendBookingVideo, sendTemplate, sendText, WindowClosedError, type SendTextOpts } from "./send.js";
import { channelOf } from "./channel.js";
import { tpl } from "./template-params.js";
import { CLIENT } from "../client.gen.js";
import { isQuietHour } from "../cron/quiet.js";
import { getContact, kvDelete, kvGet, kvSet, kvSetIfAbsent } from "../db/queries.js";
import { greetingName } from "../cron/display-name.js";
import { parseQualification } from "../cron/nudge-copy.js";
import { bandFromQualification } from "./age-band.js";
import { cdmxDateStr } from "../cron/time.js";
import { postNote as slackOpsNote } from "./slack.js";
import { TOKEN_TTL_SEC, signToken, tokenId, type CuestionarioVersion } from "./cuestionario-token.js";
import {
  F_SENT,
  F_VERSION,
  cellFilled,
  cellText,
  deriveVersion,
  inviteTemplateBase,
  inviteTemplateBody,
  inviteTemplateComponents,
  inviteText,
  isoToEpoch,
} from "./cuestionario-core.js";

/** Legacy questionnaire page (still served; the confirmation page links to it). */
export const CUESTIONARIO_URL = "https://mdcondesa.com/cuestionario/";

/**
 * THE page the one link points at: the personalized "tu primera clase"
 * confirmation on mdcondesa.com (name, day, time, calendar, questionnaire
 * card). One page per version — the kids and baby pages already carry their
 * own "qué traer / así va a ser" copy, so the token picks the page instead of
 * swapping blocks inside the adults page.
 */
export function firstClassUrl(version: CuestionarioVersion): string {
  return version === "bfc"
    ? "https://mdcondesa.com/tu-primera-clase-bebes/"
    : version === "kids"
      ? "https://mdcondesa.com/tu-primera-clase-ninos/"
      : "https://mdcondesa.com/tu-primera-clase/";
}

/**
 * Token lifetime: 14 days, or 3 days past the class when the trial is booked
 * further out — a link that dies before the class it confirms is useless.
 */
export function tokenTtlFor(nowSec: number, trialEpoch: number | null): number {
  const base = TOKEN_TTL_SEC;
  if (trialEpoch === null) return base;
  return Math.max(base, trialEpoch + 3 * 86400 - nowSec);
}

/** kv backstop for the "already sent" check while the Airtable column is missing. */
export function sentKey(recordId: string): string {
  return `cuestionario_sent:${recordId}`;
}

// ---- rate limit (public route) ----

/** Requests one token may make per clock hour (GET + PATCH together). */
export const RATE_LIMIT_PER_HOUR = 120;

/** kv key of a token's counter for one hour bucket (hour first → range GC). */
export function rateKey(token: string, nowSec: number): string {
  return `cq_rl:${Math.floor(nowSec / 3600)}:${tokenId(token)}`;
}

/** Drop rate-limit counters older than two days (kv range scan, daily). */
export async function gcCuestionarioRate(db: D1Database, nowSec: number): Promise<void> {
  await db
    .prepare(`DELETE FROM kv WHERE key >= 'cq_rl:' AND key < ?1`)
    .bind(`cq_rl:${Math.floor(nowSec / 3600) - 48}:`)
    .run();
}

// ---- Airtable -----------------------------------------------------------------

/** One Leads record by id; null when it's gone (404). Throws on other errors. */
export async function getLeadRecord(env: Env, recordId: string): Promise<AirtableRecord | null> {
  const url = `${baseUrl(env, env.AIRTABLE_TRIALS_TABLE)}/${encodeURIComponent(recordId)}`;
  const res = await airtableFetch(env, url, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`airtable getLeadRecord failed: HTTP ${res.status}`);
  return (await res.json()) as AirtableRecord;
}

/**
 * PATCH (typecast:true, so new select options are created) and, when the
 * owner hasn't created a column yet, drop it and retry — one missing column
 * must not lose every other answer. At most (fields + 1) attempts. `record` is
 * null when EVERY column was unknown (nothing stored, not an error).
 */
export async function patchLeadAnswers(
  env: Env,
  recordId: string,
  fields: Record<string, unknown>,
  update: typeof updateRecord = updateRecord,
): Promise<{ record: AirtableRecord | null; dropped: string[] }> {
  const pending = { ...fields };
  const dropped: string[] = [];
  const maxAttempts = Object.keys(fields).length + 1;
  for (let i = 0; i < maxAttempts; i++) {
    if (Object.keys(pending).length === 0) return { record: null, dropped };
    try {
      const record = await update(env, env.AIRTABLE_TRIALS_TABLE, recordId, pending);
      return { record, dropped };
    } catch (err) {
      if (!(err instanceof AirtableWriteError) || !err.unknownField) throw err;
      const name = extractUnknownFieldName(err.message);
      if (!name || !Object.hasOwn(pending, name)) throw err;
      delete pending[name];
      dropped.push(name);
    }
  }
  if (Object.keys(pending).length === 0) return { record: null, dropped };
  throw new Error("patchLeadAnswers: too many unknown fields");
}

// ---- completion summary idempotence ---------------------------------------------

export function doneKey(recordId: string): string {
  return `cq_done:${recordId}`;
}

/**
 * Post the completion summary at most once per record (kv claim
 * `cq_done:<rec>` taken BEFORE posting — a double `__complete` from two tabs
 * posts once). A failed post releases nothing: one summary or none, never two.
 */
export async function postCompletionOnce(
  db: D1Database,
  recordId: string,
  post: () => Promise<void>,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!(await kvSetIfAbsent(db, doneKey(recordId), String(nowSec)))) return false;
  await post();
  return true;
}

// ---- send -----------------------------------------------------------------------

export interface CuestionarioDeps {
  /** Ops-channel note (non-window send failures; the daily template-failure note). */
  postNote(text: string): Promise<void>;
  now?(): number;
  /** Test seams; default to the real implementations. */
  getRecord?: (env: Env, recordId: string) => Promise<AirtableRecord | null>;
  getContact?: (db: D1Database, phone: string) => Promise<Contact | null>;
  sendText?: (env: Env, phone: string, body: string, opts?: SendTextOpts) => Promise<string>;
  sendTemplate?: (env: Env, phone: string, name: string, lang: string, components?: unknown[]) => Promise<string>;
  patch?: (env: Env, recordId: string, fields: Record<string, unknown>) => Promise<unknown>;
}

export interface SendCuestionarioInput {
  recordId: string;
  version?: CuestionarioVersion;
  resend?: boolean;
  /** Exact contact id to send to (the bot hook knows the webhook wa_id).
   *  Absent ⇒ the record's phone, normalized. */
  phone?: string;
}

export type SendCuestionarioResult =
  | {
      ok: true;
      version: CuestionarioVersion;
      phone: string;
      link: string;
      /** "text" in the 24 h window, "template" (cuestionario_invite*) outside it. */
      via: "text" | "template";
      warning?: string;
    }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_found"
        | "no_phone"
        | "opted_out"
        | "already_sent"
        | "no_copy"
        | "window_closed"
        | "send_failed"
        | "airtable_error";
      detail?: string;
    };

/** kv: one ops note per CDMX day about invite templates that could not be sent. */
export function templateNoteKey(nowSec: number): string {
  return `cq_tpl_note:${cdmxDateStr(nowSec)}`;
}

/**
 * Send the questionnaire link for one Leads record. Never throws: every
 * failure comes back as `{ok:false, reason}`.
 *
 * In the 24 h window → free-form text. Window closed (web-form bookers) →
 * the Utility template `cuestionario_invite[_kids]_es/_en` with the token as
 * the URL-button suffix (docs/templates.md §19). Only if THAT fails too (not
 * approved yet, IG/FB, no class date to fill it): console.warn + at most one
 * ops note per day — never a note per lead.
 *
 * Unless `resend`, the kv sent marker is CLAIMED atomically before sending
 * (two hooks racing on one booking send once) and released if the send fails.
 */
export async function sendCuestionario(
  env: Env,
  deps: CuestionarioDeps,
  input: SendCuestionarioInput,
): Promise<SendCuestionarioResult> {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  if (!env.CUESTIONARIO_SECRET) return { ok: false, reason: "not_configured" };
  const m = leadsMap();

  let rec: AirtableRecord | null;
  try {
    rec = await (deps.getRecord ?? getLeadRecord)(env, input.recordId);
  } catch (err) {
    return { ok: false, reason: "airtable_error", detail: String(err) };
  }
  if (!rec) return { ok: false, reason: "not_found" };
  const f = rec.fields;

  const phone = input.phone ?? normalizeMxPhone(cellText(f[m.phone]) ?? "");
  if (!phone) return { ok: false, reason: "no_phone" };
  if (!input.resend && cellFilled(f[F_SENT])) return { ok: false, reason: "already_sent" };

  const contact = await (deps.getContact ?? getContact)(env.DB, phone).catch(() => null);
  if (contact?.status === "opted_out") return { ok: false, reason: "opted_out" };
  const lang: Language = contact?.lang === "en" ? "en" : "es";
  const qual = parseQualification(contact);
  const version =
    input.version ?? deriveVersion(f, m, bandFromQualification(qual), qual.child_name ?? null);

  const trialEpoch = isoToEpoch(cellText(f[m.trialDateTime]));
  const token = await signToken(
    env.CUESTIONARIO_SECRET,
    { recordId: rec.id, version },
    now,
    tokenTtlFor(now, trialEpoch),
  );
  const link = `${firstClassUrl(version)}?t=${token}`;
  const name = greetingName(cellText(f[m.name]) ?? contact?.name ?? null);
  const kid =
    version === "adultos" ? null : greetingName(cellText(f[m.childName]) ?? qual.child_name ?? null) || null;
  const text = inviteText({ version, lang, name, kid, trialEpoch, link });
  if (!text) return { ok: false, reason: "no_copy" };

  // Atomic claim (unless resend): whoever inserts the marker sends.
  const key = sentKey(rec.id);
  let claimed = false;
  if (!input.resend) {
    try {
      claimed = await kvSetIfAbsent(env.DB, key, String(now));
    } catch (err) {
      return { ok: false, reason: "send_failed", detail: `kv claim: ${String(err)}` };
    }
    if (!claimed) return { ok: false, reason: "already_sent" };
  }
  const release = async (): Promise<void> => {
    if (claimed) await kvDelete(env.DB, key).catch(() => {});
  };

  let via: "text" | "template" = "text";
  try {
    await (deps.sendText ?? sendText)(env, phone, text, { metaExtra: { cuestionario: version } });
  } catch (err) {
    if (!(err instanceof WindowClosedError)) {
      await release();
      await deps
        .postNote(`📝 Cuestionario NO enviado a ${phone} (${rec.id}): ${String(err).slice(0, 200)}`)
        .catch(() => {});
      return { ok: false, reason: "send_failed", detail: String(err) };
    }
    // Closed window → the invite template.
    const tplErr = await sendInviteTemplate(env, deps, { phone, version, lang, trialEpoch, kid, token });
    if (tplErr) {
      await release();
      console.warn(`[cuestionario] ${rec.id} ${phone}: window closed, template not sent: ${tplErr}`);
      try {
        if (await kvSetIfAbsent(env.DB, templateNoteKey(now), "1")) {
          await deps.postNote(
            `📝 Cuestionario: hoy hay leads con la ventana cerrada a los que no se pudo mandar la plantilla cuestionario_invite (${tplErr.slice(0, 160)}). ¿Está aprobada en WhatsApp Manager? (un aviso por día)`,
          );
        }
      } catch {
        // note is best-effort
      }
      return { ok: false, reason: "window_closed", detail: tplErr };
    }
    via = "template";
  }

  // Sent. Stamp the record (and the kv marker); a failed stamp only costs
  // dedupe, never the send that already happened.
  let warning: string | undefined;
  if (!claimed) {
    try {
      await kvSet(env.DB, key, String(now));
    } catch (err) {
      console.warn("[cuestionario] kv sent marker failed", err);
    }
  }
  try {
    const stamp = { [F_SENT]: cdmxDateStr(now), [F_VERSION]: version };
    if (deps.patch) {
      await deps.patch(env, rec.id, stamp);
    } else {
      const { dropped } = await patchLeadAnswers(env, rec.id, stamp);
      if (dropped.length) warning = `faltan columnas en Airtable: ${dropped.join(", ")}`;
    }
  } catch (err) {
    warning = `no se pudo marcar Airtable: ${String(err).slice(0, 200)}`;
  }
  if (warning) console.warn(`[cuestionario] ${rec.id}: ${warning}`);
  return { ok: true, version, phone, link, via, ...(warning ? { warning } : {}) };
}

/** The closed-window template send; returns an error string, or null on success. */
async function sendInviteTemplate(
  env: Env,
  deps: CuestionarioDeps,
  a: {
    phone: string;
    version: CuestionarioVersion;
    lang: Language;
    trialEpoch: number | null;
    kid: string | null;
    token: string;
  },
): Promise<string | null> {
  if (a.trialEpoch === null) return "sin fecha de clase para la plantilla";
  if (channelOf(a.phone) !== "wa") return "IG/FB no tiene plantillas";
  const copy = a.version === "adultos"
    ? (a.lang === "en" ? CLIENT.copy.cuestionarioEn : CLIENT.copy.cuestionarioEs)
    : (a.lang === "en" ? CLIENT.copy.cuestionarioKidsEn : CLIENT.copy.cuestionarioKidsEs);
  if (!copy) return "sin texto configurado";
  const { kidVars } = inviteTemplateBody(copy, a.lang);
  try {
    await (deps.sendTemplate ?? sendTemplate)(
      env,
      a.phone,
      tpl(inviteTemplateBase(a.version), a.lang),
      a.lang,
      inviteTemplateComponents(a.version, a.lang, a.trialEpoch, a.kid, a.token, kidVars),
    );
    return null;
  } catch (err) {
    return String(err instanceof Error ? err.message : err);
  }
}

// ---- the booking hook ---------------------------------------------------------------

export function cuestionarioEnabled(env: Env): boolean {
  return env.CUESTIONARIO_ENABLED === "1" && !!env.CUESTIONARIO_SECRET;
}

/** Leads record for a phone when the caller doesn't know it (contact link, then phone lookup). */
export async function recordIdForPhone(env: Env, phone: string): Promise<string | null> {
  const contact = await getContact(env.DB, phone).catch(() => null);
  if (contact?.airtable_lead_id) return contact.airtable_lead_id;
  const found = await findLeadByPhone(env, normalizeMxPhone(phone)).catch(() => null);
  return found?.id ?? null;
}

/** kv guard: the sync loop tries a record at most once (whatever the outcome). */
export function syncTryKey(recordId: string): string {
  return `cuestionario_try:${recordId}`;
}

/**
 * Web-form / staff-entered bookings (owner decision 2026-10-13): called from
 * the Airtable booking sync (cron/followups.syncBookings) for a record with a
 * future trial and a phone. Sends once per record — idempotent via
 * `Cuestionario enviado` (cheap pre-check on the synced cell), the
 * `cuestionario_sent:` marker, and a `cuestionario_try:` claim so a window-
 * closed record isn't retried (and re-noted) on every later edit. Gated by
 * CUESTIONARIO_ENABLED. Never throws into the sync loop.
 */
export async function syncCuestionario(
  env: Env,
  postNote: (text: string) => Promise<void>,
  rec: { id: string; cuestionarioEnviado?: unknown },
  phone: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<SendCuestionarioResult | null> {
  if (!cuestionarioEnabled(env)) return null;
  // Unsolicited send → quiet hours apply (21:00–08:00 CDMX). Skip WITHOUT
  // claiming, so a later sync of the same record can still send.
  if (isQuietHour(nowSec)) return null;
  try {
    if (cellFilled(rec.cuestionarioEnviado)) return null;
    if (await kvGet(env.DB, sentKey(rec.id))) return null;
    if (!(await kvSetIfAbsent(env.DB, syncTryKey(rec.id), String(nowSec)))) return null;
    const r = await sendCuestionario(env, { postNote, now: () => nowSec }, { recordId: rec.id, phone });
    if (!r.ok && r.reason !== "already_sent") console.warn(`[cuestionario] sync ${rec.id}: ${r.reason}`);
    return r;
  } catch (err) {
    console.error(`[cuestionario] sync send failed for ${rec.id}`, err);
    return null;
  }
}

export interface AfterConfirmedOpts {
  /** Leads record id, when the caller has it (a `#n` sequence suffix is stripped). */
  recordId?: string | null;
  /** Ops-note sink for sendCuestionario. Defaults to the Slack ops channel. */
  postNote?: (text: string) => Promise<void>;
}

/**
 * THE post-confirmation hook. Every path that delivers a trial-booking
 * confirmation to the lead already ends with the booking video (R4) — the
 * brain's direct send (pipeline/inbound routeResult), an approved/edited/
 * best-bet booking draft (approvals.runPostSendEffects), a human registration
 * (booking-core.registerBooking) and the web-form trial_confirm
 * (cron/followups.sendTrialConfirm). So the video call site IS "the
 * confirmation just landed", and this function replaces it there: video
 * first, then the questionnaire invite.
 *
 * The invite is gated on CUESTIONARIO_ENABLED === "1" (ships dark) and is
 * strictly best-effort: never throws, never delays the confirmation (it runs
 * after it), and is deduped per record by `Cuestionario enviado` + kv.
 */
export async function afterBookingConfirmed(
  env: Env,
  phone: string,
  opts: AfterConfirmedOpts = {},
): Promise<void> {
  await sendBookingVideo(env, phone);
  if (!cuestionarioEnabled(env)) return;
  try {
    const bare = opts.recordId ? opts.recordId.split("#")[0] ?? "" : "";
    const recordId = /^rec[A-Za-z0-9]{3,}$/.test(bare) ? bare : await recordIdForPhone(env, phone);
    if (!recordId) {
      console.warn(`[cuestionario] no Leads record for ${phone}; invite skipped`);
      return;
    }
    const r = await sendCuestionario(
      env,
      { postNote: opts.postNote ?? ((t) => slackOpsNote(env, t)) },
      { recordId, phone },
    );
    if (!r.ok && r.reason !== "already_sent") {
      console.warn(`[cuestionario] ${phone} ${recordId}: ${r.reason}${"detail" in r && r.detail ? ` ${r.detail}` : ""}`);
    }
  } catch (err) {
    console.error(`[cuestionario] hook failed for ${phone}`, err);
  }
}
