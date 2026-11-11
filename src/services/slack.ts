// Slack Web API client (raw fetch) + Block Kit builders for the WhatsApp AI
// agent's human-approval layer. Implements SlackPort (postDraft/postNote) plus
// the control panel, card-update helpers, attendance/holding pings and the
// FYI booking card. Zero npm deps: raw fetch + WebCrypto only.
//
// Pure, unit-testable helpers (signature verify, payload parse, business-hours /
// timeout logic) live in ./slack-timeouts.js and are re-exported here.

import {
  buildPingText,
  buildStatusLine,
  shouldPing,
  summarizeQueue,
  KV_STATUS_LINE_PING_AT,
  KV_STATUS_LINE_TS,
} from "./status-line.js";
import { dashboardChatUrl, dashboardUrl } from "./dashboard-link.js";
import type {
  AutoSentFyi,
  BookTrialInput,
  Env,
  NoteOpts,
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
  kvSetIfAbsent,
  kvClaimIfAbsentOrOlder,
  releaseHoldingClaim,
  resolveApproval,
  setContactStatus,
  setHumanOverride,
  isBotEnabled,
} from "../db/queries.js";
import { sendTemplate, sendText, WindowClosedError } from "./send.js";
import { channelOf, displayContact } from "./channel.js";
import {
  adAttributionLine,
  decideTimeout,
  DEFAULT_APPROVALS,
  escalateWhyLabel,
  escalationNotes,
  holdingLineFor,
  isApologyDraft,
  lastLeadLine,
  timeoutPolicy,
  windowHoursLeft,
  type EscalateWhy,
  type EscalationLine,
  type TimeoutPolicy,
  decideEscalationPing,
  escalationTaskKey,
  parseEscalationTask,
  type EscalationTaskState,
  type EscalationKind,
  type TimeoutApprovalView,
} from "./slack-timeouts.js";
import {
  awaitingReplyKey,
  guardedApprovalKey,
  reasonKindKey,
  runPostSendEffects,
  surenessKey,
} from "./approvals.js";
import {
  attendedCardText,
  postTrialCardKey,
  POST_TRIAL_CLAIM_VERB,
} from "../cron/post-trial.js";
import { greetingName } from "../cron/display-name.js";
import { nameParam, tpl } from "./template-params.js";
import type { BookingCapture, HumanSendSource } from "./booking-claims.js";
import { autoModeEndLabel, getAutoModeUntil } from "./auto-mode.js";
import { AUTO_SEND_DAILY_CAP, isAutoSendEnabled } from "./auto-send.js";
import { claimApproval, getCampaign } from "../db/queries-admin.js";
import { staleDateIssue, staleDateLabel } from "./stale-dates.js";
import { declinedKey, parseDeclineMarker } from "../pipeline/decline.js";
import type { Proposal } from "./kb-editor.js";
import { CLIENT } from "../client.gen.js";
import {
  criticalAlertLine,
  criticalDedupeKey,
  inferLevel,
  shouldPostCritical,
  writeOpsLog,
} from "./ops-log.js";

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

/**
 * Slack destinations (2026-10-22 restructure, docs/slack-routing.md):
 *   "task"   SLACK_CHANNEL_ID (#wa-leads) — ONLY what the team must act on:
 *            approval cards, booking FYIs, human-task notes, the scoreboard.
 *   "alerts" SLACK_CHANNEL_ALERTS_ID (#evan-alerts) — ONLY what needs Evan:
 *            nightly-audit summary, sales escalations, template approved /
 *            rejected, weekly scoreboard, level=critical one-liners.
 * Everything else is NOT Slack: postNote writes the D1 ops_log (services/
 * ops-log.ts, /admin → Logs). #bot-ops (SLACK_CHANNEL_OPS_ID) is no longer a
 * destination; the var survives only so a button on a card posted there
 * before the restructure can still be edited (updateMessage retry).
 * Dedupe rule: one event → at most ONE Slack channel.
 */
export type NoteKind = "task" | "alerts";

