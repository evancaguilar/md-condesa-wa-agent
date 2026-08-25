// Program classification + per-program nudge copy (R3 of sequences-v2). Pure:
// no DB, no side effects — just (contact, kind, program) → string. Tone mirrors
// the ManyChat flows in docs/manychat-flows.md (warm Mexican Spanish, WhatsApp
// style, light emoji); every message ends with a booking link or a question.
//
// Programs: adults | kids | baby. Adults & baby extended copy is adapted from
// ManyChat; kids extended copy (d2–d5) does not exist there and is AUTHORED here
// following the adults arc (retry → objection-handling → social proof → goodbye).
// The mc.ht links from the transcript are replaced with the real booking URLs.
//
// B (nudge overhaul, 2026-08): every nudge now CLOSES WITH ONE CONCRETE SLOT
// taken from the generated schedule (./next-slot.ts) instead of an open-ended
// "¿hay algo con lo que te pueda ayudar?" or a bare link — proposing a real day
// and hour was the owner's #1 edit pattern. The link stays as the secondary
// option. Kids/baby copy speaks in plural to the parent ("¿les late?") and only
// ever proposes a KID slot; adults stay singular. When the grid yields no slot
// (nextTrialSlot → null) the copy falls back to its pre-B generic form so a send
// never breaks.

import type { Contact, Language, Qualification } from "../types.js";
import { CLIENT } from "../client.gen.js";
import { greetingName } from "./display-name.js";
import type { Slot } from "../brain/slots.gen.js";
import { SLOTS } from "../brain/slots.gen.js";
import {
  disciplineLabel,
  formatSlotLabel,
  nextTrialSlot,
  prettyDiscipline,
  type NextSlot,
} from "./next-slot.js";

// ---- kinds ----

/**
 * Every day-1 drip kind. This is the CANCELLATION surface (and the set the cron
 * dispatcher handles): nudge_6h is no longer scheduled — see
 * SCHEDULED_NUDGE_KINDS — but rows created before that change must still be
 * cancellable and sendable, so it keeps its copy and its kind.
 */
export const NUDGE_KINDS = ["nudge_1h", "nudge_6h", "nudge_8h"] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

/**
 * The day-1 kinds actually SCHEDULED, in send order (B3, 2026-08). The MIDDLE
 * step (nudge_6h, +6h) was dropped: three same-day touches produced 18 leads
 * with 3+ nudges in a single day and only 3 of them ever replied again. Two
 * touches carry the day — the +1h check-in and the +8h free-trial close — and
 * the extended chain picks up at d2.
 */
export const SCHEDULED_NUDGE_KINDS = ["nudge_1h", "nudge_8h"] as const;

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

/**
 * Greeting name: the qualification name (a real name the lead TOLD us) wins;
 * the WhatsApp push name is only used when it passes greetingName's "is this
 * actually a first name?" test — it is user-typed junk as often as not.
 */
function firstName(contact: Contact | null, q: Qualification): string {
  return greetingName(q.name) || greetingName(contact?.name);
}

/** " Nombre" (leading space) or "" — for "¡Hola${sp}!" style greetings. */
function nameSuffix(name: string): string {
  return name ? ` ${name}` : "";
}

/**
 * Program classification (pure). baby if qualification.discipline contains
 * "baby" OR the campaign name matches /baby/i; kids if audience === "kid" OR the
 * campaign is a kids campaign ("Kids", "niños", "peques" — a campaign-only lead
 * has no qualification at all, and was falling through to the adults pitch +
 * adults booking link); else adults.
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
  if (campaignName != null && KIDS_CAMPAIGN_RE.test(campaignName)) return "kids";
  return "adults";
}

/** Campaign names that mean "this lead is a parent", not an adult student. */
const KIDS_CAMPAIGN_RE = /\bkids?\b|ni[ñn]os?|peques?|infantil/i;

// ---- concrete-slot proposal ----

/** Audience a program books into. baby/kids leads must never see an adult slot. */
export function programAudience(program: Program): "adult" | "kid" {
  return program === "adults" ? "adult" : "kid";
}

