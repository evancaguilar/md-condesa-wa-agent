// Nightly booking-reconciliation backstop (Slice 7): find outbound messages
// from the last 48h that CLAIM a completed trial booking ("ya quedó
// agendado", "te esperamos el sábado…") where Airtable has no matching trial
// datetime, and post ONE Slack digest so no lead is ever silently left
// unbooked. Runs from the existing daily ~10:00 CDMX block in dispatcher.ts.

import type { Env } from "../types.js";
import { taskNote, type CronSlackDeps } from "./deps.js";
import { recentClaimSends } from "../db/queries.js";
import { listRecentBookings } from "../services/airtable.js";
import { cdmxParts } from "./time.js";
import {
  findUnbackedConfirmations,
  RECON_LOOKBACK_S,
  slotLabel,
  stillActionable,
  type Mismatch,
  type ReconBooking,
} from "./booking-recon-core.js";

// Repeats daily until resolved (was a single 48h look, so a missed alert was
// lost for good) — see stillActionable for when an entry drops off.
const CLAIM_LOOKBACK_S = RECON_LOOKBACK_S;
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
  const slot = slotLabel(m);
  if (!slot) return "";
  if (!m.claimedDate) return ` — clase prometida: ${slot}`;
  const has = m.nearestBookingDate ? m.nearestBookingDate : "ninguna clase";
  return ` — prometido ${slot}, en Airtable: ${has}`;
}

export interface BookingReconDeps {
  /** The digest goes to postTaskNote (#wa-leads) via taskNote(). */
  slack: CronSlackDeps;
  /** Test seams; default to the D1 query and the Airtable list. */
  loadSends?: typeof recentClaimSends;
  loadBookings?: typeof listRecentBookings;
}

/**
 * Scans the last 48h of outbound messages for unbacked booking claims and
 * posts a #wa-leads digest when it finds any (the team registers them by
 * hand). Returns the mismatch count (0 when clean — nothing is posted in that
 * case, keeping #wa-leads quiet).
 */
export async function runBookingRecon(
  env: Env,
  deps: BookingReconDeps,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const sends = await (deps.loadSends ?? recentClaimSends)(env.DB, nowEpoch - CLAIM_LOOKBACK_S);
  const sinceIso = new Date((nowEpoch - BOOKING_LOOKBACK_S) * 1000).toISOString();
  const records = await (deps.loadBookings ?? listRecentBookings)(env, sinceIso);
  const bookings: ReconBooking[] = records.map((r) => ({
    phone: r.phone ?? "",
    trialDateTimeIso: r.trialDateTimeIso,
  }));

  const mismatches = findUnbackedConfirmations(sends, bookings, nowEpoch).filter((m) =>
    stillActionable(m, nowEpoch),
  );
  if (mismatches.length === 0) return 0;

  const lines = mismatches
    .map(
      (m) =>
        `• ${m.phone} — "${m.snippet}" (${fechaCdmx(m.ts)})${slotLine(m)}`,
    )
    .join("\n");
  // The team must register these by hand ⇒ #wa-leads (task channel).
  await taskNote(
    deps.slack,
    `🕵️ Reconciliación de agendados — ${mismatches.length} confirmación(es) SIN registro en Airtable:\n${lines}\nRevisa y regístralos a mano — este aviso se repite cada día hasta que el registro exista.`,
  );
  return mismatches.length;
}
