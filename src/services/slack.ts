// Slack Web API client (raw fetch) + Block Kit builders for the WhatsApp AI
// agent's human-approval layer. Implements SlackPort (postDraft/postNote) plus
// the control panel, card-update helpers, attendance/holding pings and the
// FYI booking card. Zero npm deps: raw fetch + WebCrypto only.
//
// Pure, unit-testable helpers (signature verify, payload parse, business-hours /
// timeout logic) live in ./slack-timeouts.js and are re-exported here.

import type {
  AutoSentFyi,
  BookTrialInput,
  Env,
  PendingApproval,
  SlackPort,
} from "../types.js";
import {
  cancelPendingApprovals,
  claimHoldingSend,
  getApprovalStatus,
  getContact,
  getPendingApprovals,
  insertEdit,
  kvGet,
  kvSet,
  kvClaimIfAbsentOrOlder,
  releaseHoldingClaim,
  resolveApproval,
  setContactStatus,
  setHumanOverride,
  isBotEnabled,
} from "../db/queries.js";
import { sendTemplate, sendText, WindowClosedError } from "./send.js";
import { channelOf } from "./channel.js";
import {
  adAttributionLine,
  decideTimeout,
  HOLDING_LINE,
  windowHoursLeft,
  type TimeoutApprovalView,
} from "./slack-timeouts.js";
import {
  awaitingReplyKey,
  guardedApprovalKey,
  runPostSendEffects,
  surenessKey,
} from "./approvals.js";
import type { BookingCapture, HumanSendSource } from "./booking-claims.js";
import { autoModeEndLabel, getAutoModeUntil } from "./auto-mode.js";
import { AUTO_SEND_DAILY_CAP, isAutoSendEnabled } from "./auto-send.js";
import { claimApproval, getCampaign } from "../db/queries-admin.js";
import type { Proposal } from "./kb-editor.js";
import { CLIENT } from "../client.gen.js";

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
  approval: PendingApproval & { contextText: string; sureness?: number },
  name: string | null,
  hoursLeft: number,
  reason: string | null,
  adLine: string | null,
): unknown[] {
  const who = name ? `${name} · ${approval.phone}` : approval.phone;
  // The model's own 0–100 read of the draft. Shown so Evan can calibrate the
  // thresholds against reality (>=75 never reaches this card; 25–74 self-sends
  // after an hour). Absent on legacy rows and guard-stripped drafts.
  const seguridad =
    approval.sureness !== undefined ? ` · seguridad ${approval.sureness}%` : "";
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📲 ${who}${seguridad}`, emoji: true },
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

function controlPanelBlocks(
  enabled: boolean,
  autoUntil: number | null,
  autoSend: boolean,
): unknown[] {
  const status = enabled ? "✅ Activo" : "⏸️ Pausado";
  const mode = autoUntil
    ? `🌙 *AUTO hasta las ${autoModeEndLabel(autoUntil)}* (respuestas sin aprobación)`
    : "🎓 Manual (cada respuesta pasa por aprobación)";
  // The gated lane only matters while replies still need approval; under night
  // mode everything high-confidence already sends on its own.
  const lane = autoSend
    ? `🤖 Auto-envío seguro: *ACTIVADO* (seguridad ≥75% sale sola; máx. ${AUTO_SEND_DAILY_CAP}/día; nunca un agendado sin respaldo)`
    : "🤖 Auto-envío seguro: *apagado*";
  return [
    section(`🤖 *Bot ${CLIENT.shortName}* — estado: *${status}*\n${mode}\n${lane}`),
    {
      type: "actions",
      block_id: "control_panel",
      elements: [
        button("⏸️ Pausar bot", "bot_pause", enabled ? "danger" : undefined),
        button("▶️ Reanudar", "bot_resume", enabled ? undefined : "primary"),
        autoUntil
          ? button("🎓 Volver a manual ya", "auto_manual", "danger")
          : button("🌙 Auto hasta las 7am", "auto_night"),
        autoSend
          ? button("🤖 Apagar auto-envío", "autosend_off", "danger")
          : button("🤖 Activar auto-envío", "autosend_on"),
      ],
    },
  ];
}

// ---- SlackPort implementation + public posting helpers ----

/** Posts the draft-approval card; returns the Slack message ts. */
export async function postDraft(
  env: Env,
  a: PendingApproval & { contextText: string; sureness?: number },
): Promise<string> {
  const contact = await getContact(env.DB, a.phone);
  const name = contact?.name ?? null;
  const now = Math.floor(Date.now() / 1000);
  const hoursLeft = windowHoursLeft(contact?.last_inbound_at ?? null, now);
  const reason = extractReason(a.context);
  // Campaign attribution for the card header. Best-effort: a lookup failure
  // must never block posting the draft.
  let campaignName: string | null = null;
  if (contact?.campaign_id != null) {
    try {
      campaignName = (await getCampaign(env.DB, contact.campaign_id))?.name ?? null;
    } catch {
      // leave campaignName null
    }
  }
  const adLine = adAttributionLine(contact?.ad_ref ?? null, campaignName);
  const blocks = draftBlocks(a, name, hoursLeft, reason, adLine);
  // <!here> so action-required cards ping even with the channel muted to
  // "Mentions only"; FYI posts (postNote/postBookingFyi) stay silent.
  blocks.unshift(context("<!here>"));
  return postMessage(env, blocks, `<!here> Nueva respuesta por aprobar — ${a.phone}`);
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

/**
 * FYI card for a reply the gated auto-send lane sent WITHOUT approval. Silent
 * on purpose (no <!here>): nothing is action-required — it already went out.
 * "Tomar control" pauses the bot for that lead so a human can take the thread;
 * it is phone-keyed (`takeover_phone|<phone>`) because an auto-sent reply never
 * created an approval row to claim.
 */
export async function postAutoSentFyi(env: Env, fyi: AutoSentFyi): Promise<void> {
  const who = fyi.name ? `${fyi.name} · ${fyi.phone}` : fyi.phone;
  const seguridad =
    fyi.sureness !== undefined ? `seguridad ${fyi.sureness}%` : "alta confianza";
  const blocks: unknown[] = [
    section(`🤖 *Auto-enviado (${seguridad})* — ${who}`),
    section(`>${quote(fyi.text)}`),
    context(
      `${fyi.dailyCount}/${AUTO_SEND_DAILY_CAP} hoy  •  sin aprobación (auto-envío seguro)`,
    ),
    {
      type: "actions",
      block_id: `autosent_${fyi.phone}`,
      elements: [button("🙋 Tomar control", `takeover_phone|${fyi.phone}`)],
    },
  ];
  await postMessage(env, blocks, `Auto-enviado — ${fyi.phone}`);
}

/** "¿Llegó {name}?" attendance card (posted by workstream D's cron). */
export async function postAttendanceCheck(
  env: Env,
  name: string,
  phone: string,
  recordId: string,
): Promise<string> {
  const blocks = [
    section(`<!here> 🥋 *¿Llegó ${name}?*\n${phone}`),
    {
      type: "actions",
      block_id: `attendance_${recordId}`,
      elements: [
        button("✅ Sí llegó", `attended_yes|${recordId}`, "primary"),
        button("❌ No llegó", `attended_no|${recordId}`, "danger"),
      ],
    },
  ];
  return postMessage(env, blocks, `<!here> ¿Llegó ${name}?`);
}

/** Re-ping with <!here> for a still-pending approval (cron timeout path). */
export async function postHoldingPing(
  env: Env,
  approvalId: number,
  who?: { name?: string | null; phone?: string; draft?: string },
): Promise<void> {
  // Identify the approval — a bare "#816" is unfindable when the channel has
  // scrolled past the card. Name + number + draft snippet locate it instantly.
  const label = [who?.name, who?.phone].filter(Boolean).join(" · ");
  const snippet = who?.draft
    ? ` — «${who.draft.length > 80 ? `${who.draft.slice(0, 80)}…` : who.draft}»`
    : "";
  const text = `<!here> ⏳ La respuesta #${approvalId}${label ? ` para ${label}` : ""} lleva rato pendiente${snippet} — ¿la revisamos?`;
  await postMessage(env, [section(text)], text);
}