/**
 * The slot a nudge should propose: the lead's own discipline when they told us
 * one (baby always books Baby Fight Club), otherwise the soonest class of their
 * audience. Pure over (contact, program, now, schedule).
 */
export function nudgeSlot(
  contact: Contact | null,
  program: Program,
  nowEpoch: number,
  schedule: readonly Slot[] = SLOTS,
): NextSlot | null {
  const q = parseQualification(contact);
  const discipline = program === "baby" ? "baby" : (q.discipline ?? null);
  return nextTrialSlot(discipline, programAudience(program), nowEpoch, schedule);
}

/**
 * The closing call-to-action: a concrete slot first ("Te puedo apartar lugar en
 * Muay Thai mañana viernes 7:00 am — ¿te late?"), the booking link second. With
 * no slot available it degrades to the pre-B link-only CTA.
 */
function slotCta(
  program: Program,
  lang: Language,
  slot: NextSlot | null,
  link: string,
  nowEpoch: number,
): string {
  const plural = program !== "adults";
  if (!slot) {
    if (lang === "en") {
      return plural
        ? `You can book their free class here: ${link}`
        : `You can book your free day here: ${link}`;
    }
    return plural
      ? `Pueden apartar su clase gratis aquí: ${link}`
      : `Puedes agendar tu día gratuito aquí: ${link}`;
  }
  const what = disciplineLabel(slot.discipline);
  const when = formatSlotLabel(slot, nowEpoch, lang === "en" ? "en" : "es");
  if (lang === "en") {
    return plural
      ? `I can save their spot in ${what} ${when} — does that work? Or pick another time here: ${link}`
      : `I can save you a spot in ${what} ${when} — does that work? Or pick another time here: ${link}`;
  }
  return plural
    ? `Les puedo apartar lugar en ${what} ${when} — ¿les late? Si prefieren otro horario: ${link}`
    : `Te puedo apartar lugar en ${what} ${when} — ¿te late? Si prefieres otro horario: ${link}`;
}

// ---- day-1 copy (nudge_1h / nudge_6h / nudge_8h) ----

/**
 * Program-specific day-1 nudge copy. Every step opens with a short, warm line
 * and closes with ONE concrete slot (+ link as the fallback option). Step 1
 * deliberately keeps the "todavía no has agendado" opener: booking-recon-core's
 * isNudgePhrase() excludes nudge bodies from the "this message claims a booking"
 * sweep by exactly that phrase — do not drop it without updating that module.
 * Pure over (contact, kind, campaignName, now, schedule).
 */
export function nudgeCopy(
  contact: Contact | null,
  kind: NudgeKind,
  campaignName?: string | null,
  nowEpoch: number = Math.floor(Date.now() / 1000),
  schedule: readonly Slot[] = SLOTS,
): string {
  const q = parseQualification(contact);
  // campaignName matters: a lead who clicked the Baby Fight Club ad and never
  // reached the brain has NO qualification, so without it they fell through to
  // the adults copy — and got the adults pitch + adults booking link (live
  // 2026-08-07). The extended drip has always passed it; day-1 now does too.
  const program = classifyProgram(contact, campaignName);
  const lang: Language = contact?.lang === "en" ? "en" : "es";
  const name = firstName(contact, q);
  const sp = nameSuffix(name);
  const disc = prettyDiscipline(q.discipline ?? "");
  const link = programLink(program);
  const slot = nudgeSlot(contact, program, nowEpoch, schedule);
  const cta = slotCta(program, lang, slot, link, nowEpoch);

  if (lang === "en") return dayOneEn(program, kind, sp, disc, cta);
  return dayOneEs(program, kind, sp, disc, cta);
}

function dayOneEs(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  cta: string,
): string {
  return dayOneEsInner(program, kind, sp, disc, cta) ?? `¡Hola${sp}! 🥋\n${cta}`;
}

