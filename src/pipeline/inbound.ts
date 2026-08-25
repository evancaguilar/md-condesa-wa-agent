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
  cancelPendingApprovals,
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
  setContactNameIfEmpty,
  setContactStatus,
  setHumanOverride,
  touchLastInbound,
  upsertContact,
} from "../db/queries.js";
import { flagOptOutInAirtable, syncLead } from "../services/lead-sync.js";
import {
  appendCampaignAdId,
  cancelFollowupsByKinds,
  getActiveCampaigns,
  getCampaign,
  getTrainingWheels,
  hasScheduledFollowupOfKind,
  setContactAdRef,
  setContactCampaign,
} from "../db/queries-admin.js";
import {
  FIRST_REPLY_RESEND_COOLDOWN_SECONDS,
  adIdToLearn,
  adTextForMatch,
  firstReplyDecision,
  firstReplyFor,
  firstReplyKey,
  hasRealQuestion,
  matchCampaignTiered,
  normalizeText,
} from "./campaigns.js";
import { isOptOut } from "./opt-out.js";
import { compileSafetyPatterns, matchesSafety } from "./safety.js";
import { sendText, sendBookingVideo, WindowClosedError } from "../services/send.js";
import { channelOf } from "../services/channel.js";
import { bookingApprovalKey, awaitingReplyKey } from "../services/approvals.js";
import {
  evaluateAutoSendLane,
  getAutoSendCount,
  releaseAutoSendSlot,
  tryClaimAutoSendSlot,
} from "../services/auto-send.js";
import { CLIENT } from "../client.gen.js";
import {
  fetchMediaBytes,
  fetchMediaBytesFromUrl,
  transcribe,
} from "../services/media.js";
import { lookupAdMeta } from "../services/ad-meta.js";
import {
  finalizeBooking,
  planBookingSequences,
  type FinalizeBookingInput,
} from "../services/booking-core.js";
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
  /** Message kind from the parser ("text"|"audio"|"image"|...). Absent = text-ish. */
  kind?: string;
  /** WhatsApp profile (push) name from the webhook, if present. */
  profileName?: string;
  /** Click-to-WhatsApp ad referral rider (parsed from the webhook), if present. */
  referral?: InboundReferral;
  /** Media rider (audio/image/video/document/sticker), if present. WA media
   *  carries a Graph mediaId; IG/FB attachments carry a direct CDN mediaUrl. */
  media?: {
    mediaId?: string;
    mediaUrl?: string;
    mimeType: string | null;
    filename?: string | null;
  };
}

/** Failure body stored when a voice note can't be transcribed. */
const VOICE_FAIL_BODY = "[nota de voz — no se pudo transcribir]";

/** Placeholder bodies for visual media (shown in transcripts + brain history). */
const MEDIA_PLACEHOLDER: Record<string, string> = {
  image: "[imagen]",
  video: "[video]",
  document: "[documento]",
  sticker: "[sticker]",
};

