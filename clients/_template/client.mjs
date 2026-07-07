// {{CLIENT_ID}} — configuración del negocio.
// Generado por tools/new-client.mjs. Llena los TODO y ve marcando docs/new-client.md.

export default {
  clientId: "{{CLIENT_ID}}",
  businessName: "TODO Nombre completo del negocio",
  shortName: "TODO Nombre corto", // etiquetas de Slack y copy de check-in
  ownerName: "TODO Nombre del dueño", // lo usa el editor de KB del dashboard
  address: "", // dirección física si aplica (copy de confirmación)
  links: {
    booking: "", // enlace de auto-agenda si existe
    // bookingKids: "",
    // schedule: "",
  },
  // Servicios agendables (solo si features.booking = true). key = clave compacta
  // que emite el modelo; match = regex (sin acentos, minúsculas) que mapea
  // etiquetas libres a la key.
  services: [
    // { key: "clase", label: "Clase muestra", match: "clase|muestra|trial" },
  ],
  features: {
    booking: false, // book_trial + validación de slots + registro en Airtable
    nudges: false, // drip de re-enganche a leads fríos (+1h/+6h/+8h)
    airtableSync: false, // sync de reservas/resultados/alumnos desde Airtable
    safety: false, // gate de crisis pre-modelo (OBLIGATORIO en clientes de acompañamiento emocional)
  },
  // Descomenta si features.safety = true (ver clients/iasmin/client.mjs de ejemplo):
  // safety: {
  //   patterns: ["suicid", "no quiero (vivir|existir)"], // sin acentos, minúsculas
  //   responseEs: "TODO contención + recursos reales (911, Línea de la Vida 800 911 2000…)",
  //   responseEn: "TODO containment + real resources",
  //   pauseHours: 24,
  // },
  copy: {
    // Placeholders disponibles: {who} → " Nombre" o "", {address}, {link}.
    confirmEs: "¡Hola{who}! Tu cita quedó agendada. Estamos en {address}. ¡Nos vemos!",
    confirmEn: "Hi{who}! You're booked. We're at {address}. See you soon!",
    checkinEs: "¡Hola! Te escribimos de TODO-nombre 👋",
    checkinEn: "Hi! Just checking in from TODO-name 👋",
    noShowEs: "¡Hola{who}! Te esperábamos. ¿Reagendamos? {link}",
    noShowEn: "Hi{who}! We missed you. Want to reschedule? {link}",
    welcomeEs: "¡Bienvenid@{who}! 🎉 {link}",
    welcomeEn: "Welcome{who}! 🎉 {link}",
  },
};