function dayOneEsInner(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  cta: string,
): string | undefined {
  if (program === "kids") {
    switch (kind) {
      case "nudge_1h":
        return `¡Hola${sp}! Veo que todavía no has agendado el día gratuito de tu peque 🙂\n${cta}`;
      case "nudge_6h":
        return `¡Hola${sp}! Uno de los cambios más bonitos que vemos en los niños es cómo ganan confianza poco a poco: no solo aprenden técnicas, también se paran más seguros y creen más en sí mismos 🙌\n${cta}`;
      case "nudge_8h":
        return `¡Hola${sp}! La clase de prueba de tu peque es GRATIS y es una gran forma de sacarlo un rato de las pantallas 🥋\n${cta}`;
    }
  }
  if (program === "baby") {
    switch (kind) {
      case "nudge_1h":
        return `¡Hola${sp}! Veo que todavía no has agendado la clase gratuita de tu bebé 🙂\n${cta}`;
      case "nudge_6h":
        return `¡Hola${sp}! A esta edad cada nueva experiencia cuenta mucho 🙌 Baby Fight Club le da a tu bebé movimiento, convivencia y confianza desde pequeñito, siempre acompañado por ti.\n${cta}`;
      case "nudge_8h":
        return `¡Hola${sp}! La primera clase de Baby Fight Club es GRATIS 🥋\n${cta}`;
    }
  }
  // adults
  switch (kind) {
    case "nudge_1h":
      return disc
        ? `¡Hola${sp}! Veo que todavía no has agendado tu día gratuito — sigo por aquí si te quedó alguna duda sobre ${disc} 🙂\n${cta}`
        : `¡Hola${sp}! Veo que todavía no has agendado tu día gratuito 🙂\n${cta}`;
    case "nudge_6h":
      return `¡Hola${sp}! Muchos de nuestros alumnos nos dicen que entrar a la academia les cambió la vida — por la condición, por bajar de peso o por la confianza de aprender a defenderse 🙌\n${cta}`;
    case "nudge_8h":
      return `¡Hola${sp}! Tu primera clase es una prueba GRATIS 🥋\n${cta}`;
  }
}

function dayOneEn(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  cta: string,
): string {
  return dayOneEnInner(program, kind, sp, disc, cta) ?? `Hi${sp}! 🥋\n${cta}`;
}

function dayOneEnInner(
  program: Program,
  kind: NudgeKind,
  sp: string,
  disc: string,
  cta: string,
): string | undefined {
  if (program === "kids") {
    switch (kind) {
      case "nudge_1h":
        return `Hi${sp}! Looks like you haven't booked your kid's free trial yet 🙂\n${cta}`;
      case "nudge_6h":
        return `Hi${sp}! One of the loveliest changes we see in kids is how they slowly gain confidence — they don't just learn technique, they stand taller and believe in themselves more 🙌\n${cta}`;
      case "nudge_8h":
        return `Hi${sp}! Your kid's trial class is FREE, and it's a great way to get them off screens for a bit 🥋\n${cta}`;
    }
  }
  if (program === "baby") {
    switch (kind) {
      case "nudge_1h":
        return `Hi${sp}! Looks like you haven't booked your baby's free class yet 🙂\n${cta}`;
      case "nudge_6h":
        return `Hi${sp}! At this age every new experience counts 🙌 Baby Fight Club gives your baby movement, connection and confidence early on — no pressure, and always with you.\n${cta}`;
      case "nudge_8h":
        return `Hi${sp}! Your baby's first Baby Fight Club class is FREE 🥋\n${cta}`;
    }
  }
  // adults
  switch (kind) {
    case "nudge_1h":
      return disc
        ? `Hi${sp}! Looks like you haven't booked your free trial yet — still here if you have any questions about ${disc} 🙂\n${cta}`
        : `Hi${sp}! Looks like you haven't booked your free trial yet 🙂\n${cta}`;
    case "nudge_6h":
      return `Hi${sp}! So many of our students tell us joining changed their life — for the fitness, the weight they lost, or the confidence of learning to defend themselves 🙌\n${cta}`;
    case "nudge_8h":
      return `Hi${sp}! Your first class is a FREE trial 🥋\n${cta}`;
  }
}

