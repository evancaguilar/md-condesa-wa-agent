// Program classification + per-program nudge copy (R3 of sequences-v2). Pure:
// no DB, no side effects — just (contact, kind, program) → string. Tone mirrors
// the ManyChat flows in docs/manychat-flows.md (warm Mexican Spanish, WhatsApp
// style, light emoji); every message ends with a booking link or a question.
//
// Programs: adults | kids | baby. Adults & baby extended copy is adapted from
// ManyChat; kids extended copy (d2–d5) does not exist there and is AUTHORED here
// following the adults arc (retry → objection-handling → social proof → goodbye).
// The mc.ht links from the transcript are replaced with the real booking URLs.

import type { Contact, Language, Qualification } from "../types.js";
import { CLIENT } from "../client.gen.js";

// ---- kinds ----

/** Day-1 drip kinds (in send order). Kept here so copy + engine share one source. */
export const NUDGE_KINDS = ["nudge_1h", "nudge_6h", "nudge_8h"] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

/** Extended (multi-day) drip kinds (in send order). */
export const EXTENDED_NUDGE_KINDS = [
  "nudge_d2",
  "nudge_d3",
  "nudge_d4",
  "nudge_d5",
] as const;
export type ExtendedKind = (typeof EXTENDED_NUDGE_KINDS)[number];

/** Every nudge kind (day-1 + extended) — used for kind-scoped cancellation. */
export const ALL_NUDGE_KINDS = [
  ...NUDGE_KINDS,
  ...EXTENDED_NUDGE_KINDS,
] as const;

export type Program = "adults" | "kids" | "baby";

// ---- links ----

const ADULT_LINK = CLIENT.links.booking;
const KIDS_LINK = CLIENT.links.bookingKids ?? CLIENT.links.booking;

/** Booking link for a program (adults → adults page; kids/baby → kids page). */
export function programLink(program: Program): string {
  return program === "adults" ? ADULT_LINK : KIDS_LINK;
}

// ---- helpers ----

export function parseQualification(contact: Contact | null): Qualification {
  if (!contact?.qualification) return {};
  try {
    return JSON.parse(contact.qualification) as Qualification;
  } catch {
    return {};
  }
}

function firstName(contact: Contact | null, q: Qualification): string {
  const raw = (q.name ?? contact?.name ?? "").trim();
  if (!raw) return "";
  return raw.split(/\s+/)[0] ?? "";
}

/** " Nombre" (leading space) or "" — for "¡Hola${sp}!" style greetings. */
function nameSuffix(name: string): string {
  return name ? ` ${name}` : "";
}

/**
 * Program classification (pure). baby if qualification.discipline contains
 * "baby" OR the campaign name matches /baby/i; kids if audience === "kid";
 * else adults.
 */
export function classifyProgram(
  contact: Contact | null,
  campaignName?: string | null,
): Program {
  const q = parseQualification(contact);
  const disc = (q.discipline ?? "").toLowerCase();
  if (disc.includes("baby") || (campaignName != null && /baby/i.test(campaignName))) {
    return "baby";
  }
  if (q.audience === "kid") return "kids";
  return "adults";
}

// ---- day-1 copy (nudge_1h / nudge_6h / nudge_8h) ----

/**
 * Program-specific day-1 nudge copy. Adults keeps discipline personalization on
 * step 1; kids/baby mirror the ManyChat step 1–3 arc. Step 3 always carries the
 * booking link. Pure over (contact, kind).
 */
export function nudgeCopy(contact: Contact | null, kind: NudgeKind): string {
  const q = parseQualification(contact);
  const program = classifyProgram(contact);
  const lang: Language = contact?.lang === "en" ? "en" : "es";
  const name = firstName(contact, q);
  const sp = nameSuffix(name);
  const disc = (q.discipline ?? "").trim();
  const link = programLink(program);

  if (lang === "en") return dayOneEn(program, kind, sp, disc, link);
  return dayOneEs(program, kind, sp, disc, link);
}

function dayOneEs(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  link: string,
): string {
  return dayOneEsInner(program, kind, sp, disc, link) ?? `¡Hola${sp}! 🥋`;
}

