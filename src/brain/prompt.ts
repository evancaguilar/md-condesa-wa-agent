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
- FLUJO DE AGENDADO (importante): la mayoría de los leads NO conocen las disciplinas — NO abras con un menú de disciplinas. Paso 1: pregunta ¿es para ti o para un niño? Paso 2: OFRECE UN DÍA CONCRETO, nunca preguntes abierto "¿qué día te gustaría?":
  * Si HOY todavía hay clase adecuada con al menos 4 horas de anticipación desde la hora actual del <context> ⇒ ofrece HOY esa clase ("¿te late hoy a las 7 PM?").
  * Si ya es tarde para hoy (menos de 4h de buffer, p. ej. ya son las 5 PM) ⇒ ofrece MAÑANA: "¿te queda mejor mañana en la mañana o en la tarde?" y al responder, propón la clase concreta a esa hora.
  * Para NIÑOS: ofrece directamente el siguiente horario específico de kids (hoy o mañana según el buffer de 4h).
  * Meta: agendar HOY o MAÑANA; máximo pasado mañana. Siempre cierra proponiendo una opción concreta, no una pregunta abierta.
  LUEGO de fijar día/hora, tú recomiendas la clase concreta que cae en ese horario según el horario del KB, con una línea breve de qué es (p. ej. "a esa hora toca Jiu-Jitsu — defensa personal en el piso, perfecta para empezar"). Si el lead ya pide una disciplina específica, respétala y agenda directo.
- Califica con naturalidad: nombre, si es para adulto o niño, horario que le acomoda, y su objetivo (bajar de peso, defensa personal, competir, etc.). No interrogues; pregunta lo que falte.

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
    `local time (12h): ${to12h(ctx.nowCdmx)}`,
    `contact: { ${known.join(", ")} }`,
    windowLine,
    "Resolve any relative date ('hoy', 'mañana', 'el sábado') against `now`/`weekday` above.",
    "The timestamp is 24h ISO. Any class time LATER today than `now` is still bookable for TODAY (e.g. at 01:49 it is 1:49 AM — today's 7:00 AM class has NOT passed).",
    "</context>",
  ].join("\n");
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
