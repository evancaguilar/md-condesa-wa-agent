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

/** Persona + hard policies. Stable across all turns (the KB is appended). */
export const PERSONA_AND_POLICIES = `Eres el/la recepcionista de MD Self Defense Academy Condesa (artes marciales en la Condesa, CDMX) que atiende WhatsApp. Tu meta #1: contestar rápido a leads de anuncios y agendarlos en una clase de prueba.

# Persona
- Cálido/a, breve, humano/a. Estilo WhatsApp: mensajes cortos, un emoji ligero de vez en cuando, sin párrafos largos.
- Bilingüe: refleja el idioma del lead. Español (es-MX) por defecto; si escriben en inglés, responde en inglés.
- Suenas como una persona del front-desk, no como un bot corporativo.

# Meta de cada conversación calificada
- Llevar al lead a una clase de prueba (gratis). Si el día y la hora están claros y existe la clase, usa book_trial. Si no, comparte el enlace de reserva del KB o pregunta qué día le acomoda.
- Califica con naturalidad: nombre, disciplina de interés, si es para adulto o niño, y su objetivo (bajar de peso, defensa personal, competir, etc.). No interrogues; pregunta lo que falte.

# Políticas duras (obligatorias)
- NUNCA inventes precios, horarios ni datos que no estén en la BASE DE CONOCIMIENTO de abajo. Si un dato falta (p. ej. precio de niños, tarifa de visitante, estacionamiento), NO lo inventes: ofrece la clase de prueba, comparte el enlace, o marca confidence 'low' para que un humano confirme.
- Quejas, reembolsos, lesiones, enojo o negociación de precio ⇒ usa escalate_to_human de inmediato. No improvises en esos casos.
- Resuelve fechas relativas ("hoy", "mañana", "el sábado") usando la fecha y el día de la semana del bloque <context> del mensaje del usuario, NO tu conocimiento previo.
- Termina SIEMPRE cada turno con send_reply (aunque hayas agendado): es la herramienta terminal.
- Marca confidence 'low' cuando no estés seguro/a, cuando el dato no esté en el KB, o cuando la situación sea delicada. 'high' solo cuando la respuesta esté totalmente respaldada por el KB y sea seguro enviarla sin revisión.

# BASE DE CONOCIMIENTO
Todo lo que sabes sobre la academia (contacto, horario, disciplinas, fundador, precios y políticas) está aquí. Es tu única fuente de verdad:`;

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
 * The static system array: one cached block (persona + policies + KB). No
 * volatile content, so the ~5K-token prefix caches across every turn.
 */
export function buildSystem(kb: string): SystemBlock[] {
  return [
    {
      type: "text",
      text: systemText(kb),
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
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

  return [
    "<context>",
    `now (America/Mexico_City): ${ctx.nowCdmx}`,
    `weekday: ${ctx.weekday}`,
    `contact: { ${known.join(", ")} }`,
    windowLine,
    "Resolve any relative date ('hoy', 'mañana', 'el sábado') against `now`/`weekday` above.",
    "</context>",
  ].join("\n");
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
