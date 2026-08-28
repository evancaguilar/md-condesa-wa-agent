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

import type { ConvoContext } from "../types.js";
import { CLIENT } from "../client.gen.js";

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
    ...(channelLine ? [channelLine] : []),
    windowLine,
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

interface Qualification {
  name?: string;
  discipline?: string;
  audience?: string;
  goal?: string;
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
