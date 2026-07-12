// Inbound pipeline. Gate order is EXACTLY as architecture.md §Inbound pipeline:
// dedupe → kill switch → opt-out → campaign tagging → student → human override
// → crisis → campaign first-reply → 8s debounce → brain → route reply.
// Brain/Slack/Airtable arrive as injected ports.

import type {
  AdRef,
  BrainResult,
  Campaign,
  ConvoContext,
  Env,
  Ports,
  StoredMessage,
} from "../types.js";
import {
  cancelFollowups,
  createApproval,
  getContact,
  getPendingApprovals,
  supersedeApproval,
  hasOutboundMessage,
  insertMessageIfNew,
  isBotEnabled,
  kvSet,
  kvSetIfAbsent,
  kvClaimIfAbsentOrOlder,
  newestInboundWamid,
  recentMessages,
  scheduleFollowup,
  setApprovalSlackTs,
  setContactStatus,
  setHumanOverride,
  setQualification,
  touchLastInbound,
  upsertContact,
} from "../db/queries.js";
import { flagOptOutInAirtable, syncLead } from "../services/lead-sync.js";
import {
  getActiveCampaigns,
  getCampaign,
  getTrainingWheels,
  hasScheduledFollowupOfKind,
  setContactAdRef,
  setContactCampaign,
} from "../db/queries-admin.js";
import {
  FIRST_REPLY_RESEND_COOLDOWN_SECONDS,
  firstReplyDecision,
  firstReplyFor,
  firstReplyKey,
  matchCampaign,
  matchCampaignByAdId,
  normalizeText,
} from "./campaigns.js";
import { isOptOut } from "./opt-out.js";
import { compileSafetyPatterns, matchesSafety } from "./safety.js";
import { sendText, sendBookingVideo, WindowClosedError } from "../services/wa.js";
import { bookingApprovalKey } from "../services/approvals.js";
import { CLIENT } from "../client.gen.js";
import { fetchMediaBytes, transcribe } from "../services/media.js";
import { scheduleTrialSequence, cdmxIso } from "../cron/followups.js";
import { armNudges, BOOKING_KINDS, cancelNudges } from "../cron/nudges.js";
import type { InboundReferral } from "../routes/webhook-parse.js";

// Crisis patterns compiled once per isolate (empty when the feature is off).
const SAFETY_PATTERNS =
  CLIENT.features.safety && CLIENT.safety
    ? compileSafetyPatterns(CLIENT.safety)
    : [];
const DEBOUNCE_MS = 8000;
const HISTORY_LIMIT = 20;
const HISTORY_WINDOW_SECONDS = 48 * 3600;
const WINDOW_SECONDS = 24 * 3600;

export interface InboundMessage {
  wamid: string;
  phone: string;
  body: string;
  ts: number;
  /** Click-to-WhatsApp ad referral rider (parsed from the webhook), if present. */
  referral?: InboundReferral;
  /** Voice-note / audio media to transcribe (kind:'audio'), if present. */
  media?: { mediaId: string; mimeType: string | null };
}

/** Failure body stored when a voice note can't be transcribed. */
const VOICE_FAIL_BODY = "[nota de voz — no se pudo transcribir]";