// ---- extended copy (nudge_d2 … nudge_d5) ----

/**
 * Program-specific extended-drip copy. Pure over (contact, kind, program, now).
 * d2–d4 keep their ManyChat-derived value prop and close with the same concrete
 * slot CTA as day-1; d5 is the goodbye, so it keeps the link-only close (no
 * point proposing a class in the message that says we'll stop writing).
 */
export function extendedCopy(
  contact: Contact | null,
  kind: ExtendedKind,
  program: Program,
  nowEpoch: number = Math.floor(Date.now() / 1000),
  schedule: readonly Slot[] = SLOTS,
): string {
  const q = parseQualification(contact);
  const lang: Language = contact?.lang === "en" ? "en" : "es";
  const sp = nameSuffix(firstName(contact, q));
  const link = programLink(program);
  const slot = kind === "nudge_d5" ? null : nudgeSlot(contact, program, nowEpoch, schedule);
  const cta = slotCta(program, lang, slot, link, nowEpoch);
  const table = lang === "en" ? EXTENDED_EN : EXTENDED_ES;
  const line = table[program][kind];
  return line(sp, cta);
}

type ExtendedLine = (sp: string, cta: string) => string;
// Mapped over the finite Program/ExtendedKind keys so indexing stays total under
// noUncheckedIndexedAccess (no spurious `| undefined`).
type ExtendedTable = { [P in Program]: { [K in ExtendedKind]: ExtendedLine } };

const EXTENDED_ES: ExtendedTable = {
  adults: {
    nudge_d2: (sp, cta) =>
      `¡Hola${sp}! 👋 ¿Pudiste ver algún horario que te quede bien para tu día gratuito en MD Condesa?\n${cta}`,
    nudge_d3: (sp, cta) =>
      `¡Hola${sp}! Por si te sirve saberlo: no necesitas estar en forma ni tener experiencia para empezar. Justo por eso existe el día gratuito — vienes, pruebas unas clases reales y ves si se siente como algo que sí puedes sostener 💪\n${cta}`,
    nudge_d4: (sp, cta) =>
      `¡Hola${sp}! A veces el cambio no empieza con una decisión enorme… empieza con una clase. Una hora. Un primer paso 🥋\n${cta}`,
    nudge_d5: (sp, cta) =>
      `¡Hola${sp}! Parece que por ahora quizá no es el momento, y está bien 🙂 Este será nuestro último mensaje de seguimiento por ahora. Si algo cambia y te gustaría ponerte en forma, aprender a defenderte y ganar confianza, aquí estamos.\n${cta}`,
  },
  kids: {
    nudge_d2: (sp, cta) =>
      `¡Hola${sp}! 👋 ¿Pudieron ver algún horario que le funcione a tu peque para su clase de prueba en MD Condesa?\n${cta}`,
    nudge_d3: (sp, cta) =>
      `¡Hola${sp}! Muchos papás nos buscan porque su peque es un poco tímido o ha tenido problemas de bullying. Justo ahí es donde más vemos el cambio: aprenden a defenderse, a poner límites sanos y a creer más en sí mismos 💪\n${cta}`,
    nudge_d4: (sp, cta) =>
      `¡Hola${sp}! Además de moverse y salir un rato de las pantallas, los niños hacen amigos, ganan disciplina y se divierten muchísimo 🙌\n${cta}`,
    nudge_d5: (sp, cta) =>
      `¡Hola${sp}! Parece que quizá no es el momento, y está perfecto 🙂 Este será nuestro último mensaje por ahora. Si más adelante quieren que tu peque pruebe una clase, con gusto les guardamos lugar.\n${cta}`,
  },
  baby: {
    nudge_d2: (sp, cta) =>
      `¡Hola${sp}! Algo que nos ha encantado ver en Baby Fight Club es cómo algunos bebés llegan tímidos y, después de unas clases, se mueven con más confianza y hasta se adueñan del tatami 😄\n${cta}`,
    nudge_d3: (sp, cta) =>
      `¡Hola de nuevo${sp}! Además de la clase, al final tenemos 10 minutos de juego libre. Esa parte ha sido increíble para que los bebés exploren, convivan y socialicen en un espacio seguro 🙌\n${cta}`,
    nudge_d4: (sp, cta) =>
      `¡Hola${sp}! A esta edad, estimular movimiento, equilibrio, coordinación y confianza hace una gran diferencia. En Baby Fight Club tu bebé se mueve, juega y gana seguridad, siempre acompañado por mamá o papá 💪\n${cta}`,
    nudge_d5: (sp, cta) =>
      `¡Hola${sp}! Parece que quizá no es el momento para ustedes, y está bien 🙂 Este será nuestro último mensaje de seguimiento por el momento. Si más adelante quieren que tu bebé pruebe Baby Fight Club, aquí estamos.\n${cta}`,
  },
};

