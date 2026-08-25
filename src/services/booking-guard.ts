// Slice 4 — human-booking gap closure.
//
// Humans confirm trial classes over WhatsApp constantly (Aprobar/Editar on a
// Slack draft, or typing straight from the dashboard) and NONE of that ever
// wrote Airtable — the brain's book_trial was the only booking writer. The
// nightly reconciliation digest (cron/booking-recon.ts) caught the damage after
// the fact; this closes the loop in real time:
//
//   human-originated outbound → claimsBooking? → already backed? → parse the
//   promised class out of the copy (regex first, one cheap model call only when
//   that isn't enough) → validate against the real schedule → Slack capture card
//   with a one-tap "Registrar en Airtable".
//
// auditHumanSend NEVER throws: it is an audit hook bolted onto the send paths,
// and a bad parse or a Slack hiccup must never break a message that already
// landed with the lead. Every call site still AWAITS it — Workers kill floating
// promises.

import type { BookTrialInput, Env } from "../types.js";
import {
  getContact,
  kvDelete,
  kvGet,
  kvSet,
  kvSetIfAbsent,
  recentMessages,
} from "../db/queries.js";
import {
  hasScheduledFollowupOfKind,
  scheduledFollowupsOfKind,
} from "../db/queries-admin.js";
import { BOOKING_KINDS } from "../cron/nudges.js";
import { cdmxDateStr, cdmxHintContext, DAY } from "../cron/time.js";
import { isNudgePhrase } from "../cron/booking-recon-core.js";
import {
  claimsBooking,
  parseBookingHints,
  type BookingCapture,
  type BookingHints,
  type BookingVerdict,
  type HumanSendSource,
} from "./booking-claims.js";
import {
  bookingRecordedKey,
  parseBookingRecordedMarker,
  registerBooking,
  type BookingRecordedMarker,
  type RegisterBookingResult,
} from "./booking-core.js";
import { normalizeDiscipline, validateSlot } from "../brain/tools.js";
import { callAnthropic, type ToolUseContent } from "../brain/claude.js";
import { accrueChatUsage } from "./usage.js";
import {
  postBookingCaptureCard,
  postBookingFyi,
  postNote,
  updateBookingCaptureCard,
} from "./slack.js";
import { CLIENT } from "../client.gen.js";

export type { HumanSendSource } from "./booking-claims.js";

/** A `booking_recorded:<phone>` marker younger than this backs a claim. */
export const RECORDED_MARKER_TTL_SECONDS = 72 * 3600;
/** Sent text stored on the capture record (Slack block + kv row hygiene). */
const SENT_TEXT_CAP = 500;
/** Transcript depth handed to the fallback model call. */
const HISTORY_LIMIT = 10;
const MAX_PARSE_OUTPUT_TOKENS = 300;

/** kv key of one capture record. Colons are safe inside a Slack action_id arg. */
export function bookingCaptureKey(epochSec: number, phone: string): string {
  return `booking_capture:${epochSec}:${phone}`;
}

/** At-most-once claim guarding the "Registrar" button. */
export function bookingCaptureClaimKey(key: string): string {
  return `booking_capture_claim:${key}`;
}

/** One capture per lead per CDMX day, however many times they re-confirm. */
export function bookingClaimThrottleKey(phone: string, day: string): string {
  return `booking_claim:${phone}:${day}`;
}

/** private_metadata prefix that tells the view_submission handler this is ours. */
export const BOOKING_META_PREFIX = "booking:";

// ---- injectable seams (tests drive the whole flow with fakes) --------------

export interface BookingGuardDeps {
  postCard: typeof postBookingCaptureCard;
  updateCard: typeof updateBookingCaptureCard;
  postNote: typeof postNote;
  postBookingFyi(env: Env, booking: BookTrialInput): Promise<void>;
  registerBooking: typeof registerBooking;
  validateSlot: typeof validateSlot;
  /** The transport the fallback model call uses (stubbed in tests). */
  doFetch: typeof fetch;
  now(): number;
}

