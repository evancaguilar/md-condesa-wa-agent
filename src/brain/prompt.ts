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

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral"; ttl: "1h" };
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

  const lines = [
    "<context>",
    `now (America/Mexico_City): ${ctx.nowCdmx}`,
    `weekday: ${ctx.weekday}`,
    `local time (12h): ${to12h(ctx.nowCdmx)}`,
    `contact: { ${known.join(", ")} }`,
    windowLine,
    "Resolve any relative date ('hoy', 'mañana', 'el sábado') against `now`/`weekday` above.",
    "The timestamp is 24h ISO. Any class time LATER today than `now` is still bookable for TODAY (e.g. at 01:49 it is 1:49 AM — today's 7:00 AM class has NOT passed).",
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

  return lines.join("\n");
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
