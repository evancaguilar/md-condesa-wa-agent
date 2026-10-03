// One-shot, kv-guarded campaign seeds applied from the worker (same pattern as
// db/indexes.ts and template-sync.ts): campaigns live only in D1 and the
// dashboard needs an owner login, so a campaign Evan asks for from a chat
// session ships here and lands on the first cron tick after deploy. Each seed
// runs once per SEED_KEY; after that the row is Evan's to edit in /admin.
// Idempotent on the trigger phrase too: an existing campaign with the same
// normalized trigger is left alone (the UNIQUE index would reject it anyway).

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { createCampaign, listCampaigns } from "../db/queries-admin.js";
import { normalizeText } from "../pipeline/campaigns.js";

export interface CampaignSeed {
  key: string; // kv guard
  name: string;
  triggerPhrase: string;
  adKeywords: string;
  firstReply: string;
  info: string;
  endsAt?: number | null;
}

// Blindaje 8 (Evan, 2026-10-02; cheatsheet written with Claude Cowork). Ad is
// relaunching as an ongoing campaign, so no end date and no hardcoded dates:
// the "which Saturday" logic reads the clock from <context>.
export const BLINDAJE_8: CampaignSeed = {
  key: "seed_campaign:blindaje-8:2026-10-02",
  name: "Blindaje 8",
  triggerPhrase: "Hola! Quiero apartar mi lugar para la clase gratis de Blindaje 8",
  adKeywords: "blindaje 8, blindaje, defensa personal",
  firstReply:
    "¡Hola! Qué bueno que escribes 🙌 La clase gratis de Blindaje 8 es los sábados a las 12:00 pm en MD Condesa (Av. México 49, Condesa): nuestro programa de fundamentos de defensa personal para personas sin experiencia. ¿Te aparto tu lugar para este sábado? Dime tu nombre completo y si vienes solo o con alguien.",
  info: `BLINDAJE 8 — CLASE GRATIS (programa en curso desde el 3 de octubre de 2026)

QUÉ ES
- Programa de fundamentos de defensa personal en 8 semanas. Integra lo esencial de Jiu-Jitsu brasileño, Muay Thai, Box y MMA aplicado a situaciones reales. Para personas sin experiencia.
- Coach: Daniel Reynoso. Sábados de 12:00 a 1:30 pm en MD Condesa (Av. México 49).
- La primera clase es gratis y sin compromiso para quien viene por primera vez. No hay cupo límite.

QUÉ SÁBADO OFRECER (calcula con la fecha y hora del <context>)
- Blindaje 8 SOLO existe los sábados a las 12:00 pm. Nunca ofrezcas una clase entre semana como si fuera Blindaje.
- Si hoy es sábado y faltan al menos 60 minutos para las 12 pm: ofrece "hoy a las 12 pm".
- Cualquier otro momento: ofrece el próximo sábado a las 12 pm, con su fecha ("el sábado 10 a las 12 pm").
- Si no puede ese sábado, en este orden: (1) el sábado siguiente; (2) pregunta si le quedaría bien un lunes a las 10:00 am, aclarando que es un horario que estamos por abrir y que le avisamos si se confirma; (3) una clase de prueba normal de adultos del horario del KB.
- Si le interesa el lunes 10:00 am: NO lo agendes. Llama escalate_to_human con la nota "Blindaje lunes 10am".

CÓMO AGENDAR
- Pide nombre completo y si viene solo o acompañado. Si viene acompañado, pide el nombre de cada persona y agenda a cada una.
- Agenda con book_trial: disciplina Jiu-Jitsu (jiu), adultos, sábado 12:00 — es la fila del horario donde se da Blindaje 8. En el mensaje de confirmación di "Blindaje 8", no "Jiu-Jitsu".
- Confirma en el chat con fecha, hora y dirección.

PREGUNTAS FRECUENTES
- Qué llevar: ropa deportiva y agua. No se necesita equipo. Se entrena descalzo en el tatami. Llegar 10 minutos antes.
- Instalaciones: área para dejar tus cosas y regaderas.
- Estacionamiento: la info general de la academia (parquímetro en Parque México y calles cercanas).
- Edad (EXCEPCIÓN a la regla general del KB): Blindaje 8 es para adultos de 16 años en adelante. Jóvenes de 14 o 15 pueden venir solo si asisten con su papá o mamá y trabajan juntos como pareja toda la clase. Menores de 14: ofrece la clase de prueba de Kids.
- Condición física: no se necesita; el programa empieza desde cero.
- Lesiones: sí puede venir. Pídele que le avise al coach antes de empezar.
- Contacto y sparring: clase técnica controlada en parejas. El sparring es opcional y se hace después de la clase; lo recomendamos, aunque sea ligero y controlado, para quien de verdad quiere poder defenderse.
- Grupo mixto: la clase es mixta. Si preguntan por una opción solo para mujeres, explica con honestidad que entrenar con hombres tiene sentido, porque así se acostumbran a ese nivel de fuerza por si algún día necesitan usar estas técnicas.
- Después de la clase gratis: el programa sigue 7 sábados más y al final de la clase se explican las opciones para inscribirse.
- Alumnos actuales: pueden asistir gratis a su primera clase de Blindaje.

REGLAS
- Precio: NO lo digas. Di que en la clase se explican las opciones y que la primera clase es gratis y sin compromiso. Si insiste por segunda vez, escala a humano.
- No se puede pagar ni reservar el programa completo antes de la clase. Invítalo a venir primero.
- No prometas resultados. El programa enseña fundamentos.
- No menciones la promo de mañanas $999 ni otros planes a estos leads a menos que pregunten.`,
  endsAt: null,
};

export const CAMPAIGN_SEEDS: readonly CampaignSeed[] = [BLINDAJE_8];

/** Applies every unapplied seed. Returns the names it created. */
export async function seedCampaigns(
  env: Env,
  deps: { postNote: (t: string) => Promise<void> },
  seeds: readonly CampaignSeed[] = CAMPAIGN_SEEDS,
): Promise<string[]> {
  const created: string[] = [];
  for (const seed of seeds) {
    if (await kvGet(env.DB, seed.key)) continue;
    const norm = normalizeText(seed.triggerPhrase);
    const existing = (await listCampaigns(env.DB)).find((c) => c.trigger_norm === norm);
    if (!existing) {
      const c = await createCampaign(env.DB, {
        name: seed.name,
        triggerPhrase: seed.triggerPhrase,
        triggerNorm: norm,
        info: seed.info,
        firstReply: seed.firstReply,
        adKeywords: seed.adKeywords,
        endsAt: seed.endsAt ?? null,
      });
      created.push(seed.name);
      await deps.postNote(
        `📣 Campaña *${seed.name}* creada desde el worker (#${c.id}). Edítala en /admin → Campañas; falta pegar el/los ID(s) del anuncio.`,
      );
    }
    await kvSet(env.DB, seed.key, existing ? `exists:${existing.id}` : "created");
  }
  return created;
}