/** Built per call (not at module scope) so import cycles stay harmless. */
export function realGuardDeps(): BookingGuardDeps {
  return {
    postCard: postBookingCaptureCard,
    updateCard: updateBookingCaptureCard,
    postNote,
    postBookingFyi,
    registerBooking,
    validateSlot,
    doFetch: fetch,
    now: () => Math.floor(Date.now() / 1000),
  };
}

// ---- the audit hook -------------------------------------------------------

/**
 * Fire-and-forget audit of one HUMAN-originated outbound. Never throws.
 *
 * Gates, in order (each one is a cheap exit before the expensive one below):
 *  1. the text doesn't claim a completed booking          → nothing to do
 *  2. the claimed SLOT is already backed (see isBookingBacked) → nothing to do
 *  3. a capture was already opened for this lead today    → throttled
 *  4. parse → validate → persist the capture → post the Slack card
 */
export async function auditHumanSend(
  env: Env,
  phone: string,
  text: string,
  source: HumanSendSource,
  by?: string,
  deps: BookingGuardDeps = realGuardDeps(),
): Promise<void> {
  try {
    if (!claimsBooking(text)) return;
    // Nudge copy ("todavía no has agendado…") can carry the token without
    // being a claim — same second line of defense the recon digest uses.
    if (isNudgePhrase(text)) return;

    const now = deps.now();
    // Parse FIRST: the backed check needs the claimed slot to know whether an
    // existing booking is THIS class or a different one.
    const ctx = cdmxHintContext(now);
    const claimedSlot = parseBookingHints(text, ctx.iso, ctx.weekdayIdx);
    const backing = await isBookingBacked(env, phone, now, claimedSlot);
    if (backing.backed) return;

    // Daily throttle: one card per lead per CDMX day, atomically claimed so two
    // concurrent sends can't both open a capture.
    const claimed = await kvSetIfAbsent(
      env.DB,
      bookingClaimThrottleKey(phone, cdmxDateStr(now)),
      String(now),
    );
    if (!claimed) return;

    const contact = await getContact(env.DB, phone);
    const parsed = await parseBookingFromText(env, phone, text, now, deps);
    const capture: BookingCapture = {
      phone,
      sentText: text.slice(0, SENT_TEXT_CAP),
      source,
      verdict: parsed.verdict,
      status: "open",
      createdAt: now,
    };
    if (contact?.name) capture.name = contact.name;
    if (by) capture.by = by;
    if (backing.conflict) {
      const { trialDate, trialTime } = backing.conflict;
      capture.conflictNote =
        `Ya hay un registro para ${trialDate}${trialTime ? ` ${trialTime}` : ""}` +
        ` — esto parece OTRA clase`;
    }
    applyHints(capture, parsed.hints);

    const key = bookingCaptureKey(now, phone);
    await kvSet(env.DB, key, JSON.stringify(capture));
    const ts = await deps.postCard(env, key, capture);
    capture.slackTs = ts;
    await kvSet(env.DB, key, JSON.stringify(capture));
  } catch (err) {
    console.error(`[booking-guard] audit failed for ${phone}:`, err);
  }
}

export interface BackedCheck {
  backed: boolean;
  /** A fresh marker exists, but for a DIFFERENT slot than the one claimed. */
  conflict?: { trialDate: string; trialTime?: string };
}

/**
 * Trial dates implied by a lead's scheduled anti-no-show rows. The offsets come
 * from computeTrialSequence (cron/followups.ts), which derives every due_at from
 * the class datetime:
 *   - `same_day`   = class − 4h, clamped into 09:00–21:00 CDMX ⇒ its CDMX due
 *     date IS the trial date (the clamp only ever moves an early class forward
 *     to 09:00 the same day);
 *   - `day_before` = 18:00 CDMX the day before (inside the window, never
 *     clamped) ⇒ its due date + 1 day is the trial date;
 *   - `trial_confirm` = when the booking was DETECTED, not the class → carries
 *     no date signal, so it is ignored here.
 */
