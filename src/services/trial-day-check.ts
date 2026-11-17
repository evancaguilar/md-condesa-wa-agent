// Does a booked trial class still run? Pure module — unit-tested.
//
// Incident 2026-11-16: a kids trial was booked for Mon 2026-11-16 3:15 pm;
// later that Monday became a "special" holiday (four ADULT classes only). The
// booking's day-before, same-day and first no-show messages all still went
// out ("Parece que hoy no pudieron llegar…" → "ustedes cancelaron").
//
// Only CONFIGURED closures are judged (CLIENT.closedDates). An ordinary day is
// always "running": staff book custom times the grid does not list, so the
// regular schedule is never used to second-guess a booking.

import type { ClosedDate } from "../client-config.js";
import { cdmxParts } from "../cron/time.js";

export type TrialDayVerdict =
  | { runs: true }
  | {
      runs: false;
      /** Why, in staff words: "cerrado" / "horario por confirmar" / "horario especial". */
      why: "cerrado" | "horario por confirmar" | "horario especial";
      /** The closure's own reason text ("lunes feriado"), when configured. */
      reason: string | null;
      /** CDMX date of the class, "YYYY-MM-DD". */
      date: string;
    };

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "HH:mm" → minutes, or null when unreadable ("9:00" is accepted). */
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Pure. Whether the trial class starting at `trialEpoch` (epoch seconds) runs,
 * judged ONLY against `closedDates`:
 *  - date not listed → runs (never judge ordinary days);
 *  - listed, no mode / "closed" → does not run ("cerrado");
 *  - "tbd" → does not run ("horario por confirmar");
 *  - "special" → runs only when one of its slots starts at exactly that CDMX
 *    HH:mm (any group); a special day without slots behaves like closed.
 */
export function trialDayCheck(trialEpoch: number, closedDates: readonly ClosedDate[]): TrialDayVerdict {
  if (!Number.isFinite(trialEpoch)) return { runs: true };
  const p = cdmxParts(trialEpoch);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const c = closedDates.find((d) => d.date === date);
  if (!c) return { runs: true };
  const reason = c.reason?.trim() || null;
  if (c.mode === "tbd") return { runs: false, why: "horario por confirmar", reason, date };
  if (c.mode === "special") {
    const slots = c.slots ?? [];
    if (slots.length === 0) return { runs: false, why: "cerrado", reason, date };
    const at = p.hour * 60 + p.minute;
    if (slots.some((s) => minutesOf(s.time) === at)) return { runs: true };
    return { runs: false, why: "horario especial", reason, date };
  }
  return { runs: false, why: "cerrado", reason, date };
}

/** Pure. True when `closedDates` lists a date within [now, now + days] (CDMX dates). */
export function hasClosureWithin(closedDates: readonly ClosedDate[], now: number, days: number): boolean {
  if (closedDates.length === 0) return false;
  const ymd = (e: number): string => {
    const p = cdmxParts(e);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  };
  const from = ymd(now);
  const to = ymd(now + days * 86400);
  return closedDates.some((c) => c.date >= from && c.date <= to);
}

/** kv claim: the "this class does not run" task note goes out ONCE per phone + trial. */
export function noClassNoteKey(phone: string, trialEpoch: number): string {
  return `trial_noclass_note:${phone}:${trialEpoch}`;
}

/** Pure. The closure in staff words: "es lunes feriado: ese día solo hay horario especial". */
export function noClassWhy(v: Extract<TrialDayVerdict, { runs: false }>): string {
  const r = v.reason ? ` (${v.reason})` : "";
  switch (v.why) {
    case "horario por confirmar":
      return `ese día el horario está por confirmar${r}`;
    case "horario especial":
      return `ese día hay horario especial${r} y esa clase no está en él`;
    default:
      return `ese día estamos cerrados${r}`;
  }
}

/** Pure. The #wa-leads task note when a booked class does not run that day. */
export function noClassTaskNote(opts: {
  who: string;
  /** "el lunes 16 a las 3:15 pm". */
  classLabel: string;
  verdict: Extract<TrialDayVerdict, { runs: false }>;
  cancelledRows: number;
}): string {
  return (
    `🚫 ${opts.who} tiene clase de prueba ${opts.classLabel}, pero ${noClassWhy(opts.verdict)}.\n` +
    `Detuve los recordatorios automáticos y el mensaje de «no llegaste» de esa clase (${opts.cancelledRows} programado(s)). ` +
    `Al lead NO se le envió nada: *avísale tú* y reagenda su clase (actualiza la fecha de prueba en Airtable).`
  );
}

/** Pure. The #wa-leads note after a staff member pressed «Cancelar clase de prueba». */
export function staffCancelTaskNote(opts: { who: string; by: string; classes: string[]; cancelledRows: number }): string {
  const cls = opts.classes.length ? ` (${opts.classes.join(" / ")})` : "";
  return (
    `🚫 ${opts.by} canceló desde el panel la clase de prueba de ${opts.who}${cls}. ` +
    `Detuve ${opts.cancelledRows} mensaje(s) automático(s) de esa clase (recordatorios y «no llegaste»); al lead no se le envió nada.\n` +
    `*En Airtable:* mueve o borra la fecha de prueba (o marca Reprogramó) — no lo marques «No asistió».`
  );
}
