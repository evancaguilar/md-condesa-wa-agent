// Shared contract for all workstreams (A–E). B/C/D implement against the
// port interfaces at the bottom; do not add runtime logic here.

/**
 * Minimal Workers AI binding surface. The pinned @cloudflare/workers-types does
 * not ship an `Ai` type, so we declare just the `run` method the media/whisper
 * path uses. Kept local to avoid a types-package bump.
 */
export interface Ai {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Worker bindings, secrets, and vars. Mirrors wrangler.jsonc + `wrangler secret`. */
export interface Env {
  // Bindings
  DB: D1Database;
  /** Workers AI (Whisper transcription). Optional so local/sandbox runs skip it. */
  AI?: Ai;

  // Secrets
  META_APP_SECRET: string;
  WA_ACCESS_TOKEN: string;
  WA_PHONE_NUMBER_ID: string;
  WA_VERIFY_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  AIRTABLE_PAT: string;

  // Vars
  SLACK_CHANNEL_ID: string;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TRIALS_TABLE: string;
  /** Airtable field holding the trial-class outcome. Defaults in code to
   *  "Resultado clase prueba" when unset. */
  AIRTABLE_RESULT_FIELD?: string;
  TRAINING_WHEELS: string; // "1" forces approval; "0" allows auto-send
  HUMAN_SNOOZE_HOURS: string; // stringified integer, default "8"
  /** Booking-confirmation video URL. Defaults in code (DEFAULT_BOOKING_VIDEO_URL). */
  BOOKING_VIDEO_URL?: string;