function trialDatesFromFollowups(
  rows: Array<{ kind: string; due_at: number }>,
): Set<string> {
  const dates = new Set<string>();
  for (const r of rows) {
    if (r.kind === "same_day") dates.add(cdmxDateStr(r.due_at));
    else if (r.kind === "day_before") dates.add(cdmxDateStr(r.due_at + DAY));
  }
  return dates;
}

/** Does a fresh marker cover the slot this text just claimed? */
function markerCovers(marker: BookingRecordedMarker, hints: BookingHints): boolean {
  // LEGACY bare-epoch marker: no slot to compare, so it backs anything — the
  // pre-slice behavior, kept for the ≤72h of legacy rows still in prod kv.
  if (!marker.trialDate) return true;
  if (marker.trialDate !== hints.trialDate) return false;
  // Time only discriminates when BOTH sides state one (exact HH:mm).
  if (marker.trialTime && hints.trialTime) return marker.trialTime === hints.trialTime;
  return true;
}

/**
 * Is this booking claim already backed by a real record?
 *
 * With a DATE in the claim the check is slot-exact: only a marker for that same
 * date (and time, when both state one) or an anti-no-show sequence armed for
 * that date counts. An old booking therefore stops masking a new, unbacked
 * promise for a different class — and when it is fresh, we say so on the card.
 *
 * Without a date (vague "ya quedó agendado") ANY fresh marker or booking-kind
 * followup still counts, exactly like before: cardsing every vague re-confirmation
 * would be pure false-positive noise.
 */
async function isBookingBacked(
  env: Env,
  phone: string,
  now: number,
  hints: BookingHints,
): Promise<BackedCheck> {
  const marker = parseBookingRecordedMarker(await kvGet(env.DB, bookingRecordedKey(phone)));
  const fresh =
    marker !== null && now - marker.ts < RECORDED_MARKER_TTL_SECONDS ? marker : null;

  if (!hints.trialDate) {
    if (fresh) return { backed: true };
    // The anti-no-show sequence only exists when a real Airtable record does.
    return { backed: await hasScheduledFollowupOfKind(env.DB, phone, BOOKING_KINDS) };
  }

  if (fresh && markerCovers(fresh, hints)) return { backed: true };
  const rows = await scheduledFollowupsOfKind(env.DB, phone, BOOKING_KINDS);
  if (trialDatesFromFollowups(rows).has(hints.trialDate)) return { backed: true };
  if (fresh?.trialDate) {
    return {
      backed: false,
      conflict: {
        trialDate: fresh.trialDate,
        ...(fresh.trialTime ? { trialTime: fresh.trialTime } : {}),
      },
    };
  }
  return { backed: false };
}

/** Copy the parsed fields onto a capture record (undefined never overwrites). */
function applyHints(capture: BookingCapture, hints: BookingHints): void {
  if (hints.trialDate) capture.trialDate = hints.trialDate;
  if (hints.trialTime) capture.trialTime = hints.trialTime;
  if (hints.discipline) capture.discipline = hints.discipline;
  if (hints.audience) capture.audience = hints.audience;
  if (hints.childName) capture.childName = hints.childName;
}

// ---- parse + verdict ------------------------------------------------------

export interface ParsedBooking {
  hints: BookingHints;
  verdict: BookingVerdict;
}

/**
 * Deterministic regex parse first; ONE cheap model call fills the gaps only
 * when the regex pass isn't `full`. The regex result always wins on the fields
 * it did read — the model is a gap-filler, never an override.
 */