const EXTENDED_EN: ExtendedTable = {
  adults: {
    nudge_d2: (sp, cta) =>
      `Hi${sp}! 👋 Did you manage to find a time that works for your free day at MD Condesa?\n${cta}`,
    nudge_d3: (sp, cta) =>
      `Hi${sp}! In case it helps: you don't need to be fit or have any experience to start. That's exactly why the free trial exists — you come, try real classes and see if it feels like something you can sustain 💪\n${cta}`,
    nudge_d4: (sp, cta) =>
      `Hi${sp}! Change doesn't always start with a huge decision… it starts with one class. One hour. One first step 🥋\n${cta}`,
    nudge_d5: (sp, cta) =>
      `Hi${sp}! Maybe now isn't the moment, and that's okay 🙂 This'll be our last follow-up for now. If anything changes and you'd like to get fit, learn to defend yourself and build confidence, we're here.\n${cta}`,
  },
  kids: {
    nudge_d2: (sp, cta) =>
      `Hi${sp}! 👋 Did you get a chance to find a time that works for your kid's trial class at MD Condesa?\n${cta}`,
    nudge_d3: (sp, cta) =>
      `Hi${sp}! A lot of parents come to us because their kid is a bit shy or has dealt with bullying. That's exactly where we see the biggest change: they learn to defend themselves, set healthy boundaries and believe in themselves more 💪\n${cta}`,
    nudge_d4: (sp, cta) =>
      `Hi${sp}! Beyond moving and getting off screens for a while, kids make friends, gain discipline and have a blast 🙌\n${cta}`,
    nudge_d5: (sp, cta) =>
      `Hi${sp}! Looks like maybe now isn't the moment, and that's perfectly fine 🙂 This'll be our last message for now. If later you'd like your kid to try a class, we'd be happy to save them a spot.\n${cta}`,
  },
  baby: {
    nudge_d2: (sp, cta) =>
      `Hi${sp}! Something we've loved seeing in Baby Fight Club is how some babies arrive shy at first and, after a few classes, move with more confidence and even own the mat 😄\n${cta}`,
    nudge_d3: (sp, cta) =>
      `Hi again${sp}! Besides the class, we finish with 10 minutes of free play. That part has been amazing for babies to explore, connect and start socializing in a safe space 🙌\n${cta}`,
    nudge_d4: (sp, cta) =>
      `Hi${sp}! At this age, stimulating movement, balance, coordination and confidence makes a big difference. In Baby Fight Club your baby moves, plays and gains security, always with mom or dad 💪\n${cta}`,
    nudge_d5: (sp, cta) =>
      `Hi${sp}! Looks like maybe now isn't the moment for you, and that's okay 🙂 This'll be our last follow-up for now. If later you'd like your baby to try Baby Fight Club, we're here.\n${cta}`,
  },
};

/**
 * Template base name for a program's extended step (e.g. "nudge_d2_adults"). The
 * WA sender appends the language suffix (_es/_en). See docs/templates.md.
 */
export function extendedTemplateName(kind: ExtendedKind, program: Program): string {
  return `${kind}_${program}`;
}
