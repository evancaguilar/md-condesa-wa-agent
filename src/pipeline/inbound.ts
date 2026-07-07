// Inbound pipeline. Gate order is EXACTLY as architecture.md §Inbound pipeline:
// dedupe → kill switch → opt-out → student → human override → 8s debounce →
// brain → route reply. Brain/Slack/Airtable arrive as injected ports.

import type {
  BrainResult,
  ConvoContext,
  Env,
  Ports,
  StoredMessage,
} from "../types.js";
import {
  cancelFollowups,
  createApproval,
  getContact,
  insertMessageIfNew,
  isBotEnabled,
  newestInboundWamid,
  recentMessages,
  scheduleFollowup,
  setApprovalSlackTs,
  setContactStatus,
  touchLastInbound,
  upsertContact,
} from "../db/queries.js";
import {
  getActiveCampaigns,
  getCampaign,
  getTrainingWheels,
  setContactCampaign,
} from "../db/queries-admin.js";
import { matchCampaign, normalizeText } from "./campaigns.js";
import { sendText, WindowClosedError } from "../services/wa.js";
import { scheduleTrialSequence, cdmxIso } from "../cron/followups.js";

const OPT_OUT = /^\s*(baja|stop|alto)\s*$/i;
const DEBOUNCE_MS = 8000;
const HISTORY_LIMIT = 20;
const HISTORY_WINDOW_SECONDS = 48 * 3600;
const WINDOW_SECONDS = 24 * 3600;

export interface InboundMessage {
  wamid: string;
  phone: string;
  body: string;
  ts: number;
}

export async function processInbound(
  env: Env,
  ctx: ExecutionContext,
  ports: Ports,
  msg: InboundMessage,
): Promise<void> {
  // 1. Dedupe: INSERT OR IGNORE; existing row ⇒ drop the event entirely.
  const inserted = await insertMessageIfNew(env.DB, {
    wamid: msg.wamid,
    phone: msg.phone,
    direction: "in",
    body: msg.body,
    ts: msg.ts,
  });
  if (!inserted) return;

  await upsertContact(env.DB, { phone: msg.phone });
  await touchLastInbound(env.DB, msg.phone, msg.ts);

  // 2. Global kill switch.
  if (!(await isBotEnabled(env.DB))) {
    await ports.slack.postNote(
      `Bot en pausa (kill switch). Mensaje de ${msg.phone}: ${msg.body}`,
    );
    return;
  }

  // 3. Opt-out.
  if (OPT_OUT.test(msg.body)) {
    await setContactStatus(env.DB, msg.phone, "opted_out");
    await cancelFollowups(env.DB, msg.phone, "skipped_optout");
    try {
      await sendText(
        env,
        msg.phone,
        "Listo, no te enviaremos más mensajes. Si cambias de opinión, escríbenos cuando quieras. 🙌",
      );
    } catch (err) {
      if (!(err instanceof WindowClosedError)) throw err;
    }
    return;
  }

  // 3b. Campaign tagging: if this inbound repeats an active campaign's trigger
  // phrase (the lead came from that ad), tag the contact so the brain gets the
  // campaign's extra knowledge. Only active, in-flight campaigns are considered.
  const activeCampaigns = await getActiveCampaigns(env.DB);
  if (activeCampaigns.length > 0) {
    const campaignId = matchCampaign(normalizeText(msg.body), activeCampaigns);
    if (campaignId !== null) {
      await setContactCampaign(env.DB, msg.phone, campaignId);
    }
  }

  const contact = await getContact(env.DB, msg.phone);
  if (!contact) return;

  // 4. Student on the lead line: silent, ping Slack.
  if (contact.status === "student") {
    await ports.slack.postNote(
      `Alumno conocido escribió en la línea de leads (${msg.phone}): ${msg.body}`,
    );
    return;
  }

  // 5. Human override active.
  const nowSec = Math.floor(Date.now() / 1000);
  if (contact.human_override_until && contact.human_override_until > nowSec) {
    await ports.slack.postNote(
      `(bot en pausa por override) ${msg.phone}: ${msg.body}`,
    );
    return;
  }

  // 6. Debounce: wait ~8s, then only the newest inbound proceeds so we consume
  // all unanswered messages in one brain call.
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
  const newest = await newestInboundWamid(env.DB, msg.phone);
  if (newest !== msg.wamid) return;

  // 7. Brain → route.
  const fresh = await getContact(env.DB, msg.phone);
  if (!fresh) return;
  const history = await recentMessages(
    env.DB,
    msg.phone,
    HISTORY_LIMIT,
    nowSec - HISTORY_WINDOW_SECONDS,
  );
  const windowOpen =
    (fresh.last_inbound_at ?? 0) > nowSec - WINDOW_SECONDS;
  const trainingWheels = await getTrainingWheels(env);

  // If the lead is tagged with a campaign, load its extra knowledge for the brain.
  let campaign: ConvoContext["campaign"];
  if (fresh.campaign_id !== null) {
    const camp = await getCampaign(env.DB, fresh.campaign_id);
    if (camp) campaign = { name: camp.name, info: camp.info };
  }

  const cdmx = cdmxNow();
  const brainCtx: ConvoContext = {
    phone: msg.phone,
    contact: fresh,
    history,
    nowCdmx: cdmx.iso,
    weekday: cdmx.weekday,
    windowOpen,
    trainingWheels,
    campaign,
  };

  const result = await ports.brain.respond(brainCtx);
  await routeResult(env, ports, brainCtx, result, history);
}

