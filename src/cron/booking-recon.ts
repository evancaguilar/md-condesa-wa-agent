// Nightly booking-reconciliation backstop (Slice 7): find outbound messages
// from the last 48h that CLAIM a completed trial booking ("ya quedó
// agendado", "te esperamos el sábado…") where Airtable has no matching trial
// datetime, and post ONE Slack digest so no lead is ever silently left
// unbooked. Runs from the existing daily ~10:00 CDMX block in dispatcher.ts.

import type { Env } from "../types.js";
import type { CronSlackDeps } from "./deps.js";
import { recentClaimSends } from "../db/queries.js";
import { listRecentBookings } from "../services/airtable.js";
import { cdmxParts } from "./time.js";
import {
  findUnbackedConfirmations,
  type Mismatch,
  type ReconBooking,
} from "./booking-recon-core.js";

const CLAIM_LOOKBACK_S = 48 * 3600;
const BOOKING_LOOKBACK_S = 21 * 24 * 3600;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "DD/MM HH:MM" in CDMX, for the digest line. */
function fechaCdmx(epoch: number): string {
  const p = cdmxParts(epoch);
  return `${pad2(p.day)}/${pad2(p.month)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** " — prometido 2026-08-29, en Airtable: 2026-08-28" for a dated claim. */
function slotLine(m: Mismatch): string {
  if (!m.claimedDate) return "";
  const has = m.nearestBookingDate ? m.nearestBookingDate : "ninguna clase";
  return ` — prometido ${m.claimedDate}, en Airtable: ${has}`;
}

export interface BookingReconDeps {
  slack: CronSlackDeps;
}

/**
 * Scans the last 48h of outbound messages for unbacked booking claims and
 * posts a Slack digest when it finds any. Returns the mismatch count (0 when
 * clean — nothing is posted in that case, keeping #wa-leads quiet).
 */
export async function runBookingRecon(
  env: Env,
  deps: BookingReconDeps,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const sends = await recentClaimSends(env.DB, nowEpoch - CLAIM_LOOKBACK_S);
  const sinceIso = new Date((nowEpoch - BOOKING_LOOKBACK_S) * 1000).toISOString();
  const records = await listRecentBookings(env, sinceIso);
  const bookings: ReconBooking[] = records.map((r) => ({
    phone: r.phone ?? "",
    trialDateTimeIso: r.trialDateTimeIso,
  }));

  const mismatches = findUnbackedConfirmations(sends, bookings, nowEpoch);
  if (mismatches.length === 0) return 0;

  const lines = mismatches
    .map(
      (m) =>
        `• ${m.phone} — "${m.snippet}" (${fechaCdmx(m.ts)})${slotLine(m)}`,
    )
    .join("\n");
  await deps.slack.postNote(
    `🕵️ Reconciliación de agendados — ${mismatches.length} confirmación(es) SIN registro en Airtable:\n${lines}\nRevisa y regístralos a mano.`,
  );
  return mismatches.length;
}
