// Client (business) configuration contract. Everything business-specific that
// the engine needs at runtime lives behind this type; the concrete object is
// GENERATED into src/client.gen.ts by tools/compile-kb.mjs from
// clients/<id>/client.mjs + persona.md. Engine code imports { CLIENT } from
// "./client.gen.js" and must never hardcode business facts.
//
// Pure types only — no runtime logic here.

/** A bookable service/discipline (MD Condesa: jiu, muay, mma, box, baby). */
export interface ServiceDef {
  /** Compact key the model emits and the schedule slots use (e.g. "jiu"). */
  key: string;
  /** Human label (e.g. "Jiu-Jitsu"). */
  label: string;
  /**
   * Regex source (case-insensitive) mapping free-form labels the model might
   * emit to `key` (e.g. "jiu|bjj|jitsu|grappl"). Optional — without it only an
   * exact key match normalizes.
   */
  match?: string;
}

/**
 * Crisis-safety gate config (features.safety). A deterministic pre-brain layer:
 * when an inbound matches any pattern, the bot answers ONLY with the configured
 * containment message (with real crisis resources), pauses itself for the
 * conversation, and escalates to a human. Never rely on the persona prompt
 * alone for this.
 */
export interface SafetyConfig {
  /** Regex sources, matched case/diacritic-insensitively against the inbound. */
  patterns: string[];
  /** Containment reply (es / en). Must include real, local crisis resources. */
  responseEs: string;
  responseEn: string;
  /** Hours the bot stays paused for the conversation after a match. */
  pauseHours: number;
}

/** Follow-up / nudge copy. Placeholders: {who} → " Nombre" or "", {address}, {link}. */
export interface ClientCopy {
  /** Booking confirmation (kind: trial_confirm). Uses {who} and {address}. */
  confirmEs: string;
  confirmEn: string;
  /** Generic check-in when a custom followup has no note. */
  checkinEs: string;
  checkinEn: string;
  /** Result-watcher: no-show reschedule. Uses {who} and {link}. */
  noShowEs: string;
  noShowEn: string;
  /** Result-watcher: enrolled welcome. Uses {who} and {link}. */
  welcomeEs: string;
  welcomeEn: string;
}

export interface ClientFeatures {
  /** book_trial tool + slot validation + Airtable record creation. */
  booking: boolean;
  /** Lead-nudge drip (nudge_1h/6h/8h). */
  nudges: boolean;
  /** Cron Airtable syncs (bookings + result watcher + daily students). */
  airtableSync: boolean;
  /** Crisis-safety gate (see SafetyConfig). */
  safety: boolean;
  /** Instagram DM channel (Meta Messenger Platform). Optional: absent = off. */
  instagram?: boolean;
  /** Facebook Messenger channel. Optional: absent = off. */
  messenger?: boolean;
  /** Marketing-funnel metrics feeder (Meta spend import, lead/student link
   *  sweeps, daily Slack brief). Requires `airtableMetrics`. Optional: absent = off. */
  marketingMetrics?: boolean;
}

/**
 * Column names + value maps for the client's REAL Airtable Leads table, so the
 * engine adapts to an existing CRM instead of imposing English field names.
 * Every property is optional in client.mjs; unset ones fall back to the legacy
 * English defaults in services/airtable.ts (DEFAULT_LEADS_MAP).
 */
export interface AirtableLeadsMap {
  /** Phone column. Rows may hold any format; lookup matches the last 10 digits. */
  phone: string;
  name: string;
  source: string;
  /** Value written to `source` for bot-originated leads (fill-if-empty). */
  sourceValue: string;
  /** `source` value for Instagram-DM leads (defaults to "IG" in code). */
  sourceValueIg?: string;
  /** `source` value for Facebook-Messenger leads (defaults to "FB" in code). */
  sourceValueFb?: string;
  ad: string;
  campaign: string;
  trialDateTime: string;
  discipline: string;
  /** True when `discipline` is a multipleSelects column (values sent as arrays). */
  disciplineIsMulti: boolean;
  audience: string;
  /** Trial-outcome column watched by the result cron (env-overridable). */
  result: string;
  /** service key (or "<key>:kid") → select option name, e.g. jiu→"BJJ". */
  disciplineValues: Record<string, string>;
  /** "adult" | "kid" | "baby" → select option name, e.g. adult→"Adultos". */
  audienceValues: Record<string, string>;
  /** Multi-select column used to tag leads (e.g. opt-out), e.g. "Tags". */
  tags: string;
  /** Value added to `tags` when a lead opts out, e.g. "Baja". */
  optOutTag: string;
  /** Child-name column for kid/baby bookings, e.g. "Nombre Del Niñ@". */
  childName: string;
  /** Sales-conversation recordings (src/cron/sales-audio.ts). Absent = feature off. */
  salesAudio?: {
    /** Attachment column staff upload the recording to. */
    audio: string;
    transcript: string;
    summary: string;
    /** Technical column: processed attachment ids, "procesando…", or the last error. */
    processed: string;
  };
}

