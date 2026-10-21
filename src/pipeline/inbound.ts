// Inbound pipeline. Gate order is EXACTLY as architecture.md §Inbound pipeline:
// dedupe → kill switch → opt-out → reto login → campaign tagging → student → human override
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
  kvGet,
  kvSet,
  kvSetIfAbsent,
  kvClaimIfAbsentOrOlder,
  kvDelete,
  newestInboundWamid,
  recentMessages,
  scheduleFollowup,
  setApprovalSlackTs,
  setContactName,
  setContactNameIfEmpty,
  setContactStatus,
  setHumanOverride,
  touchLastInbound,
  upsertContact,
} from "../db/queries.js";
import { withTemplateText } from "../services/template-text.js";
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
  trialReminderRows,
} from "../db/queries-admin.js";
import { upcomingTrialDateFromReminders } from "../services/booking-guard.js";
import { claimsBooking } from "../services/booking-claims.js";
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
  shouldSkipCannedWelcome,
  slotQueryForCampaign,
  SLOT_PLACEHOLDER,
} from "./campaigns.js";
import { nextTrialSlot } from "../cron/next-slot.js";
import { greetingName } from "../cron/display-name.js";
import { classifyReminderReply, reminderAckText } from "./reminder-reply.js";
import {
  detectLeadCancel,
  recentCancelIntent,
  trialCancelledKey,
  type LeadCancelIntent,
} from "./lead-cancel.js";
import { applyLeadCancellation } from "../services/trial-cancel.js";
import {
  OVERRIDE_CHECK_PREFIX,
  armOverrideCheck,
  decideOverrideCheck,
  overrideCheckKey,
  overrideFromStaffReply,
  overrideRouting,
  parseOverrideCheck,
} from "./override-check.js";
import { isOptOut, isOptOutBurst, OPT_OUT_BURST_SECONDS } from "./opt-out.js";
import { isRetoLoginRequest, retoLoginConfigured } from "./reto-login.js";
import { requestRetoLogin } from "../services/reto-login.js";
import { hasBuyIntent } from "../cron/nudge-signals.js";
import { compileSafetyPatterns, matchesSafety } from "./safety.js";
import { sendText, WindowClosedError } from "../services/send.js";
import { afterBookingConfirmed, personalizeBookingConfirmation } from "../services/cuestionario.js";
import { channelOf } from "../services/channel.js";
import {
  bookingApprovalKey,
  awaitingReplyKey,
  guardedApprovalKey,
  surenessKey,
  escalationKey,
  reasonKindKey,
} from "../services/approvals.js";
import { classifyEscalation, escalationNeedsTask } from "../services/slack-timeouts.js";
import {
  evaluateAutoSendLane,
  getAutoSendCount,
  releaseAutoSendSlot,
  surenessOf,
  tryClaimAutoSendSlot,
} from "../services/auto-send.js";
import { CLIENT } from "../client.gen.js";
import { isNoReplySentinel } from "../brain/prompt.js";
import { taskNote } from "../cron/deps.js";
import {
  fetchMediaBytes,
  fetchMediaBytesFromUrl,
  transcribe,
} from "../services/media.js";
import { lookupAdMeta } from "../services/ad-meta.js";
import { attributionFor, decorateBookingLinks } from "../services/booking-link.js";
import {
  googleClickKey,
  googleRefKey,
  parseGoogleClickCode,
  parseGoogleClickRef,
  parseStoredGoogleClick,
  type GoogleClick,
} from "../services/google-click.js";
import {
  bookingMarkerLive,
  bookingRecordedKey,
  finalizeBooking,
  parseBookingRecordedMarker,
  planBookingSequences,
  type FinalizeBookingInput,
} from "../services/booking-core.js";
import { armNudges, BOOKING_KINDS, cancelNudges } from "../cron/nudges.js";
import { parseQualification } from "../cron/nudge-copy.js";
import { mergeQualUpdate, programSignalUpdate } from "../services/program-signal.js";
import { setQualification } from "../db/queries.js";
import type { InboundReferral } from "../routes/webhook-parse.js";

// Crisis patterns compiled once per isolate (empty when the feature is off).
const SAFETY_PATTERNS =
  CLIENT.features.safety && CLIENT.safety
    ? compileSafetyPatterns(CLIENT.safety)
    : [];
