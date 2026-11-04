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

/**
 * Follow-up / nudge copy. Placeholders: {who} → " Nombre" or "", {address},
 * {link}, and {cta} → the closing call-to-action the engine builds from the
 * real schedule ("Te puedo apartar lugar en Muay Thai mañana viernes 7:00 am —
 * ¿te late? Si prefieres otro horario: <link>"), which degrades to a plain link
 * line when the grid has no slot to offer.
 */
export interface ClientCopy {
  /** Booking confirmation (kind: trial_confirm). Uses {who} and {address}. */
  confirmEs: string;
  confirmEn: string;
  /** Generic check-in when a custom followup has no note. */
  checkinEs: string;
  checkinEn: string;
  /** Result-watcher: no-show reschedule, sent on marking. Uses {who} and {cta}. */
  noShowEs: string;
  noShowEn: string;
  /** Second no-show touch (kind: no_show_d3), ~3 days later. Uses {who} and {cta}. */
  noShowD3Es: string;
  noShowD3En: string;
  /** Result-watcher: enrolled welcome. Uses {who} and {link}. */
  welcomeEs: string;
  welcomeEn: string;
  /**
   * Post-trial sequence for a lead who attended and did not sign up
   * (kinds: post_trial_d0 / d2 / d5). d0+d2 use {who}; d5 also uses {link}
   * (the public schedule).
   */
  postTrialD0Es: string;
  postTrialD0En: string;
  /** d0 variant when it lands the day AFTER the class ("verte ayer"). */
  postTrialD0AyerEs: string;
  postTrialD0AyerEn: string;
  postTrialD2Es: string;
  postTrialD2En: string;
  postTrialD5Es: string;
  postTrialD5En: string;
  /**
   * v2 chains (src/cron/post-trial.ts, 2026-10-11). Optional: a client without
   * them falls back to the v1 lines. `Kids` = plural copy to a parent (mini /
   * kids / teens); `Baby` = plural to a parent who takes the class WITH the
   * baby (Baby Fight Club — never "tu cuerpo" or "what did the baby think"). Extra placeholders, filled by post-trial.ts:
   * {day} → "hoy" / "ayer" / "el sábado" (computed at send time) and
   * {kid} → the child's name or "su peque" / "su bebé".
   */
  noShowHoyEs?: string;
  noShowHoyEn?: string;
  noShowHoyKidsEs?: string;
  noShowHoyBabyEs?: string;
  noShowHoyKidsEn?: string;
  noShowHoyBabyEn?: string;
  noShowD2Es?: string;
  noShowD2En?: string;
  noShowD2KidsEs?: string;
  noShowD2BabyEs?: string;
  noShowD2KidsEn?: string;
  noShowD2BabyEn?: string;
  noShowD7Es?: string;
  noShowD7En?: string;
  noShowD7KidsEs?: string;
  noShowD7BabyEs?: string;
  noShowD7KidsEn?: string;
  noShowD7BabyEn?: string;
  postTrialD0KidsEs?: string;
  postTrialD0BabyEs?: string;
  postTrialD0KidsEn?: string;
  postTrialD0BabyEn?: string;
  postTrialD3Es?: string;
  postTrialD3En?: string;
  postTrialD3KidsEs?: string;
  postTrialD3BabyEs?: string;
  postTrialD3KidsEn?: string;
  postTrialD3BabyEn?: string;
  postTrialD6Es?: string;
  postTrialD6En?: string;
  postTrialD6KidsEs?: string;
  postTrialD6BabyEs?: string;
  postTrialD6KidsEn?: string;
  postTrialD6BabyEn?: string;
  /**
   * Student kit after "Se inscribió" (src/cron/student-kit.ts): the check-in QR
   * caption, and the responsiva nudge ({link} = the Alumno's signing link).
   * Optional: a client without them never schedules the kit.
   */
  studentQrEs?: string;
  studentQrEn?: string;
  studentResponsivaEs?: string;
  studentResponsivaEn?: string;
  /**
   * "¿Cómo nos encontraste?" (src/services/origin-question.ts): asked once, a
   * few minutes after the booking confirmation, to leads with no ad / Google
   * click / campaign. Numbered options in ORIGIN_OPTIONS order (Anuncio, Post
   * orgánico, Google Maps, Google, Referido, Local). Optional: a client
   * without it never asks.
   */
  originQuestionEs?: string;
  originQuestionEn?: string;
  /**
   * Pre-trial questionnaire invite (src/services/cuestionario.ts), sent right
   * after a booking confirmation. Placeholders: {who} → " Nombre" or "",
   * {cuando} → " el jueves 16 de octubre a las 7:00 PM" or "" (no date on the
   * record), {kid} → the child's name or "tu peque", {link} → the tokenized
   * mdcondesa.com/cuestionario/ link. Kids = kids/teens/mini; Bfc = baby.
   * Optional: a client without them never sends the questionnaire.
   */
  cuestionarioEs?: string;
  cuestionarioEn?: string;
  cuestionarioKidsEs?: string;
  cuestionarioKidsEn?: string;
  cuestionarioBfcEs?: string;
  cuestionarioBfcEn?: string;
  /**
   * THE trial-booking confirmation (docs/cuestionario.md, owner copy
   * 2026-10-16): one text with the personalized /tu-primera-clase/ link, then
   * the booking video. Same placeholders as cuestionario* ({cuando} → " el
   * jueves 16 de octubre a las 7:00 PM" / " on Friday, October 16 at 7:00 PM";
   * {link} → the signed first-class page). The closing paragraph
   * (confirmClosing*) is appended after a blank line by the code — and to the
   * brain's own confirmation when it lacks it. Closed window → the
   * primera_clase* Utility templates generated from these (docs/templates.md §20).
   */
  primeraClaseEs?: string;
  primeraClaseEn?: string;
  primeraClaseKidsEs?: string;
  primeraClaseKidsEn?: string;
  primeraClaseBfcEs?: string;
  primeraClaseBfcEn?: string;
  confirmClosingEs?: string;
  confirmClosingEn?: string;
  /**
   * Day-before reminder (free-form path only) when the lead's questionnaire
   * gave a `Motivo principal` / `Meta 6 meses`. Placeholders: {who},
   * {hora} ("7:00 PM"), {motivo} (lowercased, no final period). Optional:
   * absent ⇒ the generic reminder.
   */
  reminderMotivoEs?: string;
  reminderMotivoEn?: string;
  /** Kids/bfc twin of reminderMotivo (to the parent): also {kid}. */
  reminderMotivoKidsEs?: string;
  reminderMotivoKidsEn?: string;
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
  /** Conversions API for Business Messaging: downstream funnel events (booked /
   *  attended / purchase) sent back to Meta for ctwa_clid leads
   *  (docs/meta-capi.md). Also requires env.META_CAPI_DATASET_ID. Absent = off. */
  metaCapi?: boolean;
  /** Customer-list custom audiences (paid / active students from Airtable)
   *  synced daily to the ad account (docs/meta-audiences.md). Absent = off. */
  metaAudiences?: boolean;
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
  /** Formula column resolving who actually trains (child if set, else the
   *  lead), e.g. "Quién entrena". Read by the Agenda tab; absent ⇒ the worker
   *  derives it from childName/name. */
  whoTrains?: string;
  /** Formula column with the pre-trial questionnaire state as staff see it in
   *  Airtable (⏳ pending / ✅ completed), e.g. "Respuestas cuestionario".
   *  Read-only, Agenda tab. */
  cuestionarioStatus?: string;
  /** "Se inscribió" checkbox (enrolment). Read-only, Agenda tab. */
  enrolled?: string;
  /** Amount the lead paid when they enrolled, e.g. "Pago Inicial". Read-only:
   *  the worker never writes it. Used as the Purchase value sent to Meta
   *  (docs/meta-capi.md). Absent/blank column ⇒ Purchase without value. */
  initialPayment?: string;
  /** Click-to-WhatsApp click id column, e.g. "CTWA Click ID". Written
   *  fill-if-empty from contacts.ad_ref (docs/meta-capi.md). Absent = not synced. */
  ctwaClid?: string;
  /** Google Ads click id column, e.g. "gclid" (gbraid/wbraid as "gbraid:<id>").
   *  The site's booking forms prefill it; the bot writes it fill-if-empty from
   *  the WhatsApp prefill ref (src/services/google-click.ts). Absent = not synced. */
  gclid?: string;
  /** Free-text "how did you find us" column, e.g. "Cómo nos encontró". The
   *  origin question writes the lead's raw answer here fill-if-empty (the
   *  classified value goes to `source`). Absent = raw answer not stored. */
  howFound?: string;
  /** Click time of `gclid`, ISO with the CDMX offset, e.g. "gclid_time".
   *  Written only together with `gclid`. */
  gclidTime?: string;
  /** Lifetime revenue of the lead (rollup of the linked student's payments),
   *  e.g. "Ingresos Lead". Read-only: the Purchase value sent to Meta. */
  leadIncome?: string;
  /** Multi-select the CAPI drain marks after Meta accepts an event, e.g.
   *  "Eventos Meta Enviados" with options Agendó / Asistió / Compró. */
  metaEventsSent?: string;
  /** Option names inside `metaEventsSent` per funnel step. Defaults to
   *  Agendó / Asistió / Compró. */
  metaEventsSentValues?: { booked: string; attended: string; purchase: string };
  /** 0/1 formula columns the CAPI sweep reads: booked ("Agendó"), attended
   *  ("Asistió"), closed ("Cerró"). All three required for the sweep to run. */
  booked?: string;
  attended?: string;
  closed?: string;
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
    /** Audience sync (docs/meta-audiences.md): email column, Status single
     *  select, the 0/1 "currently active" formula and the statuses that are
     *  not customers (staff, seminar-only, paid visitors). Optional: absent ⇒
     *  the audience sync refuses to run. */
    email?: string;
    status?: string;
    activeFlag?: string;
    excludedStatuses?: string[];
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

/**
 * An hour range the business PREFERS to receive trials in — typically when the
 * owner is on the floor to close. Never a restriction: it only breaks ties
 * between two classes that fall inside the same 24h (see next-slot.ts).
 */
export interface PreferredBlock {
  /** 0=Mon … 6=Sun — the SLOTS convention, not JS getDay(). */
  dow: number;
  /** Inclusive earliest class START time, "HH:mm" 24h CDMX. */
  from: string;
  /** Inclusive latest class START time, "HH:mm" 24h CDMX. */
  to: string;
}

/** Trial-offer tuning. Absent / empty ⇒ pure soonest-first (the default). */
export interface BookingConfig {
  /** Tie-breaker blocks; EMPTY by default. Order is irrelevant. */
  preferredBlocks: PreferredBlock[];
}

/**
 * What Meta charges the client per delivered template message (per-message
 * pricing since 2025-07-01), for the ONE market the client sends to. Used only
 * to estimate the cost of bulk sends in the dashboard (src/services/blast-cost.ts)
 * — never to decide whether to send. Copy the numbers from Meta's published
 * rate card for the WABA's currency; never invent them.
 */
export interface WhatsAppPricing {
  /** ISO currency of the rates below, e.g. "USD". */
  currency: string;
  /** Marketing template rate per message. */
  marketing: number;
  /** Utility template rate per message. */
  utility: number;
  /** Rate card the numbers came from, "YYYY-MM" (Meta updates quarterly). */
  asOf: string;
  /** URL of that rate card, so the next person can re-check it. */
  source: string;
  /** True when the numbers could NOT be verified against Meta's own rate card
   *  (the UI then says "estimado" louder). Absent = verified. */
  unverified?: boolean;
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
    /** New-member guide page (enrolment welcome). Falls back to `schedule`. */
    welcome?: string;
    /** Members' WhatsApp group invite (enrolment welcome, {group}). */
    group?: string;
  };
  /** Bookable services. Empty when features.booking is false. */
  services: ServiceDef[];
  /** Days the business is closed (CDMX "YYYY-MM-DD"): no slots proposed, no
   *  bookings accepted, and the brain is told in the per-turn context. */
  closedDates?: ClosedDate[];
  /** Trial-offer tuning (preferred blocks). Absent ⇒ pure soonest-first. */
  booking?: BookingConfig;
  /** Full persona + hard-policies system-prompt text (from persona.md). */
  persona: string;
  features: ClientFeatures;
  /** Required when features.safety is true. */
  safety?: SafetyConfig;
  /** Real Leads-table column names; unset keys use the English defaults. */
  airtableLeads?: Partial<AirtableLeadsMap>;
  /** Marketing-metrics table/column names (required when features.marketingMetrics). */
  airtableMetrics?: AirtableMetricsMap;
  /** Meta's per-message rate card for this client's market (blast cost estimates).
   *  Absent ⇒ the dashboard shows message counts but no money. */
  whatsappPricing?: WhatsAppPricing;
  /** Names of the customer-list audiences the daily sync maintains
   *  (docs/meta-audiences.md). Required when features.metaAudiences. */
  metaAudiences?: MetaAudiencesConfig;
  copy: ClientCopy;
}

/** Custom-audience names on the client's ad account (created when missing). */
export interface MetaAudiencesConfig {
  /** Everyone who ever paid (Total Pagado > 0, minus excluded statuses). */
  paid: string;
  /** Currently active members (activeFlag = 1), for exclusion targeting. */
  active: string;
}

/** Interpolate {who}/{address}/{link}/{cta} placeholders in copy strings. */
export function renderCopy(
  template: string,
  vars: { who?: string; address?: string; link?: string; cta?: string; group?: string },
): string {
  return template
    .replaceAll("{who}", vars.who ?? "")
    .replaceAll("{address}", vars.address ?? "")
    .replaceAll("{link}", vars.link ?? "")
    .replaceAll("{cta}", vars.cta ?? "")
    .replaceAll("{group}", vars.group ?? "");
}