function dayOneEsInner(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  link: string,
): string | undefined {
  if (program === "kids") {
    switch (kind) {
      case "nudge_1h":
        return `¡Hola${sp}! Me parece que todavía no has agendado el día gratuito para tu peque. ¿Hay algo con lo que te pueda ayudar o alguna duda antes de reservar? 🙂`;
      case "nudge_6h":
        return `¡Hola${sp}! Uno de los cambios más bonitos que vemos en los niños es cómo empiezan a ganar confianza poco a poco: no solo aprenden técnicas, también se paran más seguros, escuchan mejor y creen más en sí mismos 🙌 Puedes reservar su clase gratis aquí: ${link}`;
      case "nudge_8h":
        return `¡Hola${sp}! También es una gran forma de sacarlos un rato de las pantallas 🙌 En vez de estar sentados, se mueven, juegan, entrenan y conviven con otros niños. Si ves un horario que les funcione, agenda su clase gratis aquí: ${link}`;
    }
  }
  if (program === "baby") {
    switch (kind) {
      case "nudge_1h":
        return `¡Hola${sp}! Me parece que todavía no has agendado la clase gratuita para tu bebé. ¿Hay algo con lo que te pueda ayudar o alguna duda antes de reservar? 🙂`;
      case "nudge_6h":
        return `¡Hola${sp}! A esta edad cada nueva experiencia cuenta mucho 🙌 Baby Fight Club es una forma divertida de darle a tu bebé movimiento, convivencia y confianza desde pequeñito, sin presión y acompañado por ti. Puedes reservar su clase gratis aquí: ${link}`;
      case "nudge_8h":
        return `¡Hola${sp}! Si les interesa probar, el siguiente paso es muy sencillo 💪 Cuéntame y apartamos su clase gratis, o resérvala directo aquí: ${link}`;
    }
  }
  // adults
  switch (kind) {
    case "nudge_1h":
      return disc
        ? `¡Hola${sp}! Sigo por aquí si te quedó alguna duda sobre ${disc} 🙂`
        : `¡Hola${sp}! Me parece que todavía no has agendado tu día gratuito. ¿Hay algo con lo que te pueda ayudar o alguna duda antes de reservar? 🙂`;
    case "nudge_6h":
      return `¡Hola${sp}! Muchos de nuestros alumnos nos dicen que entrar a la academia les cambió la vida — por la condición, por bajar de peso o por la confianza de aprender a defenderse 🙌 Cuando gustes te ayudo a encontrar un horario que te acomode: ${link}`;
    case "nudge_8h":
      return `¡Hola${sp}! Tu primera clase es una prueba GRATIS 🥋 ¿La agendamos? Puedes reservar aquí: ${link}`;
  }
}

function dayOneEn(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  link: string,
): string {
  return dayOneEnInner(program, kind, sp, disc, link) ?? `Hi${sp}! 🥋`;
}

function dayOneEnInner(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  link: string,
): string | undefined {
  if (program === "kids") {
    switch (kind) {
      case "nudge_1h":
        return `Hi${sp}! Looks like you haven't booked your kid's free trial yet. Anything I can help with before you reserve? 🙂`;
      case "nudge_6h":
        return `Hi${sp}! One of the loveliest changes we see in kids is how they slowly gain confidence — they don't just learn technique, they stand taller and believe in themselves more 🙌 You can book their free class here: ${link}`;
      case "nudge_8h":
        return `Hi${sp}! It's also a great way to get them off screens for a bit 🙌 They move, play, train and make friends. If a time works for you, book their FREE trial here: ${link}`;
    }
  }
  if (program === "baby") {
    switch (kind) {
      case "nudge_1h":
        return `Hi${sp}! Looks like you haven't booked your baby's free class yet. Anything I can help with before you reserve? 🙂`;
      case "nudge_6h":
        return `Hi${sp}! At this age every new experience counts 🙌 Baby Fight Club is a fun way to give your baby movement, connection and confidence early on — no pressure, and always with you. Book their free class here: ${link}`;
      case "nudge_8h":
        return `Hi${sp}! If you'd like to try it, the next step is super simple 💪 Tell me and we'll save their free spot, or book it right here: ${link}`;
    }
  }
  // adults
  switch (kind) {
    case "nudge_1h":
      return disc
        ? `Hi${sp}! Still here if you have any questions about ${disc} 🙂`
        : `Hi${sp}! Looks like you haven't booked your free trial yet. Anything I can help with before you reserve? 🙂`;
    case "nudge_6h":
      return `Hi${sp}! So many of our students tell us joining changed their life — for the fitness, the weight they lost, or the confidence of learning to defend themselves 🙌 Whenever you're ready I'll help you find a time: ${link}`;
    case "nudge_8h":
      return `Hi${sp}! Your first class is a FREE trial 🥋 Want to lock in a spot? You can book here: ${link}`;
  }
}