// ---- edit-tuner cards (weekly edit-pattern analysis) ----

/** Truncation for tuning-card before/after quotes (Slack block cap safety). */
function snip(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Header message posted before the per-proposal tuning cards. */
export async function postTuningSummary(
  env: Env,
  summary: string,
  nEdits: number,
  nProposals: number,
): Promise<string> {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🧠 Análisis de ediciones", emoji: true },
    },
    section(summary || "_(sin resumen)_"),
    context(
      `${nEdits} ediciones analizadas · ${nProposals} propuesta(s) — revisa las tarjetas de abajo`,
    ),
  ];
  return postMessage(env, blocks, "Análisis de ediciones del bot");
}

/**
 * One tuning-proposal card with Aplicar/Descartar buttons. `key` is the kv key
 * of the persisted TuningRecord — it rides in the action_id (verb|arg splits on
 * the FIRST pipe, colons are safe). Returns the ts for later chat.update.
 */
export async function postTuningProposalCard(
  env: Env,
  key: string,
  p: Proposal,
): Promise<string> {
  const blocks: unknown[] = [];
  if (p.kind === "kb_edit") {
    const title = p.sectionId === null ? `${p.title} (sección nueva)` : p.title;
    blocks.push(section(`✏️ *Propuesta: ${title}*`));
    if (p.prevContent) {
      blocks.push(section(`*Antes:*\n>${quote(snip(p.prevContent))}`));
    }
    blocks.push(section(`*Después:*\n>${quote(snip(p.newContent))}`));
    if (p.reason) blocks.push(context(p.reason));
  } else if (p.kind === "kb_delete") {
    blocks.push(
      section(`🗑 *Propuesta: eliminar sección «${p.prevTitle ?? p.sectionId}»*`),
    );
    if (p.prevContent) blocks.push(section(`>${quote(snip(p.prevContent))}`));
    if (p.reason) blocks.push(context(p.reason));
  } else {
    // The tuner only emits kb_edit/kb_delete; render a minimal fallback.
    blocks.push(section(`*Propuesta (${p.kind})*`));
  }
  blocks.push({
    type: "actions",
    block_id: `tuning_${key}`,
    elements: [
      button("✅ Aplicar", `tune_apply|${key}`, "primary"),
      button("🗑 Descartar", `tune_discard|${key}`),
    ],
  });
  return postMessage(env, blocks, "Propuesta de ajuste del bot");
}

