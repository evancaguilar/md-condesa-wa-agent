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
    // Google Ads click (site attribution.js → WhatsApp prefill ref or form
    // prefill). Text columns; written fill-if-empty, id and time together.
    gclid: "gclid",
    gclidTime: "gclid_time",
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
      "¡Hola{who}! 🥋 Tu clase de prueba quedó agendada. Estamos en {address}. Trae ropa cómoda, agua, y si tienes guantes y vendas tráelos; si no, sin bronca, nosotros te prestamos. ¡Nos vemos!",
    confirmEn:
      "Hi{who}! 🥋 Your trial class is booked. We're at {address}. Bring comfortable clothes, water, and your gloves and wraps if you have them; if not, no worries, we lend them. See you soon!",
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
    // Student kit (owner, 2026-10-13): ~90 s after the welcome, the new student
    // gets their check-in QR as an image (studentQr* = the caption) and, when
    // Airtable says the responsiva is unsigned, the signing link
    // ({link} = the Alumno's `Link Responsiva`, prefilled with name/phone/email).
    // Same text is the student_qr / student_responsiva Utility templates for the
    // closed window (docs/templates.md §17–18) — there the "👉 {link}" line is
    // dropped because the link rides on the URL button. Keep them in sync.
    studentQrEs:
      "Este es tu código QR de acceso 🥋 Guárdalo en tus fotos y escanéalo en recepción al llegar a cada clase.\n\nCon eso registramos tu asistencia, y es lo que usamos para seguir tu avance: grados, graduaciones y quién está listo para competir.",
    studentQrEn:
      "This is your check-in QR code 🥋 Save it to your photos and scan it at the front desk when you arrive for each class.\n\nThat's how we log your attendance, and it's what we use to track your progress: stripes, promotions and who's ready to compete.",
    studentResponsivaEs:
      "Último paso: tu responsiva. Toma 2 minutos desde tu cel y la necesitamos firmada antes de tu siguiente clase 📝\n\n👉 {link}",
    studentResponsivaEn:
      "Last step: your waiver. It takes 2 minutes from your phone and we need it signed before your next class 📝\n\n👉 {link}",
    // Pre-trial questionnaire (docs/cuestionario.md, owner copy 2026-10-13).
    // Sent ONCE right after the booking confirmation (src/services/cuestionario.ts).
    // {who} = " Nombre" or "" (→ "Listo, quedó…"), {cuando} = " el jueves 16 de
    // octubre a las 7:00 PM" (or "" when the record has no date), {kid} = the
    // child's name or "tu peque", {link} = the tokenized questionnaire link.
    cuestionarioEs:
      "Listo{who}, quedó tu clase{cuando}. Una cosa más - contéstanos esto en 3 minutos para que tu coach te reciba sabiendo qué buscas. Es lo que hace que tu primera clase sea para ti y no una clase genérica: {link}",
    cuestionarioEn:
      "All set{who}, your class is booked{cuando}. One more thing - answer this in 3 minutes so your coach meets you already knowing what you're looking for. It's what makes your first class about you instead of a generic class: {link}",
    cuestionarioKidsEs:
      "Listo{who}, quedó tu clase{cuando}. Una cosa más - contéstanos esto en 3 minutos para que tu coach reciba a {kid} sabiendo qué buscan ustedes. Es lo que hace que su primera clase sea para {kid} y no una clase genérica: {link}",
    cuestionarioKidsEn:
      "All set{who}, the class is booked{cuando}. One more thing - answer this in 3 minutes so the coach meets {kid} already knowing what you're looking for as a family. It's what makes the first class about {kid} instead of a generic class: {link}",
    cuestionarioBfcEs:
      "Listo{who}, quedó tu clase{cuando}. Una cosa más - contéstanos esto en 2 minutos para que tu coach reciba a {kid} sabiendo qué buscan ustedes. Es lo que hace que su primera clase sea para {kid} y no una clase genérica: {link}",
    cuestionarioBfcEn:
      "All set{who}, the class is booked{cuando}. One more thing - answer this in 2 minutes so the coach meets {kid} already knowing what you're looking for as a family. It's what makes the first class about {kid} instead of a generic class: {link}",
    // Day-before reminder when the questionnaire told us what they want
    // (free-form path only; the WA template fallback is unchanged).
    // {motivo} = Motivo principal (or Meta 6 meses), lowercased, no final period.
    reminderMotivoEs:
      "Hola{who}! Mañana a las {hora} es tu clase. Ya le pasé al coach que buscas {motivo}, te va a estar esperando. Av. México 49, 1º piso. Llega 10 min antes.",
    reminderMotivoEn:
      "Hi{who}! Your class is tomorrow at {hora}. I already told the coach you're looking for {motivo}, they'll be expecting you. Av. México 49, 1st floor. Please arrive 10 min early.",
    // Same for kids/bfc (to the parent); {kid} = the child's name. Unknown
    // child name → the generic reminder.
    reminderMotivoKidsEs:
      "Hola{who}! Mañana a las {hora} es la clase de {kid}. Ya le pasé al coach que buscan {motivo}, lo va a estar esperando. Av. México 49, 1º piso. Lleguen 10 min antes.",
    reminderMotivoKidsEn:
      "Hi{who}! {kid}'s class is tomorrow at {hora}. I already told the coach you're looking for {motivo}, they'll be expecting {kid}. Av. México 49, 1st floor. Please arrive 10 min early.",
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
    // "su peque" / "su bebé" / "su hijo o hija". *Kids* = plural, to the parent
    // (mini / kids / teens). *Baby* = Baby Fight Club (6–36 months): plural, the
    // parent moves WITH the baby the whole class — never "tu cuerpo", never ask
    // what the baby "thought"; movement / coordination / confidence framing.
    // Same no-price rule as above. Template twins: docs/templates.md §11–§16.
    // Attended, did not sign up — same evening (parents; adults keep D0 above).
    postTrialD0KidsEs:
      "¡Hola{who}! Qué gusto tenerlos {day} en la academia 🥋 ¿Cómo les fue? ¿Qué le pareció la clase a {kid}? Si se quedaron con ganas de más, les ayudo a dejar lista su inscripción.",
    postTrialD0KidsEn:
      "Hi{who}! So good to have you at the academy {day} 🥋 How did it go? What did {kid} think of the class? If you'd like to keep going, I can help you get enrolled.",
    postTrialD0BabyEs:
      "¡Hola{who}! Qué gusto tenerlos {day} en Baby Fight Club 🥋 ¿Cómo les fue a {kid} y a ustedes moviéndose juntos? Si se quedaron con ganas de más, les ayudo a dejar lista su inscripción.",
    postTrialD0BabyEn:
      "Hi{who}! So good to have you at Baby Fight Club {day} 🥋 How did it go for {kid} and you, moving together? If you'd like to keep going, I can help you get enrolled.",
    // +3 days, 11:00 — ready to join? (no slot offer, owner 2026-10-15).
    postTrialD3Es:
      "¡Hola{who}! Ya tuviste unos días para pensarlo 🙂 ¿Te animas a dar el paso y unirte a la academia? Si tienes alguna duda, aquí estoy para ayudarte.",
    postTrialD3En:
      "Hi{who}! You've had a few days to think it over 🙂 Ready to take the step and join the academy? If you have any questions, I'm here to help.",
    postTrialD3KidsEs:
      "¡Hola{who}! Ya tuvieron unos días para pensarlo 🙂 ¿Se animan a dar el paso e inscribir a {kid} en la academia? Si tienen alguna duda, aquí estoy para ayudarles.",
    postTrialD3KidsEn:
      "Hi{who}! You've had a few days to think it over 🙂 Ready to take the step and enroll {kid} at the academy? If you have any questions, I'm here to help.",
    postTrialD3BabyEs:
      "¡Hola{who}! Ya tuvieron unos días para pensarlo 🙂 ¿Se animan a dar el paso e inscribir a {kid} en Baby Fight Club? Si tienen alguna duda, aquí estoy para ayudarles.",
    postTrialD3BabyEn:
      "Hi{who}! You've had a few days to think it over 🙂 Ready to take the step and enroll {kid} in Baby Fight Club? If you have any questions, I'm here to help.",
    // +6 days, 11:00 — the goodbye: what could we improve? (no link).
    postTrialD6Es:
      "¡Hola{who}! Vi que todavía no te has inscrito. ¿Hay algo en particular que podríamos mejorar para que te hubieras animado a inscribirte? Tu opinión nos ayuda mucho 🙏",
    postTrialD6En:
      "Hi{who}! I noticed you haven't signed up yet. Is there anything in particular we could improve that would have made you want to sign up? Your feedback helps us a lot 🙏",
    postTrialD6KidsEs:
      "¡Hola{who}! Vi que todavía no han inscrito a {kid}. ¿Hay algo en particular que podríamos mejorar para que se hubieran animado a inscribirse? Su opinión nos ayuda mucho 🙏",
    postTrialD6KidsEn:
      "Hi{who}! I noticed you haven't enrolled {kid} yet. Is there anything in particular we could improve that would have made you want to sign up? Your feedback helps us a lot 🙏",
    postTrialD6BabyEs:
      "¡Hola{who}! Vi que todavía no han inscrito a {kid} en Baby Fight Club. ¿Hay algo en particular que podríamos mejorar para que se hubieran animado a inscribirse? Su opinión nos ayuda mucho 🙏",
    postTrialD6BabyEn:
      "Hi{who}! I noticed you haven't enrolled {kid} in Baby Fight Club yet. Is there anything in particular we could improve that would have made you want to sign up? Your feedback helps us a lot 🙏",
    // No-show — class start + 2 h ({day} = hoy, or ayer/el sábado when it
    // lands later), then +2 days and +7 days at 11:00. hoy carries the
    // program booking link ({link}); d2 one real slot ({cta}).
    noShowHoyEs:
      "¡Hola{who}! Parece que {day} no pudiste llegar a tu clase de prueba 🙏 Sin bronca, pasa seguido. ¿La reagendamos? Aquí puedes elegir otro día: {link}",
    noShowHoyEn:
      "Hi{who}! Looks like you couldn't make it to your trial class {day} 🙏 No worries, it happens. Want to reschedule? You can pick another day here: {link}",
    noShowHoyKidsEs:
      "¡Hola{who}! Parece que {day} no pudieron llegar a la clase de prueba de {kid} 🙏 Sin bronca, pasa seguido. ¿Se la reagendamos? Aquí pueden elegir otro día: {link}",
    noShowHoyKidsEn:
      "Hi{who}! Looks like you couldn't make it to {kid}'s trial class {day} 🙏 No worries, it happens. Want to reschedule? You can pick another day here: {link}",
    noShowHoyBabyEs:
      "¡Hola{who}! Parece que {day} no pudieron llegar a la clase de prueba de {kid} en Baby Fight Club 🙏 Sin bronca, pasa seguido. ¿Se la reagendamos? Aquí pueden elegir otro día: {link}",
    noShowHoyBabyEn:
      "Hi{who}! Looks like you couldn't make it to {kid}'s Baby Fight Club trial class {day} 🙏 No worries, it happens. Want to reschedule? You can pick another day here: {link}",
    noShowD2Es:
      "¡Hola{who}! Te seguimos guardando tu día de prueba gratis en MD Condesa 🥋 Elige el día que te quede mejor aquí: {link}",
    noShowD2En:
      "Hi{who}! We're still holding your free trial day at MD Condesa 🥋 Pick the day that works best for you here: {link}",
    noShowD2KidsEs:
      "¡Hola{who}! Les seguimos guardando el día de prueba gratis de {kid} en MD Condesa 🥋 Elijan el día que les quede mejor aquí: {link}",
    noShowD2KidsEn:
      "Hi{who}! We're still holding {kid}'s free trial day at MD Condesa 🥋 Pick the day that works best for you here: {link}",
    noShowD2BabyEs:
      "¡Hola{who}! Les seguimos guardando el día de prueba gratis de {kid} en Baby Fight Club 🥋 Elijan el día que les quede mejor aquí: {link}",
    noShowD2BabyEn:
      "Hi{who}! We're still holding {kid}'s free Baby Fight Club trial day 🥋 Pick the day that works best for you here: {link}",
    noShowD7Es:
      "¡Hola{who}! Es la última vez que te escribimos por aquí 🙂 Si todavía quieres agendar tu clase de prueba gratis en MD Condesa, mándanos un mensaje y te agendamos. ¡Que estés muy bien!",
    noShowD7En:
      "Hi{who}! This is the last time we'll write here 🙂 If you still want to book your free trial class at MD Condesa, just message us and we'll book you in. Take care!",
    noShowD7KidsEs:
      "¡Hola{who}! Es la última vez que les escribimos por aquí 🙂 Si todavía quieren agendar la clase de prueba gratis de {kid} en MD Condesa, mándennos un mensaje y les agendamos. ¡Que estén muy bien!",
    noShowD7KidsEn:
      "Hi{who}! This is the last time we'll write here 🙂 If you still want to book {kid}'s free trial class at MD Condesa, just message us and we'll book you in. Take care!",
    noShowD7BabyEs:
      "¡Hola{who}! Es la última vez que les escribimos por aquí 🙂 Si todavía quieren agendar la clase de prueba gratis de {kid} en Baby Fight Club, mándennos un mensaje y les agendamos. ¡Que estén muy bien!",
    noShowD7BabyEn:
      "Hi{who}! This is the last time we'll write here 🙂 If you still want to book {kid}'s free Baby Fight Club trial class, just message us and we'll book you in. Take care!",
  },
};
