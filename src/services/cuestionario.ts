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

import type { Env, Language } from "../types.js";
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
import { sendBookingVideo, sendText, WindowClosedError } from "./send.js";
import { getContact, kvGet, kvSet, kvSetIfAbsent } from "../db/queries.js";
import { greetingName } from "../cron/display-name.js";
import { parseQualification } from "../cron/nudge-copy.js";
import { bandFromQualification } from "./age-band.js";
import { cdmxDateStr } from "../cron/time.js";
import { postNote as slackOpsNote } from "./slack.js";
import { signToken, tokenId, type CuestionarioVersion } from "./cuestionario-token.js";
import {
  F_SENT,
  F_VERSION,
  cellFilled,
  cellText,
  deriveVersion,
  inviteText,
  isoToEpoch,
} from "./cuestionario-core.js";

/** Public page the links point at (md-condesa-site /cuestionario/). */
export const CUESTIONARIO_URL = "https://mdcondesa.com/cuestionario/";

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
 * must not lose every other answer. Returns the record + what was dropped.
 */
export async function patchLeadAnswers(
  env: Env,
  recordId: string,
  fields: Record<string, unknown>,
  update: typeof updateRecord = updateRecord,
): Promise<{ record: AirtableRecord; dropped: string[] }> {
  const pending = { ...fields };
  const dropped: string[] = [];
  for (let i = 0; i <= 12; i++) {
    try {
      const record = await update(env, env.AIRTABLE_TRIALS_TABLE, recordId, pending);
      return { record, dropped };
    } catch (err) {
      if (!(err instanceof AirtableWriteError) || !err.unknownField) throw err;
      const name = extractUnknownFieldName(err.message);
      if (!name || !(name in pending)) throw err;
      delete pending[name];
      dropped.push(name);
      if (Object.keys(pending).length === 0) {
        throw new AirtableWriteError(`all fields unknown: ${dropped.join(", ")}`, true, err.status);
      }
    }
  }
  throw new Error("patchLeadAnswers: too many unknown fields");
}

// ---- send -----------------------------------------------------------------------

export interface CuestionarioDeps {
  /** Ops-channel note (window closed / send failure). */
  postNote(text: string): Promise<void>;
  now?(): number;
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
  | { ok: true; version: CuestionarioVersion; phone: string; link: string; warning?: string }
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

/**
 * Send the questionnaire link for one Leads record. Never throws: every
 * failure comes back as `{ok:false, reason}` (window_closed / send_failed also
 * post one ops note). No template fallback on a closed window — the booking
 * confirmation just went out, so the window is normally open; when it isn't,
 * a human decides.
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
    rec = await getLeadRecord(env, input.recordId);
  } catch (err) {
    return { ok: false, reason: "airtable_error", detail: String(err) };
  }
  if (!rec) return { ok: false, reason: "not_found" };
  const f = rec.fields;

  const phone = input.phone ?? normalizeMxPhone(cellText(f[m.phone]) ?? "");
  if (!phone) return { ok: false, reason: "no_phone" };

  if (!input.resend) {
    let kvSent: string | null = null;
    try {
      kvSent = await kvGet(env.DB, sentKey(rec.id));
    } catch {
      kvSent = null;
    }
    if (cellFilled(f[F_SENT]) || kvSent) return { ok: false, reason: "already_sent" };
  }

  const contact = await getContact(env.DB, phone).catch(() => null);
  if (contact?.status === "opted_out") return { ok: false, reason: "opted_out" };
  const lang: Language = contact?.lang === "en" ? "en" : "es";
  const version =
    input.version ?? deriveVersion(f, m, bandFromQualification(parseQualification(contact)));

  const token = await signToken(env.CUESTIONARIO_SECRET, { recordId: rec.id, version }, now);
  const link = `${CUESTIONARIO_URL}?t=${token}`;
  const name = greetingName(cellText(f[m.name]) ?? contact?.name ?? null);
  const kid = version === "adultos" ? null : greetingName(cellText(f[m.childName])) || null;
  const text = inviteText({
    version,
    lang,
    name,
    kid,
    trialEpoch: isoToEpoch(cellText(f[m.trialDateTime])),
    link,
  });
  if (!text) return { ok: false, reason: "no_copy" };

  try {
    await sendText(env, phone, text, { metaExtra: { cuestionario: version } });
  } catch (err) {
    const windowClosed = err instanceof WindowClosedError;
    await deps
      .postNote(
        windowClosed
          ? `📝 Cuestionario NO enviado a ${phone} (${rec.id}): la ventana de 24 h está cerrada. Mándaselo a mano si hace falta.`
          : `📝 Cuestionario NO enviado a ${phone} (${rec.id}): ${String(err).slice(0, 200)}`,
      )
      .catch(() => {});
    return windowClosed
      ? { ok: false, reason: "window_closed" }
      : { ok: false, reason: "send_failed", detail: String(err) };
  }

  // Sent. Stamp the record (and the kv backstop); a failed stamp only costs
  // dedupe, never the send that already happened.
  let warning: string | undefined;
  try {
    await kvSet(env.DB, sentKey(rec.id), String(now));
  } catch (err) {
    console.warn("[cuestionario] kv sent marker failed", err);
  }
  try {
    const { dropped } = await patchLeadAnswers(env, rec.id, {
      [F_SENT]: cdmxDateStr(now),
      [F_VERSION]: version,
    });
    if (dropped.length) warning = `faltan columnas en Airtable: ${dropped.join(", ")}`;
  } catch (err) {
    warning = `no se pudo marcar Airtable: ${String(err).slice(0, 200)}`;
  }
  if (warning) console.warn(`[cuestionario] ${rec.id}: ${warning}`);
  return { ok: true, version, phone, link, ...(warning ? { warning } : {}) };
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
): Promise<SendCuestionarioResult | null> {
  if (!cuestionarioEnabled(env)) return null;
  try {
    if (cellFilled(rec.cuestionarioEnviado)) return null;
    if (await kvGet(env.DB, sentKey(rec.id))) return null;
    if (!(await kvSetIfAbsent(env.DB, syncTryKey(rec.id), String(Math.floor(Date.now() / 1000))))) return null;
    const r = await sendCuestionario(env, { postNote }, { recordId: rec.id, phone });
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