/** Re-render a tuning card (terminal state, warning, or error + retry). */
export async function updateTuningCard(
  env: Env,
  ts: string,
  headline: string,
  body: string,
  buttons?: { text: string; actionId: string; style?: "primary" | "danger" }[],
): Promise<void> {
  const blocks: unknown[] = [section(`${headline}\n${body}`)];
  if (buttons && buttons.length > 0) {
    blocks.push({
      type: "actions",
      block_id: `tuning_update_${ts}`,
      elements: buttons.map((b) => button(b.text, b.actionId, b.style)),
    });
  }
  await updateMessage(env, ts, blocks, headline);
}

// ---- booking-capture cards (human confirmed a class, Airtable has nothing) ---

const SOURCE_ES: Record<HumanSendSource, string> = {
  approved: "respuesta aprobada en Slack",
  edited: "respuesta editada en Slack",
  staff: "mensaje del panel",
  staff_later: "envío programado del panel",
  auto_timeout: "auto-enviada tras 1h sin revisión",
};

/** "jiu · adultos · 2026-08-29 19:00" — the fields we managed to read back. */
function captureFieldsLine(c: BookingCapture): string {
  const parts: string[] = [];
  parts.push(c.discipline ? c.discipline : "_disciplina?_");
  parts.push(
    c.audience ? (c.audience === "kid" ? "niños" : "adultos") : "_programa?_",
  );
  parts.push(c.trialDate ? c.trialDate : "_fecha?_");
  parts.push(c.trialTime ? c.trialTime : "_hora?_");
  return parts.join(" · ");
}

/** ✅/⚠️ chip summarizing validateSlot's answer for the card. */
function captureVerdictChip(c: BookingCapture): string {
  if (c.verdict.ok) return "✅ horario válido";
  const alts = c.verdict.alternatives?.length
    ? ` · opciones ese día: ${c.verdict.alternatives.join(", ")}`
    : "";
  return `⚠️ ${c.verdict.reason ?? "horario no validado"}${alts}`;
}

