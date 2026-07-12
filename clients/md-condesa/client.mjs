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
  features: {
    booking: true,
    nudges: true,
    airtableSync: true,
    safety: false,
  },
  // Real Leads-table columns (base appcX38TBVltyxHR6). The CRM predates the
  // bot and its automations depend on these Spanish names — never rename them.
  airtableLeads: {
    phone: "# de Teléfono",
    name: "Nombre de Lead",
    source: "Canal",
    sourceValue: "WA",
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