  // Admin dashboard secret (Cloudflare secret; auth for /admin)
  ADMIN_PASSWORD: string;
}

export type Language = "es" | "en";
export type Audience = "kid" | "adult";
export type ContactStatus = "lead" | "student" | "opted_out";

/** Parsed shape of contacts.qualification JSON. */
export interface Qualification {
  name?: string;
  discipline?: string;
  audience?: Audience;
  goal?: string;
}

/** Row of the `contacts` table. Epoch fields are seconds. */
export interface Contact {
  phone: string; // digits only, e.g. 5215512345678
  name: string | null;
  lang: Language;
  status: ContactStatus;
  qualification: string | null; // JSON (see Qualification)
  human_override_until: number | null;
  last_inbound_at: number | null;
  campaign_id: number | null; // FK-ish → campaigns.id; the campaign the lead arrived through
  /** JSON click-to-WhatsApp ad referral captured on first inbound (see AdRef). */
  ad_ref: string | null;
  created_at: number;
  updated_at: number;
}

/** Parsed shape of contacts.ad_ref JSON — a Meta click-to-WhatsApp referral. */
export interface AdRef {
  sourceId: string | null; // referral.source_id (the ad id)
  headline: string | null;
  body: string | null;
  sourceUrl: string | null;
  ctwaClid: string | null;
}

// ---- Admin dashboard: knowledge-base overlay + campaigns ----

/** A live-editable overlay section layered on top of the compiled KB base. */
export interface KbSection {
  id: number;
  title: string;
  content: string;
  sort: number;
  enabled: number; // 0 | 1
  created_at: number;
  updated_at: number;
}

/** Audit row for every overlay change (manual dashboard edit or chat proposal). */
export interface KbRevision {
  id: number;
  section_id: number | null;
  action: "create" | "update" | "delete" | "revert";
  title: string;
  content: string | null; // after (NULL on delete)
  prev_content: string | null; // before (NULL on create)
  reason: string | null;
  source: "manual" | "chat";
  created_at: number;
}

/** An ad/promo campaign; leads whose first message matches its trigger are tagged. */
export interface Campaign {
  id: number;
  name: string;
  trigger_phrase: string;
  trigger_norm: string; // normalized (diacritic-stripped, lowercased) for matching
  info: string; // extra knowledge fed to the brain for this campaign's leads
  status: "active" | "paused" | "ended";
  ends_at: number | null; // epoch seconds; null = no end date
  /** Meta ad id: leads whose referral.source_id matches auto-attach (ad_id > phrase). */
  ad_id: string | null;
  created_at: number;
  updated_at: number;
}

export type MessageDirection = "in" | "out_bot" | "out_human_echo";

/** Row of the `messages` table. */
export interface StoredMessage {
  wamid: string;
  phone: string;
  direction: MessageDirection;
  body: string;
  ts: number; // epoch seconds
  meta: string | null; // JSON
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "edited"
  | "taken_over"
  | "expired"
  | "discarded";

export type Confidence = "high" | "low";

/** Row of the `pending_approvals` table. */
export interface PendingApproval {
  id: number;
  phone: string;
  draft: string;
  context: string | null;
  confidence: Confidence;
  slack_ts: string | null;
  status: ApprovalStatus;
  holding_sent: number; // 0 | 1
  created_at: number;
  resolved_at: number | null;
  final_text: string | null;
}

export type FollowupKind =
  | "trial_confirm"
  | "day_before"
  | "same_day"
  | "attendance_check"
  | "no_show_1"
  | "reengage_7d"
  | "nudge_1h"
  | "nudge_6h"
  | "nudge_8h"
  | "nudge_d2"
  | "nudge_d3"
  | "nudge_d4"
  | "nudge_d5"
  | "custom";

export type FollowupStatus = "scheduled" | "sent" | "cancelled" | "skipped_optout";

/** Row of the `followups` table. */
export interface Followup {
  id: number;
  phone: string;
  kind: FollowupKind;
  due_at: number; // epoch seconds
  status: FollowupStatus;
  airtable_record_id: string | null;
  note: string | null;
  created_at: number;
}

/** Everything the brain needs for one turn. Assembled by the inbound pipeline. */
export interface ConvoContext {
  phone: string;
  contact: Contact;
  history: StoredMessage[]; // oldest → newest, already capped
  nowCdmx: string; // ISO 8601 in America/Mexico_City
  weekday: string; // e.g. "lunes" / "Monday" — lets the model resolve relative dates
  windowOpen: boolean; // true if within the 24h customer-service window
  trainingWheels: boolean; // true ⇒ every reply routes through approval
  campaign?: { name: string; info: string }; // present when the lead arrived via a campaign
}

/** Input to AirtablePort.bookTrial (also emitted inside a 'book' BrainResult). */
export interface BookTrialInput {
  name: string;
  discipline: string;
  audience: Audience;
  trialDate: string; // YYYY-MM-DD (America/Mexico_City)
  trialTime: string; // HH:mm 24h (America/Mexico_City)
  phone: string;
  /** "headline (id)" string from the contact's ad_ref, when the lead came via an ad. */
  ad?: string;
}

/** A custom follow-up the model asked to schedule (set_followup tool). The
 *  pipeline persists this as a `kind:'custom'` followup row. */
export interface FollowupRequest {
  hoursFromNow: number;
  note: string;
}

/**
 * Discriminated union returned by the brain, mirroring the model tools in the
 * spec (send_reply / book_trial / escalate_to_human / set_followup).
 *
 * `followup` rides on send/draft results: the brain acknowledges set_followup so
 * the model still ends with send_reply, and the pipeline persists the request.
 */
export type BrainResult =
  | {
      action: "send";
      message: string;
      language: Language;
      confidence: Confidence;
      followup?: FollowupRequest;
    }
  | {
      action: "draft";
      message: string;
      language: Language;
      confidence: Confidence;
      reason?: string;
      followup?: FollowupRequest;
    }
  | { action: "escalate"; reason: string; summary: string }
  | ({
      action: "book";
      followupMessage: string;
      /** Airtable record id from bookTrial — keys the anti-no-show sequence. */
      recordId: string;
    } & BookTrialInput);

// ---- Ports (stable interfaces B/C/D implement against) ----

export interface BrainPort {
  respond(ctx: ConvoContext): Promise<BrainResult>;
}

export interface SlackPort {
  /** Posts a draft-approval card; returns the Slack message ts. */
  postDraft(a: PendingApproval & { contextText: string }): Promise<string>;
  /** Posts a plain informational note to the channel. */
  postNote(text: string): Promise<void>;
  /** FYI card posted whenever book_trial fires (spec: always ALSO to Slack). */
  postBookingFyi(booking: BookTrialInput): Promise<void>;
}

export interface AirtablePort {
  /** Creates a trial record (Source=WhatsApp); returns the Airtable record id. */
  bookTrial(input: BookTrialInput): Promise<string>;
}

/** Ports bundle injected into the inbound pipeline. */
export interface Ports {
  brain: BrainPort;
  slack: SlackPort;
  airtable: AirtablePort;
}