function captureButtons(key: string, verdictOk: boolean): Record<string, unknown> {
  return {
    type: "actions",
    block_id: `bkcap_${key}`,
    elements: [
      button(
        verdictOk ? "✅ Registrar en Airtable" : "✅ Registrar de todos modos",
        `bkreg|${key}`,
        "primary",
      ),
      button("✏️ Corregir datos", `bkedit|${key}`),
      button("🚫 No era un agendado", `bkskip|${key}`),
    ],
  };
}

/**
 * The capture card: a human promised a class over WhatsApp and nothing wrote it
 * to Airtable. One tap registers it (and arms the anti-no-show sequence).
 * `key` is the kv key of the persisted BookingCapture — it rides in the
 * action_id (verb|arg splits on the FIRST pipe, so its colons are safe).
 */
export async function postBookingCaptureCard(
  env: Env,
  key: string,
  capture: BookingCapture,
): Promise<string> {
  const contact = await getContact(env.DB, capture.phone).catch(() => null);
  const name = capture.name ?? contact?.name ?? null;
  const who = name ? `${name} · ${capture.phone}` : capture.phone;
  const blocks: unknown[] = [
    context("<!here>"),
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "⚠️ Confirmaste una clase sin registro en Airtable",
        emoji: true,
      },
    },
    section(`*${who}*`),
    section(`>${quote(snip(capture.sentText))}`),
    context(
      `${captureFieldsLine(capture)}${capture.childName ? ` · menor: ${capture.childName}` : ""}`,
    ),
    context(
      `${captureVerdictChip(capture)}  •  origen: ${SOURCE_ES[capture.source]}${capture.by ? ` (${capture.by})` : ""}`,
    ),
  ];
  // Fresh booking on file, but for another slot — say so before anyone taps.
  if (capture.conflictNote) blocks.push(context(`⚠️ ${capture.conflictNote}`));
  blocks.push(captureButtons(key, capture.verdict.ok));
  return postMessage(
    env,
    blocks,
    `<!here> Agendado sin registro en Airtable — ${capture.phone}`,
  );
}

/** Re-render a capture card (terminal state, or an error + retry buttons). */
export async function updateBookingCaptureCard(
  env: Env,
  ts: string,
  headline: string,
  body: string,
  buttons?: { key: string; verdictOk: boolean },
): Promise<void> {
  const blocks: unknown[] = [section(`${headline}\n${body}`)];
  if (buttons) blocks.push(captureButtons(buttons.key, buttons.verdictOk));
  await updateMessage(env, ts, blocks, headline);
}

// ---- control panel ----

/**
 * Posts the pinned control-panel card once and stores its ts in kv. Idempotent:
 * if the ts already exists we just refresh it. Pinning is best-effort.
 */