export async function processInbound(
  env: Env,
  ctx: ExecutionContext,
  ports: Ports,
  msg: InboundMessage,
): Promise<void> {
  // 0. Voice notes: fetch the media + transcribe BEFORE dedupe so the stored
  // message body is the transcript. Whisper/media failures degrade to a marker
  // body (the brain then goes low-confidence / asks them to write it). Never
  // throws — media.ts swallows all errors to null.
  let body = msg.body;
  let meta: Record<string, unknown> | null = null;
  if (msg.media) {
    const bytes = await fetchMediaBytes(env, msg.media.mediaId);
    const transcript = bytes ? await transcribe(env, bytes) : null;
    if (transcript) {
      body = transcript;
      meta = { voice: true };
    } else {
      body = VOICE_FAIL_BODY;
      meta = { voice: true, failed: true };
    }
  }

  // 1. Dedupe: INSERT OR IGNORE; existing row ⇒ drop the event entirely.
  const inserted = await insertMessageIfNew(env.DB, {
    wamid: msg.wamid,
    phone: msg.phone,
    direction: "in",
    body,
    ts: msg.ts,
    meta: meta ? JSON.stringify(meta) : null,
  });
  if (!inserted) return;

  await upsertContact(env.DB, { phone: msg.phone });
  await touchLastInbound(env.DB, msg.phone, msg.ts);

  // 1a. Ad attribution: on the first inbound carrying a click-to-WhatsApp
  // referral, persist it (only when the contact has none yet — keep the
  // original attribution). Best-effort; failure must not block the reply path.
  if (msg.referral) {
    const contactForAd = await getContact(env.DB, msg.phone);
    if (contactForAd && contactForAd.ad_ref === null) {
      const adRef: AdRef = {
        sourceId: msg.referral.sourceId,
        headline: msg.referral.headline,
        body: msg.referral.body,
        sourceUrl: msg.referral.sourceUrl,
        ctwaClid: msg.referral.ctwaClid,
      };
      await setContactAdRef(env.DB, msg.phone, JSON.stringify(adRef));
    }
  }

  // 1b. Cancel any pending lead-nudge drip: every new inbound resets it. The
  // drip re-arms after the next bot reply (auto-send or approved). Runs before
  // the gates so the drip is cleared even for kill-switch/override/opt-out paths.
  await cancelNudges(env, msg.phone);

  // 2. Global kill switch.
  if (!(await isBotEnabled(env.DB))) {
    await ports.slack.postNote(
      `Bot en pausa (kill switch). Mensaje de ${msg.phone}: ${body}`,
    );
    return;
  }

  // 3. Opt-out. CRM flag + Slack note go out BEFORE the confirmation send so
  // the baja is visible to the team even if that send fails.
  if (isOptOut(body)) {
    await setContactStatus(env.DB, msg.phone, "opted_out");
    await cancelFollowups(env.DB, msg.phone, "skipped_optout");
    ctx.waitUntil(flagOptOutInAirtable(env, msg.phone));
    await ports.slack.postNote(
      `🚫 ${msg.phone} se dio de baja (opt-out). Seguimientos cancelados.`,
    );
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

  // 3b. Campaign tagging. Precedence: an ad-id match (referral.source_id →
  // campaigns.ad_id) wins over a trigger-phrase match, because a click-to-
  // WhatsApp lead is attributed by the ad it clicked, not its prefilled text.
  // Only active, in-flight campaigns are considered.
  const activeCampaigns = await getActiveCampaigns(env.DB);
  let matchedCampaign: Campaign | null = null;
  if (activeCampaigns.length > 0) {
    const campaignId =
      matchCampaignByAdId(msg.referral?.sourceId, activeCampaigns) ??
      matchCampaign(normalizeText(body), activeCampaigns);
    if (campaignId !== null) {
      matchedCampaign =
        activeCampaigns.find((c) => c.id === campaignId) ?? null;
      await setContactCampaign(env.DB, msg.phone, campaignId);
      // Sync the campaign tag + fire campaign/program rules (best-effort).
      ctx.waitUntil(syncLead(env, msg.phone, "campaign_matched"));
    }
  }

  const contact = await getContact(env.DB, msg.phone);
  if (!contact) return;

  // First-contact Airtable row: every lead gets a Leads record (Airtable is the
  // CRM). Only when we haven't synced yet; best-effort, never blocks the reply.
  if (contact.airtable_lead_id === null) {
    ctx.waitUntil(syncLead(env, msg.phone, "lead_created"));
  }

  // 4. Student on the lead line: silent, ping Slack.
  if (contact.status === "student") {
    await ports.slack.postNote(
      `Alumno conocido escribió en la línea de leads (${msg.phone}): ${body}`,
    );
    return;
  }

  // 5. Human override active.
  const nowSec = Math.floor(Date.now() / 1000);
  if (contact.human_override_until && contact.human_override_until > nowSec) {
    await ports.slack.postNote(
      `(bot en pausa por override) ${msg.phone}: ${body}`,
    );
    return;
  }

  // 5b. Crisis-safety gate (features.safety). Deterministic, pre-brain, no
  // debounce: reply ONLY with the containment message + real resources, pause
  // the bot for this conversation, kill all followups, and escalate urgently.
  if (SAFETY_PATTERNS.length > 0 && matchesSafety(body, SAFETY_PATTERNS)) {
    const safety = CLIENT.safety!;
    const reply = contact.lang === "en" ? safety.responseEn : safety.responseEs;
    await setHumanOverride(env.DB, msg.phone, safety.pauseHours);
    await cancelFollowups(env.DB, msg.phone);
    try {
      await sendText(env, msg.phone, reply);
    } catch (err) {
      if (!(err instanceof WindowClosedError)) throw err;
    }
    await ports.slack.postNote(
      `🚨 SEÑAL DE CRISIS (${msg.phone}). Bot pausado ${safety.pauseHours}h; se envió el mensaje de contención con recursos. ATENCIÓN HUMANA URGENTE.\nMensaje: ${body}`,
    );
    return;
  }

  // 5c. Campaign first-reply: a campaign-matched lead gets the pre-written
  // welcome INSTANTLY — no debounce, no brain, no approval (ManyChat parity);
  // the AI takes over from the lead's NEXT message. Two ways in:
  //  - "first": brand-new lead (no outbound ever); at-most-once via kv claim.
  //  - "resend": a known lead CLICKED AN AD AGAIN (referral present) and has
  //    no trial booked — same welcome again, at most once per cooldown window
  //    (atomic kv timestamp claim). Typing trigger-like text mid-chat never
  //    re-welcomes. A failed send falls through to the brain path.
  if (matchedCampaign && contact.status === "lead") {
    const canned = firstReplyFor(matchedCampaign, false);
    if (canned !== null) {
      const hasPriorOutbound = await hasOutboundMessage(env.DB, msg.phone);
      const hasActiveBooking =
        hasPriorOutbound && msg.referral
          ? await hasScheduledFollowupOfKind(env.DB, msg.phone, BOOKING_KINDS)
          : false;
      const decision = firstReplyDecision({
        hasPriorOutbound,
        hasReferral: Boolean(msg.referral),
        hasActiveBooking,
      });
      const key = firstReplyKey(msg.phone);
      const claimed =
        decision === "first"
          ? await kvSetIfAbsent(env.DB, key, String(nowSec))
          : decision === "resend"
            ? await kvClaimIfAbsentOrOlder(
                env.DB,
                key,
                nowSec,
                FIRST_REPLY_RESEND_COOLDOWN_SECONDS,
              )
            : false;
      if (claimed) {
        try {
          await sendText(env, msg.phone, canned);
          await armNudges(env, msg.phone);
          const note =
            decision === "first"
              ? `⚡ Nuevo lead — campaña «${matchedCampaign.name}» (${msg.phone}). Respuesta automática enviada; la IA contesta a partir de su próximo mensaje.`
              : `🔁 Lead volvió a llegar por la campaña «${matchedCampaign.name}» (${msg.phone}). Bienvenida reenviada.`;
          ctx.waitUntil(ports.slack.postNote(note).catch(() => {}));
          return;
        } catch (err) {
          // WindowClosed can't happen here (last_inbound was just touched); any
          // other send failure degrades to a normal AI reply this turn.
          console.error(
            `[inbound] first-reply send failed for ${msg.phone}:`,
            err,
          );
        }
      }
    }
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
    // Chat booking: the bot confirms inline below, so skip the scheduled
    // trial_confirm (it's for web-form bookers detected via syncBookings).
    await scheduleTrialSequence(
      env,
      phone,
      result.recordId,
      cdmxIso(result.trialDate, result.trialTime),
      { includeConfirm: false },
    );
    // Persist qualification (this is the sole caller — gives classifyProgram real
    // data) then sync the booking to Airtable + fire program rules. Isolated so a
    // sync failure never derails the confirmation/video path below.
    try {
      await setQualification(
        env.DB,
        phone,
        JSON.stringify({
          discipline: result.discipline,
          audience: result.audience,
          name: result.name,
        }),
      );
      await syncLead(env, phone, "booking_created");
    } catch (err) {
      console.warn(`[inbound] booking sync failed for ${phone}:`, err);
    }
    if (ctx.trainingWheels) {
      // Booking confirmation routes through approval; mark it booking-origin so
      // approve/edit fires the booking video after sending (R4).
      await queueApproval(
        env,
        ports,
        ctx,
        result.followupMessage,
        history,
        undefined,
        true,
      );
    } else {
      const delivered = await deliverOrDraft(
        env,
        ports,
        ctx,
        result.followupMessage,
        "high",
        history,
        true,
      );
      // Confirmation text landed → fire the booking video right after (R4).
      if (delivered) await sendBookingVideo(env, phone);
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
  bookingOrigin = false,
): Promise<boolean> {
  void confidence;
  try {
    await sendText(env, ctx.phone, message);
  } catch (err) {
    if (err instanceof WindowClosedError) {
      // Window closed: can't free-form. Surface as an approval so a human can
      // decide on a template (template sending belongs to workstreams C/D). Carry
      // the booking-origin marker so approve/edit still fires the video (R4).
      await queueApproval(
        env,
        ports,
        ctx,
        message,
        history,
        "24h window closed",
        bookingOrigin,
      );
      return false;
    }
    throw err;
  }
  // Bot reply landed with the lead. Arm (or re-arm) the nudge drip. armNudges is
  // internally conditional: it only arms status='lead' with no active booking,
  // no override, and under the rolling cap — so booking-confirmation sends and
  // student/opted-out contacts are no-ops.
  await armNudges(env, ctx.phone);
  return true;
}

async function queueApproval(
  env: Env,
  ports: Ports,
  ctx: ConvoContext,
  draft: string,
  history: StoredMessage[],
  reason?: string,
  bookingOrigin = false,
): Promise<void> {
  const contextText = history
    .slice(-6)
    .map((m) => {
      const who = m.direction === "in" ? "👤" : "🤖";
      const mic = isVoiceMeta(m.meta) ? "🎤 " : "";
      return `${who} ${mic}${m.body}`;
    })
    .join("\n");
  const confidence = "low";
  // Older pending cards for this phone are strictly stale — this new draft was
  // built from the FULL conversation. Snapshot them now, supersede after create.
  const stale = await getPendingApprovals(env.DB, ctx.phone);
  const id = await createApproval(env.DB, {
    phone: ctx.phone,
    draft,
    context: contextText,
    confidence,
  });
  for (const s of stale) {
    try {
      // Atomic guard: skip the card swap if Evan approved it in a race.
      if (await supersedeApproval(env.DB, s.id)) {
        await ports.slack.markSuperseded(s, id);
      }
    } catch (err) {
      console.error("supersede approval failed", s.id, err);
    }
  }
  // Booking-origin marker (kv, keyed by approval id) so the video fires when this
  // draft is approved/edited later. Kept off the stored context column, which is
  // rendered verbatim in Slack + the dashboard.
  if (bookingOrigin) await kvSet(env.DB, bookingApprovalKey(id), "1");
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

/** True when a stored message's meta JSON marks it as a voice transcription. */
function isVoiceMeta(meta: string | null): boolean {
  if (!meta) return false;
  try {
    return (JSON.parse(meta) as { voice?: boolean }).voice === true;
  } catch {
    return false;
  }
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