export async function parseBookingFromText(
  env: Env,
  phone: string,
  text: string,
  now: number,
  deps: BookingGuardDeps = realGuardDeps(),
): Promise<ParsedBooking> {
  const { iso, weekdayIdx } = cdmxHintContext(now);
  const hints = parseBookingHints(text, iso, weekdayIdx);

  let merged = hints;
  if (hints.confidence !== "full") {
    const fromModel = await proposeBooking(env, phone, text, iso, weekdayIdx, deps);
    if (fromModel) merged = mergeHints(hints, fromModel);
  }
  return { hints: merged, verdict: verdictFor(merged, deps) };
}

/** Regex hints win; model hints only fill what the regex left undefined. */
function mergeHints(base: BookingHints, extra: BookingHints): BookingHints {
  const out: BookingHints = { ...base };
  if (!out.trialDate && extra.trialDate) out.trialDate = extra.trialDate;
  if (!out.trialTime && extra.trialTime) out.trialTime = extra.trialTime;
  if (!out.discipline && extra.discipline) out.discipline = extra.discipline;
  if (!out.audience && extra.audience) out.audience = extra.audience;
  if (!out.childName && extra.childName) out.childName = extra.childName;
  const found = [out.trialDate, out.trialTime, out.discipline].filter(Boolean).length;
  out.confidence = found === 3 ? "full" : found === 0 ? "none" : "partial";
  return out;
}

/** validateSlot's answer for a (possibly incomplete) parse. */
function verdictFor(hints: BookingHints, deps: BookingGuardDeps): BookingVerdict {
  if (!hints.trialDate || !hints.trialTime || !hints.discipline) {
    return { ok: false, reason: "faltan datos (disciplina, fecha u hora)" };
  }
  const check = deps.validateSlot(
    hints.trialDate,
    hints.trialTime,
    hints.audience ?? "adult",
    hints.discipline,
  );
  if (check.ok) return { ok: true };
  return {
    ok: false,
    reason: check.reason ?? "horario inválido",
    ...(check.alternatives ? { alternatives: check.alternatives } : {}),
  };
}

const PROPOSE_BOOKING_TOOL = {
  name: "propose_booking",
  description:
    "Report the trial class the staff member just promised the lead. Only fill a field you are confident about; omit anything the conversation does not state.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Lead's name (the person writing)." },
      child_name: { type: "string", description: "Child's name for kid/baby bookings." },
      discipline: {
        type: "string",
        enum: CLIENT.services.map((s) => s.key),
        description: `One of: ${CLIENT.services.map((s) => s.key).join(", ")}.`,
      },
      audience: { type: "string", enum: ["adult", "kid"] },
      trial_date: { type: "string", description: "YYYY-MM-DD in America/Mexico_City." },
      trial_time: { type: "string", description: "HH:mm 24h in America/Mexico_City." },
    },
    required: [] as string[],
    additionalProperties: false,
  },
};

const PARSE_INSTRUCTIONS = `Eres un extractor de datos para ${CLIENT.businessName}. Recibes el final de una conversación de WhatsApp donde un HUMANO del equipo acaba de confirmarle una clase de prueba al prospecto. Tu única tarea: llamar propose_booking con la clase concreta que quedó confirmada en el ÚLTIMO mensaje enviado.

Reglas:
- Resuelve fechas relativas ("hoy", "mañana", "el sábado") con la fecha y el día de la semana del bloque <context>.
- Solo llena un campo si la conversación lo dice o lo implica claramente. Omite lo que no sepas — NO inventes.
- Si el último mensaje no confirma ninguna clase concreta, NO llames la herramienta.
- No escribas explicación; solo la llamada a la herramienta.`;

