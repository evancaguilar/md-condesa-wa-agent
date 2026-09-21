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
    },
    tags: "Tags",
    optOutTag: "Baja",
    childName: "Nombre Del Niñ@",
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
    welcomeEs:
      "¡Bienvenid@ a la familia{who}! 🥋🎉 Nos da mucho gusto tenerte. Lo que sigue: revisa los horarios ({link}) y recuerda que hay 10% de descuento si te inscribes en equipo. ¡Nos vemos en el tatami!",
    welcomeEn:
      "Welcome to the family{who}! 🥋🎉 So glad you joined. Next: check the schedule ({link}) and remember there's a 10% discount when you sign up as a team. See you on the mats!",
    // Post-trial chain (attended, did not sign up). The ONLY offer named here is
    // the standing one from the KB — inscripción $999, gratis al inscribirse en
    // línea. Never add a price, plan or promise that isn't in intake.md.
    postTrialD0Es:
      "¡Hola{who}! Qué gusto verte hoy en el tatami 🥋 ¿Cómo te sentiste en la clase? Si quieres seguir, te guardamos la inscripción sin costo (normalmente $999) durante 48 horas. ¿Te apartamos tu lugar?",
    postTrialD0En:
      "Hi{who}! So good to have you on the mats today 🥋 How did the class feel? If you'd like to keep going, we'll hold the sign-up fee for you free (normally $999) for the next 48 hours. Want us to save your spot?",
    postTrialD2Es:
      "¡Hola{who}! Hoy vence el plazo para guardarte la inscripción sin costo 🥋 ¿Quieres que te apartemos tu lugar antes de que cierre el día?",
    postTrialD2En:
      "Hi{who}! Today is the last day we can hold the free sign-up for you 🥋 Want us to save your spot before the day ends?",
    postTrialD5Es:
      "¡Hola{who}! No queremos insistir más 🙂 Este es nuestro último mensaje. Nos dio mucho gusto tenerte en clase y aquí seguimos cuando quieras volver — estos son los horarios: {link}",
    postTrialD5En:
      "Hi{who}! We won't keep writing 🙂 This is our last message. We loved having you in class and we're here whenever you want to come back — here's the schedule: {link}",
  },
};
