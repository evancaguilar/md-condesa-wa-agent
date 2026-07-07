// Slack Web API client (raw fetch) + Block Kit builders for the WhatsApp AI
// agent's human-approval layer. Implements SlackPort (postDraft/postNote) plus
// the control panel, card-update helpers, attendance/holding pings and the
// FYI booking card. Zero npm deps: raw fetch + WebCrypto only.
//
// Pure, unit-testable helpers (signature verify, payload parse, business-hours /
// timeout logic) live in ./slack-timeouts.js and are re-exported here.

import type {
  BookTrialInput,
  Env,
  PendingApproval,
  SlackPort,
} from "../types.js";
import {
  cancelPendingApprovals,
  getContact,
  getPendingApprovals,
  insertEdit,
  kvGet,
  kvSet,
  markHoldingSent,
  resolveApproval,
  setContactStatus,
  setHumanOverride,
  isBotEnabled,
} from "../db/queries.js";
import { sendTemplate, sendText, WindowClosedError } from "./wa.js";
import {
  decideTimeout,
  HOLDING_LINE,
  windowHoursLeft,
  type TimeoutApprovalView,
} from "./slack-timeouts.js";

export {
  verifySlackSignature,
  parseInteractionPayload,
  type ParsedInteraction,
  type ParsedAction,
} from "./slack-timeouts.js";

const SLACK_API = "https://slack.com/api";
const KV_CONTROL_PANEL_TS = "control_panel_ts";
const HUMAN_FOLLOWUP_TEMPLATE = "human_followup";

// ---- low-level Web API ----

interface SlackResponse {
  ok: boolean;
  ts?: string;
  error?: string;
  [k: string]: unknown;
}

async function slackCall(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackResponse> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as SlackResponse;
  if (!data.ok) {
    throw new Error(`slack ${method} failed: ${data.error ?? res.status}`);
  }
  return data;
}

async function postMessage(
  env: Env,
  blocks: unknown[],
  text: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const data = await slackCall(env, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    text,
    blocks,
    ...extra,
  });
  return data.ts as string;
}

async function updateMessage(
  env: Env,
  ts: string,
  blocks: unknown[],
  text: string,
): Promise<void> {
  await slackCall(env, "chat.update", {
    channel: env.SLACK_CHANNEL_ID,
    ts,
    text,
    blocks,
  });
}

// ---- Block Kit builders (pure) ----