/** One cheap tool-only model call; null on any failure (never throws). */
async function proposeBooking(
  env: Env,
  phone: string,
  sentText: string,
  nowCdmxIso: string,
  weekdayIdx: number,
  deps: BookingGuardDeps,
): Promise<BookingHints | null> {
  try {
    if (!env.ANTHROPIC_API_KEY) return null;
    const history = await recentMessages(env.DB, phone, HISTORY_LIMIT);
    const transcript = history
      .map((m) => `${m.direction === "in" ? "👤" : "🧑"} ${m.body}`)
      .join("\n");
    const weekdayName = WEEKDAY_ES[weekdayIdx] ?? "";
    const user = [
      `<context>\nnow_cdmx: ${nowCdmxIso}\nweekday: ${weekdayName}\n</context>`,
      `<conversation>\n${transcript}\n</conversation>`,
      `<sent_message>\n${sentText}\n</sent_message>`,
    ].join("\n\n");

    const resp = await callAnthropic(
      deps.doFetch,
      env.ANTHROPIC_API_KEY,
      [{ type: "text", text: PARSE_INSTRUCTIONS }],
      [{ role: "user", content: user }],
      [PROPOSE_BOOKING_TOOL],
      MAX_PARSE_OUTPUT_TOKENS,
    );
    await accrueChatUsage(env, resp.usage).catch(() => {});

    const tu = resp.content.find(
      (b): b is ToolUseContent =>
        b.type === "tool_use" && b.name === "propose_booking",
    );
    if (!tu) return null;
    return hintsFromToolInput(tu.input);
  } catch (err) {
    console.error(`[booking-guard] propose_booking failed for ${phone}:`, err);
    return null;
  }
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

/** Coerce the tool payload into BookingHints, dropping anything malformed. */
function hintsFromToolInput(raw: Record<string, unknown>): BookingHints {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const trialDate = str(raw.trial_date);
  const time = str(raw.trial_time);
  const trialTime = time && /^\d{1,2}:\d{2}$/.test(time)
    ? time.padStart(5, "0")
    : undefined;
  const disciplineRaw = str(raw.discipline);
  const discipline = disciplineRaw ? normalizeDiscipline(disciplineRaw) : undefined;
  const audience = raw.audience === "kid" ? "kid" : raw.audience === "adult" ? "adult" : undefined;
  const childName = str(raw.child_name);

  const validDate = trialDate && /^\d{4}-\d{2}-\d{2}$/.test(trialDate) ? trialDate : undefined;
  const found = [validDate, trialTime, discipline].filter(Boolean).length;
  const hints: BookingHints = {
    confidence: found === 3 ? "full" : found === 0 ? "none" : "partial",
  };
  if (validDate) hints.trialDate = validDate;
  if (trialTime) hints.trialTime = trialTime;
  if (discipline) hints.discipline = discipline;
  if (audience) hints.audience = audience;
  if (childName) hints.childName = childName;
  return hints;
}

// ---- capture records: read / apply / skip / edit ---------------------------

/** Parse a stored capture; null when absent or unparseable. */
export function parseCapture(raw: string | null): BookingCapture | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BookingCapture;
    return typeof parsed?.phone === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function getBookingCapture(
  env: Env,
  key: string,
): Promise<BookingCapture | null> {
  return parseCapture(await kvGet(env.DB, key));
}

/** The BookTrialInput a capture describes, or null when fields are missing. */
export function captureToBookInput(c: BookingCapture): BookTrialInput | null {
  if (!c.discipline || !c.trialDate || !c.trialTime) return null;
  const input: BookTrialInput = {
    name: (c.name ?? "").trim(),
    discipline: c.discipline,
    audience: c.audience ?? "adult",
    trialDate: c.trialDate,
    trialTime: c.trialTime,
    phone: c.phone,
  };
  if (c.childName) input.childName = c.childName;
  return input;
}

/**
 * "✅ Registrar" — at-most-once (a kv claim, released only on failure so a
 * fixed cause can be retried). `force` skips validateSlot; the Slack button
 * passes the stored verdict's failure through, which is exactly what the
 * "Registrar de todos modos" label promises.
 */
export async function applyBookingCapture(
  env: Env,
  key: string,
  opts?: { force?: boolean; by?: string },
  deps: BookingGuardDeps = realGuardDeps(),
): Promise<void> {
  const record = await getBookingCapture(env, key);
  if (!record) {
    await deps.postNote(env, `🗓 Registro de agendado no encontrado (${key}).`);
    return;
  }
  if (record.status !== "open") {
    if (record.slackTs) {
      const done =
        record.status === "registered"
          ? `✅ Ya estaba registrado${record.recordId ? ` (${record.recordId})` : ""}`
          : "🚫 Ya estaba marcado como «no era un agendado»";
      await deps.updateCard(env, record.slackTs, done, record.phone);
    }
    return;
  }

  const claimKey = bookingCaptureClaimKey(key);
  if (!(await kvSetIfAbsent(env.DB, claimKey, String(deps.now())))) return;

  const input = captureToBookInput(record);
  if (!input) {
    await kvDelete(env.DB, claimKey);
    await failCard(
      env,
      record,
      key,
      "Faltan datos para registrar (disciplina, fecha u hora) — usa «Corregir datos».",
      deps,
    );
    return;
  }

  const result: RegisterBookingResult = await deps.registerBooking(
    env,
    {
      postBookingFyi: (booking) => deps.postBookingFyi(env, booking),
      postNote: (text) => deps.postNote(env, text),
    },
    input,
    { force: opts?.force === true, ...(opts?.by ? { by: opts.by } : {}) },
  );

  if (!result.ok) {
    // Release the claim: the cause (bad slot, Airtable down) is fixable and a
    // human must be able to tap again after fixing it.
    await kvDelete(env.DB, claimKey);
    const alts = result.alternatives?.length
      ? ` Opciones ese día: ${result.alternatives.join(", ")}.`
      : "";
    await failCard(env, record, key, `${result.detail}${alts}`, deps);
    return;
  }

  const next: BookingCapture = {
    ...record,
    status: "registered",
    recordId: result.recordId,
  };
  await kvSet(env.DB, key, JSON.stringify(next));
  if (record.slackTs) {
    await deps.updateCard(
      env,
      record.slackTs,
      `✅ Registrado (${result.recordId}) — secuencia anti-no-show activada`,
      `${record.phone} · ${record.discipline} · ${record.trialDate} ${record.trialTime}`,
    );
  }
}

/** Error card that KEEPS the buttons so the action can be retried/corrected. */
async function failCard(
  env: Env,
  record: BookingCapture,
  key: string,
  detail: string,
  deps: BookingGuardDeps,
): Promise<void> {
  if (!record.slackTs) {
    await deps.postNote(env, `❌ No se pudo registrar ${record.phone}: ${detail}`);
    return;
  }
  await deps.updateCard(
    env,
    record.slackTs,
    "❌ No se pudo registrar en Airtable",
    `${record.phone} — ${detail}`,
    { key, verdictOk: false },
  );
}

/** "🚫 No era un agendado" — close the capture without touching Airtable. */
export async function skipBookingCapture(
  env: Env,
  key: string,
  deps: BookingGuardDeps = realGuardDeps(),
): Promise<void> {
  const record = await getBookingCapture(env, key);
  if (!record) {
    await deps.postNote(env, `🗓 Registro de agendado no encontrado (${key}).`);
    return;
  }
  if (record.status !== "open") return;
  await kvSet(env.DB, key, JSON.stringify({ ...record, status: "skipped" }));
  if (record.slackTs) {
    await deps.updateCard(
      env,
      record.slackTs,
      "🚫 Marcado como «no era un agendado»",
      `${record.phone} — no se escribió nada en Airtable.`,
    );
  }
}

// ---- "✏️ Corregir datos" modal --------------------------------------------

/** Field ids of the correction modal (block_id → the single action_id). */
export const BOOKING_MODAL_FIELDS = {
  name: "bk_name",
  childName: "bk_child",
  discipline: "bk_disc",
  trialDate: "bk_date",
  trialTime: "bk_time",
} as const;
export const BOOKING_MODAL_ACTION = "input";

/** Flattened `{block_id: value}` from a parsed view_submission's viewValues. */
export function flattenViewValues(
  viewValues: Record<string, Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const blockId of Object.keys(viewValues)) {
    const inner = viewValues[blockId] ?? {};
    const first = Object.keys(inner)[0];
    if (first !== undefined) out[blockId] = inner[first] ?? "";
  }
  return out;
}

