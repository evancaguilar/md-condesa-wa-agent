// Booking-failure observability. The brain's book_trial can fail two ways and
// both used to be invisible outside the model loop: validateSlot rejects the
// slot (the lead is told "otra hora" and nobody knows), or Airtable throws (the
// lead may be told it's booked while NO record exists — so the anti-no-show
// sequence never runs). makeBookingFailureNotifier turns those into a Slack
// note + a structured log.
//
// Noise policy (Evan gets every one of these on his phone):
// - invalid_slot: one plain note per lead per CDMX day; a SECOND failure the
//   same day escalates once with <!here> (the model is looping on a bad slot).
//   Anything after that is silent — the log still has it.
// - airtable_error: ALWAYS <!here>. A real booking was lost; it needs hands.

import type { BookingFailureEvent, BookingFailureNotifier, Env } from "../types.js";
import { kvGet, kvSet, kvSetIfAbsent } from "../db/queries.js";
import { cdmxDateStr } from "../cron/time.js";
import { postNote } from "./slack.js";

/** Injected so the unit tests can stub Slack and freeze the clock. */
export interface BookingAlertDeps {
  postNote(env: Env, text: string): Promise<void>;
  /** Epoch seconds. */
  now(): number;
}

const DEFAULT_DEPS: BookingAlertDeps = {
  postNote,
  now: () => Math.floor(Date.now() / 1000),
};

/** At-most-one plain note per lead per CDMX day. */
export function bookingFailureNoteKey(phone: string, day: string): string {
  return `book_fail_note:${phone}:${day}`;
}

/** Same-day failure counter; 2 flips the escalation. */
export function bookingFailureCountKey(phone: string, day: string): string {
  return `book_fail_n:${phone}:${day}`;
}

const AUDIENCE_ES = { kid: "niños", adult: "adultos" } as const;

/** "jiu · adultos · 2026-08-25 18:00" */
function requestedLine(ev: BookingFailureEvent): string {
  const r = ev.requested;
  return `Pidió: ${r.discipline} · ${AUDIENCE_ES[r.audience]} · ${r.trialDate} ${r.trialTime}`;
}

function whoLine(ev: BookingFailureEvent): string {
  const r = ev.requested;
  const name = (r.name || "").trim() || "sin nombre";
  const child = (r.childName || "").trim();
  return child ? `${name} (menor: ${child}) · ${ev.phone}` : `${name} · ${ev.phone}`;
}

export function invalidSlotNote(ev: BookingFailureEvent): string {
  const alts = ev.alternatives && ev.alternatives.length ? ev.alternatives.join(", ") : "—";
  return [
    `⚠️ Agendado FALLIDO (horario inválido) — ${whoLine(ev)}`,
    requestedLine(ev),
    `Motivo: ${ev.reason}`,
    `Opciones ese día: ${alts}`,
    `El bot va a proponer otra hora. Si el lead ya esperaba ESA hora, agéndalo a mano en Airtable.`,
  ].join("\n");
}

export function airtableErrorNote(ev: BookingFailureEvent): string {
  return [
    `<!here> 🔴 Airtable RECHAZÓ el agendado — ${whoLine(ev)}`,
    requestedLine(ev),
    `Error: ${ev.reason.slice(0, 200)}`,
    `NO existe el registro: la secuencia anti-no-show NO está activa. Agéndalo a mano en Airtable.`,
  ].join("\n");
}

/**
 * Builds the notifier the brain calls on every failed book_trial. Injected in
 * src/index.ts only — the admin sandbox brain deliberately gets none, so
 * "Probar" never pings the channel.
 */
export function makeBookingFailureNotifier(
  env: Env,
  deps: BookingAlertDeps = DEFAULT_DEPS,
): BookingFailureNotifier {
  return async (ev: BookingFailureEvent): Promise<void> => {
    // Always first, before any throttling: Workers Logs is the record of record.
    console.error("[booking-failure]", JSON.stringify(ev));

    // A lost booking is never throttled — and never touches kv, so a D1 hiccup
    // can't swallow the one alert that matters.
    if (ev.kind === "airtable_error") {
      await deps.postNote(env, airtableErrorNote(ev));
      return;
    }

    const day = cdmxDateStr(deps.now());
    const count = await bumpFailureCount(env, ev.phone, day);

    // First of the day → the plain note (kvSetIfAbsent makes it at-most-once
    // even if two turns race).
    if (await kvSetIfAbsent(env.DB, bookingFailureNoteKey(ev.phone, day), "1")) {
      await deps.postNote(env, invalidSlotNote(ev));
      return;
    }

    // Exactly the second failure today → escalate once. Third+ stays silent.
    if (count === 2) {
      await deps.postNote(
        env,
        `<!here> ${invalidSlotNote(ev)}\n(2º intento fallido hoy con este lead — el bot puede estar atorado en un loop.)`,
      );
    }
  };
}

/** Read-modify-write same-day counter; returns the new count (0 if kv failed). */
async function bumpFailureCount(env: Env, phone: string, day: string): Promise<number> {
  const key = bookingFailureCountKey(phone, day);
  const prev = Number.parseInt((await kvGet(env.DB, key)) ?? "0", 10);
  const next = (Number.isFinite(prev) ? prev : 0) + 1;
  await kvSet(env.DB, key, String(next));
  return next;
}
