// Prompt assembly for the Anthropic Messages request.
//
// Two pieces, kept strictly separate so prompt caching works:
//   1. buildSystem(kb) → ONE static block (persona + hard policies + full KB)
//      with cache_control ephemeral 1h. NOTHING volatile here — no date, no
//      name — or the cache invalidates every turn. The KB text is passed in
//      (the integrator supplies src/kb.ts's KB) so this module stays free of the
//      *.md text-module import and is unit-testable under plain Node.
//   2. buildContextBlock() → the per-turn <context> string that goes INSIDE the
//      latest user message: current CDMX datetime + weekday, contact known info,
//      qualification state, window status. This is what lets the model resolve
//      "hoy a las 6pm" / "mañana".
//
// Pure module (no I/O) — unit-tested.

import type { ConvoContext, Qualification } from "../types.js";
import { CLIENT } from "../client.gen.js";
import type { ClosedDate } from "../client-config.js";
import { classifyProgram, weekdaySet } from "../cron/nudge-copy.js";
import {
  TODAY_BUFFER_SECONDS,
  atClockEs,
  bandDayOptions,
  disciplineLabel,
  time12h,
  upcomingBandSlots,
  type BandDay,
  type NextSlot,
} from "../cron/next-slot.js";
import { bandLabel, isNivel0, slotMatchesBand, type ProgramBand } from "../services/age-band.js";
import { SLOTS } from "./slots.gen.js";
import { isKnownDiscipline, normalizeDiscipline } from "./tools.js";
import { cdmxToEpoch } from "../cron/time.js";

/**
 * Persona + hard policies. Stable across all turns (the KB is appended).
 * Sourced from clients/<id>/persona.md via the generated client config —
 * edit the persona there, never here.
 */
export const PERSONA_AND_POLICIES = CLIENT.persona;

/**
 * Token the model emits INSTEAD of a reply when the canned campaign welcome
 * that just went out already answered the lead in full (see the
 * `<bienvenida_ya_enviada>` context block). Honored ONLY on a turn where
 * `ctx.justSentWelcome` is set — on any other turn the instruction that
 * teaches it is absent from the prompt, and the pipeline treats it as plain
 * text, so the model can never silently drop an ordinary lead.
 */
export const NO_REPLY_SENTINEL = "<sin_respuesta>";

/**
 * Is `message` the bare no-reply sentinel? Tolerates surrounding whitespace and
 * the stray trailing period/emoji a model sometimes appends; anything with real
 * words alongside it is a REPLY (we send it rather than risk dropping a lead).
 */
export function isNoReplySentinel(message: string): boolean {
  const stripped = message.replace(NO_REPLY_SENTINEL, " ").trim();
  return message.includes(NO_REPLY_SENTINEL) && !/\p{L}|\p{N}/u.test(stripped);
}

export interface SystemBlock {
  type: "text";
  text: string;
  /**
   * Optional: the brain's big persona+KB / overlay blocks always set it (that's
   * the whole caching strategy). Short one-off prompts — e.g. booking-guard's
   * field extractor — leave it off, since a block below the model's minimum
   * cacheable size would never be cached anyway.
   */
  cache_control?: { type: "ephemeral"; ttl: "1h" };
}

/** Assemble the frozen system text: persona/policies + the KB body. */
export function systemText(kb: string): string {
  return `${PERSONA_AND_POLICIES}\n\n${kb}`;
}

/**
 * The system array. Block 1 is the frozen prefix (persona + policies + KB) with
 * no volatile content, so the ~5K-token prefix caches across every turn.
 *
 * When `overlay` is a non-empty string, a SECOND cached block is appended: the
 * live-editable overlay (dashboard "actualizaciones y correcciones"). It has its
 * own 1h ephemeral cache, so editing the overlay only invalidates block 2 — the
 * expensive base prefix keeps hitting cache. With no overlay the single-block
 * shape (and byte-for-byte text) is unchanged from before, so existing callers
 * and the cache key are preserved.
 */
