// POST /slack/interactive — Block Kit action + modal-submit handler.
// Verifies Slack's signing secret (v0 HMAC over `v0:{ts}:{rawBody}`, 5-min replay
// window), ACKs within 3s, and does the real work in ctx.waitUntil.
//
// Idempotency: every approval action re-reads the approval and acts only from
// 'pending' (attendance + control-panel actions are exempt).

import type { Env } from "../types.js";
import {
  getPendingApprovals,
  insertEdit,
  kvSet,
  phoneForRecordId,
  resolveApproval,
  scheduleFollowup,
  setContactStatus,
  setHumanOverride,
} from "../db/queries.js";
import { sendText, WindowClosedError } from "../services/wa.js";
import { cdmxParts, cdmxToEpoch, DAY } from "../cron/time.js";
import {
  parseInteractionPayload,
  verifySlackSignature,
  type ParsedAction,
} from "../services/slack-timeouts.js";
import {
  markApprovedCard,
  markDiscardedCard,
  markEditedCard,
  markStudentCard,
  markTakenOverCard,
  markWindowClosedCard,
  sendHumanFollowupTemplate,
  updateControlPanel,
} from "../services/slack.js";

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
    // Modal submit: ack by clearing the view, then send the edit off-path.
    ctx.waitUntil(onViewSubmission(env, interaction.privateMetadata, interaction.firstInputValue));
    return json({ response_action: "clear" });
  }

  if (interaction.kind === "block_actions") {
    // Some actions (edit) need the trigger_id synchronously to open a modal.
    const editAction = interaction.actions.find((a) => a.verb === "edit");
    if (editAction && interaction.triggerId) {
      ctx.waitUntil(openEditModal(env, interaction.triggerId, editAction));
    }
    for (const action of interaction.actions) {
      if (action.verb === "edit") continue; // handled above
      ctx.waitUntil(dispatchAction(env, action));
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

async function dispatchAction(env: Env, action: ParsedAction): Promise<void> {
  try {
    switch (action.verb) {
      case "approve":
        return await onApprove(env, num(action.arg));
      case "takeover":
        return await onTakeover(env, num(action.arg));
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
      case "attended_yes":
        return await onAttendance(env, action.arg, true);
      case "attended_no":
        return await onAttendance(env, action.arg, false);
      default:
        return;
    }
  } catch (err) {
    console.error("slack action error", action.actionId, err);
  }
}

// ---- approval actions (idempotent: act only from 'pending') ----

async function onApprove(env: Env, id: number): Promise<void> {
  const a = await loadPending(env, id);
  if (!a) return;
  try {
    await sendText(env, a.phone, a.draft);
  } catch (err) {
    if (err instanceof WindowClosedError) {
      await resolveApproval(env.DB, id, "expired");
      await markWindowClosedCard(env, a);
      return;
    }
    throw err;
  }
  await resolveApproval(env.DB, id, "approved", a.draft);
  await markApprovedCard(env, a, a.draft);
}

async function onTakeover(env: Env, id: number): Promise<void> {
  const a = await loadPending(env, id);
  if (!a) return;
  const hours = Number(env.HUMAN_SNOOZE_HOURS) || 8;
  await setHumanOverride(env.DB, a.phone, hours);
  await resolveApproval(env.DB, id, "taken_over");
  await markTakenOverCard(env, a);
}

async function onMarkStudent(env: Env, id: number): Promise<void> {
  const a = await loadPending(env, id);
  if (!a) return;
  await setContactStatus(env.DB, a.phone, "student");
  await resolveApproval(env.DB, id, "discarded");
  await markStudentCard(env, a);
}

async function onDiscard(env: Env, id: number): Promise<void> {
  const a = await loadPending(env, id);
  if (!a) return;
  await resolveApproval(env.DB, id, "discarded");
  await markDiscardedCard(env, a);
}

/** From the expired/window-closed card: send the human_followup template. */
async function onSendTemplate(env: Env, id: number): Promise<void> {
  // Approval is already resolved (expired) at this point; fetch phone from the
  // resolved row is not exposed, so re-derive via the pending list is empty.
  // We recorded the phone on the card via the approval; look it up broadly.
  const a = await loadResolved(env, id);
  if (!a) return;
  await sendHumanFollowupTemplate(env, a.phone);
  await markApprovedCard(env, a, "[plantilla human_followup enviada]");
}

async function onViewSubmission(
  env: Env,
  privateMetadata: string | null,
  editedText: string | null,
): Promise<void> {
  if (!privateMetadata || !editedText) return;
  const id = num(privateMetadata);
  const a = await loadPending(env, id);
  if (!a) return;
  try {
    await sendText(env, a.phone, editedText);
  } catch (err) {
    if (err instanceof WindowClosedError) {
      await resolveApproval(env.DB, id, "expired");
      await markWindowClosedCard(env, a);
      return;
    }
    throw err;
  }
  await insertEdit(env.DB, a.phone, a.draft, editedText);
  await resolveApproval(env.DB, id, "edited", editedText);
  await markEditedCard(env, a, editedText);
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