function section(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): Record<string, unknown> {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function divider(): Record<string, unknown> {
  return { type: "divider" };
}

function button(
  text: string,
  actionId: string,
  style?: "primary" | "danger",
): Record<string, unknown> {
  const b: Record<string, unknown> = {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    action_id: actionId,
  };
  if (style) b.style = style;
  return b;
}

/** Status chips row for the draft header (nuevo lead / calificación / ventana). */
function statusChips(
  approval: PendingApproval,
  name: string | null,
  hoursLeft: number,
): string {
  const chips: string[] = [];
  chips.push(name ? "🧭 en calificación" : "🆕 nuevo lead");
  if (approval.confidence === "low") chips.push("⚠️ baja confianza");
  chips.push(hoursLeft > 0 ? `⏱ ventana cierra en ${hoursLeft}h` : "🔒 ventana cerrada");
  return chips.join("  •  ");
}

/** Renders the last ~6 conversation lines already embedded in contextText. */
function draftBlocks(
  approval: PendingApproval & { contextText: string },
  name: string | null,
  hoursLeft: number,
  reason: string | null,
  adLine: string | null,
): unknown[] {
  const who = name ? `${name} · ${approval.phone}` : approval.phone;
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📲 ${who}`, emoji: true },
    },
    context(statusChips(approval, name, hoursLeft)),
  ];
  if (adLine) blocks.push(context(adLine));
  blocks.push(
    divider(),
    section(`*Conversación:*\n${approval.contextText || "_(sin contexto)_"}`),
    section(`*Respuesta propuesta:*\n>${quote(approval.draft)}`),
    context(
      `Confianza: *${approval.confidence === "high" ? "alta" : "baja"}*` +
        (reason ? `  •  ${reason}` : ""),
    ),
    {
      type: "actions",
      block_id: `approval_${approval.id}`,
      elements: [
        button("✅ Aprobar", `approve|${approval.id}`, "primary"),
        button("✏️ Editar", `edit|${approval.id}`),
        button("🙋 Tomar control", `takeover|${approval.id}`),
        {
          type: "overflow",
          action_id: `overflow|${approval.id}`,
          options: [
            {
              text: { type: "plain_text", text: "Marcar como alumno", emoji: true },
              value: `mark_student|${approval.id}`,
            },
            {
              text: { type: "plain_text", text: "Descartar", emoji: true },
              value: `discard|${approval.id}`,
            },
          ],
        },
      ],
    },
  );
  return blocks;
}

/** Prefixes every line with `>` so multi-line drafts render as a full quote. */
function quote(text: string): string {
  return text.split("\n").join("\n>");
}

/** Terminal card once an approval is resolved (approved/edited/etc.). */
function resolvedBlocks(
  approval: PendingApproval,
  name: string | null,
  headline: string,
  sentText: string,
  extraButton?: { text: string; actionId: string },
): unknown[] {
  const who = name ? `${name} · ${approval.phone}` : approval.phone;
  const blocks: unknown[] = [
    section(`${headline}\n*${who}*`),
    section(`>${quote(sentText)}`),
  ];
  if (extraButton) {
    blocks.push({
      type: "actions",
      block_id: `resolved_${approval.id}`,
      elements: [button(extraButton.text, extraButton.actionId)],
    });
  }
  return blocks;
}

function controlPanelBlocks(enabled: boolean): unknown[] {
  const status = enabled ? "✅ Activo" : "⏸️ Pausado";
  return [
    section(`🤖 *Bot MD Condesa* — estado: *${status}*`),
    {
      type: "actions",
      block_id: "control_panel",
      elements: [
        button("⏸️ Pausar bot", "bot_pause", enabled ? "danger" : undefined),
        button("▶️ Reanudar", "bot_resume", enabled ? undefined : "primary"),
      ],
    },
  ];
}

// ---- SlackPort implementation + public posting helpers ----

/** Posts the draft-approval card; returns the Slack message ts. */
export async function postDraft(
  env: Env,
  a: PendingApproval & { contextText: string },
): Promise<string> {
  const contact = await getContact(env.DB, a.phone);
  const name = contact?.name ?? null;
  const now = Math.floor(Date.now() / 1000);
  const hoursLeft = windowHoursLeft(contact?.last_inbound_at ?? null, now);
  const reason = extractReason(a.context);
  const adLine = adContextLine(contact?.ad_ref ?? null);
  const blocks = draftBlocks(a, name, hoursLeft, reason, adLine);
  return postMessage(env, blocks, `Nueva respuesta por aprobar — ${a.phone}`);
}

/** Plain informational note to the channel. */
export async function postNote(env: Env, text: string): Promise<void> {
  await postMessage(env, [section(text)], text);
}

/** FYI card posted when the model's book_trial tool fires. */
export async function postBookingFyi(env: Env, booking: BookTrialInput): Promise<void> {
  const when = `${booking.trialDate} ${booking.trialTime}`;
  const blocks = [
    section(
      `📅 *Clase de prueba agendada*\n*${booking.name}* · ${booking.phone}`,
    ),
    context(
      `${booking.discipline} · ${booking.audience === "kid" ? "niños" : "adultos"} · ${when}`,
    ),
  ];
  await postMessage(env, blocks, `Clase de prueba agendada — ${booking.name}`);
}

/** "¿Llegó {name}?" attendance card (posted by workstream D's cron). */
export async function postAttendanceCheck(
  env: Env,
  name: string,
  phone: string,
  recordId: string,
): Promise<string> {
  const blocks = [
    section(`🥋 *¿Llegó ${name}?*\n${phone}`),
    {
      type: "actions",
      block_id: `attendance_${recordId}`,
      elements: [
        button("✅ Sí llegó", `attended_yes|${recordId}`, "primary"),
        button("❌ No llegó", `attended_no|${recordId}`, "danger"),
      ],
    },
  ];
  return postMessage(env, blocks, `¿Llegó ${name}?`);
}

/** Re-ping with <!here> for a still-pending approval (cron timeout path). */
export async function postHoldingPing(env: Env, approvalId: number): Promise<void> {
  const text = `<!here> ⏳ La respuesta #${approvalId} lleva rato pendiente — ¿la revisamos?`;
  await postMessage(env, [section(text)], text);
}

// ---- control panel ----

/**
 * Posts the pinned control-panel card once and stores its ts in kv. Idempotent:
 * if the ts already exists we just refresh it. Pinning is best-effort.
 */
export async function ensureControlPanel(env: Env): Promise<string> {
  const existing = await kvGet(env.DB, KV_CONTROL_PANEL_TS);
  const enabled = await isBotEnabled(env.DB);
  if (existing) {
    await updateMessage(env, existing, controlPanelBlocks(enabled), "Panel de control");
    return existing;
  }
  const ts = await postMessage(
    env,
    controlPanelBlocks(enabled),
    "Panel de control del bot MD Condesa",
  );
  await kvSet(env.DB, KV_CONTROL_PANEL_TS, ts);
  try {
    await slackCall(env, "pins.add", { channel: env.SLACK_CHANNEL_ID, timestamp: ts });
  } catch {
    // pins.add is best-effort (needs pins:write; not fatal if it fails).
  }
  return ts;
}

/** Refreshes the pinned control panel to reflect the current bot_enabled flag. */
export async function updateControlPanel(env: Env): Promise<void> {
  const ts = await kvGet(env.DB, KV_CONTROL_PANEL_TS);
  const enabled = await isBotEnabled(env.DB);
  if (!ts) {
    await ensureControlPanel(env);
    return;
  }
  await updateMessage(env, ts, controlPanelBlocks(enabled), "Panel de control");
}

// ---- card-update helpers (chat.update terminal states) ----

async function updateResolvedCard(
  env: Env,
  approval: PendingApproval,
  headline: string,
  sentText: string,
  extraButton?: { text: string; actionId: string },
): Promise<void> {
  if (!approval.slack_ts) return;
  const contact = await getContact(env.DB, approval.phone);
  const blocks = resolvedBlocks(approval, contact?.name ?? null, headline, sentText, extraButton);
  await updateMessage(env, approval.slack_ts, blocks, headline);
}

export function markApprovedCard(env: Env, a: PendingApproval, sent: string): Promise<void> {
  return updateResolvedCard(env, a, "✅ *Enviada*", sent);
}
export function markEditedCard(env: Env, a: PendingApproval, sent: string): Promise<void> {
  return updateResolvedCard(env, a, "✏️ *Editada y enviada*", sent);
}
export function markTakenOverCard(env: Env, a: PendingApproval): Promise<void> {
  return updateResolvedCard(env, a, "🙋 *Tomaste el control* — bot en pausa", a.draft);
}
export function markExpiredCard(env: Env, a: PendingApproval, windowClosed: boolean): Promise<void> {
  const extra = windowClosed
    ? { text: "📨 Enviar plantilla human_followup", actionId: `send_template|${a.id}` }
    : undefined;
  return updateResolvedCard(env, a, "⌛ *Expirada* (sin respuesta a tiempo)", a.draft, extra);
}
export function markStudentCard(env: Env, a: PendingApproval): Promise<void> {
  return updateResolvedCard(env, a, "🎓 *Marcado como alumno* — descartada", a.draft);
}
export function markDiscardedCard(env: Env, a: PendingApproval): Promise<void> {
  return updateResolvedCard(env, a, "🗑️ *Descartada*", a.draft);
}
/** Window closed on approve/edit: swap the card to offer the template button. */
export function markWindowClosedCard(env: Env, a: PendingApproval): Promise<void> {
  return updateResolvedCard(
    env,
    a,
    "🔒 *Ventana cerrada* — no se pudo enviar texto libre",
    a.draft,
    { text: "📨 Enviar plantilla human_followup", actionId: `send_template|${a.id}` },
  );
}

// ---- helpers used by the route handler (Env-bound, exported) ----

/** Sends the human_followup template (reopens the 24h window). */
export async function sendHumanFollowupTemplate(
  env: Env,
  phone: string,
): Promise<void> {
  const contact = await getContact(env.DB, phone);
  const lang = contact?.lang ?? "es";
  await sendTemplate(env, phone, HUMAN_FOLLOWUP_TEMPLATE, lang);
}

// ---- holding-timeout helper (called by workstream D's cron) ----

/** The queries surface runApprovalTimeouts depends on (injectable for tests). */
export interface TimeoutQueries {
  getPendingApprovals: typeof getPendingApprovals;
  getContact: typeof getContact;
  markHoldingSent: typeof markHoldingSent;
  resolveApproval: typeof resolveApproval;
}

export interface TimeoutDeps {
  sendText: typeof sendText;
  now?: number; // injectable clock (seconds)
}

/**
 * Per spec §Slack timeouts. Called by D's every-5-minute cron.
 * - pending >10min in business hours (09–21 CDMX) & !holding_sent & window open
 *   ⇒ send holding line, mark holding_sent, re-ping Slack <!here>.
 * - pending >12h ⇒ expire + update card (offer template button if window closed).
 */
export async function runApprovalTimeouts(
  env: Env,
  queries: TimeoutQueries = {
    getPendingApprovals,
    getContact,
    markHoldingSent,
    resolveApproval,
  },
  deps: TimeoutDeps = { sendText },
): Promise<void> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const pending = await queries.getPendingApprovals(env.DB);

  for (const a of pending) {
    const contact = await queries.getContact(env.DB, a.phone);
    const view: TimeoutApprovalView = {
      id: a.id,
      phone: a.phone,
      createdAt: a.created_at,
      holdingSent: a.holding_sent === 1,
      lastInboundAt: contact?.last_inbound_at ?? null,
    };
    const decision = decideTimeout(view, now);

    try {
      if (decision.kind === "hold") {
        await deps.sendText(env, a.phone, HOLDING_LINE);
        await queries.markHoldingSent(env.DB, a.id);
        await postHoldingPing(env, a.id);
      } else if (decision.kind === "expire") {
        await queries.resolveApproval(env.DB, a.id, "expired");
        await markExpiredCard(env, a, decision.windowClosed);
      }
    } catch (err) {
      // A closed window on the holding line just means we skip it; never throw
      // out of the cron for one bad approval.
      if (!(err instanceof WindowClosedError)) {
        console.error("runApprovalTimeouts error", a.id, err);
      }
    }
  }
}

