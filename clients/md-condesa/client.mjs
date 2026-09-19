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
    noShowEs:
      "¡Hola{who}! Te esperábamos en tu clase de prueba 🥋 No pasa nada, ¿la reagendamos? Elige otro horario aquí: {link}",
    noShowEn:
      "Hi{who}! We missed you at your trial class 🥋 No worries — want to reschedule? You can pick a new time here: {link}",
    welcomeEs:
      "¡Bienvenid@ a la familia{who}! 🥋🎉 Nos da mucho gusto tenerte. Lo que sigue: revisa los horarios ({link}) y recuerda que hay 10% de descuento si te inscribes en equipo. ¡Nos vemos en el tatami!",
    welcomeEn:
      "Welcome to the family{who}! 🥋🎉 So glad you joined. Next: check the schedule ({link}) and remember there's a 10% discount when you sign up as a team. See you on the mats!",
  },
};
