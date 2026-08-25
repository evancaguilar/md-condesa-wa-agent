// Pure matching logic for the nightly booking-reconciliation backstop
// (Slice 7): find outbound messages that CLAIM a completed trial booking
// where Airtable has no matching trial datetime, so a lead is never
// silently left unbooked. No D1/Airtable/Slack imports here — wiring lives
// in booking-recon.ts.

import { claimsBooking } from "../services/booking-claims.js";

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
}

const SEVEN_DAYS_S = 7 * 24 * 3600;
const FOURTEEN_DAYS_S = 14 * 24 * 3600;

/** Nudge/reminder copy that happens to contain a bare "agendad…" token but is
 *  NOT a completed-booking claim ("todavía no has agendado tu clase…"). The
 *  regex in booking-claims.ts already excludes "no (has/ha) agendad…" via a
 *  lookbehind; this is a second, body-level check so the exclusion holds
 *  even if the claim came from an unrelated sentence in the same message. */
function isNudgePhrase(body: string): boolean {
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

function isBacked(send: ReconSend, bookings: ReconBooking[]): boolean {
  const key = last10(send.phone);
  if (!key) return false;
  return bookings.some((b) => {
    if (last10(b.phone) !== key) return false;
    if (!b.trialDateTimeIso) return false;
    const trialEpochMs = Date.parse(b.trialDateTimeIso);
    if (Number.isNaN(trialEpochMs)) return false;
    const trialEpochS = Math.floor(trialEpochMs / 1000);
    return (
      trialEpochS >= send.ts - SEVEN_DAYS_S &&
      trialEpochS <= send.ts + FOURTEEN_DAYS_S
    );
  });
}

/**
 * Returns one Mismatch per phone (the latest claiming send) for every send
 * that claims a completed booking but has no Airtable trial datetime within
 * [ts-7d, ts+14d] on a matching phone (last 10 digits).
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
    if (!isBacked(send, bookings)) {
      mismatches.push({
        phone: send.phone,
        ts: send.ts,
        snippet: send.body.slice(0, 120),
      });
    }
  }
  return mismatches;
}