// ---- SlackPort binding for the pipeline (index.ts wires this in) ----

/** Factory: binds the Env into a SlackPort the inbound pipeline can call. */
export function makeSlackPort(env: Env): SlackPort {
  return {
    postDraft: (a) => postDraft(env, a),
    postNote: (text) => postNote(env, text),
    postBookingFyi: (booking) => postBookingFyi(env, booking),
  };
}

// ---- internal ----

/**
 * Builds the "📣 Anuncio: …" context line from a contact's ad_ref JSON, or null
 * when there's no referral. Prefers the ad headline, falling back to source_id.
 */
function adContextLine(adRef: string | null): string | null {
  if (!adRef) return null;
  try {
    const r = JSON.parse(adRef) as { headline?: string | null; sourceId?: string | null };
    const label = (r.headline ?? "").trim() || (r.sourceId ?? "").trim();
    return label ? `📣 Anuncio: ${label}` : null;
  } catch {
    return null;
  }
}

/** The brain stashes its escalation reason in the approval context JSON. */
function extractReason(context: string | null): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context) as { reason?: string };
    return parsed.reason ?? null;
  } catch {
    return null;
  }
}

// Re-export so callers importing from slack.ts get a single surface.
export { cancelPendingApprovals, insertEdit, setContactStatus, setHumanOverride };