export async function processInbound(
  env: Env,
  ctx: ExecutionContext,
  ports: Ports,
  msg: InboundMessage,
): Promise<void> {
  // 0. Media pre-processing BEFORE dedupe so the stored row is complete.
  // Voice notes: fetch + transcribe (failures degrade to a marker body — the
  // brain then goes low-confidence / asks them to write it; never throws).
  // Visual media (image/video/document/sticker): keep caption as body (or a
  // placeholder) and stash the media id in meta so the dashboard can render it.
  let body = msg.body;
  let meta: Record<string, unknown> | null = null;
  const isAudio = msg.media && (msg.kind === "audio" || msg.kind === undefined);
  if (msg.media && isAudio) {
    const bytes = msg.media.mediaId
      ? await fetchMediaBytes(env, msg.media.mediaId)
      : msg.media.mediaUrl
        ? await fetchMediaBytesFromUrl(msg.media.mediaUrl)
        : null;
    const transcript = bytes ? await transcribe(env, bytes) : null;
    const mediaRef = msg.media.mediaId
      ? { mediaId: msg.media.mediaId }
      : { mediaUrl: msg.media.mediaUrl };
    if (transcript) {
      body = transcript;
      meta = { voice: true, ...mediaRef, mimeType: msg.media.mimeType };
    } else {
      body = VOICE_FAIL_BODY;
      meta = { voice: true, failed: true, ...mediaRef, mimeType: msg.media.mimeType };
    }
  } else if (msg.media && msg.kind && MEDIA_PLACEHOLDER[msg.kind]) {
    if (!body.trim()) body = MEDIA_PLACEHOLDER[msg.kind]!;
    meta = {
      type: msg.kind,
      mimeType: msg.media.mimeType,
    };
    if (msg.media.mediaId) meta.mediaId = msg.media.mediaId;
    if (msg.media.mediaUrl) meta.mediaUrl = msg.media.mediaUrl;
    if (msg.media.filename) meta.filename = msg.media.filename;
  }
  // Per-message ad context: lets the dashboard show "respondió a un anuncio"
  // on THIS bubble (contact.ad_ref below keeps only the first attribution).
  if (msg.referral && (msg.referral.headline || msg.referral.sourceId)) {
    meta = meta ?? {};
    meta.adRef = {
      headline: msg.referral.headline,
      body: msg.referral.body,
      thumbnailUrl: msg.referral.thumbnailUrl ?? null,
      sourceId: msg.referral.sourceId,
    };
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

  // Reactions (👍/❤️ on one of our messages): stored above so the dashboard
  // shows "[reaccionó ❤️]", but they end here — no brain/approval (a reaction
  // needs no reply), and no touchLastInbound (a reaction does NOT reopen the
  // 24h service window, so counting it would fake an open window).
  if (msg.kind === "reaction") {
    await upsertContact(env.DB, { phone: msg.phone });
    return;
  }

  await upsertContact(env.DB, { phone: msg.phone });
  // WhatsApp push name → contact.name, fill-if-empty only (never overwrite a
  // real name learned in conversation). Gives Airtable a name from message #1,
  // like ManyChat did.
  if (msg.profileName) {
    await setContactNameIfEmpty(env.DB, msg.phone, msg.profileName);
  }
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
        thumbnailUrl: msg.referral.thumbnailUrl ?? null,
      };
      await setContactAdRef(env.DB, msg.phone, JSON.stringify(adRef));
    }
  }

  // 1b. Cancel any pending lead-nudge drip: every new inbound resets it. The
  // drip re-arms after the next bot reply (auto-send or approved). Runs before
  // the gates so the drip is cleared even for kill-switch/override/opt-out paths.
  await cancelNudges(env, msg.phone);
  // Same reset for a staff "send later": the lead spoke first, so the queued
  // text must not go out. This clears the dashboard card immediately; the
  // fire-time last_inbound_at check in cron/followups is the race-proof twin.
  await cancelFollowupsByKinds(env.DB, msg.phone, ["staff_later"]);

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
    // A draft queued before the baja must not stay approvable in Slack/panel.
    await cancelPendingApprovals(env.DB, msg.phone, "discarded");
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

  // 3b. Campaign tagging. Precedence: trigger phrase (designed prefill — one
  // ad's several ice-breaker prefills can route to DIFFERENT campaigns) →
  // exact ad-id → ad keywords vs creative text + Ads-Manager ad name / Meta
  // campaign name (Graph API lookup, kv-cached, fail-soft). The keyword tier
  // covers brand-new ads whose ids nobody registered AND prefills Meta
  // rewrote/localized; a keyword/trigger match on a referral AUTO-LEARNS the
  // new ad id into the campaign — Evan mints new ads ~daily, manual id
  // registration doesn't scale. Only active campaigns.
  const activeCampaigns = await getActiveCampaigns(env.DB);
  let matchedCampaign: Campaign | null = null;
  if (activeCampaigns.length > 0) {
    let adMetaNorm = "";
    if (msg.referral?.sourceId) {
      const adMeta = await lookupAdMeta(env, msg.referral.sourceId);
      if (adMeta) {
        adMetaNorm = normalizeText(
          `${adMeta.name ?? ""} ${adMeta.campaignName ?? ""}`,
        );
      }
    }
    const match = matchCampaignTiered({
      sourceId: msg.referral?.sourceId,
      adTextNorm: [adTextForMatch(msg.referral), adMetaNorm]
        .filter(Boolean)
        .join(" "),
      bodyNorm: normalizeText(body),
      campaigns: activeCampaigns,
    });
    // A fresh ad click that matches NOTHING must also CLEAR any stale campaign
    // tag — otherwise the brain answers with the old campaign's info (seen
    // live: a mananas-999 click still branded as Reto from a July attribution).
    if (match === null && msg.referral) {
      await setContactCampaign(env.DB, msg.phone, null);
    }
    if (match !== null) {
      matchedCampaign = activeCampaigns.find((c) => c.id === match.id) ?? null;
      await setContactCampaign(env.DB, msg.phone, match.id);
      // Auto-learn: best-effort, off the reply path; the Slack note fires only
      // on a real append (once per new ad, not per message).
      const learnId = adIdToLearn(match, msg.referral?.sourceId);
      if (learnId !== null && matchedCampaign) {
        const campaignName = matchedCampaign.name;
        ctx.waitUntil(
          appendCampaignAdId(env.DB, match.id, learnId)
            .then((learned) =>
              learned
                ? ports.slack.postNote(
                    `🔗 Anuncio ${learnId} vinculado automáticamente a la campaña «${campaignName}» (coincidió por el texto del anuncio).`,
                  )
                : undefined,
            )
            .catch((err) =>
              console.error(
                `[inbound] ad-id auto-learn failed (campaign ${match.id}):`,
                err,
              ),
            ),
        );
      }
    }
  }

  const contact = await getContact(env.DB, msg.phone);
  if (!contact) return;

  // Airtable sync — ONE sequential chain, never parallel calls: a first ad
  // message needs both lead_created and campaign_matched, and firing them
  // concurrently made both see "no row yet" and create DUPLICATE Leads rows.
  // Best-effort, never blocks the reply.
  {
    const needsLeadCreate = contact.airtable_lead_id === null;
    const campaignJustMatched = matchedCampaign !== null;
    if (needsLeadCreate || campaignJustMatched) {
      ctx.waitUntil(
        (async () => {
          if (needsLeadCreate) await syncLead(env, msg.phone, "lead_created");
          if (campaignJustMatched) {
            await syncLead(env, msg.phone, "campaign_matched");
          }
        })(),
      );
    }
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
          // The canned welcome answers the AD, not the lead. Audit 2026-08:
          // 4/20 conversations in chunk 00 had their opening question
          // swallowed right here ("¿Es apto para niños?", "¿costo?") — the
          // lead got the welcome and never an answer. When the first message
          // carries a real question, fall through so they get BOTH: the
          // instant welcome now, plus a real reply through the normal
          // debounce → brain → approval path.
          if (!hasRealQuestion(body, matchedCampaign.trigger_phrase)) return;
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

  // The clicked ad's own text rides along even when it isn't mapped to any
  // campaign, so the brain can still infer program/audience from the creative.
  // Prefer THIS message's referral (the ad the lead just clicked) over the
  // stored contact.ad_ref, which keeps the FIRST-ever attribution for the CRM:
  // a returning lead clicking a NEW ad must not be briefed with the old one.
  let adRef: ConvoContext["adRef"];
  if (msg.referral && (msg.referral.headline || msg.referral.body)) {
    adRef = {
      headline: msg.referral.headline ?? null,
      body: msg.referral.body ?? null,
      sourceId: msg.referral.sourceId ?? null,
    };
  } else if (fresh.ad_ref) {
    try {
      const r = JSON.parse(fresh.ad_ref) as AdRef;
      adRef = {
        headline: r.headline ?? null,
        body: r.body ?? null,
        sourceId: r.sourceId ?? null,
      };
    } catch {
      // malformed ad_ref must never block the reply path
    }
  }

  const cdmx = cdmxNow();
  const brainCtx: ConvoContext = {
    phone: msg.phone,
    channel: channelOf(msg.phone),
    contact: fresh,
    history,
    nowCdmx: cdmx.iso,
    weekday: cdmx.weekday,
    windowOpen,
    trainingWheels,
    campaign,
    adRef,
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
    // <!here> — an escalation is action-required (often the HOTTEST leads:
    // "quiero pagar/inscribirme"). Without the ping it drowns in a channel
    // muted to Mentions-only and the lead never gets any reply (seen live
    // 2026-08-07: enrollment-ready lead silently dropped for 6 hours).
    await ports.slack.postNote(
      `<!here> ⚠️ Escalar (${phone}): ${result.reason}\n${result.summary}\n_El bot NO respondió nada — este lead espera respuesta humana._`,
    );
    return;
  }

  if (result.action === "book") {
    // The brain already created the Airtable record(s) (inside its tool loop)
    // and handed us the recordId(s). finalizeBooking does the shared
    // post-booking work — Slack FYI card, anti-no-show sequence keyed to that
    // record, qualification + lead sync — and is the SAME routine the human
    // registration path (services/booking-core.registerBooking) runs. We then
    // deliver the booking confirmation to the lead; a confirmation is still a
    // reply, so under TRAINING_WHEELS it routes through draft-approval instead.
    //
    // Slice 5: a turn can carry SEVERAL bookings (one book_trial call per
    // person — mamá + hijo, two friends). Everyone gets their own FYI card;
    // planBookingSequences decides which of them arm an anti-no-show sequence
    // and under what key (one per distinct slot, `#n`-suffixed after the
    // first — see its doc comment, including the result-watcher trade-off).
    // Older results without `bookings` fall back to the flat fields.
    const list: FinalizeBookingInput[] = result.bookings?.length
      ? result.bookings.map((b) => ({ ...b, phone }))
      : [
          {
            name: result.name,
            discipline: result.discipline,
            audience: result.audience,
            trialDate: result.trialDate,
            trialTime: result.trialTime,
            phone,
            recordId: result.recordId,
          },
        ];
    const sequenceKeys = new Map<FinalizeBookingInput, string>();
    for (const plan of planBookingSequences(list)) {
      sequenceKeys.set(plan.booking, plan.sequenceKey);
    }
    for (const [i, booking] of list.entries()) {
      await finalizeBooking(env, ports.slack, booking, undefined, {
        // null ⇒ an earlier person already armed this exact slot's sequence.
        sequenceKey: sequenceKeys.get(booking) ?? null,
        // Qualification + lead sync are per-PHONE: only the first booking runs
        // them, so a family member never overwrites the lead's qualification.
        skipLeadSync: i > 0,
      });
    }
    if (ctx.trainingWheels) {
      // Booking confirmation routes through approval; mark it booking-origin so
      // approve/edit fires the booking video after sending (R4). Confidence
      // "high": without wheels this send happens unconditionally, so the audit
      // view must count it as a would-have-auto-sent reply.
      await queueApproval(
        env,
        ports,
        ctx,
        result.followupMessage,
        history,
        undefined,
        true,
        true,
        "high",
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

  // Gated auto-send lane: with training wheels ON, an OBVIOUSLY safe reply on a
  // chat a human already signed off on goes straight out instead of waiting for
  // an approval (gates + rationale in services/auto-send.ts). Dead unless the kv
  // switch `auto_send_enabled` is "1". Anything it refuses falls through to the
  // normal approval queue below — no other behavior changes.
  if (ctx.trainingWheels) {
    const lane = await evaluateAutoSendLane(env.DB, {
      phone,
      action: result.action,
      confidence: result.confidence,
      message: result.message,
    });
    if (lane.auto) {
      // The cap is claimed ATOMICALLY here — after every other gate passed and
      // immediately before delivery — so two concurrent webhooks can never both
      // take the last slot of the day. Losing the claim falls through to the
      // approval queue exactly like the pure gate's `cap` block would.
      if (await tryClaimAutoSendSlot(env.DB, lane.day, lane.cap)) {
        // Same delivery path as the wheels-off send: stores the outbound row and
        // arms the nudge drip. A closed window returns false — deliverOrDraft
        // already queued the approval, so we give the slot back and announce
        // nothing.
        const delivered = await deliverOrDraft(
          env,
          ports,
          ctx,
          result.message,
          "high",
          history,
        );
        if (!delivered) {
          await releaseAutoSendSlot(env.DB, lane.day);
          return;
        }
        const dailyCount = await getAutoSendCount(env.DB, lane.day);
        // FYI only — never blocks the reply that already landed.
        try {
          await ports.slack.postAutoSentFyi({
            phone,
            name: ctx.contact.name,
            text: result.message,
            dailyCount,
          });
        } catch (err) {
          console.error("[inbound] auto-send FYI failed", phone, err);
        }
        return;
      }
    }
  }

  // Draft / low confidence / training wheels ⇒ Slack approval. The brain's
  // REAL confidence is stored (was hardcoded "low"): 'high' rows are the
  // would-have-auto-sent replies the audit view reviews before loosening
  // training wheels.
  const reason = result.action === "draft" ? result.reason : undefined;
  await queueApproval(
    env,
    ports,
    ctx,
    result.message,
    history,
    reason,
    false,
    result.awaitingReply ?? true,
    result.confidence,
  );
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
        true,
        confidence,
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
  awaitingReply = true,
  confidence: "high" | "low" = "low",
): Promise<void> {
  const contextText = history
    .slice(-6)
    .map((m) => {
      const who =
        m.direction === "in"
          ? "👤"
          : m.direction === "out_human" || m.direction === "out_human_echo"
            ? "🧑"
            : "🤖";
      const mic = isVoiceMeta(m.meta) ? "🎤 " : "";
      return `${who} ${mic}${m.body}`;
    })
    .join("\n");
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
  // Not-waiting marker (kv, like bookingOrigin): timeout cron skips the holding
  // line for closings. Only written when false — missing key = waiting.
  if (!awaitingReply) await kvSet(env.DB, awaitingReplyKey(id), "0");
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
