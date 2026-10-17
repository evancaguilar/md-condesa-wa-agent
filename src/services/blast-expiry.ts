// Per-run expiry for template blasts (2026-10-17). Day-specific copy ("mañana
// sábado…") must never spill into the next morning: on 2026-10-16 three runs
// queued at 16:25 did not drain by 21:00 and resumed at 09:00 Saturday (~900
// wrong-day sends; same thing on 2026-09-25). A run now carries `expiresAt`
// (epoch seconds | null = never); the drain cancels whatever is still queued
// once `now >= expiresAt`. Pure: no I/O, fake clocks in test/blast-expiry.test.ts.

import { cdmxParts, cdmxToEpoch } from "../cron/time.js";
import { BLAST_HOUR_END, blastDueAt } from "./blast.js";

/** The end of the sending window (21:00 CDMX) of the day `startAt` first
 *  sends. A run queued after 21:00 starts tomorrow 09:00, so it defaults to
 *  tomorrow 21:00 — the day its first message goes out. */
export function defaultExpiresAt(startAt: number): number {
  const p = cdmxParts(blastDueAt(startAt));
  return cdmxToEpoch(p.year, p.month, p.day, BLAST_HOUR_END, 0, 0);
}

export type ResolvedExpiry =
  | { ok: true; expiresAt: number | null; defaulted: boolean }
  | { ok: false; error: string };

/**
 * What the queue endpoint stores from the request's `expiresAt`:
 *   undefined        → default (21:00 CDMX of the first sending day)
 *   null | 0 | false → never expires (evergreen copy)
 *   epoch > now      → as given
 *   anything else    → error
 */
export function resolveExpiresAt(raw: unknown, nowEpoch: number, startAt: number): ResolvedExpiry {
  if (raw === undefined) return { ok: true, expiresAt: defaultExpiresAt(startAt), defaulted: true };
  if (raw === null || raw === 0 || raw === false || raw === "") return { ok: true, expiresAt: null, defaulted: false };
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, error: "expiresAt inválido (epoch en segundos, null = no expira)" };
  const e = Math.floor(n);
  if (e <= nowEpoch) return { ok: false, error: "expiresAt ya pasó" };
  if (e <= startAt) return { ok: false, error: "expiresAt debe ser posterior al inicio (startAt)" };
  return { ok: true, expiresAt: e, defaulted: false };
}

/** True when a run with this expiry must stop sending at `nowEpoch`. */
export function runExpired(expiresAt: number | null | undefined, nowEpoch: number): boolean {
  return typeof expiresAt === "number" && expiresAt > 0 && nowEpoch >= expiresAt;
}

/** Runs that must be expired this tick: still sendable (active or paused —
 *  a paused day-specific run resumed tomorrow is the same bug) and past due. */
export function expiredRuns<T extends { status: string; expiresAt: number | null }>(
  metas: T[],
  nowEpoch: number,
): T[] {
  return metas.filter((m) => (m.status === "active" || m.status === "paused") && runExpired(m.expiresAt, nowEpoch));
}

/** "HH:mm" CDMX for Slack notes. */
export function cdmxHm(epoch: number): string {
  const p = cdmxParts(epoch);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