export function channelFor(
  env: Pick<Env, "SLACK_CHANNEL_ID" | "SLACK_CHANNEL_ALERTS_ID">,
  kind: NoteKind,
): string | null {
  if (kind === "alerts") return env.SLACK_CHANNEL_ALERTS_ID || null;
  return env.SLACK_CHANNEL_ID;
}

async function postMessage(
  env: Env,
  blocks: unknown[],
  text: string,
  extra?: Record<string, unknown>,
  kind: NoteKind = "task",
): Promise<string> {
  const channel = channelFor(env, kind);
  if (!channel) throw new Error(`slack: no channel configured for "${kind}"`);
  const data = await slackCall(env, "chat.postMessage", {
    channel,
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
  // Cards live in the task channel. Button payloads only carry the ts, so a
  // miss there retries in the retired #bot-ops channel, where auto-sent FYIs
  // (with a "Tomar control" button) were posted before 2026-10-22.
  try {
    await slackCall(env, "chat.update", { channel: env.SLACK_CHANNEL_ID, ts, text, blocks });
  } catch (err) {
    const legacyOps = env.SLACK_CHANNEL_OPS_ID;
    if (!legacyOps || legacyOps === env.SLACK_CHANNEL_ID || !/message_not_found|channel_not_found/.test(String(err))) throw err;
    await slackCall(env, "chat.update", { channel: legacyOps, ts, text, blocks });
  }
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
export function draftBlocks(
  approval: PendingApproval & { contextText: string; sureness?: number },
  name: string | null,
  hoursLeft: number,
  reason: string | null,
  adLine: string | null,
  chatUrl: string | null = null,
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
    context(
      statusChips(approval, name, hoursLeft) +
        (chatUrl ? `  •  <${chatUrl}|💬 Abrir en el panel>` : ""),
    ),
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
  const blocks = draftBlocks(a, name, hoursLeft, reason, adLine, dashboardChatUrl(env, a.phone));
  // <!here> so action-required cards ping even with the channel muted to
  // "Mentions only"; FYI posts (postNote/postBookingFyi) stay silent.
  blocks.unshift(context("<!here>"));
  return postMessage(env, blocks, `<!here> Nueva respuesta por aprobar — ${a.phone}`);
}

/**
 * Mechanical note (FYI / report / debug / non-blocking failure) → D1 ops_log,
 * NOT Slack. Never throws. level defaults from the leading emoji (inferLevel);
 * level "critical" (a failure that blocks sends) ALSO posts one line to
 * #evan-alerts, deduped per kind for 30 min.
 */
export async function postNote(env: Env, text: string, opts: NoteOpts = {}): Promise<void> {
  const level = opts.level ?? inferLevel(text);
  const kind = opts.kind ?? "misc";
  await writeOpsLog(env.DB, { level, kind, message: text, meta: opts.meta });
  if (level !== "critical") return;
  // Fail OPEN on D1: an infra alert (services/infra-alert.ts) arrives here
  // exactly when D1 is down, so a kv error must not swallow the Slack line.
  const line = criticalAlertLine(kind, text);
  const key = criticalDedupeKey(kind);
  const now = Math.floor(Date.now() / 1000);
  const prev = await kvGet(env.DB, key).catch(() => null);
  if (!shouldPostCritical(prev, line, now)) return;
  await kvSet(env.DB, key, `${now}|${line}`).catch(() => {});
  const full = `${line} · <${dashboardUrl(env, `logs/${kind}`)}|detalle>`;
  try {
    await postMessage(env, [section(full)], line, undefined, "alerts");
  } catch (err) {
    console.error("[slack] critical alert line failed", kind, err);
  }
}

/**
 * Needs Evan → #evan-alerts (also recorded in ops_log so the Logs tab is the
 * complete record). Throws on a Slack failure so retry-on-failure callers
 * (nightly audit) retry. No alerts channel configured ⇒ ops_log only.
 */
export async function postAlert(env: Env, text: string, opts: Omit<NoteOpts, "level"> = {}): Promise<void> {
  const kind = opts.kind ?? "misc";
  await writeOpsLog(env.DB, {
    level: inferLevel(text),
    kind,
    message: text,
    meta: { ...(opts.meta ?? {}), slack: "evan-alerts" },
  });
  if (!channelFor(env, "alerts")) {
    console.warn("[slack] SLACK_CHANNEL_ALERTS_ID unset; alert kept in ops_log only", kind);
    return;
  }
  await postMessage(env, [section(text)], text, undefined, "alerts");
}

/** A human must act → task channel (#wa-leads). */
export async function postTaskNote(env: Env, text: string): Promise<void> {
  await postMessage(env, [section(text)], text, undefined, "task");
}

/**
 * Escalation task with SLA (audit 2026-10: hot leads waited 3–8 h; the same
 * lead got a fresh <!here> per message). ONE open task per phone: while the
 * approval it tracks is still pending, a new escalation for that phone EDITS
 * the existing message (no new @here); otherwise a fresh <!here> task is
 * posted and tracked. Re-pings are driven by runApprovalTimeouts.
 */
export async function postEscalationTask(
  env: Env,
  phone: string,
  approvalId: number,
  text: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const key = escalationTaskKey(phone);
  const open = parseEscalationTask(await kvGet(env.DB, key));
  if (open && (await getApprovalStatus(env.DB, open.approvalId)) === "pending") {
    const body = text.replace(/<!here>\s*/g, "");
    try {
      await updateMessage(env, open.ts, [section(body)], body);
      await kvSet(env.DB, key, JSON.stringify({ ...open, approvalId }));
      return;
    } catch (err) {
      console.error("[slack] escalation task update failed; reposting", phone, err);
    }
  }
  const ts = await postMessage(env, [section(text)], text, undefined, "task");
  const state: EscalationTaskState = { ts, approvalId, createdAt: nowSec, pings: 0 };
  await kvSet(env.DB, key, JSON.stringify(state));
}

/** One SLA step for a pending row whose phone has an open escalation task. */
async function escalationSlaStep(env: Env, a: PendingApproval, now: number): Promise<void> {
  const key = escalationTaskKey(a.phone);
  const open = parseEscalationTask(await kvGet(env.DB, key));
  if (!open || open.approvalId !== a.id) return;
  const step = decideEscalationPing(open, now);
  if (step === "none") return;
  // Claim the step first (kv write) so two overlapping cron passes don't both ping.
  await kvSet(env.DB, key, JSON.stringify({ ...open, pings: open.pings + 1 }));
  const mins = Math.round((now - open.createdAt) / 60);
  if (step === "reping") {
    await postMessage(
      env,
      [section(`<!here> ⏰ ${a.phone} lleva ${mins} min esperando respuesta humana.`)],
      `${a.phone} lleva ${mins} min esperando`,
      { thread_ts: open.ts, reply_broadcast: true },
      "task",
    );
    return;
  }
  // Sales escalation past its SLA → #evan-alerts (was a DM to
  // SLACK_OWNER_USER_ID, usually unset). The task itself stays in #wa-leads.
  await postAlert(env, `⏰ ${a.phone} lleva ${mins} min sin respuesta humana en #wa-leads (escalación).`, {
    kind: "approvals",
    meta: { phone: a.phone, approvalId: a.id },
  });
}

/** FYI card posted when the model's book_trial tool fires. */
export async function postBookingFyi(env: Env, booking: BookTrialInput): Promise<void> {
  const when = `${booking.trialDate} ${booking.trialTime}`;
  const chatUrl = dashboardChatUrl(env, booking.phone);
  const blocks = [
    section(
      `📅 *Clase de prueba agendada*\n*${booking.name}* · ${booking.phone}`,
    ),
    context(
      `${booking.discipline} · ${booking.audience === "kid" ? "niños" : "adultos"} · ${when}` +
        (chatUrl ? `  •  <${chatUrl}|💬 Abrir en el panel>` : ""),
    ),
  ];
  // #wa-leads, silent (no <!here>): the team preps for the visit.
  await postMessage(env, blocks, `Clase de prueba agendada — ${booking.name}`, undefined, "task");
}

/**
 * A reply the gated auto-send lane sent WITHOUT approval → ops_log (kind
 * "autosend"), not Slack (2026-10-22): it already went out, nobody must act.
 * Taking the thread over is done from the dashboard chat (link in meta).
 */
export async function postAutoSentFyi(env: Env, fyi: AutoSentFyi): Promise<void> {
  const who = fyi.name ? `${fyi.name} · ${fyi.phone}` : fyi.phone;
  const seguridad =
    fyi.sureness !== undefined ? `seguridad ${fyi.sureness}%` : "alta confianza";
  await postNote(
    env,
    `🤖 Auto-enviado (${seguridad}) — ${who}: «${fyi.text}» · ${fyi.dailyCount}/${AUTO_SEND_DAILY_CAP} hoy`,
    {
      kind: "autosend",
      level: "info",
      meta: { phone: fyi.phone, sureness: fyi.sureness ?? null, dailyCount: fyi.dailyCount, chat: dashboardChatUrl(env, fyi.phone) },
    },
  );
}

/**
 * "Asistió y no se inscribió" card, posted by the result watcher. The single
 * button is the signal the bot otherwise cannot get: staff follow these leads up
 * from their OWN phones, so no inbound ever reaches us and every send-time stop
 * condition stays false. Clicking it kills only today's message (see
 * cron/post-trial.ts decideClaim). Silent (no <!here>): the chain runs either way.
 */
export async function postPostTrialCard(
  env: Env,
  args: { name: string; phone: string },
): Promise<string> {
  const blocks: unknown[] = [
    // The text shows the human-readable contact; the button carries the RAW id,
    // which is what the kv keys and the followups rows are keyed by.
    section(attendedCardText(args.name, displayContact(args.phone))),
    {
      type: "actions",
      block_id: `posttrial_${args.phone}`,
      elements: [
        button("🙋 Yo le escribo", `${POST_TRIAL_CLAIM_VERB}|${args.phone}`, "primary"),
      ],
    },
  ];
  const ts = await postMessage(env, blocks, `Asistió sin inscribirse — ${args.phone}`);
  // Remembered so the click can chat.update THIS message (there is no approval
  // row to hang a slack_ts on). Best-effort: a failed write only costs the edit.
  await kvSet(env.DB, postTrialCardKey(args.phone), ts).catch(() => {});
  return ts;
}

/** Replace the post-trial card with its claimed state (button gone). */
export async function updatePostTrialCard(
  env: Env,
  phone: string,
  text: string,
): Promise<void> {
  const ts = await kvGet(env.DB, postTrialCardKey(phone));
  if (!ts) return; // card unknown (old kv, or the post failed) — nothing to edit
  await updateMessage(env, ts, [section(text)], text);
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

/**
 * #wa-leads scoreboard: one message edited in place each cron tick, pinned on
 * first post, re-posted if someone deleted it. <!here> at most once per hour
 * while the oldest open item is past 30 min (services/status-line.ts).
 */
export async function ensureStatusLine(
  env: Env,
  pending: PendingApproval[],
  nowSec: number,
): Promise<void> {
  const q = summarizeQueue(pending, nowSec);
  const text = buildStatusLine(q, nowSec);
  const existing = await kvGet(env.DB, KV_STATUS_LINE_TS);
  let posted = false;
  if (existing) {
    try {
      await slackCall(env, "chat.update", {
        channel: env.SLACK_CHANNEL_ID,
        ts: existing,
        text,
        blocks: [section(text)],
      });
      posted = true;
    } catch (err) {
      if (!/message_not_found|channel_not_found/.test(String(err))) throw err;
    }
  }
  if (!posted) {
    const ts = await postMessage(env, [section(text)], text, undefined, "task");
    await kvSet(env.DB, KV_STATUS_LINE_TS, ts);
    try {
      await slackCall(env, "pins.add", { channel: env.SLACK_CHANNEL_ID, timestamp: ts });
    } catch {
      // best-effort
    }
  }
  const lastPingRaw = await kvGet(env.DB, KV_STATUS_LINE_PING_AT);
  const lastPing = lastPingRaw ? Number(lastPingRaw) : null;
  if (shouldPing(q, Number.isFinite(lastPing) ? lastPing : null, nowSec)) {
    await kvSet(env.DB, KV_STATUS_LINE_PING_AT, String(nowSec));
    await postTaskNote(env, buildPingText(q));
  }
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
 * The timeout send (owner directive 2026-08-25, wait cut to 15 min on
 * 2026-11-11): nobody reviewed the draft and the bot sent it itself. The card
 * says so explicitly, with the model's own sureness, so Evan can audit which
 * numbers were worth trusting.
 */
export function markAutoSentCard(
  env: Env,
  a: PendingApproval,
  sureness: number,
  waitedMin?: number,
): Promise<void> {
  const after = waitedMin === undefined ? "" : ` tras ${waitedMin} min sin revisión`;
  return updateResolvedCard(
    env,
    a,
    `⏱️ *Enviada automáticamente*${after} · seguridad ${sureness}%`,
    a.draft,
  );
}
/**
 * Aprobar refused on a late draft whose hoy/mañana or class time no longer
 * holds: a thread reply on the card (it stays pending — Editar still works).
 */
export async function postStaleApproveWarning(env: Env, a: PendingApproval, label: string): Promise<void> {
  if (!a.slack_ts) return;
  const text = `⚠️ No se envió: ${label}. Usa ✏️ Editar para corregir el día/hora y envíalo.`;
  await postMessage(env, [section(text)], text, { thread_ts: a.slack_ts });
}
/** The draft was moot (stale date, the lead wrote again): a fresh brain turn replaces it. */
export function markRegeneratedCard(env: Env, a: PendingApproval, why: string): Promise<void> {
  return updateResolvedCard(env, a, `🔄 *Reemplazada* — ${why}; el bot generó una respuesta nueva`, a.draft);
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

/**
 * Sends the human_followup template (reopens the 24h window).
 *
 * The approved templates are `human_followup_es` / `_en`, each declaring
 * {{1}} = first name. Until 2026-09-21 this sent the BARE base name with no
 * parameters, so every click of "📨 Enviar plantilla" on an expired card failed
 * at Graph twice over — wrong name AND wrong param count.
 */
export async function sendHumanFollowupTemplate(
  env: Env,
  phone: string,
): Promise<void> {
  const contact = await getContact(env.DB, phone);
  const lang = contact?.lang ?? "es";
  await sendTemplate(env, phone, tpl(HUMAN_FOLLOWUP_TEMPLATE, lang), lang, [
    nameParam(greetingName(contact?.name), lang),
  ]);
}

// ---- approval timeouts (called by the every-5-minute cron) ----

/** The newest lead message — what a regenerated turn answers. */
export interface TimeoutInbound {
  wamid: string;
  phone: string;
  body: string;
  ts: number;
}

/** The queries surface runApprovalTimeouts depends on (injectable for tests). */
export interface TimeoutQueries {
  getPendingApprovals: typeof getPendingApprovals;
  getContact: typeof getContact;
  claimHoldingSend: typeof claimHoldingSend;
  releaseHoldingClaim: typeof releaseHoldingClaim;
  claimApproval: typeof claimApproval;
  getApprovalStatus: typeof getApprovalStatus;
  /** Staff answered this lead (dashboard / WA app) after `sinceTs`. */
  staffRepliedSince?: (db: D1Database, phone: string, sinceTs: number) => Promise<boolean>;
  newestInbound?: (db: D1Database, phone: string) => Promise<TimeoutInbound | null>;
}

export interface TimeoutDeps {
  sendText: typeof sendText;
  now?: number; // injectable clock (seconds)
  /**
   * Fresh brain turn for a moot draft (stale hoy/mañana, the lead wrote again,
   * the brain's failure apology). Wired in index.ts to pipeline/inbound
   * runBrainTurn; absent ⇒ those rows escalate to a human instead.
   */
  regenerate?: (msg: TimeoutInbound, nowSec: number) => Promise<void>;
  /** Policy override for tests; default CLIENT.approvals. */
  policy?: TimeoutPolicy;
}

/** Brain re-runs per cron tick (each one is an Anthropic call, ~5–30 s). */
export const REGENERATE_PER_TICK = 2;
/** One regeneration per phone in this window; a second moot draft escalates. */
export const REGENERATE_COOLDOWN_SEC = 3 * 3600;

/** kv: the timeout escalation for approval `id` went out (posted once). */
export function timeoutEscalatedKey(id: number): string {
  return `tmo_esc:${id}`;
}

async function defaultStaffRepliedSince(db: D1Database, phone: string, sinceTs: number): Promise<boolean> {
  // idx_messages_phone_ts (phone, ts) — a short range scan of one chat.
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM messages WHERE phone = ?1 AND ts > ?2 AND direction IN ('out_human','out_human_echo') LIMIT 1`,
    )
    .bind(phone, sinceTs)
    .first<{ x: number }>();
  return row !== null;
}

async function defaultNewestInbound(db: D1Database, phone: string): Promise<TimeoutInbound | null> {
  const row = await db
    .prepare(
      `SELECT wamid, COALESCE(body, '') AS body, ts FROM messages WHERE phone = ?1 AND direction = 'in' ORDER BY ts DESC LIMIT 1`,
    )
    .bind(phone)
    .first<{ wamid: string; body: string; ts: number }>();
  return row && row.wamid ? { wamid: row.wamid, phone, body: row.body, ts: row.ts } : null;
}

/** Declined-stop sources that mean "do not answer for me" (pipeline/decline.ts). */
const DECLINE_BLOCKS = new Set(["not_interested", "complaint"]);

/**
 * Per spec §Slack timeouts + the 2026-11-11 policy (client.mjs `approvals`).
 * Called by the every-5-minute cron. Decisions are pure (decideTimeout); this
 * loop reads the side-channels, then acts:
 * - hold      ⇒ claim holding_sent, send the holding line (lead's language).
 * - bestbet   ⇒ staff answered since? superseded. Stale hoy/mañana or clock
 *               time (staleDateIssue)? regenerate. Else claim `auto_sent`, send
 *               the draft as-is, stamp the card, run the post-send effects.
 * - regenerate⇒ claim `superseded`, run one fresh brain turn on the newest
 *               lead message (≤ 2 per tick, ≤ 1 per phone per 3 h — else the
 *               row escalates).
 * - escalate  ⇒ once per approval (kv tmo_esc:<id>); every row of the tick goes
 *               into ONE #wa-leads task + ONE #evan-alerts line.
 * - expire    ⇒ claim `expired`, swap the card; escalates too if nobody was
 *               paged yet.
 *
 * Every write is an atomic claim (claimHoldingSend / claimApproval) because
 * the pending list is a snapshot: a human can approve, edit or take over an
 * approval between the snapshot and the action, and the loser of that race
 * must do nothing at all.
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
  const policy = deps.policy ?? timeoutPolicy(CLIENT.approvals ?? DEFAULT_APPROVALS);
  const staffRepliedSince = queries.staffRepliedSince ?? defaultStaffRepliedSince;
  const newestInbound = queries.newestInbound ?? defaultNewestInbound;
  const pending = await queries.getPendingApprovals(env.DB);
  const botEnabled = pending.length > 0 ? await isBotEnabled(env.DB) : true;
  const toEscalate: EscalationLine[] = [];
  let regenerated = 0;

  for (const a of pending) {
    let contact: Awaited<ReturnType<typeof getContact>> = null;
    let view: TimeoutApprovalView | null = null;
    try {
      contact = await queries.getContact(env.DB, a.phone);
      // Brain's not-waiting marker (kv, set at queue time): "0" ⇒ skip holding.
      const awaitingRaw = await kvGet(env.DB, awaitingReplyKey(a.id));
      // Side-channels written by queueApproval (point reads by primary key; the
      // queue is dozens of rows at worst — cheaper than a schema change).
      const surenessRaw = await kvGet(env.DB, surenessKey(a.id));
      const guardedRaw = await kvGet(env.DB, guardedApprovalKey(a.id));
      const kindRaw = await kvGet(env.DB, reasonKindKey(a.id));
      const surenessNum = Number(surenessRaw);
      view = {
        id: a.id,
        phone: a.phone,
        createdAt: a.created_at,
        holdingSent: a.holding_sent === 1,
        lastInboundAt: contact?.last_inbound_at ?? null,
        awaitingReply: awaitingRaw === "0" ? false : undefined,
        sureness:
          surenessRaw !== null && Number.isFinite(surenessNum) ? surenessNum : undefined,
        guarded: guardedRaw === "1",
        reasonKind: (kindRaw as EscalationKind | null) ?? null,
        hasDraft: !!a.draft && a.draft.trim() !== "",
        apologyDraft: isApologyDraft(a.draft),
        botEnabled,
        optedOut: contact?.status === "opted_out",
        overrideActive: !!contact?.human_override_until && contact.human_override_until > now,
      };
      // The rest only matters once the row can come due (min wait), so young
      // rows cost no extra reads.
      if (now - a.created_at >= Math.min(policy.autoSendAfterSec, policy.taskAutoSendAfterSec)) {
        const task = parseEscalationTask(await kvGet(env.DB, escalationTaskKey(a.phone)));
        view.tasked = task?.approvalId === a.id;
        view.escalated = (await kvGet(env.DB, timeoutEscalatedKey(a.id))) !== null;
        const decl = parseDeclineMarker(await kvGet(env.DB, declinedKey(a.phone)));
        view.declined = !!decl && DECLINE_BLOCKS.has(decl.source);
      }
    } catch (err) {
      console.error("[timeouts] reading row state failed", a.id, err);
      continue;
    }
    let decision = decideTimeout(view, now, policy);

    // Escalation SLA: 45-min re-ping, then the owner alert (business hours only).
    try {
      await escalationSlaStep(env, a, now);
    } catch (err) {
      console.error("[timeouts] escalation SLA step failed", a.id, err);
    }

    const escalate = async (why: string[]): Promise<void> => {
      if (!(await kvSetIfAbsent(env.DB, timeoutEscalatedKey(a.id), String(now)))) return;
      toEscalate.push({
        phone: a.phone,
        name: contact?.name ?? null,
        question: lastLeadLine(a.context),
        why,
        approvalId: a.id,
      });
    };
    const whyLabels = (list: EscalateWhy[]): string[] =>
      list.map((w) => escalateWhyLabel(w, { sureness: view!.sureness, reasonKind: view!.reasonKind }));

    try {
      // A due send/regenerate on a chat a human already answered after this
      // draft: the draft is moot and the lead has an answer — close it quietly.
      if (
        (decision.kind === "bestbet" || decision.kind === "regenerate") &&
        (await staffRepliedSince(env.DB, a.phone, a.created_at))
      ) {
        if (await queries.claimApproval(env.DB, a.id, "superseded")) {
          await markSupersededCard(env, a, null);
        }
        continue;
      }
      // Stale relative dates: a late send re-reads hoy / mañana / clock times.
      let staleLabel: string | null = null;
      if (decision.kind === "bestbet" && now - a.created_at >= policy.staleCheckAfterSec) {
        const issue = staleDateIssue(a.draft, a.created_at, now);
        if (issue) {
          staleLabel = staleDateLabel(issue);
          decision = { kind: "regenerate", id: a.id, phone: a.phone, why: "no_answer" };
        }
      }

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
        // Last look before an irreversible WhatsApp send (best-effort narrowing
        // of the claim→send race; the claim is kept either way).
        if ((await queries.getApprovalStatus(env.DB, a.id)) !== "pending") continue;
        try {
          // meta.holding=1: the inbox list skips holding lines when deriving a
          // chat's "last message", so the lead still shows as waiting (unread).
          await deps.sendText(env, a.phone, holdingLineFor(contact?.lang), {
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
      } else if (decision.kind === "discard") {
        // Defensive baja check: the inbound gate already discards pending
        // drafts on opt-out, so reaching here is a race (or a manual baja). An
        // automated send has no human to catch it.
        if (await queries.claimApproval(env.DB, a.id, "discarded")) {
          await markDiscardedCard(env, a);
        }
      } else if (decision.kind === "bestbet") {
        // Claim FIRST (atomic, pending-only) so a human tapping Aprobar in the
        // same second wins and the lead never gets the draft twice.
        if (!(await queries.claimApproval(env.DB, a.id, "auto_sent", a.draft))) continue;
        try {
          await deps.sendText(env, a.phone, a.draft);
        } catch (err) {
          if (err instanceof WindowClosedError) {
            // decideTimeout checked the window, but it can close in between.
            await resolveApproval(env.DB, a.id, "expired");
            await markWindowClosedCard(env, a);
            continue;
          }
          // Transient failure: hand the row back so the next pass (or a human)
          // can still send it.
          await resolveApproval(env.DB, a.id, "pending");
          throw err;
        }
        await markAutoSentCard(env, a, decision.sureness, Math.round((now - a.created_at) / 60));
        // Exactly the post-send work approve/edit do — booking video, nudge
        // re-arm, booking-claim audit — under its own source so the audit card
        // says nobody reviewed this one.
        await runPostSendEffects(env, a.id, a.phone, a.draft, "auto_timeout");
      } else if (decision.kind === "regenerate") {
        const capped =
          !deps.regenerate ||
          regenerated >= REGENERATE_PER_TICK ||
          !(await kvClaimIfAbsentOrOlder(env.DB, `regen:${a.phone}`, now, REGENERATE_COOLDOWN_SEC));
        if (capped) {
          // Over the per-tick budget: try again next tick (5 min).
          if (deps.regenerate && regenerated >= REGENERATE_PER_TICK) continue;
          await escalate([staleLabel ?? escalateWhyLabel("regen_failed")]);
          continue;
        }
        const msg = await newestInbound(env.DB, a.phone);
        if (!msg) {
          await escalate([staleLabel ?? escalateWhyLabel("regen_failed")]);
          continue;
        }
        // The old draft dies first, so an overlapping tick or a human tap can't
        // send it while the brain writes the fresh one.
        if (!(await queries.claimApproval(env.DB, a.id, "superseded"))) continue;
        await markRegeneratedCard(env, a, staleLabel ?? (decision.why === "lead_wrote_again" ? "el lead escribió de nuevo" : "el bot no había respondido"));
        regenerated++;
        try {
          await deps.regenerate!(msg, now);
        } catch (err) {
          console.error("[timeouts] regenerate failed", a.id, err);
          await escalate([escalateWhyLabel("regen_failed")]);
        }
      } else if (decision.kind === "escalate") {
        await escalate(whyLabels(decision.why));
      } else if (decision.kind === "expire") {
        // Atomic: never stomp a row a human resolved between snapshot and now.
        if (!(await queries.claimApproval(env.DB, a.id, "expired"))) continue;
        await markExpiredCard(env, a, decision.windowClosed);
        if (decision.escalate) await escalate([escalateWhyLabel("expired")]);
      }
    } catch (err) {
      // A closed window on the holding line just means we skip it; never throw
      // out of the cron for one bad approval.
      if (!(err instanceof WindowClosedError)) {
        console.error("runApprovalTimeouts error", a.id, err);
      }
    }
  }

  // ONE task + ONE owner alert for everything that needs a human this tick.
  const notes = escalationNotes(toEscalate);
  if (notes) {
    try {
      await postTaskNote(env, notes.task);
    } catch (err) {
      console.error("[timeouts] escalation task failed", err);
    }
    try {
      await postAlert(env, notes.alert, {
        kind: "approvals",
        meta: { approvalIds: toEscalate.map((l) => l.approvalId) },
      });
    } catch (err) {
      console.error("[timeouts] escalation alert failed", err);
    }
  }
}

// ---- SlackPort binding for the pipeline (index.ts wires this in) ----

/** Factory: binds the Env into a SlackPort the inbound pipeline can call. */
export function makeSlackPort(env: Env): SlackPort {
  return {
    postDraft: (a) => postDraft(env, a),
    postNote: (text, opts) => postNote(env, text, opts),
    postTaskNote: (text) => postTaskNote(env, text),
    postAlert: (text, opts) => postAlert(env, text, opts),
    postEscalationTask: (phone, approvalId, text) => postEscalationTask(env, phone, approvalId, text),
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
