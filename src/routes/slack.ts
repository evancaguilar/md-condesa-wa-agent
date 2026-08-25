// POST /slack/interactive — Block Kit action + modal-submit handler.
// Verifies Slack's signing secret (v0 HMAC over `v0:{ts}:{rawBody}`, 5-min replay
// window), ACKs within 3s, and does the real work in ctx.waitUntil.
//
// Idempotency: every approval action re-reads the approval and acts only from
// 'pending' (attendance + control-panel actions are exempt).

import type { Env } from "../types.js";
import {
  getPendingApprovals,
  kvSet,
  phoneForRecordId,
  scheduleFollowup,
  setHumanOverride,
} from "../db/queries.js";
import { cdmxParts, cdmxToEpoch, DAY } from "../cron/time.js";
import {
  parseInteractionPayload,
  verifySlackSignature,
  type ParsedAction,
  type ParsedInteraction,
} from "../services/slack-timeouts.js";
import {
  markApprovedCard,
  postNote,
  sendHumanFollowupTemplate,
  updateControlPanel,
} from "../services/slack.js";
import {
  armAutoMode,
  autoModeEndLabel,
  disarmAutoMode,
} from "../services/auto-mode.js";
import { AUTO_SEND_DAILY_CAP, setAutoSendEnabled } from "../services/auto-send.js";
import { OptedOutError } from "../services/wa.js";
import { ChannelCapabilityError } from "../services/channel.js";
import {
  approveAndSend,
  discardApproval,
  editAndSend,
  markStudentFromApproval,
  takeoverApproval,
} from "../services/approvals.js";
import {
  applyTuningProposal,
  discardTuningProposal,
} from "../services/edit-tuner.js";
import {
  applyBookingCapture,
  flattenViewValues,
  getBookingCapture,
  parseViewSubmissionTarget,
  skipBookingCapture,
  submitBookingCaptureEdit,
  BOOKING_META_PREFIX,
  BOOKING_MODAL_ACTION,
  BOOKING_MODAL_FIELDS,
} from "../services/booking-guard.js";

