// Pure matching logic for the nightly booking-reconciliation backstop
// (Slice 7): find outbound messages that CLAIM a completed trial booking
// where Airtable has no matching trial datetime, so a lead is never
// silently left unbooked. No D1/Airtable/Slack imports here — wiring lives
// in booking-recon.ts.

import { claimsBooking, parseBookingHints } from "../services/booking-claims.js";
import { cdmxDateStr, cdmxHintContext } from "./time.js";

export interface ReconSend {
  phone: string;
  ts: number; // epoch seconds
  body: string;
}

export interface ReconBooking {
  phone: string;
  trialDateTimeIso: string | null;
}

export interface Mismatch {
  phone: string;
  ts: number;
  snippet: string;
  /** CDMX date the copy actually promised, when it states one. */
  claimedDate?: string;
  /** Closest booking this lead DOES have (CDMX date), or null if none at all. */
  nearestBookingDate?: string | null;
}

const SEVEN_DAYS_S = 7 * 24 * 3600;
const FOURTEEN_DAYS_S = 14 * 24 * 3600;
const THIRTY_DAYS_S = 30 * 24 * 3600;

/** Nudge/reminder copy that happens to contain a bare "agendad…" token but is
 *  NOT a completed-booking claim ("todavía no has agendado tu clase…"). The
 *  regex in booking-claims.ts already excludes "no (has/ha) agendad…" via a
 *  lookbehind; this is a second, body-level check so the exclusion holds
 *  even if the claim came from an unrelated sentence in the same message. */
export function isNudgePhrase(body: string): boolean {
  return /no\s+has\s+agendado|todav[ií]a\s+no/i.test(body);
}

function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Last 10 digits of the phone, digits-only — MX mobile numbers vary in
 *  country/trunk prefix (+52, 521, (55)…) but always share the same last 10. */
function last10(phone: string): string {
  return digitsOnly(phone).slice(-10);
}

/** Trial epochs (seconds) this lead has on file, oldest-first order preserved. */
function trialEpochsFor(send: ReconSend, bookings: ReconBooking[]): number[] {
  const key = last10(send.phone);
  if (!key) return [];
  const out: number[] = [];
  for (const b of bookings) {
    if (last10(b.phone) !== key) continue;
    if (!b.trialDateTimeIso) continue;
    const ms = Date.parse(b.trialDateTimeIso);
    if (Number.isNaN(ms)) continue;
    out.push(Math.floor(ms / 1000));
  }
  return out;
}

/**
 * The CDMX date the copy promised, when it states one. Same parser the capture
 * guard uses, with the clock taken from the send itself so "el sábado" resolves
 * against the day it was WRITTEN, not the day the cron runs.
 */
function claimedDateOf(send: ReconSend): string | undefined {
  const { iso, weekdayIdx } = cdmxHintContext(send.ts);
  return parseBookingHints(send.body, iso, weekdayIdx).trialDate;
}

/** Noon CDMX of a YYYY-MM-DD, for date-distance math. */
function noonEpoch(ymd: string): number {
  return Math.floor(Date.parse(`${ymd}T12:00:00-06:00`) / 1000);
}

/**
 * Returns one Mismatch per phone (the latest claiming send) for every send that
 * claims a completed booking Airtable can't back, on a matching phone (last 10
 * digits). Two sharpnesses:
 *
 *  - the copy names a DATE ⇒ a booking must fall on that same CDMX calendar day.
 *    Day granularity on purpose: the recon's job is "does this class exist at
 *    all", and a staff member writing 6 pm for a 6:30 class is not a lost lead.
 *  - the copy names no date ⇒ the original [ts-7d, ts+14d] window rule, so a
 *    vague "ya quedó agendado" doesn't spam the digest.
 */
export function findUnbackedConfirmations(
  sends: ReconSend[],
  bookings: ReconBooking[],
  now: number,
): Mismatch[] {
  const latestClaimByPhone = new Map<string, ReconSend>();
  for (const s of sends) {
    if (s.ts > now) continue; // ignore clock-skewed/future rows defensively
    if (!claimsBooking(s.body)) continue;
    if (isNudgePhrase(s.body)) continue;
    const key = last10(s.phone) || s.phone;
    const existing = latestClaimByPhone.get(key);
    if (!existing || s.ts > existing.ts) latestClaimByPhone.set(key, s);
  }

  const mismatches: Mismatch[] = [];
  for (const send of latestClaimByPhone.values()) {
    const trials = trialEpochsFor(send, bookings);
    const claimedDate = claimedDateOf(send);
    // A date derived from a BARE weekday ("nos vemos el sábado") is ambiguous
    // — 2026-08-28's digest flagged two perfectly-registered bookings because
    // "el sábado" resolved to the wrong Saturday. Only hold the copy to an
    // exact calendar day when it stated one explicitly (day-month, ISO, or
    // hoy/mañana); weekday-only claims are backed by ANY nearby future trial.
    const explicitDate =
      /\b\d{1,2}\s+de\s+\p{L}+|\b\d{4}-\d{2}-\d{2}\b|\bhoy\b|\bma[ñn]ana\b/iu.test(
        send.body,
      );
    const backed =
      claimedDate && explicitDate
        ? trials.some((t) => cdmxDateStr(t) === claimedDate)
        : trials.some(
            (t) => t >= send.ts - SEVEN_DAYS_S && t <= send.ts + THIRTY_DAYS_S,
          );
    if (backed) continue;
    const m: Mismatch = {
      phone: send.phone,
      ts: send.ts,
      snippet: send.body.slice(0, 120),
    };
    if (claimedDate) {
      m.claimedDate = claimedDate;
      // What the lead DOES have, so the digest can say "prometido X, hay Y".
      const target = noonEpoch(claimedDate);
      let nearest: number | null = null;
      for (const t of trials) {
        if (nearest === null || Math.abs(t - target) < Math.abs(nearest - target)) {
          nearest = t;
        }
      }
      m.nearestBookingDate = nearest === null ? null : cdmxDateStr(nearest);
    }
    mismatches.push(m);
  }
  return mismatches;
}