export function buildSystem(kb: string, overlay?: string): SystemBlock[] {
  const blocks: SystemBlock[] = [
    {
      type: "text",
      text: systemText(kb),
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
  if (overlay && overlay.length > 0) {
    blocks.push({
      type: "text",
      text: overlay,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  }
  return blocks;
}

/** Days ahead (incl. today) whose closures are announced in the context. */
const CLOSURE_HORIZON_DAYS = 14;

/**
 * Pure. Closure lines for the <context> block: today's closure (loud — the
 * model must not offer or confirm anything for today) plus any closure inside
 * the next two weeks so it never proposes a class on a holiday.
 */
export function closureLines(
  nowCdmx: string,
  closedDates: readonly ClosedDate[] = CLIENT.closedDates ?? [],
): string[] {
  const today = nowCdmx.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
  if (!m) return [];
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const out: string[] = [];
  for (const c of closedDates) {
    const cm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.date);
    if (!cm) continue;
    const days = Math.round((Date.UTC(Number(cm[1]), Number(cm[2]) - 1, Number(cm[3])) - base) / 86400000);
    const why = c.reason ? ` (${c.reason})` : "";
    if (days === 0) {
      out.push(
        `CERRADO HOY ${c.date}${why}: la academia NO abre hoy — no hay clases ni clases de prueba. NUNCA ofrezcas, propongas ni confirmes nada para hoy; ofrece a partir de mañana. Si el lead pregunta por hoy, dile que hoy estamos cerrados por el feriado.`,
      );
    } else if (days > 0 && days <= CLOSURE_HORIZON_DAYS) {
      out.push(`CERRADO el ${c.date}${why}: no hay clases ese día — no lo ofrezcas ni agendes nada ahí.`);
    }
  }
  return out;
}

/** How many upcoming hours the context hands the model (persona caps offers at 3). */
const CONTEXT_SLOT_COUNT = 3;

/** Class days the day-complete line covers. */
const CONTEXT_DAY_COUNT = 2;

/** An add-on class must start within this many minutes of the arrival class. */
const COMBO_GAP_MIN = 60;

/** Lead discipline (free text) → a service key the band actually has, or null. */
function bandDiscipline(raw: string | undefined, band: ProgramBand): string | null {
  if (band === "baby" || band === "mini") return null; // one program per band
  const key = normalizeDiscipline(raw ?? "");
  if (!isKnownDiscipline(key)) return null;
  return SLOTS.some((s) => s.discipline === key && !s.name && slotMatchesBand(s, band)) ? key : null;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function slotWhat(s: NextSlot, band: ProgramBand = "adults"): string {
  if (band === "mini") return "Mini Muay Thai";
  if (band === "baby") return "Baby Fight Club";
  if (band === "kids" || band === "teens") {
    const tag = band === "kids" ? "Kids" : "Teens";
    // Two-class day: the arrival names its second half, which is never listed
    // as an hour of its own (next-slot.isKidSecondHalf).
    const then = s.then ? ` + ${disciplineLabel(s.then.discipline)} ${tag} ${time12h(s.then.time)}` : "";
    return `${disciplineLabel(s.discipline)} ${tag}${then}`;
  }
  return s.name ?? disciplineLabel(s.discipline);
}

/**
 * Pure. The discipline-first combo line: the lead came for `disc`, so the
 * ARRIVAL is that class; a class of another discipline starting within an
 * hour before/after it is an optional add-on ("de pilón"), never the arrival
 * (2026-10-09, Jess: a Muay Thai lead was told to arrive at 9 am Jiu-Jitsu).
 * Looks at the first day in `days` that has such a pair. null when none.
 */
export function comboLine(days: readonly BandDay[], disc: string): string | null {
  for (const d of days) {
    const arrival = d.slots.find((s) => s.discipline === disc && !s.name);
    if (!arrival) continue;
    const t = minutes(arrival.time);
    const addOn = d.slots.find(
      (s) =>
        s.discipline !== disc &&
        s.time !== arrival.time &&
        Math.abs(minutes(s.time) - t) <= COMBO_GAP_MIN,
    );
    if (!addOn) continue;
    const when = minutes(addOn.time) < t ? "antes" : "después";
    return `combo (llegó por ${disciplineLabel(disc)}): su hora de llegada es ${disciplineLabel(disc)} ${d.label} ${atClockEs(arrival.time)}; ${slotWhat(addOn)} ${time12h(addOn.time)} (justo ${when}) es OPCIONAL de pilón — una línea: "si quieres, ${time12h(addOn.time)} ${slotWhat(addOn)} de pilón y pruebas dos clases en una visita". Nunca propongas el pilón como hora de llegada.`;
  }
  return null;
}

/**
 * Soonest-first hours for THIS lead's AGE BAND, pre-computed so the model never
 * has to do calendar math (persona.md, "Flujo de agendado"). Three compact
 * lines, all within the band (never a row of another age group):
 *  1. "programa por edad: …" + the next 3 valid hours, the lead's discipline
 *     first when known (1h buffer = the persona's own "hoy" rule);
 *  2. EVERY trial option of the band on the next two class days, so "a las 9
 *     no puedo" has the rest of the day to fall back on;
 *  3. the discipline-first combo (arrival = the lead's discipline).
 * Declined days are never listed.
 *
 * VOLATILE — belongs in the per-turn block, never in a cached system block.
 * Returns [] when the clock can't be parsed.
 */
export function upcomingSlotLines(ctx: ConvoContext): string[] {
  const now = cdmxIsoToEpoch(ctx.nowCdmx);
  if (now === null) return [];
  const band = classifyProgram(ctx.contact, ctx.campaign?.name ?? null);
  const q = parseQualification(ctx.contact.qualification);
  const disc = bandDiscipline(q.discipline, band);
  const excludeWeekdays = weekdaySet(q.declined_days);
  const ageMonths = typeof q.child_age_months === "number" ? q.child_age_months : null;
  const opts = {
    leadSeconds: TODAY_BUFFER_SECONDS,
    ...(excludeWeekdays.size ? { excludeWeekdays } : {}),
    ...(ageMonths !== null ? { ageMonths } : {}),
  };
  const ageKnown = ageMonths !== null || q.program !== undefined;

  const lines: string[] = [];
  const label = band === "baby" && isNivel0(ageMonths) ? "Baby Fight Club Nivel 0 (6–11 meses)" : bandLabel(band);
  const bandWords =
    band === "adults" ? "adultos" : `${label}${ageKnown ? "" : " — edad aún no confirmada: pregúntala antes de agendar"}`;
  lines.push(`programa por edad: ${bandWords}`);

  // One entry per hour (two disciplines at 7 am are ONE option to the lead).
  const soon: { label: string; whats: string[] }[] = [];
  for (const s of upcomingBandSlots(band, disc, now, CONTEXT_SLOT_COUNT * 4, opts)) {
    const hit = soon.find((x) => x.label === s.label);
    if (hit) {
      if (!hit.whats.includes(slotWhat(s, band))) hit.whats.push(slotWhat(s, band));
    } else if (soon.length < CONTEXT_SLOT_COUNT) {
      soon.push({ label: s.label, whats: [slotWhat(s, band)] });
    }
  }
  if (soon.length > 0) {
    lines.push(
      `próximos horarios válidos${disc ? ` de ${disciplineLabel(disc)}` : ""} (más próximo primero, con buffer de 1h): ${soon
        .map((s) => `${s.label} (${s.whats.join(" / ")})`)
        .join(" · ")}`,
    );
  }

  const days = bandDayOptions(band, now, CONTEXT_DAY_COUNT, opts);
  if (days.length > 0) {
    lines.push(
      `todas las opciones de prueba de su grupo, próximos ${days.length} días con clase: ${days
        .map((d) => {
          // The lead's discipline leads each day; the rest keep clock order.
          const mine = disc
            ? d.slots.filter((s) => (s.discipline === disc && !s.name) || s.then?.discipline === disc)
            : [];
          const rest = d.slots.filter((s) => !mine.includes(s));
          return `${d.label} ${d.date}: ${[...mine, ...rest]
            .map((s) => `${time12h(s.time)} ${slotWhat(s, band)}`)
            .join(", ")}`;
        })
        .join(" | ")}`,
    );
    const combo = band === "adults" && disc ? comboLine(days, disc) : null;
    if (combo) lines.push(combo);
  }

  // A kids/baby band guessed from the CAMPAIGN (no stated age) may really be a
  // 3–5-year-old: say so, without listing another group's hours.
  if (!ageKnown && (band === "kids" || band === "baby")) {
    lines.push("si el peque tiene 3–5 años su programa es Mini Muay Thai (no Kids ni BFC): pregunta la edad antes de proponer hora.");
  }
  lines.push(
    "Ofrece SOLO filas de su grupo de edad, la más próxima primero, salvo que el lead haya pedido otro día.",
  );
  return lines;
}

const DAY_WORDS: Record<string, string> = {
  lun: "lun", mar: "mar", mie: "mié", jue: "jue", vie: "vie", sab: "sáb", dom: "dom",
};
const WEEKDAY_KEYS = ["lun", "mar", "mie", "jue", "vie"];

/** "entre semana NO" when all five weekdays are declined, else "lun, mar NO". */
function daysPhrase(days: readonly string[]): string {
  if (WEEKDAY_KEYS.every((d) => days.includes(d))) {
    const rest = days.filter((d) => !WEEKDAY_KEYS.includes(d));
    return ["entre semana", ...rest.map((d) => DAY_WORDS[d] ?? d)].join(", ");
  }
  return days.map((d) => DAY_WORDS[d] ?? d).join(", ");
}

/** "4 años" / "4 años 10 meses" / "18 meses". */
function ageWords(months: number): string {
  if (months < 36) return `${months} meses`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return m ? `${y} años ${m} meses` : `${y} años`;
}

/**
 * Pure. What the lead already told us about the child and their days — a
 * compact line, or null. "el lead ya dijo: entre semana NO" is what stops the
 * bot from re-offering a day the lead already turned down.
 */
export function knownFactsLine(q: Qualification): string | null {
  const parts: string[] = [];
  if (q.child_name) parts.push(`peque: ${q.child_name}`);
  if (typeof q.child_age_months === "number") parts.push(`edad: ${ageWords(q.child_age_months)}`);
  if (q.declined_days?.length) parts.push(`${daysPhrase(q.declined_days)} NO (nunca lo vuelvas a ofrecer)`);
  if (q.preferred_days?.length) parts.push(`prefiere ${daysPhrase(q.preferred_days)}`);
  return parts.length ? `el lead ya dijo: ${parts.join("; ")}` : null;
}

/** "2026-09-21T14:30" (CDMX, no offset) → epoch seconds. null if unparseable. */
function cdmxIsoToEpoch(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  return cdmxToEpoch(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
  );
}

/**
 * The per-turn <context> block. Volatile — must NOT go in the system prompt.
 * Rendered into the latest user message so the model can resolve relative dates
 * and knows what it already learned about the lead.
 */
export function buildContextBlock(ctx: ConvoContext): string {
  const q = parseQualification(ctx.contact.qualification);
  const known: string[] = [];
  known.push(`phone: ${ctx.phone}`);
  if (ctx.contact.name) known.push(`name: ${ctx.contact.name}`);
  known.push(`lang: ${ctx.contact.lang}`);
  known.push(`status: ${ctx.contact.status}`);
  if (q.name) known.push(`qual.name: ${q.name}`);
  if (q.discipline) known.push(`qual.discipline: ${q.discipline}`);
  if (q.audience) known.push(`qual.audience: ${q.audience}`);
  if (q.goal) known.push(`qual.goal: ${q.goal}`);
  const facts = knownFactsLine(q);

  const windowLine = ctx.windowOpen
    ? "24h window OPEN (free-form replies allowed)"
    : "24h window CLOSED (only template messages until the lead writes again)";

  const channelLine =
    ctx.channel === "ig"
      ? "channel: Instagram DM — el lead te escribe por Instagram, NO por WhatsApp; nunca digas que le escribes por WhatsApp."
      : ctx.channel === "fb"
        ? "channel: Facebook Messenger — el lead te escribe por Messenger, NO por WhatsApp; nunca digas que le escribes por WhatsApp."
        : null;

  const lines = [
    "<context>",
    `now (America/Mexico_City): ${ctx.nowCdmx}`,
    `weekday: ${ctx.weekday}`,
    `local time (12h): ${to12h(ctx.nowCdmx)}`,
    `contact: { ${known.join(", ")} }`,
    ...(facts ? [facts] : []),
    ...(channelLine ? [channelLine] : []),
    windowLine,
    ...closureLines(ctx.nowCdmx),
    ...upcomingSlotLines(ctx),
    "Resolve any relative date ('hoy', 'mañana', 'el sábado') against `now`/`weekday` above.",
    "The timestamp is 24h ISO. Any class time LATER today than `now` is still bookable for TODAY (e.g. at 01:49 it is 1:49 AM — today's 7:00 AM class has NOT passed).",
    ...(ctx.recordedBooking
      ? [
          `Reserva YA registrada en Airtable para este lead${
            ctx.recordedBooking.trialDate
              ? `: ${ctx.recordedBooking.trialDate} ${ctx.recordedBooking.trialTime ?? ""}`.trimEnd()
              : ""
          }. NO llames book_trial otra vez para esa misma clase — confírmala o resuelve dudas; solo re-agenda si el lead PIDE cambiarla.`,
        ]
      : []),
    "</context>",
  ];

  // The lead arrived via an ad campaign: hand the model that campaign's extra
  // knowledge so it can respond in context (offer/promo details, etc.).
  if (ctx.campaign) {
    lines.push(
      "<campaign_info>",
      `campaña: ${ctx.campaign.name}`,
      ctx.campaign.info,
      "El lead llegó por esta campaña; úsala para responder.",
      "</campaign_info>",
    );
  }

  // The Meta ad the lead clicked (click-to-WhatsApp referral). Included even
  // when the ad isn't mapped to a campaign, so the model can still infer which
  // program/promo — and whether it's for adults or kids — from the creative.
  if (ctx.adRef && (ctx.adRef.headline || ctx.adRef.body)) {
    lines.push("<ad_info>", "El lead llegó tocando este anuncio de Meta:");
    if (ctx.adRef.headline) lines.push(`titular: ${ctx.adRef.headline}`);
    if (ctx.adRef.body) lines.push(`texto: ${truncate(ctx.adRef.body, 400)}`);
    lines.push(
      "Deduce con la base de conocimiento a qué programa o promoción corresponde este anuncio (y si es para adultos o para niños). No preguntes lo que el anuncio ya deja claro.",
      "</ad_info>",
    );
  }

  // The campaign's canned welcome went out SECONDS ago, this same turn: the
  // first-reply gate fell through because the lead's opening message carried a
  // real question (any "?"). Audit 2026-08-25: that fall-through fired even
  // when the welcome had already answered the question, and the model — having
  // nothing new to say — filled the gap by re-offering schedules, so the lead
  // got two messages and five time slots in 14 seconds. The welcome text is
  // handed over verbatim so the model can see exactly what is already covered.
  if (ctx.justSentWelcome) {
    lines.push(
      "<bienvenida_ya_enviada>",
      "Hace segundos ya le enviamos AUTOMÁTICAMENTE este mensaje de bienvenida (el lead lo está leyendo ahora mismo):",
      "---",
      truncate(ctx.justSentWelcome, 1200),
      "---",
      "Tu mensaje llega INMEDIATAMENTE después de ése. Reglas de este turno:",
      `- Si la bienvenida ya responde TODO lo que preguntó el lead y tú no agregarías nada nuevo, NO contestes: llama send_reply con message exactamente "${NO_REPLY_SENTINEL}" (sin nada más) y sureness 90. Es la opción correcta y preferida, no una falla.`,
      "- Si algo quedó sin responder, contesta SOLO eso, en una o dos líneas.",
      "- NO vuelvas a ofrecer horarios ni el link de agendar: la bienvenida ya cerró con su llamada a la acción y repetirla satura al lead.",
      "- No repitas el saludo, la ubicación, la descripción del programa ni ningún dato que ya aparezca arriba.",
      "</bienvenida_ya_enviada>",
    );
  }

  // Outage redrive (2026-10-06): the reply is hours late and it is our fault.
  if (ctx.staleReply) {
    const h = Math.max(1, Math.round(ctx.staleReply.waitedHours));
    lines.push(
      "<respuesta_tardia>",
      `El último mensaje del lead llegó el ${ctx.staleReply.lastInboundCdmx} y lleva ~${h} h SIN respuesta por una falla técnica NUESTRA (no del lead). Reglas de este turno:`,
      "- Empieza con una disculpa breve y natural por la demora (una frase, sin explicar la falla), luego responde lo que preguntó.",
      "- \"hoy\", \"mañana\", \"ahorita\" en su mensaje se refieren al momento en que ESCRIBIÓ, no a ahora. Si la hora que propuso ya pasó, ofrécele la siguiente opción real.",
      "- Si la clase o cita de la que hablan YA PASÓ (compara su fecha/hora con la hora actual del <context>), NO la confirmes como si fuera futura: pregunta si pudo asistir y, si no, ofrece reagendar.",
      "- NO agendes (book_trial) en este turno: confirma primero día y hora con el lead. Si ya hay una reserva registrada, solo confírmala.",
      `- Si el lead solo confirmó o cerró (\"ahí estaré\", \"gracias\", \"ok\") y no hay nada útil que agregar, NO contestes: llama send_reply con message exactamente \"${NO_REPLY_SENTINEL}\" (sin nada más). Un mensaje tardío sin contenido molesta más que el silencio.`,
      "</respuesta_tardia>",
    );
  }

  // Reminder button "Necesito reagendar" (pipeline/inbound, WP3).
  if (ctx.reschedule) {
    lines.push(
      "<reschedule>",
      "El lead pidió reagendar su clase de prueba (respondió al recordatorio). Ofrece las 2 próximas opciones reales de SU programa y, cuando elija, agenda con book_trial.",
      "</reschedule>",
    );
  }

  return lines.join("\n");
}

/** Caps ad body text so a long creative can't bloat the per-turn context. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** "…T01:49…" → "1:49 AM" (the 24h ISO hour confuses models at edge hours). */
function to12h(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const h24 = Number(m[1]);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]} ${h24 < 12 ? "AM" : "PM"}`;
}

function parseQualification(json: string | null): Qualification {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as Qualification;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