// ---- extended copy (nudge_d2 … nudge_d5) ----

/**
 * Program-specific extended-drip copy. Pure over (contact, kind, program). Every
 * message ends with the booking link (and a question). Adults/baby adapted from
 * ManyChat's later steps; kids authored to match the adults arc.
 */
export function extendedCopy(
  contact: Contact | null,
  kind: ExtendedKind,
  program: Program,
): string {
  const q = parseQualification(contact);
  const lang: Language = contact?.lang === "en" ? "en" : "es";
  const sp = nameSuffix(firstName(contact, q));
  const link = programLink(program);
  const table = lang === "en" ? EXTENDED_EN : EXTENDED_ES;
  const line = table[program][kind];
  return line(sp, link);
}

type ExtendedLine = (sp: string, link: string) => string;
// Mapped over the finite Program/ExtendedKind keys so indexing stays total under
// noUncheckedIndexedAccess (no spurious `| undefined`).
type ExtendedTable = { [P in Program]: { [K in ExtendedKind]: ExtendedLine } };

const EXTENDED_ES: ExtendedTable = {
  adults: {
    nudge_d2: (sp, link) =>
      `¡Hola${sp}! 👋 ¿Pudiste encontrar algún horario que te quede bien para venir a probar tu día gratuito en MD Condesa? 🙌 Si quieres, agéndalo aquí: ${link}`,
    nudge_d3: (sp, link) =>
      `¡Hola${sp}! Por si te sirve saberlo: no necesitas estar en forma ni tener experiencia para empezar. Justo por eso existe el día gratuito — vienes, pruebas unas clases reales, conoces la academia y ves si el reto se siente como algo que sí puedes sostener 💪 ¿Lo agendamos? ${link}`,
    nudge_d4: (sp, link) =>
      `¡Hola${sp}! A veces el cambio no empieza con una decisión enorme… empieza con una clase. Una hora. Un primer paso. Si buscas más condición, más confianza, más comunidad y más disciplina, esta puede ser una gran forma de empezar 🥋 ¿Te gustaría probar una clase gratis? ${link}`,
    nudge_d5: (sp, link) =>
      `¡Hola${sp}! Parece que por ahora quizá no es el momento, y está bien 🙂 Este será nuestro último mensaje de seguimiento por ahora. Si algo cambia y te gustaría ponerte en forma, aprender a defenderte y ganar confianza, aquí puedes agendar tu día gratuito cuando quieras: ${link}`,
  },
  kids: {
    nudge_d2: (sp, link) =>
      `¡Hola${sp}! 👋 ¿Pudiste ver algún horario que le funcione a tu peque para su clase de prueba en MD Condesa? 🙌 Si quieres, aparta su lugar aquí: ${link}`,
    nudge_d3: (sp, link) =>
      `¡Hola${sp}! Muchos papás nos buscan porque su peque es un poco tímido o ha tenido problemas de bullying. Justo ahí es donde más vemos el cambio: aprenden a defenderse, a poner límites sanos y a creer más en sí mismos 💪 ¿Le agendamos su clase gratis? ${link}`,
    nudge_d4: (sp, link) =>
      `¡Hola${sp}! Además de moverse y salir un rato de las pantallas, los niños hacen amigos, ganan disciplina y se divierten muchísimo 🙌 Es de las cosas que más nos gusta ver clase con clase. Si ves un horario que les funcione, aparta su clase gratis aquí: ${link}`,
    nudge_d5: (sp, link) =>
      `¡Hola${sp}! Parece que quizá no es el momento, y está perfecto 🙂 Este será nuestro último mensaje por ahora. Si más adelante te gustaría que tu peque pruebe una clase, con gusto le apartamos su lugar aquí: ${link}`,
  },
  baby: {
    nudge_d2: (sp, link) =>
      `¡Hola${sp}! Algo que nos ha encantado ver en Baby Fight Club es cómo algunos bebés llegan tímidos al inicio y, después de unas clases, empiezan a moverse con más confianza y hasta se adueñan del tatami 😄 Si todavía les interesa probar, cuéntame y apartamos su clase gratis, o resérvala aquí: ${link}`,
    nudge_d3: (sp, link) =>
      `¡Hola de nuevo${sp}! Además de la clase, al final tenemos 10 minutos de juego libre. Esa parte ha sido increíble para que los bebés exploren, convivan y empiecen a socializar en un espacio seguro 🙌 ¿Quieres que te ayude a apartar su clase gratuita? ${link}`,
    nudge_d4: (sp, link) =>
      `¡Hola${sp}! A esta edad, estimular movimiento, equilibrio, coordinación y confianza puede hacer una gran diferencia. En Baby Fight Club tu bebé se mueve, juega, explora y gana seguridad, siempre acompañado por mamá o papá 💪 Para apartar su clase gratis, resérvala aquí: ${link}`,
    nudge_d5: (sp, link) =>
      `¡Hola${sp}! Parece que quizá no es el momento para ustedes, y está bien 🙂 Este será nuestro último mensaje de seguimiento por el momento. Si más adelante te gustaría que tu bebé pruebe Baby Fight Club, con gusto les apartamos una clase gratuita aquí: ${link}`,
  },
};

