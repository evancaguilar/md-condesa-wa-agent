// Pure CDMX <-> UTC time helpers. America/Mexico_City is UTC-6 year-round
// (no DST since 2022), so the offset is a fixed constant. Keeping this as plain
// arithmetic (no Intl) makes the scheduling math deterministic and unit-testable.

export const CDMX_OFFSET_SECONDS = -6 * 3600; // UTC-6

/** Seconds in a day. */
export const DAY = 86400;

/** Epoch seconds → the wall-clock components in CDMX. */
export function cdmxParts(epoch: number): {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
} {
  const d = new Date((epoch + CDMX_OFFSET_SECONDS) * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** CDMX wall-clock (Y-M-D H:m:s) → epoch seconds. */
export function cdmxToEpoch(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.floor(utcMs / 1000) - CDMX_OFFSET_SECONDS;
}

/** "YYYY-MM-DD" of a given epoch in CDMX (used for kv date marks). */
export function cdmxDateStr(epoch: number): string {
  const p = cdmxParts(epoch);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** "YYYY-MM" (CDMX month) for budget alert marks + usage_log month sum. */
export function cdmxMonthStr(epoch: number): string {
  const p = cdmxParts(epoch);
  return `${p.year}-${pad2(p.month)}`;
}

/**
 * ISO 8601 with the fixed -06:00 offset from a CDMX date + time string.
 * e.g. ("2026-07-12", "18:30") → "2026-07-12T18:30:00-06:00".
 */
export function cdmxIso(date: string, time: string): string {
  const t = time.length === 5 ? `${time}:00` : time;
  return `${date}T${t}-06:00`;
}

/**
 * Clamp a target send epoch into the 09:00–21:00 CDMX quiet-hours window.
 * Before 09:00 same day → push to 09:00 that day. At/after 21:00 → push to
 * 09:00 the next day. Otherwise unchanged.
 */
export function clampToWindow(epoch: number): number {
  const p = cdmxParts(epoch);
  const startOfDay = cdmxToEpoch(p.year, p.month, p.day, 0, 0, 0);
  const nineAm = startOfDay + 9 * 3600;
  const ninePm = startOfDay + 21 * 3600;
  if (epoch < nineAm) return nineAm;
  if (epoch >= ninePm) return nineAm + DAY;
  return epoch;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