/**
 * Table + column names of the marketing-metrics contract in the client's
 * Airtable base (see docs/marketing-metrics.md). Airtable does the math
 * (rollups/formulas); the worker only writes spend rows + link fields and reads
 * the period rollups for the Slack brief. Every name lives here so a rename in
 * the base is a config change, never a code change.
 */
export interface AirtableMetricsMap {
  tables: {
    spend: string;
    ads: string;
    campaigns: string;
    days: string;
    months: string;
    students: string;
    movements: string;
  };
  /** Ad Spend Diario columns (one row per ad per day; upsert key = `key`). */
  spend: {
    key: string;
    date: string;
    account: string;
    adId: string;
    adName: string;
    adSetName: string;
    adSetId: string;
    campaignId: string;
    campaignName: string;
    spend: string;
    impressions: string;
    clicks: string;
    reach: string;
    conversations: string;
    updated: string;
    adLink: string;
    campaignLink: string;
    dayLink: string;
    monthLink: string;
  };
  ads: { adId: string; name: string; adSet: string; campaignLink: string };
  campaigns: { campaignId: string; name: string };
  /** Leads columns the sweeps read (formulas) and write (links). */
  leads: {
    created: string;
    dayText: string;
    monthText: string;
    adId: string;
    dayLink: string;
    monthLink: string;
    adLink: string;
    pendingAttendance: string;
    /** 0/1 strict-close formula and the Origen formula ("Desconocido" = no evidence). */
    closed: string;
    origin: string;
    originUnknown: string;
  };
  /** Alumnos columns for the student↔lead linker + exceptions. */
  students: {
    name: string;
    phone: string;
    leadLink: string;
    created: string;
    totalPaid: string;
    eligibleIncome: string;
  };
  /** Movimientos columns for the exceptions counts. */
  movements: {
    date: string;
    concept: string;
    type: string;
    typeIncome: string;
    conceptSurplus: string;
    studentLink: string;
  };
  /** Rollup/formula names shared by Días and Meses (read for the brief). */
  periods: {
    /** Primary field of Días / Meses (the key the worker links by). */
    dayKey: string;
    monthKey: string;
    spend: string;
    conversations: string;
    leads: string;
    paidLeads: string;
    unknownLeads: string;
    booked: string;
    pastTrials: string;
    showed: string;
    pending: string;
    closed: string;
    closedAfterTrial: string;
    directCloses: string;
    marked: string;
    revenue: string;
    revenue90: string;
    cpl: string;
    costPerBooking: string;
    costPerShow: string;
    costPerClose: string;
    showRate: string;
    closeRate: string;
    roas: string;
    roas90: string;
    /** Meses only. */
    provisional: string;
  };
}

export interface ClosedDate {
  /** CDMX calendar date, "YYYY-MM-DD". */
  date: string;
  /** Shown to the brain ("Día de la Independencia"). */
  reason?: string;
}

export interface ClientConfig {
  /** Folder name under clients/ (e.g. "md-condesa", "iasmin"). */
  clientId: string;
  /** Full business name (e.g. "MD Self Defense Academy Condesa"). */
  businessName: string;
  /** Short name for Slack labels and check-in copy (e.g. "MD Condesa"). */
  shortName: string;
  /** Owner's first name — used by the KB-editor assistant prompt. */
  ownerName: string;
  /** Street address used in confirmation copy ("" if not applicable). */
  address: string;
  links: {
    /** Self-serve booking link (adults / default). "" if not applicable. */
    booking: string;
    /** Kids booking link; falls back to `booking`. */
    bookingKids?: string;
    /** Public schedule link; falls back to `booking`. */
    schedule?: string;
  };
  /** Bookable services. Empty when features.booking is false. */
  services: ServiceDef[];
  /** Days the business is closed (CDMX "YYYY-MM-DD"): no slots proposed, no
   *  bookings accepted, and the brain is told in the per-turn context. */
  closedDates?: ClosedDate[];
  /** Full persona + hard-policies system-prompt text (from persona.md). */
  persona: string;
  features: ClientFeatures;
  /** Required when features.safety is true. */
  safety?: SafetyConfig;
  /** Real Leads-table column names; unset keys use the English defaults. */
  airtableLeads?: Partial<AirtableLeadsMap>;
  /** Marketing-metrics table/column names (required when features.marketingMetrics). */
  airtableMetrics?: AirtableMetricsMap;
  copy: ClientCopy;
}

/** Interpolate {who}/{address}/{link} placeholders in copy strings. */
export function renderCopy(
  template: string,
  vars: { who?: string; address?: string; link?: string },
): string {
  return template
    .replaceAll("{who}", vars.who ?? "")
    .replaceAll("{address}", vars.address ?? "")
    .replaceAll("{link}", vars.link ?? "");
}