const DEBOUNCE_MS = 8000;
const HISTORY_LIMIT = 20;
// 7 days (was 48h, 2026-10-11): the brain trims to 48h itself unless the lead
// has a child qualification or a live booking (claude.ts trimHistory).
const HISTORY_WINDOW_SECONDS = 7 * 24 * 3600;
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
  // Google Ads click ref the site appends to its WhatsApp prefill
  // ("… [ref gclid:<id>:<ts>]"): stripped from the body BEFORE it is stored, so
  // the brain/Slack/dashboard never see it; kept on the bubble's meta and, in
  // 1a below, in kv for the Leads gclid / gclid_time columns.
  // Since attribution.js v8 the prefill carries only a short code
  // ("… [K7M2QX]"); the click itself was POSTed to /g at page load and waits in
  // kv. The long ref above is still parsed for pages cached before v8.
  const gRef = parseGoogleClickRef(body);
  let googleClick: GoogleClick | null = null;
  if (gRef.click) {
    googleClick = gRef.click;
    body = gRef.body;
    meta = meta ?? {};
    meta.googleClick = googleClick;
  } else {
    const gCode = parseGoogleClickCode(body);
    if (gCode.code) {
      body = gCode.body;
      meta = meta ?? {};
      meta.googleCode = gCode.code;
      try {
        googleClick = parseStoredGoogleClick(await kvGet(env.DB, googleRefKey(gCode.code)));
      } catch (err) {
        console.warn("[inbound] google code lookup failed", msg.phone, err);
      }
      if (googleClick) meta.googleClick = googleClick;
    }
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
  // Google click: first one wins, like ad_ref. Written before the Airtable
  // sync below so this very message's lead_created/campaign_matched carries it.
  if (googleClick) {
    try {
      await kvSetIfAbsent(env.DB, googleClickKey(msg.phone), JSON.stringify(googleClick));
    } catch (err) {
      console.warn("[inbound] google click store failed", msg.phone, err);
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

  // 1c. The lead calls off a booked trial ("ya no voy a poder ir", "lo
  // dejamos para otro día"; audit 2026-10-14/21: reminders and the no-show
  // touch kept going out). Not a gate — like 1b it runs before them, so the
  // reminders stop even under kill switch / override, and the turn continues
  // to the brain, which gets a <cancelacion> hint to offer a new date. Only a
  // detector hit costs a query; no armed trial ⇒ nothing happens. Fail-soft.
  let leadCancel: LeadCancelIntent | null = null;
  const cancelIntent = detectLeadCancel(body);
  if (cancelIntent) {
    try {
      const res = await applyLeadCancellation(env, msg.phone, body, cancelIntent, {
        postTaskNote: (t) => taskNote(ports.slack, t),
      });
      if (res) leadCancel = cancelIntent;
    } catch (err) {
      console.warn("[inbound] lead cancellation failed", msg.phone, err);
    }
  }

  // 2. Global kill switch.
  if (!(await isBotEnabled(env.DB))) {
    await taskNote(ports.slack, 
      `Bot en pausa (kill switch). Mensaje de ${msg.phone}: ${body}`,
    );
    return;
  }

  // 3. Opt-out. CRM flag + Slack note go out BEFORE the confirmation send so
  // the baja is visible to the team even if that send fails.
  // v2: the last ≤3 inbound messages within 2 min count as ONE text (2026-10-10
  // …4595: "No me interesa…" / "Gracias" / "Ya no me manden mensaje.").
  let optOut = isOptOut(body);
  if (!optOut) {
    try {
      const recent = await recentMessages(env.DB, msg.phone, 6, msg.ts - OPT_OUT_BURST_SECONDS);
      optOut = isOptOutBurst(recent.map((m) => ({ body: m.body, ts: m.ts, direction: m.direction })));
    } catch (err) {
      console.warn("[inbound] opt-out burst read failed", msg.phone, err);
    }
  }
  if (optOut) {
    await applyOptOut(env, ports, msg.phone, {
      note: `🚫 ${msg.phone} se dio de baja (opt-out). Seguimientos cancelados.`,
      waitUntil: (p) => ctx.waitUntil(p),
    });
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

  // 3a. Reto course login (md-condesa-site /reto/entrar/ → "…entrar a mis cursos
  // del Reto [CURSOS]"). Deterministic: the site checks the Airtable `fundamentos` tag
  // and returns the exact reply (one-time login link, or "not found"); we relay
  // it. Runs BEFORE campaign tagging / lead sync / brain, so a member logging in
  // is never filed as a lead (no Leads row, no drip, no approval). Inert until
  // RETO_LOGIN_URL + RETO_BOT_SECRET are set. WhatsApp only (the site matches
  // on the phone number).
  if (channelOf(msg.phone) === "wa" && retoLoginConfigured(env) && isRetoLoginRequest(body)) {
    await handleRetoLogin(env, ports, msg.phone);
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

  let contact = await getContact(env.DB, msg.phone);
  if (!contact) return;

  // Program signal (2026-09-30): "2 años", "mi hija", "18 meses" → store
  // audience/discipline now, not only at booking, so nudges and blast
  // audiences stop filing unbooked parents as adults. Side effect only — not
  // a gate; fail-soft. 2026-10-11: also the child's AGE (a bare "5" counts
  // when our previous message asked for it) → child_age_months + program, and
  // the discipline of the ad they tapped when none is stored yet.
  try {
    const prior = await recentMessages(env.DB, msg.phone, 6);
    const lastOut = [...prior].reverse().find((m) => m.direction !== "in");
    let adText = matchedCampaign?.ad_keywords ?? "";
    if (contact.ad_ref) {
      try {
        const r = JSON.parse(contact.ad_ref) as { headline?: string | null; body?: string | null };
        adText = `${r.headline ?? ""} ${r.body ?? ""} ${adText}`;
      } catch {
        // malformed ad_ref: campaign keywords only
      }
    }
    const merged = programSignalUpdate(parseQualification(contact), {
      body,
      lastOutboundBody: lastOut?.body ?? null,
      adText,
    });
    if (merged) {
      const q = JSON.stringify(merged);
      await setQualification(env.DB, msg.phone, q);
      contact = { ...contact, qualification: q };
    }
  } catch (err) {
    console.warn("[inbound] program signal failed", msg.phone, err);
  }

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
    await taskNote(ports.slack, 
      `Alumno conocido escribió en la línea de leads (${msg.phone}): ${body}`,
    );
    return;
  }

  // 5. Human override active.
  const nowSec = Math.floor(Date.now() / 1000);
  if (contact.human_override_until && contact.human_override_until > nowSec) {
    // Override v2: after a STAFF REPLY, a lead who writes again is not left
    // for the whole 8 h pause (…1521, …5625 waited a day). Arm a 60-min
    // check; the cron (runOverrideChecks) runs the brain if no human answers.
    let armed = false;
    try {
      const recent = await recentMessages(env.DB, msg.phone, 10, nowSec - HISTORY_WINDOW_SECONDS);
      if (overrideFromStaffReply(recent)) {
        const key = overrideCheckKey(msg.phone);
        const prev = parseOverrideCheck(await kvGet(env.DB, key));
        await kvSet(
          env.DB,
          key,
          JSON.stringify(armOverrideCheck(prev, { wamid: msg.wamid, ts: msg.ts, body }, nowSec)),
        );
        armed = true;
      }
    } catch (err) {
      console.warn("[inbound] override check arm failed", msg.phone, err);
    }
    await ports.slack.postNote(
      `(bot en pausa por override) ${msg.phone}: ${body}` +
        (armed ? "\n_Si nadie le contesta en 60 min, la IA responde (directo si ≥70 % segura, si no borrador)._" : ""),
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
    await taskNote(ports.slack, 
      `🚨 SEÑAL DE CRISIS (${msg.phone}). Bot pausado ${safety.pauseHours}h; se envió el mensaje de contención con recursos. ATENCIÓN HUMANA URGENTE.\nMensaje: ${body}`,
    );
    return;
  }

  // 5b'. Trial-reminder quick replies (owner decision 2026-10-11; …2139 got
  // "te esperamos hoy a las 9 am" 6.5 h late, after the class). "Ahí estaré"
  // → no brain turn: silence, or CLIENT.copy.reminderAckEs/En when set.
  // "Necesito reagendar" → brain turn with a <reschedule> hint. Nothing is
  // written to Airtable here; since 2026-10-21 step 1c already cancelled the
  // old class's reminders (the phrase reads as a reschedule), and the NEW
  // booking's sequence re-arms them for the new slot.
  let reschedule = false;
  try {
    const reminderReply = classifyReminderReply({
      body,
      kind: msg.kind,
      reminders: await trialReminderRows(env.DB, msg.phone),
      now: nowSec,
    });
    if (reminderReply === "confirm") {
      const copy = CLIENT.copy as unknown as Record<string, string | undefined>;
      const ack = contact.lang === "en" ? copy.reminderAckEn : copy.reminderAckEs;
      if (ack) {
        try {
          await sendText(env, msg.phone, reminderAckText(ack, greetingName(contact.name)));
        } catch (err) {
          if (!(err instanceof WindowClosedError)) throw err;
        }
      }
      console.log(`[inbound] reminder confirm from ${msg.phone}; no brain turn`);
      return;
    }
    reschedule = reminderReply === "reschedule";
  } catch (err) {
    console.warn("[inbound] reminder reply check failed", msg.phone, err);
  }

  // 5c. Campaign first-reply: a campaign-matched lead gets the pre-written
  // welcome INSTANTLY — no debounce, no brain, no approval (ManyChat parity);
  // the AI takes over from the lead's NEXT message. Two ways in:
  //  - "first": brand-new lead (no outbound ever); at-most-once via kv claim.
  //  - "resend": a known lead CLICKED AN AD AGAIN (referral present) and has
  //    no trial booked — same welcome again, at most once per cooldown window
  //    (atomic kv timestamp claim). Typing trigger-like text mid-chat never
  //    re-welcomes. A failed send falls through to the brain path.
  // Set when the canned welcome went out AND we fell through to the brain — the
  // brain is then told what the lead is already reading (see buildContextBlock's
  // <bienvenida_ya_enviada>) so this turn adds only what the welcome left out.
  let justSentWelcome: string | undefined;
  if (matchedCampaign && contact.status === "lead" && !reschedule && !leadCancel) {
    // {{slot}} in the welcome → the concrete next bookable slot for the
    // campaign's grid (docs/welcomes-draft.md). No slot ⇒ no canned text.
    let slotLabel: string | null = null;
    if ((matchedCampaign.first_reply ?? "").includes(SLOT_PLACEHOLDER)) {
      const q = slotQueryForCampaign(matchedCampaign.name);
      slotLabel = nextTrialSlot(q.discipline, q.audience, nowSec)?.label ?? null;
    }
    const rawCanned = firstReplyFor(matchedCampaign, false, slotLabel);
    // The lead's own words beyond the ad's prefill (campaign vocabulary is
    // never the lead's — 2026-10-07 double reply).
    const realQuestion = hasRealQuestion(body, matchedCampaign.trigger_phrase, [
      matchedCampaign.name,
      matchedCampaign.ad_keywords ?? null,
      msg.referral?.headline ?? null,
    ]);
    // Age / day / hour / uncovered discipline already in the text ⇒ the brain
    // answers alone (joss_bfc_mini: "niña de 4 años" got the 12–36-month pitch;
    // welcome_resend: "Jueves 7:00am" got the Reto welcome again).
    const skipCanned = shouldSkipCannedWelcome(body, matchedCampaign);
    // Booking links inside the welcome carry the lead's ad as utm params so
    // the site's form prefill credits it (see services/booking-link.ts).
    const canned =
      rawCanned === null
        ? null
        : decorateBookingLinks(
            rawCanned,
            attributionFor(contact, matchedCampaign.name, msg.referral?.sourceId),
          );
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
        buyIntent: hasBuyIntent([body]),
        realQuestion,
        skipCanned,
      });
      const key = firstReplyKey(msg.phone);
      // Skipped first welcome still burns the at-most-once claim, so the
      // lead's NEXT message (while the brain's reply waits for approval)
      // doesn't get the canned text after all.
      if (skipCanned && !hasPriorOutbound) {
        await kvSetIfAbsent(env.DB, key, String(nowSec));
      }
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
          // The campaign's own vocabulary (name, ad keywords, the ad's
          // headline) is never the lead's question — a prefill that names
          // the program must not read as one (2026-10-07 double reply).
          if (!realQuestion) return;
          justSentWelcome = canned;
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

  // A normal turn now owns this lead's reply: any armed override check is moot.
  await kvDelete(env.DB, overrideCheckKey(msg.phone)).catch(() => {});
  // 1c's cancellation may have landed on an EARLIER message of this burst
  // (debounce): a fresh marker still steers this turn. One kv read, fail-soft.
  if (!leadCancel) {
    try {
      leadCancel = recentCancelIntent(await kvGet(env.DB, trialCancelledKey(msg.phone)), nowSec);
    } catch {
      leadCancel = null;
    }
  }
  const turnOpts: BrainTurnOptions = {
    ...(reschedule ? { reschedule: true } : {}),
    ...(leadCancel ? { leadCancel } : {}),
  };
  await runBrainTurn(env, ports, msg, nowSec, justSentWelcome, reschedule || leadCancel ? turnOpts : undefined);
}

/**
 * Options for a brain turn that did not come straight from the webhook.
 * `forceReview` (outage redrive, src/cron/redrive.ts): the reply ALWAYS lands
 * in Aprobar — no auto-send lane, no 1h best-bet (no sureness key), no 10-min
 * holding line (awaitingReply=false) — Evan reviews and sends each one.
 * `stale` rides into the prompt as <respuesta_tardia>.
 */
export interface BrainTurnOptions {
  forceReview?: boolean;
  stale?: ConvoContext["staleReply"];
  /** "Necesito reagendar" reminder reply → <reschedule> hint in the context. */
  reschedule?: boolean;
  /** The lead called off a booked trial (step 1c) → <cancelacion> hint. */
  leadCancel?: "cancel" | "reschedule";
  /** Override v2 turn (runOverrideChecks): direct send only at sureness ≥ 70. */
  overrideCheck?: boolean;
}

/**
 * Cron step (every tick): human override v2. For each armed
 * `override_check:<phone>` older than 60 min whose lead message is still
 * unanswered, run one brain turn (routeResult then sends only at ≥ 70 %
 * sureness with wheels off, else drafts). Returns how many turns ran.
 */
export async function runOverrideChecks(
  env: Env,
  ports: Ports,
  nowSec: number,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM kv WHERE key LIKE ?1 LIMIT 50`,
  )
    .bind(`${OVERRIDE_CHECK_PREFIX}%`)
    .all<{ key: string; value: string }>();
  let ran = 0;
  for (const row of results ?? []) {
    const phone = row.key.slice(OVERRIDE_CHECK_PREFIX.length);
    const state = parseOverrideCheck(row.value);
    if (!state) {
      await kvDelete(env.DB, row.key);
      continue;
    }
    try {
      const answered = await env.DB.prepare(
        `SELECT 1 AS x FROM messages WHERE phone = ?1 AND direction <> 'in' AND ts > ?2 LIMIT 1`,
      )
        .bind(phone, state.ts)
        .first<{ x: number }>();
      const contact = await getContact(env.DB, phone);
      const decision = decideOverrideCheck({
        state,
        now: nowSec,
        answeredAfter: answered !== null,
        contactStatus: contact?.status ?? null,
      });
      if (decision === "wait") continue;
      await kvDelete(env.DB, row.key); // claim before the (slow) brain turn
      if (decision === "drop") continue;
      ran++;
      await runBrainTurn(
        env,
        ports,
        { wamid: state.wamid, phone, body: state.body, ts: state.ts },
        nowSec,
        undefined,
        { overrideCheck: true },
      );
    } catch (err) {
      console.error("[override-check] failed", phone, err);
    }
  }
  return ran;
}

/**
 * Step 7 of the pipeline: build the brain context for `msg` (the newest
 * inbound of its phone), call the brain, route the result. Exported for the
 * outage redrive; processInbound calls it after the debounce.
 */
export async function runBrainTurn(
  env: Env,
  ports: Ports,
  msg: InboundMessage,
  nowSec: number,
  justSentWelcome: string | undefined,
  opts?: BrainTurnOptions,
): Promise<void> {
  // 7. Brain → route.
  const fresh = await getContact(env.DB, msg.phone);
  if (!fresh) return;
  const history = await withTemplateText(
    env,
    await recentMessages(env.DB, msg.phone, HISTORY_LIMIT, nowSec - HISTORY_WINDOW_SECONDS),
    fresh.name,
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

  // A recent real booking backs this phone's booking-claim language — without
  // it, guardUnbackedBookingClaim demotes every post-booking "nos vemos
  // mañana" ack to a low draft (~15 of 61 queued approvals on 2026-08-26).
  let recordedBooking: ConvoContext["recordedBooking"];
  try {
    const marker = parseBookingRecordedMarker(
      await kvGet(env.DB, bookingRecordedKey(msg.phone)),
    );
    if (marker && bookingMarkerLive(marker, nowSec)) {
      recordedBooking = marker;
    } else {
      // No chat-path marker: a website-form booking only shows up as its
      // anti-no-show sequence (armed by syncBookings from the real Airtable
      // record). An upcoming trial date there backs the claim just the same.
      const trialDate = upcomingTrialDateFromReminders(
        await trialReminderRows(env.DB, msg.phone),
        nowSec,
      );
      if (trialDate) recordedBooking = { ts: nowSec, trialDate };
    }
  } catch (err) {
    console.error("[inbound] recordedBooking read failed", msg.phone, err);
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
    justSentWelcome,
    recordedBooking,
    ...(opts?.stale ? { staleReply: opts.stale } : {}),
    ...(opts?.reschedule ? { reschedule: true } : {}),
    ...(opts?.leadCancel ? { leadCancel: opts.leadCancel } : {}),
  };

  const result = await ports.brain.respond(brainCtx);
  // The 8s debounce is check-then-act: two inbound messages a few seconds
  // apart can BOTH pass the newest-wamid check and run overlapping brain turns
  // (2026-08-28, Axel: three replies in 40 seconds). If a newer inbound landed
  // while THIS turn was thinking, the newer turn — which sees the fuller
  // history — owns the reply. Booking turns are exempt: their Airtable record
  // already exists, so the confirmation must still reach the lead.
  if (result.action !== "book") {
    const newestAfter = await newestInboundWamid(env.DB, msg.phone);
    if (newestAfter !== null && newestAfter !== msg.wamid) {
      console.log(`[inbound] turn superseded mid-brain for ${msg.phone}`);
      return;
    }
  }
  // The welcome already said everything: the model asked us to stay quiet.
  // Only honored on a welcome turn, and never for a booking/escalation (those
  // carry side effects a human must see).
  // Also honored on a redrive turn: a lead who only confirmed ("ahí estaré",
  // "gracias") or whose class already happened needs no late reply.
  if (
    (justSentWelcome || opts?.forceReview) &&
    (result.action === "send" || result.action === "draft") &&
    isNoReplySentinel(result.message)
  ) {
    console.log(`[inbound] welcome covered it; no reply for ${msg.phone}`);
    return;
  }
  await routeResult(env, ports, brainCtx, result, history, opts);
}

async function routeResult(
  env: Env,
  ports: Ports,
  ctx: ConvoContext,
  result: BrainResult,
  history: StoredMessage[],
  opts?: BrainTurnOptions,
): Promise<void> {
  // Belt-and-braces sentinel stop (2026-08-27: a lead RECEIVED a literal
  // "<sin_respuesta>"). The welcome-turn early return upstream is the normal
  // path; if a sentinel reaches here through any other route — a retried
  // webhook, a turn where justSentWelcome was lost — silence is what the
  // model asked for, and the literal token must never hit WhatsApp.
  if (
    (result.action === "send" || result.action === "draft") &&
    isNoReplySentinel(result.message)
  ) {
    console.log(`[routeResult] no-reply sentinel suppressed for ${ctx.phone}`);
    return;
  }
  const phone = ctx.phone;

  // Brain-flagged opt-out (escalation_reason / escalate reason "opt_out"): the
  // lead asked us to stop in words the gate-3 patterns missed. Same routine as
  // the gate — status, followups, pending drafts, Airtable «Baja» — and NO
  // reply or draft at all; staff get a one-click undo path.
  const escReason =
    result.action === "escalate" ? result.reason : result.action === "draft" ? result.reason : undefined;
  const escKind = classifyEscalation(escReason);
  if (escKind === "opt_out" && result.action !== "book") {
    await applyOptOut(env, ports, phone, {
      note:
        `🚫 ${phone} pidió no recibir más mensajes (detectado por la IA). Baja aplicada: seguimientos y borradores cancelados, sin respuesta.\n` +
        `¿Fue un error? Deshacer: panel → Chats → ${phone} → Estado «Lead».`,
    });
    return;
  }

  if (result.action === "escalate") {
    // A draft-less row in pending_approvals so the lead is listed in the
    // Aprobar tab with everything else waiting on a human (Evan, 2026-09-28:
    // one place to work through, not Aprobar + "No leídos").
    let escalationId: number | null = null;
    try {
      escalationId = await queueEscalation(env, ports, ctx, history, result.reason, result.summary);
    } catch (err) {
      console.error("[routeResult] queueEscalation failed", phone, err);
    }
    // <!here> — an escalation is action-required (often the HOTTEST leads:
    // "quiero pagar/inscribirme"). Without the ping it drowns in a channel
    // muted to Mentions-only (2026-08-07: enrollment-ready lead dropped 6 h).
    // One open task per phone: a second escalation edits it (no new @here);
    // the timeout cron re-pings at 45 min and DMs the owner after that.
    await escalationTask(
      ports,
      phone,
      escalationId,
      `<!here> ⚠️ Escalar (${phone}): ${result.reason}\n${result.summary}\n_El bot NO respondió nada — este lead espera respuesta humana._`,
    );
    return;
  }

  // Complaint / Nivel 0 / special needs / visitor package: the draft goes to
  // review (never auto-sent, never best-bet for a complaint) AND a human task
  // is opened — the bot must never leave these on "te aviso".
  if (result.action === "draft" && escalationNeedsTask(escKind)) {
    const id = await queueApproval(
      env,
      ports,
      ctx,
      result.message,
      history,
      result.reason,
      false,
      result.awaitingReply ?? true,
      result.confidence,
      escKind === "complaint" ? undefined : result.sureness,
    );
    const label: Record<string, string> = {
      complaint: "Queja / inconformidad",
      nivel0: "Bebé menor de 12 meses (Nivel 0)",
      special_needs: "Necesidades especiales (TDAH/autismo/condición)",
      visitor: "Visitante / paquete por clase",
    };
    await escalationTask(
      ports,
      phone,
      id,
      `<!here> ⚠️ ${label[escKind!] ?? escKind} (${phone}): ${result.reason ?? ""}\nBorrador adjunto en la tarjeta #${id} — revísalo y respóndele tú.`,
    );
    if (result.followup) await scheduleCustomFollowup(env, phone, result.followup);
    return;
  }

  if (result.action === "book") {
    // A booking makes every still-pending approval card stale: those drafts
    // were written BEFORE the booking existed, and approving one later
    // contradicts it (2026-08-25: Mariana was booked for jueves 8 am, then a
    // pre-booking draft went out 43 min later asking her to pick a slot
    // again). queueApproval supersedes its own; this path must too.
    await supersedeStalePending(env, ports, phone);

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
    // ONE confirmation message (owner, 2026-10-16): the brain's text carries
    // the lead's signed /tu-primera-clase/?t= link (its generic link swapped,
    // or added) and the closing paragraph. Done BEFORE queueing, so the
    // approval draft, an edit and the best-bet timeout all send the link.
    // Signing failures keep the generic link — never blocks the confirmation.
    const confirmation = await personalizeBookingConfirmation(env, phone, result.followupMessage, {
      recordId: result.recordId ?? list[0]?.recordId,
      lang: ctx.contact.lang,
    });
    if (ctx.trainingWheels || opts?.forceReview) {
      // Booking confirmation routes through approval; mark it booking-origin so
      // approve/edit fires the booking video after sending (R4). Confidence
      // "high": without wheels this send happens unconditionally, so the audit
      // view must count it as a would-have-auto-sent reply.
      // Sureness mirrors the enum fallback (surenessOf: high ⇒ 85): the booking
      // is already in Airtable, and without wheels this exact text sends
      // unconditionally — so if nobody reviews it within the hour, the best-bet
      // timeout delivers the confirmation instead of leaving the lead hanging.
      await queueApproval(
        env,
        ports,
        ctx,
        confirmation,
        history,
        undefined,
        true,
        !opts?.forceReview,
        "high",
        opts?.forceReview ? undefined : surenessOf(undefined, "high"),
      );
    } else {
      const delivered = await deliverOrDraft(
        env,
        ports,
        ctx,
        confirmation,
        "high",
        history,
        true,
      );
      // Confirmation landed → booking video (R4); the link it carried is
      // stamped on the record (services/cuestionario.afterBookingConfirmed —
      // the separate invite only when the text had no signed link).
      if (delivered) {
        await afterBookingConfirmed(env, phone, {
          recordId: result.recordId,
          sentText: confirmation,
          postNote: (t) => ports.slack.postNote(t),
        });
      }
    }
    return;
  }

  // Persist any custom follow-up the model requested (set_followup).
  if (result.action === "send" || result.action === "draft") {
    if (result.followup) {
      await scheduleCustomFollowup(env, phone, result.followup);
    }
    // The lead told us their real name without booking: replace the push name
    // on the contact and in the CRM (the booking path does the same through
    // book_trial.name). Best-effort — never blocks the reply.
    if (result.leadName && !sameContactName(ctx.contact.name, result.leadName)) {
      try {
        await setContactName(env.DB, phone, result.leadName);
        await syncLead(env, phone, "name_updated", { replaceName: ctx.contact.name });
      } catch (err) {
        console.error("[routeResult] lead name update failed", phone, err);
      }
    }
    // send_reply child_name / child_age_years / preferred / declined days →
    // qualification (merge; a missing age never erases a stated one).
    if (result.qualUpdate) {
      try {
        const fresh = await getContact(env.DB, phone);
        const merged = mergeQualUpdate(parseQualification(fresh ?? ctx.contact), result.qualUpdate);
        if (merged) await setQualification(env.DB, phone, JSON.stringify(merged));
      } catch (err) {
        console.error("[routeResult] qualification update failed", phone, err);
      }
    }
  }

  // Override v2 turn: a staff reply paused the bot and nobody answered the
  // lead's next message for an hour. Direct send only when the model is ≥ 70 %
  // sure (wheels off, no correctness guard), else a draft for review.
  if (opts?.overrideCheck && (result.action === "send" || result.action === "draft")) {
    const route = overrideRouting({
      sureness: result.sureness ?? surenessOf(undefined, result.confidence),
      trainingWheels: ctx.trainingWheels,
      guarded: result.action === "draft" && (result.reason?.includes("⚠️") ?? false),
    });
    if (route === "send") {
      const delivered = await deliverOrDraft(env, ports, ctx, result.message, "high", history);
      if (delivered) await supersedeStalePending(env, ports, phone);
      return;
    }
    await queueApproval(
      env,
      ports,
      ctx,
      result.message,
      history,
      result.action === "draft" ? result.reason : undefined,
      false,
      result.awaitingReply ?? true,
      result.confidence,
      result.sureness,
    );
    return;
  }

  // forceReview (outage redrive): NEVER the direct path, whatever the mode.
  // 2026-10-06 15:03–15:11: the first version only gated the training-wheels
  // paths; the bot was in auto mode and six stale replies went straight out.
  const autoSend =
    result.action === "send" &&
    result.confidence === "high" &&
    !ctx.trainingWheels &&
    !opts?.forceReview;

  if (autoSend) {
    const delivered = await deliverOrDraft(env, ports, ctx, result.message, "high", history);
    // Same staleness rule as the book branch: a reply built from the full
    // conversation just went out, so any older pending card is obsolete.
    // (deliverOrDraft === false means it queued an approval itself, and
    // queueApproval already superseded the older ones.)
    if (delivered) await supersedeStalePending(env, ports, phone);
    return;
  }

  // Gated auto-send lane: with training wheels ON, a reply the model is at least
  // 75% sure of goes straight to the lead instead of waiting for an approval
  // (threshold + remaining gates in services/auto-send.ts). Dead unless the kv
  // switch `auto_send_enabled` is "1". Anything it refuses falls through to the
  // normal approval queue below, where the 1h best-bet timeout can still send
  // it (services/slack-timeouts.ts).
  if (ctx.trainingWheels && !opts?.forceReview) {
    const lane = await evaluateAutoSendLane(env.DB, {
      phone,
      action: result.action,
      confidence: result.confidence,
      sureness: result.sureness,
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
        await supersedeStalePending(env, ports, phone);
        const dailyCount = await getAutoSendCount(env.DB, lane.day);
        // FYI only — never blocks the reply that already landed.
        try {
          await ports.slack.postAutoSentFyi({
            phone,
            name: ctx.contact.name,
            text: result.message,
            dailyCount,
            ...(result.sureness !== undefined ? { sureness: result.sureness } : {}),
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
  // Brain outage alarm: the holding-line draft is what staff see, but the
  // cause (balance, key, Anthropic 5xx) only they can fix. One <!here> per
  // 30 min, atomic kv claim so parallel turns don't all shout.
  if (reason?.startsWith("api_error")) {
    const claimed = await kvClaimIfAbsentOrOlder(env.DB, "brain_outage_alert", Math.floor(Date.now() / 1000), 30 * 60).catch(() => false);
    if (claimed) {
      // Awaited (no ExecutionContext here) — one Slack call every 30 min at most.
      await (
        ports.slack
          .postNote(
            `<!here> 🧠⚠️ El cerebro (Anthropic) está fallando — cada respuesta sale como línea de espera. Causa: ${reason.slice(0, 200)}\n` +
              `Revisa saldo/auto-reload en console.anthropic.com o la API key en Cloudflare. Los leads afectados esperan respuesta humana.`,
          )
          .catch(() => {})
      );
    }
  }
  await queueApproval(
    env,
    ports,
    ctx,
    result.message,
    history,
    reason,
    false,
    opts?.forceReview ? false : (result.awaitingReply ?? true),
    result.confidence,
    opts?.forceReview ? undefined : result.sureness,
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


/**
 * Marks every still-pending approval for `phone` superseded (best-effort).
 * Used by the paths that send WITHOUT queueing — booking confirmations and
 * direct high-sureness sends — where the freshly delivered reply makes any
 * older pending card stale. queueApproval has its own inline version (it
 * additionally links the replacement card id).
 */
async function supersedeStalePending(
  env: Env,
  ports: Ports,
  phone: string,
): Promise<void> {
  try {
    const stale = await getPendingApprovals(env.DB, phone);
    for (const s of stale) {
      try {
        if (await supersedeApproval(env.DB, s.id)) {
          await ports.slack.markSuperseded(s, null);
        }
      } catch (err) {
        console.error("supersede stale approval failed", s.id, err);
      }
    }
  } catch (err) {
    console.error("supersede stale sweep failed", phone, err);
  }
}

/** The last 6 turns as the emoji transcript the approval cards render. */
function approvalContextText(history: StoredMessage[]): string {
  return history
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
}

/**
 * Creates the pending_approvals row and supersedes this phone's older pending
 * cards: they are strictly stale — the new row was built from the FULL
 * conversation. Returns the new row id.
 */
async function createSupersedingApproval(
  env: Env,
  ports: Ports,
  phone: string,
  draft: string,
  contextText: string,
  confidence: "high" | "low",
): Promise<number> {
  const stale = await getPendingApprovals(env.DB, phone);
  const id = await createApproval(env.DB, { phone, draft, context: contextText, confidence });
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
  return id;
}

/**
 * An escalation as a draft-less approval row: the Aprobar tab (and the chat's
 * pending card) shows "necesita respuesta humana · <reason>" with Responder /
 * Descartar. No Slack draft card — the <!here> note already went out, and a
 * card with an Aprobar button on an empty draft would be a trap. No sureness
 * key ⇒ the timeout cron never best-bets it; the 10-min holding line still
 * applies (the lead IS waiting), and it expires like any other card.
 */
async function queueEscalation(
  env: Env,
  ports: Ports,
  ctx: ConvoContext,
  history: StoredMessage[],
  reason: string,
  summary: string,
): Promise<number> {
  const id = await createSupersedingApproval(
    env,
    ports,
    ctx.phone,
    "",
    approvalContextText(history),
    "low",
  );
  const label = summary ? `${reason} — ${summary}` : reason;
  await kvSet(env.DB, escalationKey(id), label.slice(0, 500));
  const kind = classifyEscalation(reason);
  if (kind) await kvSet(env.DB, reasonKindKey(id), kind);
  return id;
}

/**
 * Card hint for a guarded draft that promises a booking nothing backs
 * ("Les apunto el sábado 2 pm" with no book_trial — …6601): approving it
 * opens the «Registrar en Airtable» capture card (booking-guard), which is
 * where the class gets recorded.
 */
function registrarHint(reason: string, draft: string): string {
  if (!reason.includes("⚠️") || !claimsBooking(draft)) return "";
  return "\n👉 Si la clase sí va: aprueba/edita y usa «Registrar en Airtable» en la tarjeta que aparece después (o regístrala desde el panel).";
}

/** Opens/updates the phone's single escalation task (fallback: plain task note). */
async function escalationTask(
  ports: Ports,
  phone: string,
  approvalId: number | null,
  text: string,
): Promise<void> {
  try {
    if (approvalId !== null && ports.slack.postEscalationTask) {
      await ports.slack.postEscalationTask(phone, approvalId, text);
      return;
    }
  } catch (err) {
    console.error("[routeResult] escalation task failed; plain note", phone, err);
  }
  await taskNote(ports.slack, text);
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
  /** Model's 0–100 self-report; drives the card chip + the 1h best-bet timeout. */
  sureness?: number,
): Promise<number> {
  const contextText = approvalContextText(history);
  const id = await createSupersedingApproval(
    env,
    ports,
    ctx.phone,
    draft,
    contextText,
    confidence,
  );
  // Booking-origin marker (kv, keyed by approval id) so the video fires when this
  // draft is approved/edited later. Kept off the stored context column, which is
  // rendered verbatim in Slack + the dashboard.
  if (bookingOrigin) await kvSet(env.DB, bookingApprovalKey(id), "1");
  // Not-waiting marker (kv, like bookingOrigin): timeout cron skips the holding
  // line for closings. Only written when false — missing key = waiting.
  if (!awaitingReply) await kvSet(env.DB, awaitingReplyKey(id), "0");
  // Sureness marker (kv, same side-channel): the Slack card renders it and the
  // timeout cron best-bets on it after an hour. Missing key = unknown ⇒ the
  // draft can only be resolved by a human.
  if (typeof sureness === "number" && Number.isFinite(sureness)) {
    await kvSet(env.DB, surenessKey(id), String(Math.round(sureness)));
  }
  // Guarded marker: the brain's correctness guards prefix their reason with
  // "⚠️" (unbacked booking claim / slot that isn't on the grid). `includes`, not
  // `startsWith`: guardUnverifiedSlotClaim appends its warning to an existing
  // escalation reason. Such a draft NEVER best-bets — a human fixes it or it
  // expires.
  if (reason?.includes("⚠️")) await kvSet(env.DB, guardedApprovalKey(id), "1");
  // Reason bucket (complaint / opt_out / price / …): the timeout cron never
  // best-bets a complaint, opt-out or price negotiation, and never sends the
  // holding line on a complaint/opt-out.
  const kind = classifyEscalation(reason);
  if (kind) await kvSet(env.DB, reasonKindKey(id), kind);
  const slackTs = await ports.slack.postDraft({
    id,
    phone: ctx.phone,
    ...(typeof sureness === "number" && Number.isFinite(sureness)
      ? { sureness: Math.round(sureness) }
      : {}),
    draft,
    context: contextText,
    confidence,
    slack_ts: null,
    status: "pending",
    holding_sent: 0,
    created_at: Math.floor(Date.now() / 1000),
    resolved_at: null,
    final_text: null,
    contextText: reason
      ? `${reason}${registrarHint(reason, draft)}\n\n${contextText}`
      : contextText,
  });
  await setApprovalSlackTs(env.DB, id, slackTs);
  return id;
}

/**
 * Gate 3a: relays the site's answer to a Reto course-login request. The member
 * just wrote, so the window is open; a failure only costs a Slack ops note.
 */
async function handleRetoLogin(env: Env, ports: Ports, phone: string): Promise<void> {
  const res = await requestRetoLogin(env, phone);
  try {
    await sendText(env, phone, res.reply);
  } catch (err) {
    if (!(err instanceof WindowClosedError)) {
      console.error("[inbound] reto login reply failed", phone, err);
      await ports.slack.postNote(`🎓 Login de cursos del Reto: no pude responderle a ${phone} (${String(err)}).`);
      return;
    }
  }
  if (res.error || !res.ok) {
    await ports.slack.postNote(`🎓 Login de cursos del Reto: el sitio falló para ${phone} (${res.error ?? "respuesta sin texto"}). Le mandé el mensaje de respaldo.`);
  } else if (res.member === false) {
    await ports.slack.postNote(`🎓 ${phone} pidió entrar a los cursos del Reto pero su número no tiene la etiqueta \`fundamentos\` en Airtable (Alumnos). Si ya pagó el Reto, agrégala.`);
  }
}

/**
 * The one opt-out routine (gate 3 and the brain's `opt_out` escalation):
 * status opted_out, followups + pending drafts cancelled, Airtable «Baja» tag,
 * Slack note. CRM flag + note go out BEFORE any confirmation send so the baja
 * is visible to the team even if that send fails.
 */
async function applyOptOut(
  env: Env,
  ports: Ports,
  phone: string,
  opts: { note: string; waitUntil?: (p: Promise<unknown>) => void },
): Promise<void> {
  await setContactStatus(env.DB, phone, "opted_out");
  await cancelFollowups(env.DB, phone, "skipped_optout");
  // A draft queued before the baja must not stay approvable in Slack/panel.
  await cancelPendingApprovals(env.DB, phone, "discarded");
  const flag = flagOptOutInAirtable(env, phone).catch((err) =>
    console.error("[inbound] Airtable opt-out flag failed", phone, err),
  );
  if (opts.waitUntil) opts.waitUntil(flag);
  else await flag;
  await ports.slack.postNote(opts.note);
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

/** Case/space-insensitive: is the stated name already the contact's name? */
function sameContactName(current: string | null, stated: string): boolean {
  const norm = (v: string | null): string =>
    (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(current) === norm(stated);
}