export type ViewSubmissionTarget =
  | { kind: "booking"; key: string }
  | { kind: "approval"; id: number }
  | { kind: "none" };

/**
 * Route a modal submit by its private_metadata. Slack sends ONE view_submission
 * shape for every modal we open, and the approval-edit modal has always stored
 * a bare numeric id — so the booking modal namespaces itself with a `booking:`
 * prefix and everything numeric keeps flowing to editAndSend, unchanged.
 */
export function parseViewSubmissionTarget(
  privateMetadata: string | null,
): ViewSubmissionTarget {
  const raw = (privateMetadata ?? "").trim();
  if (!raw) return { kind: "none" };
  if (raw.startsWith(BOOKING_META_PREFIX)) {
    const key = raw.slice(BOOKING_META_PREFIX.length);
    return key ? { kind: "booking", key } : { kind: "none" };
  }
  if (/^\d+$/.test(raw)) return { kind: "approval", id: Number.parseInt(raw, 10) };
  return { kind: "none" };
}

/**
 * Apply the corrected fields from the modal, then register.
 *
 * Force policy (deliberate, documented): the corrected slot is re-validated and
 * normally applied WITHOUT force — a still-invalid slot comes back as an error
 * card the human can correct again. Force is used only when the corrected slot
 * is invalid AND the capture's previous verdict was already invalid: at that
 * point the human has looked at the mismatch twice and re-submitted anyway, so
 * we take them at their word rather than trapping a real booking behind the
 * schedule grid.
 */