const EXTENDED_EN: ExtendedTable = {
  adults: {
    nudge_d2: (sp, link) =>
      `Hi${sp}! 👋 Did you manage to find a time that works to come try your free day at MD Condesa? 🙌 If you'd like, book it here: ${link}`,
    nudge_d3: (sp, link) =>
      `Hi${sp}! In case it helps: you don't need to be fit or have any experience to start. That's exactly why the free trial exists — you come, try real classes, get to know the academy and see if the challenge feels like something you can sustain 💪 Shall we book it? ${link}`,
    nudge_d4: (sp, link) =>
      `Hi${sp}! Change doesn't always start with a huge decision… it starts with one class. One hour. One first step. If you're after more fitness, confidence, community and discipline, this can be a great way to begin 🥋 Want to try a free class? ${link}`,
    nudge_d5: (sp, link) =>
      `Hi${sp}! Maybe now isn't the moment, and that's okay 🙂 This'll be our last follow-up for now. If anything changes and you'd like to get fit, learn to defend yourself and build confidence, you can book your free day anytime here: ${link}`,
  },
  kids: {
    nudge_d2: (sp, link) =>
      `Hi${sp}! 👋 Did you get a chance to find a time that works for your kid's trial class at MD Condesa? 🙌 If you'd like, save their spot here: ${link}`,
    nudge_d3: (sp, link) =>
      `Hi${sp}! A lot of parents come to us because their kid is a bit shy or has dealt with bullying. That's exactly where we see the biggest change: they learn to defend themselves, set healthy boundaries and believe in themselves more 💪 Shall we book their free class? ${link}`,
    nudge_d4: (sp, link) =>
      `Hi${sp}! Beyond moving and getting off screens for a while, kids make friends, gain discipline and have a blast 🙌 It's one of our favorite things to watch class after class. If a time works, save their free class here: ${link}`,
    nudge_d5: (sp, link) =>
      `Hi${sp}! Looks like maybe now isn't the moment, and that's perfectly fine 🙂 This'll be our last message for now. If later you'd like your kid to try a class, we'd be happy to save their spot here: ${link}`,
  },
  baby: {
    nudge_d2: (sp, link) =>
      `Hi${sp}! Something we've loved seeing in Baby Fight Club is how some babies arrive shy at first and, after a few classes, start moving with more confidence and even own the mat 😄 If you're still curious, tell me and we'll save their free class, or book it here: ${link}`,
    nudge_d3: (sp, link) =>
      `Hi again${sp}! Besides the class, we finish with 10 minutes of free play. That part has been amazing for babies to explore, connect and start socializing in a safe space 🙌 Want me to help you save their free class? ${link}`,
    nudge_d4: (sp, link) =>
      `Hi${sp}! At this age, stimulating movement, balance, coordination and confidence can make a big difference. In Baby Fight Club your baby moves, plays, explores and gains security, always with mom or dad 💪 To save their free class, book it here: ${link}`,
    nudge_d5: (sp, link) =>
      `Hi${sp}! Looks like maybe now isn't the moment for you, and that's okay 🙂 This'll be our last follow-up for now. If later you'd like your baby to try Baby Fight Club, we'd gladly save a free class here: ${link}`,
  },
};

/**
 * Template base name for a program's extended step (e.g. "nudge_d2_adults"). The
 * WA sender appends the language suffix (_es/_en). See docs/templates.md.
 */
export function extendedTemplateName(kind: ExtendedKind, program: Program): string {
  return `${kind}_${program}`;
}