async function routeResult(
  env: Env,
  ports: Ports,
  ctx: ConvoContext,
  result: BrainResult,
  history: StoredMessage[],
): Promise<void> {
  const phone = ctx.phone;

  if (result.action === "escalate") {
    await ports.slack.postNote(
      `⚠️ Escalar (${phone}): ${result.reason}\n${result.summary}`,
    );
    return;
  }

  if (result.action === "book") {
    // The brain already created the Airtable record (inside its tool loop) and
    // handed us the recordId. We: (1) always post an FYI card to Slack,
    // (2) schedule the anti-no-show sequence keyed to that record, and
    // (3) deliver the booking confirmation to the lead. A confirmation is still
    // a reply, so under TRAINING_WHEELS it routes through draft-approval instead.
    const booking = {
      name: result.name,
      discipline: result.discipline,
      audience: result.audience,
      trialDate: result.trialDate,
      trialTime: result.trialTime,
      phone,
    };
    await ports.slack.postBookingFyi(booking);
    await scheduleTrialSequence(
      env,
      phone,
      result.recordId,
      cdmxIso(result.trialDate, result.trialTime),
    );
    if (ctx.trainingWheels) {
      await queueApproval(env, ports, ctx, result.followupMessage, history);
    } else {
      await deliverOrDraft(env, ports, ctx, result.followupMessage, "high", history);
    }
    return;
  }

  // Persist any custom follow-up the model requested (set_followup).
  if (result.action === "send" || result.action === "draft") {
    if (result.followup) {
      await scheduleCustomFollowup(env, phone, result.followup);
    }
  }

  const autoSend =
    result.action === "send" && result.confidence === "high" && !ctx.trainingWheels;

  if (autoSend) {
    await deliverOrDraft(env, ports, ctx, result.message, "high", history);
    return;
  }

  // Draft / low confidence / training wheels ⇒ Slack approval.
  const reason = result.action === "draft" ? result.reason : undefined;
  await queueApproval(env, ports, ctx, result.message, history, reason);
}

/** Persists a set_followup request as a kind:'custom' followup row. */
async function scheduleCustomFollowup(
  env: Env,
  phone: string,
  followup: { hoursFromNow: number; note: string },
): Promise<void> {
  const dueAt = Math.floor(Date.now() / 1000) + Math.round(followup.hoursFromNow * 3600);
  await scheduleFollowup(env.DB, {
    phone,
    kind: "custom",
    dueAt,
    note: followup.note || null,
  });
}

async function deliverOrDraft(
  env: Env,
  ports: Ports,
  ctx: ConvoContext,
  message: string,
  confidence: "high" | "low",
  history: StoredMessage[],
): Promise<void> {
  try {
    await sendText(env, ctx.phone, message);
  } catch (err) {
    if (err instanceof WindowClosedError) {
      // Window closed: can't free-form. Surface as an approval so a human can
      // decide on a template (template sending belongs to workstreams C/D).
      await queueApproval(env, ports, ctx, message, history, "24h window closed");
      return;
    }
    throw err;
  }
}

async function queueApproval(
  env: Env,
  ports: Ports,
  ctx: ConvoContext,
  draft: string,
  history: StoredMessage[],
  reason?: string,
): Promise<void> {
  const contextText = history
    .slice(-6)
    .map((m) => `${m.direction === "in" ? "👤" : "🤖"} ${m.body}`)
    .join("\n");
  const confidence = "low";
  const id = await createApproval(env.DB, {
    phone: ctx.phone,
    draft,
    context: contextText,
    confidence,
  });
  const slackTs = await ports.slack.postDraft({
    id,
    phone: ctx.phone,
    draft,
    context: contextText,
    confidence,
    slack_ts: null,
    status: "pending",
    holding_sent: 0,
    created_at: Math.floor(Date.now() / 1000),
    resolved_at: null,
    final_text: null,
    contextText: reason ? `${reason}\n\n${contextText}` : contextText,
  });
  await setApprovalSlackTs(env.DB, id, slackTs);
}

interface CdmxNow {
  iso: string;
  weekday: string;
}

function cdmxNow(): CdmxNow {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string): string =>
    parts.find((p) => p.type === t)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  return { iso, weekday: get("weekday") };
}
