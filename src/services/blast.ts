// One-off template blasts (owner-requested 2026-08-28): invite every lead of
// a program who never booked to an upcoming class, via APPROVED Meta
// templates. Flow is deliberately three-step and owner-gated:
//   1. preview  — counts + samples per group, NO sends.
//   2. test     — ONE template send to a phone the owner names (smoke-tests
//                 template name / language code / variable count).
//   3. queue    — inserts `blast` followup rows the 5-min cron drains, paced
//                 (BATCH_PER_TICK per tick) and capped per day (Meta tier).
// Hard rule upstream: never bulk-send without Evan's explicit OK — the queue
// endpoint requires {confirm:true} and an owner session.
//
// Template naming gotcha (Meta account, 2026-08-28): `adult_follow_up` =
// ADULTS, `adults_bjj_muay_thai` = KIDS (misnamed on creation), `bebe` =
// BABIES. The dashboard payload spells the mapping out; nothing is inferred
// from the template name.

import type { Contact, Env } from "../types.js";
import { classifyProgram, type Program } from "../cron/nudge-copy.js";
import { kvSetIfAbsent, scheduleFollowup } from "../db/queries.js";
import { cdmxParts, cdmxToEpoch } from "../cron/time.js";

/** Booking-evidence kinds: any row of these means the lead DID book at some point. */
const BOOKED_KINDS = ["trial_confirm", "day_before", "same_day", "attendance_check"] as const;

/** Sends released per 5-min cron tick (pacing, not a correctness limit). */
export const BATCH_PER_TICK = 50;
/** Default per-24h cap — matches Meta's lowest business-initiated tier. */
export const DEFAULT_DAILY_CAP = 250;

export interface BlastCandidate {
  phone: string;
  name: string | null;
  program: Program;
}

export interface BlastAudience {
  adults: BlastCandidate[];
  kids: BlastCandidate[];
  baby: BlastCandidate[];
  excluded: { booked: number; inWindow: number; notLead: number };
}

/**
 * Pure audience split. `contacts` = candidate leads; `bookedPhones` = phones
 * with booking evidence (followup rows or kv marker); leads who wrote within
 * the last 24h are skipped — their conversation is live and free-form, a paid
 * template would just interrupt it.
 */
export function planBlastAudience(
  contacts: (Contact & { campaign_name?: string | null })[],
  bookedPhones: Set<string>,
  nowEpoch: number,
): BlastAudience {
  const out: BlastAudience = {
    adults: [],
    kids: [],
    baby: [],
    excluded: { booked: 0, inWindow: 0, notLead: 0 },
  };
  for (const c of contacts) {
    if (c.status !== "lead") {
      out.excluded.notLead++;
      continue;
    }
    if (bookedPhones.has(c.phone)) {
      out.excluded.booked++;
      continue;
    }
    if ((c.last_inbound_at ?? 0) > nowEpoch - 24 * 3600) {
      out.excluded.inWindow++;
      continue;
    }
    const program = classifyProgram(c, c.campaign_name ?? null);
    const cand: BlastCandidate = { phone: c.phone, name: c.name, program };
    if (program === "adults") out.adults.push(cand);
    else if (program === "kids") out.kids.push(cand);
    else out.baby.push(cand);
  }
  return out;
}

/** Payload stored in the followup row's note (JSON). */
export interface BlastPayload {
  /** Exact Meta template name (e.g. "adult_follow_up"). */
  t: string;
  /** Template language code exactly as approved (e.g. "es_MX"). */
  l: string;
  /** {{2}} — the class-day text for this group. */
  p2: string;
}

export function encodeBlastNote(p: BlastPayload): string {
  return JSON.stringify(p);
}

export function decodeBlastNote(note: string | null): BlastPayload | null {
  if (!note) return null;
  try {
    const p = JSON.parse(note) as Partial<BlastPayload>;
    if (typeof p.t === "string" && typeof p.l === "string" && typeof p.p2 === "string") {
      return { t: p.t, l: p.l, p2: p.p2 };
    }
  } catch {
    /* malformed note ⇒ skip the row */
  }
  return null;
}

