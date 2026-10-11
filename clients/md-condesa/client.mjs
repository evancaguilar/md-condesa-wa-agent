// MD Self Defense Academy Condesa — client configuration.
// Consumed by tools/compile-kb.mjs, which generates src/client.gen.ts (typed
// against src/client-config.ts). Copy strings support {who}, {address}, {link}.

const BOOKING_ADULTS = "https://mdcondesa.com/clase-prueba-adultos/";
const BOOKING_KIDS = "https://mdcondesa.com/clase-prueba-ninos/";

export default {
  clientId: "md-condesa",
  businessName: "MD Self Defense Academy Condesa",
  shortName: "MD Condesa",
  ownerName: "Evan",
  address: "Av. México 49, 1º piso, Condesa",
  links: {
    booking: BOOKING_ADULTS,
    bookingKids: BOOKING_KIDS,
    schedule: "https://mdcondesa.com/#horarios",
    // New-member guide (unlisted page, generated from content/welcome.js in
    // the site repo): schedule, address, plan benefits, Venum gear discount.
    welcome: "https://mdcondesa.com/bienvenida/",
    // Members' WhatsApp group (one group for everyone, owner 2026-10-03).
    group: "https://chat.whatsapp.com/J72ov37T8BuBp6u1eJwSg9?mode=gi_t",
  },
  services: [
    { key: "jiu", label: "Jiu-Jitsu", match: "jiu|bjj|jitsu|grappl" },
    { key: "muay", label: "Muay Thai", match: "muay|thai" },
    { key: "mma", label: "MMA", match: "mma|mixed" },
    { key: "box", label: "Boxing", match: "box|boxe" },
    { key: "baby", label: "Baby Fight Club", match: "baby" },
  ],
  // Days the academy is CLOSED (CDMX dates). The brain is told in the per-turn
  // context, nudges never propose a class on them, and book_trial rejects them.
  // Add a row per holiday/closure; past dates are harmless (kept as history).
  closedDates: [
    { date: "2026-09-16", reason: "Día de la Independencia" },
  ],
  // Trial offers are SOONEST-FIRST (same-day trials show 54% vs ~29% for ones
  // a day or more out — Jul 1–Sep 21 2026, 645 trials). preferredBlocks is the
  // ONLY thing that may outrank a sooner class, and only when both fall inside
  // the same 24h: fill it with the hours Evan is on the floor closing.
  //   dow: 0=Mon … 6=Sun (the SLOTS convention, NOT JS getDay()).
  //   from/to: inclusive class START times, "HH:mm" 24h CDMX.
  //   e.g. { dow: 5, from: "09:00", to: "13:00" } = sábado por la mañana.
  // EMPTY (the default) = pure soonest-first. Never a restriction — a block
  // never hides a class, it only wins a tie.
  booking: {
    preferredBlocks: [],
  },
  // What Meta charges per delivered template message to a MEXICO number, taken
  // VERBATIM from Meta's own USD rate card (the "USD rates" CSV linked from
  // https://developers.facebook.com/docs/whatsapp/pricing/, row
  // "Mexico,USD,0.0305,0.0085,0.0085,n/a,n/a" = marketing, utility,
  // authentication). Only used to ESTIMATE the cost of bulk sends in /admin —
  // never to decide whether to send. Meta updates rates quarterly (a Mexico
  // marketing INCREASE is already announced for 2026-10-01): when it changes,
  // edit the numbers + asOf here and run `npm run build`. Never guess them.
  whatsappPricing: {
    currency: "USD",
    marketing: 0.0305,
    utility: 0.0085,
    asOf: "2026-07",
    source: "https://developers.facebook.com/docs/whatsapp/pricing/",
  },
  features: {
    booking: true,
    nudges: true,
    airtableSync: true,
    safety: false,
    // IG/FB DM channels ship dark until Meta App Review round 2 approves the
    // Messenger/Instagram permissions — flip only with Evan's OK.
    instagram: false,
    messenger: false,
    // Marketing-funnel metrics feeder (docs/marketing-metrics.md).
    marketingMetrics: true,
    // Conversions API for Business Messaging (docs/meta-capi.md): send Booked /
    // Attended / Purchase back to Meta for ctwa_clid leads. OFF until Evan
    // creates the dataset and sets META_CAPI_DATASET_ID — flip only with his OK.
    metaCapi: false,
    // Customer-list audiences (paid / active students) synced daily to the ad
    // account (docs/meta-audiences.md). ON since 2026-10-07: first upload done
    // by Evan (860 + 211 rows), both audiences ACTIVE on Meta.
    metaAudiences: true,
  },
  // Real Leads-table columns (base appcX38TBVltyxHR6). The CRM predates the
  // bot and its automations depend on these Spanish names — never rename them.
  airtableLeads: {
    phone: "# de Teléfono",
    name: "Nombre de Lead",
    source: "Canal",
    sourceValue: "WA",
    // Evan must add these options to the Canal select before flipping the
    // IG/FB feature flags (a missing option fails the sync loudly, not as WA).
    sourceValueIg: "IG",
    sourceValueFb: "FB",
    ad: "Ad",
    campaign: "Campaña",
    trialDateTime: "Fecha Clase Prueba",
    discipline: "Actividad",
    disciplineIsMulti: true,
    audience: "Programa",
    result: "Resultado Clase Prueba",
    disciplineValues: {
      jiu: "BJJ",
      muay: "Muay Thai",
      mma: "MMA",
      box: "Box",
      "jiu:kid": "BJJ Kids",
      "muay:kid": "Muay Thai Kids",
      baby: "Baby Fight Club",
    },
    audienceValues: {
      adult: "Adultos",
      kid: "Kids",
      baby: "Baby Fight Club (BFC)",
      mini: "Mini Muay Thai", // 3–5 años (option renamed from "Peques", 2026-10-11)
      teens: "Teens", // 13–17
    },
    tags: "Tags",
    optOutTag: "Baja",
    childName: "Nombre Del Niñ@",
    // Read-only: enrolment amount (MXN), used as the Purchase value sent to
    // Meta's Conversions API (docs/meta-capi.md). The worker never writes it.
    initialPayment: "Pago Inicial",
    // Conversions API columns (docs/meta-capi.md). The click id is written
    // fill-if-empty; the three 0/1 formulas are read by the 15-min sweep; the
    // multi-select is marked by the drain ONLY after Meta answers 2xx; the
    // rollup is the Purchase value (never written).
    ctwaClid: "CTWA Click ID",
    booked: "Agendó",
    attended: "Asistió",
    closed: "Cerró",
    metaEventsSent: "Eventos Meta Enviados",
    leadIncome: "Ingresos Lead",
    // Sales-conversation recordings → transcript + AI summary (2026-09-18).
    salesAudio: {
      audio: "Audio venta",
      transcript: "Transcripción venta",
      summary: "Resumen venta (IA)",
      processed: "Audio venta procesado",
    },
  },
  // Marketing-metrics contract (docs/marketing-metrics.md). Airtable does the
  // math; these are the table/column names the worker writes and reads.
  airtableMetrics: {
    tables: {
      spend: "Ad Spend Diario",
      ads: "Anuncios Meta",
      campaigns: "Campañas Meta",
      days: "Días",
      months: "Meses",
      students: "Alumnos",
      movements: "Movimientos",
    },
    spend: {
      key: "Clave",
      date: "Fecha",
      account: "Cuenta",
      adId: "Ad ID",
      adName: "Nombre Anuncio",
      adSetName: "Ad Set",
      adSetId: "Ad Set ID",
      campaignId: "Campaña Meta ID",
      campaignName: "Campaña Meta Nombre",
      spend: "Gasto",
      impressions: "Impresiones",
      clicks: "Clics",
      reach: "Alcance",
      conversations: "Conversaciones (Meta)",
      updated: "Actualizado",
      adLink: "Anuncio",
      campaignLink: "Campaña Meta",
      dayLink: "Día",
      monthLink: "Mes",
    },
    ads: { adId: "Ad ID", name: "Nombre", adSet: "Ad Set", campaignLink: "Campaña Meta" },
    campaigns: { campaignId: "Campaña ID", name: "Nombre" },
    leads: {
      created: "Fecha de Creación",
      dayText: "Día Lead",
      monthText: "Mes Lead",
      adId: "Ad ID",
      dayLink: "Día",
      monthLink: "Mes",
      adLink: "Anuncio",
      pendingAttendance: "Asistencia Pendiente",
      closed: "Cerró",
      origin: "Origen",
      originUnknown: "Desconocido",
    },
    students: {
      name: "Alumno",
      phone: "Teléfono",
      leadLink: "Lead Original",
      created: "Fecha de creación",
      totalPaid: "Total Pagado",
      eligibleIncome: "Ingresos Elegibles",
      // Audience sync (docs/meta-audiences.md).
      email: "Email",
      status: "Status",
      activeFlag: "Vigencia por Fecha Activa",
      excludedStatuses: ["Profesor", "Seminario", "Visitantes de Pago"],
    },
    movements: {
      date: "Fecha de Pago",
      concept: "Concepto",
      type: "Ingreso/Egreso",
      typeIncome: "Ingreso",
      conceptSurplus: "Sobrante",
      studentLink: "Alumnos",
    },
    periods: {
      dayKey: "Día",
      monthKey: "Mes",
      spend: "Gasto",
      conversations: "Conversaciones Meta",
      leads: "Total Leads",
      paidLeads: "Leads Pagados",
      unknownLeads: "Desconocidos",
      booked: "Agendaron",
      pastTrials: "Pruebas Vencidas",
      showed: "Asistieron",
      pending: "Pendientes",
      closed: "Cerraron",
      closedAfterTrial: "Cerraron Tras Prueba",
      directCloses: "Cierres Directos",
      marked: "Inscritos (marcados)",
      revenue: "Ingresos",
      revenue90: "Ingresos 90d",
      cpl: "CPL",
      costPerBooking: "Costo por Agendada",
      costPerShow: "Costo por Asistencia",
      costPerClose: "Costo por Cierre",
      showRate: "Show Rate",
      closeRate: "Close Rate",
      roas: "ROAS",
      roas90: "ROAS 90d",
      provisional: "Provisional",
    },
  },
  // Customer-list audiences on act_1334257084455191 (docs/meta-audiences.md).
  metaAudiences: {
    paid: "MD Condesa - Alumnos que han pagado (Airtable)",
    active: "MD Condesa - Alumnos activos",
  },
  copy: {
    confirmEs:
      "¡Hola{who}! 🥋 Tu clase de prueba quedó agendada. Estamos en {address}. Trae ropa cómoda y una botella de agua — no necesitas equipo, nosotros te lo prestamos. ¡Nos vemos!",
    confirmEn:
      "Hi{who}! 🥋 Your trial class is booked. We're at {address}. Bring comfortable clothes and a water bottle — no gear needed, we lend it. See you soon!",
    checkinEs: "¡Hola! Te escribimos de MD Condesa 🥋",
    checkinEn: "Hi! Just checking in from MD Condesa 🥋",
    // {cta} = the engine's closing line: ONE real upcoming slot from the
    // schedule ("Te puedo apartar lugar en Muay Thai mañana viernes 7:00 am —
    // ¿te late? Si prefieres otro horario: <link>"), or a plain link line when
    // the grid has nothing to offer.
    noShowEs:
      "¡Hola{who}! Te esperábamos en tu clase de prueba 🥋 No pasa nada, ¿la reagendamos? {cta}",
    noShowEn:
      "Hi{who}! We missed you at your trial class 🥋 No worries — want to reschedule? {cta}",
    noShowD3Es:
      "¡Hola{who}! Seguimos con tu lugar apartado para tu clase de prueba gratis en MD Condesa 🥋 {cta}",
    noShowD3En:
      "Hi{who}! We're still holding a spot for your free trial class at MD Condesa 🥋 {cta}",
    // Enrolment welcome (result watcher, "Se inscribió"). Short on purpose:
    // group link inline, everything else lives on the new-member page
    // ({link} = links.welcome). Same text is the student_welcome template
    // (docs/templates.md) for the closed-window fallback — keep them in sync.
    // No name on purpose (owner 2026-10-03): push names are too often junk.
    welcomeEs:
      "¡Bienvenid@ a la familia MD Condesa! 🥋🎉 Nos da mucho gusto tenerte.\n\nLo primero: únete al grupo de WhatsApp de la academia. Ahí avisamos cambios de horario, eventos y dudas rápidas: {group}\n\nY guarda tu guía de nuevo miembro: horarios, lo básico de cada disciplina, qué incluye tu plan y cómo pedir tu equipo Venum con 25% de descuento: {link}\n\nUn dato: este WhatsApp es el de ventas. Puedes seguir escribiendo aquí para dudas generales, pero para hablar con el equipo administrativo o recepción escribe al +52 55 3426 0813.\n\n¡Nos vemos en el tatami!",
    welcomeEn:
      "Welcome to the MD Condesa family! 🥋🎉 So glad to have you.\n\nFirst thing: join the academy WhatsApp group. That's where we post schedule changes, events and quick answers: {group}\n\nAnd save your new-member guide: schedule, the basics of each discipline, what your plan includes and how to order Venum gear at 25% off: {link}\n\nOne note: this WhatsApp is our sales line. You can keep writing here for general questions, but to reach the admin team or front desk, message +52 55 3426 0813.\n\nSee you on the mats!",
    // Post-trial chain (attended, did not sign up).
    // NO PRICE, NO DISCOUNT, NO DEADLINE in any of these (owner, 2026-09-21):
    // the inscription discount is SAME-DAY-ONLY at the academy, so holding it
    // open for 48h in a follow-up would be a promise we cannot keep. These
    // messages open a conversation; the humans quote the numbers.
    postTrialD0Es:
      "¡Hola{who}! Qué gusto verte hoy en la academia 🥋 ¿Qué te pareció la experiencia? Vi que todavía no queda tu inscripción — ¿ya te decides a dar el paso? Te ayudo a dejarla lista hoy mismo.",
    postTrialD0En:
      "Hi{who}! So good to have you at the academy today 🥋 How was the experience? I noticed you haven't signed up yet — ready to take the step? I can get your enrollment done today.",
    // Same touch when d0 lands on a later CDMX day than the class (evening
    // classes: d0 is pushed to 09:30 next morning) — "ayer", not "hoy".
    postTrialD0AyerEs:
      "¡Hola{who}! Qué gusto verte ayer en la academia 🥋 ¿Qué te pareció la experiencia? Vi que todavía no queda tu inscripción — ¿ya te decides a dar el paso? Te ayudo a dejarla lista hoy mismo.",
    postTrialD0AyerEn:
      "Hi{who}! So good to have you at the academy yesterday 🥋 How was the experience? I noticed you haven't signed up yet — ready to take the step? I can get your enrollment done today.",
    postTrialD2Es:
      "¡Hola{who}! ¿Cómo amaneció el cuerpo después de tu clase? 😄 Lo más difícil ya lo hiciste: venir la primera vez. ¿Qué te falta saber para decidirte? Te ayudamos a elegir horario y paquete.",
    postTrialD2En:
      "Hi{who}! How's the body feeling after your class? 😄 The hardest part is already done: showing up the first time. What else do you need to know to decide? We'll help you pick a schedule and a plan.",
    postTrialD5Es:
      "¡Hola{who}! No queremos insistir más 🙂 Este es nuestro último mensaje. Nos dio mucho gusto tenerte en clase y aquí seguimos cuando quieras volver — estos son los horarios: {link}",
    postTrialD5En:
      "Hi{who}! We won't keep writing 🙂 This is our last message. We loved having you in class and we're here whenever you want to come back — here's the schedule: {link}",
    // ---- v2 chains (2026-10-11, src/cron/post-trial.ts) ----
    // {day} = "hoy" / "ayer" / "el sábado", computed when the message is SENT
    // (never "ayer" two hours after a 7 am class). {kid} = the child's name, or
    // "su peque" / "su bebé" / "su hijo o hija". *Fam* = plural, to the parent.
    // Same no-price rule as above. Template twins: docs/templates.md §11–§16.
    // Attended, did not sign up — same evening (parents; adults keep D0 above).
    postTrialD0FamEs:
      "¡Hola{who}! Qué gusto tenerlos {day} en la academia 🥋 ¿Cómo les fue? ¿Qué le pareció la clase a {kid}? Si se quedaron con ganas de más, les ayudo a dejar lista su inscripción.",
    postTrialD0FamEn:
      "Hi{who}! So good to have you at the academy {day} 🥋 How did it go? What did {kid} think of the class? If you'd like to keep going, I can help you get enrolled.",
    // +3 days, 11:00 — one more class before deciding, ONE real slot ({cta}).
    postTrialD3Es:
      "¡Hola{who}! ¿Cómo sigue el cuerpo después de tu clase? 😄 Tu clase de prueba ya cuenta como primera clase. ¿Te gustaría venir otra vez esta semana antes de decidir? {cta}",
    postTrialD3En:
      "Hi{who}! How's the body feeling after your class? 😄 Your trial already counts as your first class. Would you like to come once more this week before deciding? {cta}",
    postTrialD3FamEs:
      "¡Hola{who}! 👋 La clase de prueba de {kid} ya cuenta como primera clase. ¿Les gustaría venir otra vez esta semana antes de decidir? {cta}",
    postTrialD3FamEn:
      "Hi{who}! 👋 {kid}'s trial already counts as a first class. Would you like to come once more this week before deciding? {cta}",
    // +6 days, 11:00 — the goodbye.
    postTrialD6Es:
      "¡Hola{who}! Cerramos la semana 🙂 Si decides inscribirte, aquí seguimos para ayudarte con horario y paquete; si prefieres más adelante, también está bien. ¡Gracias por venir! Horarios: {link}",
    postTrialD6En:
      "Hi{who}! Wrapping up the week 🙂 If you decide to sign up, we're here to help with schedule and plan; if later works better, that's fine too. Thanks for coming! Schedule: {link}",
    postTrialD6FamEs:
      "¡Hola{who}! Cerramos la semana 🙂 Si deciden inscribir a {kid}, aquí seguimos para ayudarles con horario y paquete; si prefieren más adelante, sin bronca. ¡Gracias por venir! Horarios: {link}",
    postTrialD6FamEn:
      "Hi{who}! Wrapping up the week 🙂 If you decide to enroll {kid}, we're here to help with schedule and plan; if later works better, no problem. Thanks for coming! Schedule: {link}",
    // No-show — class start + 2 h ({day} = hoy, or ayer/el sábado when it
    // lands later), then +2 days and +7 days at 11:00.
    noShowHoyEs:
      "¡Hola{who}! Parece que {day} no pudiste llegar a tu clase de prueba 🙏 Sin bronca, pasa seguido. ¿La reagendamos? {cta}",
    noShowHoyEn:
      "Hi{who}! Looks like you couldn't make it to your trial class {day} 🙏 No worries, it happens. Want to reschedule? {cta}",
    noShowHoyFamEs:
      "¡Hola{who}! Parece que {day} no pudieron llegar a la clase de prueba de {kid} 🙏 Sin bronca, pasa seguido. ¿Se la reagendamos? {cta}",
    noShowHoyFamEn:
      "Hi{who}! Looks like you couldn't make it to {kid}'s trial class {day} 🙏 No worries, it happens. Want to reschedule? {cta}",
    noShowD2Es:
      "¡Hola{who}! Te seguimos guardando tu clase de prueba gratis en MD Condesa 🥋 {cta}",
    noShowD2En:
      "Hi{who}! We're still holding your free trial class at MD Condesa 🥋 {cta}",
    noShowD2FamEs:
      "¡Hola{who}! Les seguimos guardando la clase de prueba gratis de {kid} en MD Condesa 🥋 {cta}",
    noShowD2FamEn:
      "Hi{who}! We're still holding {kid}'s free trial class at MD Condesa 🥋 {cta}",
    noShowD7Es:
      "¡Hola{who}! Es la última vez que te escribimos por aquí 🙂 Si más adelante quieres probar una clase gratis en MD Condesa, mándanos un mensaje y te agendamos. ¡Que estés muy bien!",
    noShowD7En:
      "Hi{who}! This is the last time we'll write here 🙂 If later on you'd like to try a free class at MD Condesa, just message us and we'll book you in. Take care!",
    noShowD7FamEs:
      "¡Hola{who}! Es la última vez que les escribimos por aquí 🙂 Si más adelante quieren que {kid} pruebe una clase gratis en MD Condesa, mándennos un mensaje y les agendamos. ¡Que estén muy bien!",
    noShowD7FamEn:
      "Hi{who}! This is the last time we'll write here 🙂 If later on you'd like {kid} to try a free class at MD Condesa, just message us and we'll book you in. Take care!",
  },
};