export async function ensureControlPanel(env: Env): Promise<string> {
  const existing = await kvGet(env.DB, KV_CONTROL_PANEL_TS);
  const enabled = await isBotEnabled(env.DB);
  const autoUntil = await getAutoModeUntil(env.DB);
  const autoSend = await isAutoSendEnabled(env.DB);
  if (existing) {
    await updateMessage(
      env,
      existing,
      controlPanelBlocks(enabled, autoUntil, autoSend),
      "Panel de control",
    );
    return existing;
  }
  const ts = await postMessage(
    env,
    controlPanelBlocks(enabled, autoUntil, autoSend),
    `Panel de control del bot ${CLIENT.shortName}`,
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
  const autoUntil = await getAutoModeUntil(env.DB);
  const autoSend = await isAutoSendEnabled(env.DB);
  if (!ts) {
    await ensureControlPanel(env);
    return;
  }
  await updateMessage(
    env,
    ts,
    controlPanelBlocks(enabled, autoUntil, autoSend),
    "Panel de control",
  );
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
  // Templates are WA-only: an IG/FB card never offers the template button.
  const extra = windowClosed && channelOf(a.phone) === "wa"
    ? { text: "📨 Enviar plantilla human_followup", actionId: `send_template|${a.id}` }
    : undefined;
  return updateResolvedCard(env, a, "⌛ *Expirada* (sin respuesta a tiempo)", a.draft, extra);
}
/**
 * The 1h best-bet send (owner directive 2026-08-25): nobody reviewed the draft
 * and the bot sent it itself. The card says so explicitly, with the model's own
 * sureness, so Evan can audit which numbers were worth trusting.
 */
export function markAutoSentCard(
  env: Env,
  a: PendingApproval,
  sureness: number,
): Promise<void> {
  return updateResolvedCard(
    env,
    a,
    `⏱️ *Enviada automáticamente* tras 1h sin revisión · seguridad ${sureness}%`,
    a.draft,
  );
}
export function markStudentCard(env: Env, a: PendingApproval): Promise<void> {
  return updateResolvedCard(env, a, "🎓 *Marcado como alumno* — descartada", a.draft);
}
export function markDiscardedCard(env: Env, a: PendingApproval): Promise<void> {
  return updateResolvedCard(env, a, "🗑️ *Descartada*", a.draft);
}
/** A newer draft (built from the full conversation) replaced this stale card. */
export function markSupersededCard(
  env: Env,
  a: PendingApproval,
  newId: number | null,
): Promise<void> {
  return updateResolvedCard(
    env,
    a,
    newId === null
      ? "⏭️ *Reemplazada* — la conversación avanzó (se envió una respuesta más nueva)"
      : `⏭️ *Reemplazada* por la respuesta #${newId} (el lead siguió escribiendo)`,
    a.draft,
  );
}
/** Window closed on approve/edit: swap the card to offer the template button
 *  (WA only — IG/FB have no templates; their card is informational). */
export function markWindowClosedCard(env: Env, a: PendingApproval): Promise<void> {
  return updateResolvedCard(
    env,
    a,
    "🔒 *Ventana cerrada* — no se pudo enviar texto libre",
    a.draft,
    channelOf(a.phone) === "wa"
      ? { text: "📨 Enviar plantilla human_followup", actionId: `send_template|${a.id}` }
      : undefined,
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
  claimHoldingSend: typeof claimHoldingSend;
  releaseHoldingClaim: typeof releaseHoldingClaim;
  claimApproval: typeof claimApproval;
  getApprovalStatus: typeof getApprovalStatus;
}

export interface TimeoutDeps {
  sendText: typeof sendText;
  now?: number; // injectable clock (seconds)
}

/**
 * Per spec §Slack timeouts. Called by D's every-5-minute cron.
 * - pending >10min in business hours (09–21 CDMX) & !holding_sent & window open
 *   ⇒ claim holding_sent, send holding line, re-ping Slack <!here>.
 * - pending >1h, sureness >=25, not guarded, window open ⇒ BEST BET: claim
 *   `auto_sent`, send the draft as-is, stamp the card (owner directive
 *   2026-08-25 — an hour of silence is worse than an imperfect answer).
 * - pending >12h ⇒ expire + update card (offer template button if window closed).
 *
 * Both writes are atomic claims (claimHoldingSend / claimApproval) because the
 * pending list is a snapshot: a human can approve, edit or take over an
 * approval between the snapshot and the action, and the loser of that race must
 * do nothing at all.
 */
export async function runApprovalTimeouts(
  env: Env,
  queries: TimeoutQueries = {
    getPendingApprovals,
    getContact,
    claimHoldingSend,
    releaseHoldingClaim,
    claimApproval,
    getApprovalStatus,
  },
  deps: TimeoutDeps = { sendText },
): Promise<void> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const pending = await queries.getPendingApprovals(env.DB);

  for (const a of pending) {
    const contact = await queries.getContact(env.DB, a.phone);
    // Brain's not-waiting marker (kv, set at queue time): "0" ⇒ skip holding.
    const awaitingRaw = await kvGet(env.DB, awaitingReplyKey(a.id));
    // Best-bet inputs, both kv side-channels written by queueApproval. Three
    // point reads per pending row: the queue is dozens of rows at worst, so a
    // kvGet each is cheaper than the schema change it avoids.
    const surenessRaw = await kvGet(env.DB, surenessKey(a.id));
    const guardedRaw = await kvGet(env.DB, guardedApprovalKey(a.id));
    const surenessNum = Number(surenessRaw);
    const view: TimeoutApprovalView = {
      id: a.id,
      phone: a.phone,
      createdAt: a.created_at,
      holdingSent: a.holding_sent === 1,
      lastInboundAt: contact?.last_inbound_at ?? null,
      awaitingReply: awaitingRaw === "0" ? false : undefined,
      sureness:
        surenessRaw !== null && Number.isFinite(surenessNum) ? surenessNum : undefined,
      guarded: guardedRaw === "1",
    };
    const decision = decideTimeout(view, now);

    try {
      if (decision.kind === "hold") {
        // Claim FIRST: losing the flip means the draft stopped being pending
        // (approved/edited/taken over) since the snapshot, so the lead already
        // has — or is about to get — a real answer. Stay quiet.
        if (!(await queries.claimHoldingSend(env.DB, a.id))) continue;
        // Per-PHONE cap on top of the per-approval flag: rapid-fire inbound
        // messages each spawn their own approval, and on 2026-08-27 a lead got
        // THREE "¡Gracias por escribir!" in a row. One holding line per phone
        // per 45 min is plenty; the claim above already stops this approval
        // from retrying, so losing the phone-level claim just stays quiet.
        if (
          !(await kvClaimIfAbsentOrOlder(
            env.DB,
            `holding_line:${a.phone}`,
            now,
            45 * 60,
          ))
        )
          continue;
        // Last look before an irreversible WhatsApp send: a human can resolve
        // the draft in the seconds between the claim and the send, and then the
        // holding line ("ahorita te confirmo") lands AFTER the real answer.
        // Re-reading here shrinks that window from seconds to milliseconds — it
        // cannot close it (there is no transaction spanning D1 and the Graph
        // API), so this is best-effort narrowing, not a guarantee. The claim is
        // NOT released: holding_sent=1 on a resolved row is harmless, and
        // keeping it stops the next cron pass from trying again.
        if ((await queries.getApprovalStatus(env.DB, a.id)) !== "pending") continue;
        try {
          // meta.holding=1: the inbox list skips holding lines when deriving a
          // chat's "last message", so the lead still shows as waiting (unread).
          await deps.sendText(env, a.phone, HOLDING_LINE, {
            metaExtra: { holding: 1 },
          });
        } catch (err) {
          // Closed window ⇒ keep the claim: the holding line is undeliverable
          // and retrying every 5 min would only burn calls. Anything else is
          // transient, so release the claim and let the next pass retry.
          if (!(err instanceof WindowClosedError)) {
            await queries.releaseHoldingClaim(env.DB, a.id);
          }
          throw err;
        }
        await postHoldingPing(env, a.id, {
          name: contact?.name ?? null,
          phone: a.phone,
          draft: a.draft,
        });
      } else if (decision.kind === "bestbet") {
        // Defensive baja check, same as approveAndSend: the inbound gate already
        // discards pending drafts on opt-out, so reaching here is a race (or a
        // manual baja). An automated send has no human to catch it — the draft
        // dies as `discarded` instead of going out.
        if (contact?.status === "opted_out") {
          if (await queries.claimApproval(env.DB, a.id, "discarded")) {
            await markDiscardedCard(env, a);
          }
          continue;
        }
        // Claim FIRST (atomic, pending-only) so a human tapping Aprobar in the
        // same second wins and the lead never gets the draft twice. Losing the
        // claim means the row stopped being pending — stay quiet.
        if (!(await queries.claimApproval(env.DB, a.id, "auto_sent", a.draft))) continue;
        try {
          await deps.sendText(env, a.phone, a.draft);
        } catch (err) {
          if (err instanceof WindowClosedError) {
            // decideTimeout checked the window, but it can close in between.
            // Same downgrade approveAndSend does: the row dies as `expired`
            // and the card offers the template button.
            await resolveApproval(env.DB, a.id, "expired");
            await markWindowClosedCard(env, a);
            continue;
          }
          // Transient failure: hand the row back so the next 5-minute pass (or
          // a human) can still send it.
          await resolveApproval(env.DB, a.id, "pending");
          throw err;
        }
        await markAutoSentCard(env, a, decision.sureness);
        // Exactly the post-send work approve/edit do — booking video, nudge
        // re-arm, booking-claim audit — under its own source so the audit card
        // says nobody reviewed this one.
        await runPostSendEffects(env, a.id, a.phone, a.draft, "auto_timeout");
      } else if (decision.kind === "expire") {
        // Atomic: never stomp a row a human resolved between snapshot and now.
        if (!(await queries.claimApproval(env.DB, a.id, "expired"))) continue;
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
    postAutoSentFyi: (fyi) => postAutoSentFyi(env, fyi),
    markSuperseded: (a, newId) => markSupersededCard(env, a, newId),
  };
}

// ---- internal ----

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