/** WhatsApp template components for body {{1}}=greeting, {{2}}=class text. */
export function blastComponents(greeting: string, p2: string): unknown[] {
  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: greeting },
        { type: "text", text: p2 },
      ],
    },
  ];
}

/**
 * Pure send-time plan: i-th recipient → epoch. Paced BATCH_PER_TICK per 5 min
 * inside 09:00–21:00 CDMX; recipients past `dailyCap` roll to the next day
 * 09:00 (Meta's per-24h business-initiated limit).
 */
export function blastDueAt(
  i: number,
  startEpoch: number,
  dailyCap: number = DEFAULT_DAILY_CAP,
): number {
  const day = Math.floor(i / dailyCap);
  const withinDay = i % dailyCap;
  let due = startEpoch + day * 24 * 3600 + Math.floor(withinDay / BATCH_PER_TICK) * 300;
  const p = cdmxParts(due);
  if (p.hour < 9) due = cdmxToEpoch(p.year, p.month, p.day, 9, 0, 0);
  else if (p.hour >= 21) due = cdmxToEpoch(p.year, p.month, p.day + 1, 9, 0, 0);
  return due;
}

// ---- IO --------------------------------------------------------------------

/** Leads active since `sinceEpoch` + the booking-evidence phone set. */
export async function loadBlastAudience(
  env: Env,
  sinceEpoch: number,
  nowEpoch: number,
): Promise<BlastAudience> {
  const { results: contacts } = await env.DB.prepare(
    // Newest lead first: a per-group `limit` then takes the FRESHEST leads,
    // who are far likelier to still be shopping than a week-3 ghost.
    `SELECT c.*, ca.name AS campaign_name
       FROM contacts c LEFT JOIN campaigns ca ON ca.id = c.campaign_id
      WHERE (c.created_at >= ?1 OR COALESCE(c.last_inbound_at, 0) >= ?1)
      ORDER BY COALESCE(c.last_inbound_at, c.created_at) DESC`,
  )
    .bind(sinceEpoch)
    .all<Contact & { campaign_name: string | null }>();

  const kinds = BOOKED_KINDS.map((k) => `'${k}'`).join(",");
  const { results: booked } = await env.DB.prepare(
    `SELECT DISTINCT phone FROM followups WHERE kind IN (${kinds})`,
  ).all<{ phone: string }>();
  const { results: markers } = await env.DB.prepare(
    `SELECT key FROM kv WHERE key LIKE 'booking_recorded:%'`,
  ).all<{ key: string }>();
  const bookedSet = new Set<string>([
    ...booked.map((r) => r.phone),
    ...markers.map((r) => r.key.slice("booking_recorded:".length)),
  ]);
  return planBlastAudience(contacts, bookedSet, nowEpoch);
}

export interface QueueBlastSpec {
  /** kv claim key suffix so the same blast can't be double-queued. */
  runId: string;
  groups: { group: Program; candidates: BlastCandidate[]; payload: BlastPayload }[];
  startEpoch: number;
  dailyCap?: number;
}

/** Inserts the paced `blast` rows. Returns queued count, or null if the runId
 *  was already claimed (double-click / double-POST). */
export async function queueBlast(env: Env, spec: QueueBlastSpec): Promise<number | null> {
  if (!(await kvSetIfAbsent(env.DB, `blast_run:${spec.runId}`, String(spec.startEpoch)))) {
    return null;
  }
  let i = 0;
  let queued = 0;
  for (const g of spec.groups) {
    const note = encodeBlastNote(g.payload);
    for (const cand of g.candidates) {
      const dueAt = blastDueAt(i, spec.startEpoch, spec.dailyCap ?? DEFAULT_DAILY_CAP);
      i++;
      // UNIQUE(phone, kind, airtable_record_id): record id carries the runId so
      // one lead can never get the same blast twice, but a FUTURE blast can
      // reach them again.
      await scheduleFollowup(env.DB, {
        phone: cand.phone,
        kind: "blast",
        dueAt,
        airtableRecordId: `blast:${spec.runId}`,
        note,
      });
      queued++;
    }
  }
  return queued;
}