export async function submitBookingCaptureEdit(
  env: Env,
  key: string,
  values: Record<string, string>,
  by?: string,
  deps: BookingGuardDeps = realGuardDeps(),
): Promise<void> {
  const record = await getBookingCapture(env, key);
  if (!record) {
    await deps.postNote(env, `🗓 Registro de agendado no encontrado (${key}).`);
    return;
  }
  if (record.status !== "open") return;

  const val = (id: string): string => (values[id] ?? "").trim();
  const next: BookingCapture = { ...record };
  const name = val(BOOKING_MODAL_FIELDS.name);
  if (name) next.name = name;
  const child = val(BOOKING_MODAL_FIELDS.childName);
  next.childName = child || undefined;
  const disc = val(BOOKING_MODAL_FIELDS.discipline);
  if (disc) next.discipline = normalizeDiscipline(disc);
  const date = val(BOOKING_MODAL_FIELDS.trialDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) next.trialDate = date;
  const time = val(BOOKING_MODAL_FIELDS.trialTime);
  if (/^\d{1,2}:\d{2}$/.test(time)) next.trialTime = time.padStart(5, "0");
  if (child) next.audience = "kid";

  const hints: BookingHints = { confidence: "none" };
  if (next.trialDate) hints.trialDate = next.trialDate;
  if (next.trialTime) hints.trialTime = next.trialTime;
  if (next.discipline) hints.discipline = next.discipline;
  if (next.audience) hints.audience = next.audience;
  const verdict = verdictFor(hints, deps);
  const previousFailed = record.verdict.ok === false;
  next.verdict = verdict;
  await kvSet(env.DB, key, JSON.stringify(next));

  const force = !verdict.ok && previousFailed;
  await applyBookingCapture(env, key, { force, ...(by ? { by } : {}) }, deps);
}
