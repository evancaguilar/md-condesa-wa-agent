// IAsmin — extensión digital de Yasmin Cahuich (SER SOBERANA) en WhatsApp.
// Companion entre sesiones: SIN agendado, SIN drip de nudges, SIN Airtable.
// Con gate de crisis SIEMPRE activo (ver brief §4 — no negociable).
//
// Consumido por tools/compile-kb.mjs: CLIENT=iasmin npm run build

export default {
  clientId: "iasmin",
  businessName: "IAsmin — SER SOBERANA (Yasmin Cahuich)",
  shortName: "IAsmin",
  ownerName: "Yasmin",
  address: "",
  links: {
    // TODO: enlace real al portal SER SOBERANA / agenda de Yasmin (brief §7.1).
    booking: "",
  },
  // Sin servicios agendables: IAsmin no reserva clases/sesiones en v1.
  services: [],
  features: {
    booking: false,
    nudges: false,
    airtableSync: false,
    safety: true,
  },
  safety: {
    // Se comparan contra el texto normalizado (minúsculas, sin acentos,
    // puntuación → espacio). Escríbelos sin acentos. Ampliar con Yasmin.
    patterns: [
      "suicid",
      "autolesion|auto lesion|cortarme|lastimarme|hacerme dano",
      "\\bmatarme\\b|quitarme la vida|acabar con todo|terminar con todo",
      "no quiero (vivir|existir|seguir|despertar)",
      "quiero desaparecer|quiero morir|me quiero morir|mejor no estar",
      "me esta pegando|me pega\\b|me golpea|me amenaza|tengo miedo de el|tengo miedo de ella",
      "abuso|me violo|violacion",
      "ataque de panico|no puedo respirar|crisis de panico",
      // EN — normalizeText convierte "don't" en "don t".
      "self harm|kill myself|end it all|suicide|want to die|don ?t want to (live|exist)",
    ],
    // Contención simple y cálida + recursos reales. NO terapia, NO profundizar.
    // TODO: validar lista de líneas por país con Yasmin (brief §7.5).
    responseEs:
      "Gracias por confiarme esto. Lo que sientes es importante y mereces apoyo humano real, ahora. 💛 Si estás en peligro llama al 911. En México puedes hablar 24/7 con la Línea de la Vida: 800 911 2000. Ya le avisé a Yasmin para que te acompañe personalmente. No estás sola.",
    responseEn:
      "Thank you for trusting me with this. What you're feeling matters and you deserve real human support, right now. 💛 If you're in danger call 911. In Mexico you can talk 24/7 to Línea de la Vida: 800 911 2000. I've alerted Yasmin so she can be with you personally. You are not alone.",
    pauseHours: 24,
  },
  copy: {
    // Booking/Airtable están apagados: confirm/noShow/welcome no se usan en v1,
    // pero el contrato los pide. checkin SÍ se usa (follow-ups tipo 'custom').
    confirmEs: "Quedó agendado{who}. 💛",
    confirmEn: "You're all set{who}. 💛",
    checkinEs: "Hola 💛 soy IAsmin. ¿Cómo va tu semana? ¿Cómo está tu cuerpo hoy?",
    checkinEn: "Hi 💛 it's IAsmin. How is your week going? How is your body today?",
    noShowEs: "Hola{who}, te esperábamos. ¿Reagendamos? {link}",
    noShowEn: "Hi{who}, we missed you. Want to reschedule? {link}",
    welcomeEs: "Bienvenida{who} 💛 {link}",
    welcomeEn: "Welcome{who} 💛 {link}",
  },
};