export async function handleSlackInteractive(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const raw = await req.text();
  const ok = await verifySlackSignature({
    signingSecret: env.SLACK_SIGNING_SECRET,
    signature: req.headers.get("X-Slack-Signature"),
    timestamp: req.headers.get("X-Slack-Request-Timestamp"),
    rawBody: raw,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  const interaction = parseInteractionPayload(raw);

  if (interaction.kind === "view_submission") {
    // Modal submit: ack by clearing the view, then do the work off-path.
    ctx.waitUntil(onViewSubmission(env, interaction));
    return json({ response_action: "clear" });
  }

  if (interaction.kind === "block_actions") {
    // Some actions (edit, bkedit) need the trigger_id synchronously to open a modal.
    const editAction = interaction.actions.find((a) => a.verb === "edit");
    if (editAction && interaction.triggerId) {
      ctx.waitUntil(openEditModal(env, interaction.triggerId, editAction));
    }
    const bookingEditAction = interaction.actions.find((a) => a.verb === "bkedit");
    if (bookingEditAction && interaction.triggerId) {
      ctx.waitUntil(
        openBookingCaptureModal(env, interaction.triggerId, bookingEditAction),
      );
    }
    for (const action of interaction.actions) {
      if (action.verb === "edit" || action.verb === "bkedit") continue; // handled above
      ctx.waitUntil(dispatchAction(env, action, interaction.user));
    }
  }

  // ACK fast; all work runs in waitUntil.
  return new Response("", { status: 200 });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Loads a single pending approval by id (idempotency guard). */
async function loadPending(env: Env, id: number) {
  const all = await getPendingApprovals(env.DB); // status='pending' only
  return all.find((a) => a.id === id) ?? null;
}

async function dispatchAction(
  env: Env,
  action: ParsedAction,
  by: string | null = null,
): Promise<void> {
  try {
    switch (action.verb) {
      case "approve":
        return await onApprove(env, num(action.arg));
      case "takeover":
        return await onTakeover(env, num(action.arg));
      case "takeover_phone":
        return await onTakeoverPhone(env, action.arg);
      case "mark_student":
        return await onMarkStudent(env, num(action.arg));
      case "discard":
        return await onDiscard(env, num(action.arg));
      case "send_template":
        return await onSendTemplate(env, num(action.arg));
      case "bot_pause":
        return await onBotToggle(env, false);
      case "bot_resume":
        return await onBotToggle(env, true);
      case "auto_night":
        return await onAutoMode(env, true);
      case "auto_manual":
        return await onAutoMode(env, false);
      case "autosend_on":
        return await onAutoSendToggle(env, true, by);
      case "autosend_off":
        return await onAutoSendToggle(env, false, by);
      case "attended_yes":
        return await onAttendance(env, action.arg, true);
      case "attended_no":
        return await onAttendance(env, action.arg, false);
      case "tune_apply":
        return await applyTuningProposal(env, action.arg ?? "");
      case "tune_force":
        return await applyTuningProposal(env, action.arg ?? "", true);
      case "tune_discard":
        return await discardTuningProposal(env, action.arg ?? "");
      case "bkreg":
        return await onBookingRegister(env, action.arg ?? "");
      case "bkskip":
        return await skipBookingCapture(env, action.arg ?? "");
      default:
        return;
    }
  } catch (err) {
    console.error("slack action error", action.actionId, err);
  }
}

// ---- approval actions: thin wrappers over services/approvals.ts ----
// The shared flows claim the approval atomically and handle card updates +
// window-closed handling; a lost race (already resolved) is a silent no-op here.

async function onApprove(env: Env, id: number): Promise<void> {
  await approveAndSend(env, id);
}

async function onTakeover(env: Env, id: number): Promise<void> {
  await takeoverApproval(env, id);
}

/**
 * "Tomar control" on an auto-sent FYI card. There is no approval row to claim
 * (the reply already went out), so this only pauses the bot for that lead —
 * the same snooze the approval-backed takeover applies.
 */
async function onTakeoverPhone(env: Env, phone: string | null): Promise<void> {
  if (!phone) return;
  const hours = Number(env.HUMAN_SNOOZE_HOURS) || 8;
  await setHumanOverride(env.DB, phone, hours);
  await postNote(
    env,
    `🙋 Tomaste el control de ${phone} — el bot no responde ese chat por ${hours}h.`,
  );
}

async function onMarkStudent(env: Env, id: number): Promise<void> {
  await markStudentFromApproval(env, id);
}

async function onDiscard(env: Env, id: number): Promise<void> {
  await discardApproval(env, id);
}

/** From the expired/window-closed card: send the human_followup template. */
async function onSendTemplate(env: Env, id: number): Promise<void> {
  // Approval is already resolved (expired) at this point; fetch phone from the
  // resolved row is not exposed, so re-derive via the pending list is empty.
  // We recorded the phone on the card via the approval; look it up broadly.
  const a = await loadResolved(env, id);
  if (!a) return;
  try {
    await sendHumanFollowupTemplate(env, a.phone);
  } catch (err) {
    // Blocked by the baja backstop: without feedback the button looks broken
    // and staff keep clicking. Say so once, leave the card as-is.
    if (err instanceof OptedOutError) {
      await postNote(env, `🚫 Plantilla NO enviada a ${a.phone}: el contacto está dado de baja.`);
      return;
    }
    // Legacy card for an IG/FB contact (button suppressed on new cards).
    if (err instanceof ChannelCapabilityError) {
      await postNote(env, `🚫 Plantilla NO enviada a ${a.phone}: no hay plantillas en IG/FB.`);
      return;
    }
    throw err;
  }
  await markApprovedCard(env, a, "[plantilla human_followup enviada]");
}

/**
 * Every modal we open comes back through this one handler, so it branches on
 * private_metadata: `booking:<kv key>` is a booking-capture correction, and a
 * bare numeric id is the (unchanged) approval-edit path.
 */
async function onViewSubmission(
  env: Env,
  interaction: ParsedInteraction,
): Promise<void> {
  const target = parseViewSubmissionTarget(interaction.privateMetadata);
  if (target.kind === "booking") {
    await submitBookingCaptureEdit(
      env,
      target.key,
      flattenViewValues(interaction.viewValues),
    );
    return;
  }
  if (target.kind !== "approval") return;
  if (!interaction.firstInputValue) return;
  await editAndSend(env, target.id, interaction.firstInputValue);
}

// ---- booking-capture card actions ----

/** "Registrar": force only when the stored verdict said the slot is invalid. */
async function onBookingRegister(env: Env, key: string): Promise<void> {
  if (!key) return;
  const record = await getBookingCapture(env, key);
  await applyBookingCapture(env, key, { force: record?.verdict.ok === false });
}

/** "Corregir datos": prefilled 5-field modal, namespaced private_metadata. */
async function openBookingCaptureModal(
  env: Env,
  triggerId: string,
  action: ParsedAction,
): Promise<void> {
  const key = action.arg ?? "";
  if (!key) return;
  const record = await getBookingCapture(env, key);
  if (!record || record.status !== "open") return;
  const input = (
    blockId: string,
    label: string,
    value: string | undefined,
    optional = false,
  ): Record<string, unknown> => ({
    type: "input",
    block_id: blockId,
    optional,
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: BOOKING_MODAL_ACTION,
      ...(value ? { initial_value: value } : {}),
    },
  });
  const view = {
    type: "modal",
    private_metadata: `${BOOKING_META_PREFIX}${key}`,
    title: { type: "plain_text", text: "Corregir agendado" },
    submit: { type: "plain_text", text: "Registrar" },
    close: { type: "plain_text", text: "Cancelar" },
    blocks: [
      input(BOOKING_MODAL_FIELDS.name, "Nombre", record.name),
      input(BOOKING_MODAL_FIELDS.childName, "Nombre del niño/a", record.childName, true),
      input(
        BOOKING_MODAL_FIELDS.discipline,
        "Disciplina (jiu / muay / mma / box / baby)",
        record.discipline,
      ),
      input(BOOKING_MODAL_FIELDS.trialDate, "Fecha (YYYY-MM-DD)", record.trialDate),
      input(BOOKING_MODAL_FIELDS.trialTime, "Hora (HH:mm)", record.trialTime),
    ],
  };
  await viewsOpen(env, triggerId, view);
}

async function openEditModal(
  env: Env,
  triggerId: string,
  action: ParsedAction,
): Promise<void> {
  const id = num(action.arg);
  const a = await loadPending(env, id);
  if (!a) return;
  const view = {
    type: "modal",
    private_metadata: String(id),
    title: { type: "plain_text", text: "Editar respuesta" },
    submit: { type: "plain_text", text: "Enviar" },
    close: { type: "plain_text", text: "Cancelar" },
    blocks: [
      {
        type: "input",
        block_id: "edit_block",
        label: { type: "plain_text", text: "Mensaje al lead" },
        element: {
          type: "plain_text_input",
          action_id: "edit_input",
          multiline: true,
          initial_value: a.draft,
        },
      },
    ],
  };
  await viewsOpen(env, triggerId, view);
}

// ---- control panel + attendance ----

async function onBotToggle(env: Env, enabled: boolean): Promise<void> {
  await kvSet(env.DB, "bot_enabled", enabled ? "true" : "false");
  await updateControlPanel(env);
}

/**
 * 🌙 Night mode: arm ⇒ full-auto (no approval on high-confidence replies)
 * until the next 07:00 CDMX, when the kv window lapses on its own; disarm ⇒
 * back to manual immediately. Both refresh the pinned panel and leave an
 * audit note in the channel.
 */
async function onAutoMode(env: Env, arm: boolean): Promise<void> {
  if (arm) {
    const until = await armAutoMode(env.DB);
    await postNote(
      env,
      `🌙 *Modo nocturno ACTIVADO* — el bot responde solo (sin aprobación) hasta las *${autoModeEndLabel(until)}*. Respuestas de baja confianza siguen quedando en borrador.`,
    );
  } else {
    await disarmAutoMode(env.DB);
    await postNote(env, "🎓 *Modo manual* — cada respuesta vuelve a requerir aprobación.");
  }
  await updateControlPanel(env);
}

/**
 * 🤖 Gated auto-send master switch. ON ⇒ obviously-safe high-confidence replies
 * skip the approval queue (services/auto-send.ts owns the gates); OFF ⇒ the lane
 * is completely inert. Every flip leaves an audit note naming who clicked.
 */
async function onAutoSendToggle(
  env: Env,
  enabled: boolean,
  by: string | null,
): Promise<void> {
  await setAutoSendEnabled(env.DB, enabled);
  const who = by ? ` por ${by}` : "";
  await postNote(
    env,
    enabled
      ? `🤖 *Auto-envío ACTIVADO*${who} — respuestas obvias de alta confianza salen sin aprobación (máx. ${AUTO_SEND_DAILY_CAP}/día; nunca precios, agendados ni primer contacto).`
      : `🤖 *Auto-envío DESACTIVADO*${who} — todas las respuestas vuelven a pasar por aprobación.`,
  );
  await updateControlPanel(env);
}

/**
 * Attendance card Sí/No. Writes kv `attendance:<recordId>` (yes|no) so the
 * no_show_1 followup can read it. On "No" we ALSO schedule the no-show
 * producers: `no_show_1` next morning 10:00 CDMX and `reengage_7d` at +7 days
 * (runDueFollowups cancels reengage if the contact wrote back meanwhile).
 */
async function onAttendance(
  env: Env,
  recordId: string | null,
  attended: boolean,
): Promise<void> {
  if (!recordId) return;
  await kvSet(env.DB, `attendance:${recordId}`, attended ? "yes" : "no");
  if (attended) return;

  const phone = await phoneForRecordId(env.DB, recordId);
  if (!phone) return;

  const now = Math.floor(Date.now() / 1000);
  const p = cdmxParts(now + DAY); // tomorrow in CDMX
  const nextMorning10 = cdmxToEpoch(p.year, p.month, p.day, 10, 0, 0);
  await scheduleFollowup(env.DB, {
    phone,
    kind: "no_show_1",
    dueAt: nextMorning10,
    airtableRecordId: recordId,
  });
  await scheduleFollowup(env.DB, {
    phone,
    kind: "reengage_7d",
    dueAt: now + 7 * DAY,
    airtableRecordId: recordId,
  });
}

// ---- Slack Web API bits used only by the route ----

async function viewsOpen(env: Env, triggerId: string, view: unknown): Promise<void> {
  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`views.open failed: ${data.error}`);
}

/** Fetch a resolved (non-pending) approval row for the send_template path. */
async function loadResolved(env: Env, id: number) {
  const row = await env.DB.prepare(
    `SELECT * FROM pending_approvals WHERE id = ?1`,
  )
    .bind(id)
    .first<import("../types.js").PendingApproval>();
  return row;
}

function num(v: string | null): number {
  return v ? parseInt(v, 10) : NaN;
}
