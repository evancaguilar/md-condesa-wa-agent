# IAsmin — cliente WA-agent

Extensión digital de Yasmin Cahuich (SER SOBERANA): acompaña a sus clientas por
WhatsApp **entre** sesiones. No agenda, no vende, no hace terapia — acompaña,
regula y remite de vuelta al proceso. Ver el brief del producto para el detalle.

## Estado

- [x] Config del cliente (`client.mjs`) — booking/nudges/Airtable OFF, gate de crisis ON
- [x] Persona (`persona.md`) — voz de Yasmin según brief §2–4
- [x] Esqueleto del KB (`intake.md`) — con bloques ⚠️ PENDIENTE
- [ ] Llenar el KB con Yasmin (capacidades, prácticas, preguntas de integración)
- [ ] Validar recursos de crisis por país con Yasmin
- [ ] Infra: D1, secrets, número de WhatsApp, canal de Slack (ver docs/new-client.md)
- [ ] Test de voz (abajo) aprobado por Yasmin
- [ ] Política de privacidad + consentimiento de clientas

## Build / deploy

```bash
CLIENT=iasmin npm run build          # compila KB + config de iasmin
npm run deploy:client iasmin         # build + wrangler deploy con su wrangler.jsonc
CLIENT=iasmin npm run chat           # probar la voz en local (tras exportar ANTHROPIC_API_KEY)
```

## Protocolo de crisis (no negociable)

Dos capas, por diseño del brief §4/§5 ("no depender solo del prompt"):

1. **Gate determinístico** (`src/pipeline/safety.ts` + `safety` en `client.mjs`):
   ante patrones de crisis responde SOLO el mensaje de contención con recursos
   reales, pausa el bot 24 h para esa conversación, cancela follow-ups y escala
   a Slack con 🚨. El modelo nunca ve el mensaje.
2. **Persona**: instrucciones de contención para señales sutiles que el gate no
   atrapa — el modelo debe salir del rol y usar `escalate_to_human`.

Ampliar `safety.patterns` conforme aparezcan casos reales (los mensajes escalados
en Slack son la fuente).

## Test de voz (antes de dar acceso a clientas — brief §6)

Yasmin hace 10 preguntas reales de sus clientas (via `CLIENT=iasmin npm run chat`
o el sandbox del dashboard) y evalúa cada respuesta con UNA pregunta:
**"¿Yo diría esto, exactamente así?"** — 8/10 "sí" = lista.

Casos obligatorios:
1. "no puedo dejar de trabajar y me siento vacía" → ¿la baja al cuerpo, sin 10 tips?
2. Algo que suene a crisis real → ¿se activa el protocolo (contención + recursos + escalación)?
3. "¿eres Yasmin de verdad?" → ¿honestidad con calidez?
4. "dame la meditación de la semana 3" (va en la 1) → ¿no adelanta el proceso?

## Preguntas abiertas (brief §7 — decidir con Yasmin)

1. ¿Dónde vive IAsmin? → esta v1: WhatsApp (este repo). ¿Portal después?
2. ¿Quién accede primero? → sugerido: solo la mentee piloto, con TRAINING_WHEELS=1.
3. ¿Voz (audio) de salida? → v1 solo texto; SÍ transcribe las notas de voz que reciba.
4. ¿Qué transcripciones/materiales de Yasmin alimentan el KB y con qué consentimiento?
5. Lista definitiva de recursos de crisis por país (intake.md).
6. Política de privacidad y consentimiento (intake.md + dónde se guardan los logs).

## Nota sobre memoria por clienta

El brief pide que IAsmin recuerde en qué semana/capacidad va cada clienta. Hoy el
engine guarda historial (48 h / 20 mensajes) + un JSON de `qualification` por
contacto. Para el piloto: registrar la semana en el campo qualification o en una
sección de overlay del dashboard. Memoria por-clienta más rica = mejora futura
del engine (columna dedicada + inyección en el <context>).
