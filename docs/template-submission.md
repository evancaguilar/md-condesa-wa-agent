# WhatsApp template submission pack (Evan: submit these in Meta)

One-time submission artifact for go-live. **Copy source of truth is docs/templates.md** — if the two ever disagree, templates.md wins; update both.

## Where

business.facebook.com → **WhatsApp Manager** → account **"MD Self Defense Condesa"** (WABA `2227852814309146` — the one holding the REAL number +52 55 3426 0813; NOT the test WABA `1545530463899885`) → **Account tools → Message templates** → *Create template*. Templates belong to the WABA — submitting them under the test account makes them unusable on the real number.

## Rules that will break sends if you miss them

1. **Template NAME must match exactly** (lowercase, underscores): the worker sends e.g. `trial_confirm_es`, `nudge_d3_kids_es`. A typo in the name = every send fails.
2. **Language must be plain "Spanish" (code `es`) / plain "English" (code `en`)** — NOT "Spanish (MEX)" (`es_MX`) or "English (US)". The worker sends `language.code = "es" | "en"`; a template created under `es_MX` will never match.
3. `{{1}}` = the lead's first name. In the *sample/example* field Meta asks for, put `Ana` (or `Mike` for EN). The worker passes `""` when the name is unknown — copy already reads fine without it.
4. Where a template has a **Footer** below, enter it in the **Footer** field of the template builder, NOT at the end of the body. Plain text, no underscores.
5. `trial_reminder_same_day_*` has two **Quick Reply** buttons — add them as Buttons → Quick reply, exact text below.
6. Categories: as listed per template (Utility / Marketing). If Meta auto-recategorizes a Utility one to Marketing, accept it — the send code doesn't care.

## Checklist — 24 templates

### Base templates (ES + EN = 12)

| # | Name | Lang | Category | Extras |
|---|------|------|----------|--------|
| 1 | `trial_confirm_es` | Spanish | Utility | — |
| 2 | `trial_confirm_en` | English | Utility | — |
| 3 | `trial_reminder_day_before_es` | Spanish | Utility | — |
| 4 | `trial_reminder_day_before_en` | English | Utility | — |
| 5 | `trial_reminder_same_day_es` | Spanish | Utility | 2 quick-reply buttons |
| 6 | `trial_reminder_same_day_en` | English | Utility | 2 quick-reply buttons |
| 7 | `no_show_followup_es` | Spanish | Utility | — |
| 8 | `no_show_followup_en` | English | Utility | — |
| 9 | `reengage_lead_es` | Spanish | Marketing | Footer |
| 10 | `reengage_lead_en` | English | Marketing | Footer |
| 11 | `human_followup_es` | Spanish | Utility | — |
| 12 | `human_followup_en` | English | Utility | — |

### Extended drip (ES only = 12, all Marketing, all with Footer)

| # | Name | # | Name |
|---|------|---|------|
| 13 | `nudge_d2_adults_es` | 19 | `nudge_d2_kids_es` |
| 14 | `nudge_d3_adults_es` | 20 | `nudge_d3_kids_es` |
| 15 | `nudge_d4_adults_es` | 21 | `nudge_d4_kids_es` |
| 16 | `nudge_d5_adults_es` | 22 | `nudge_d5_kids_es` |
| 17 | `nudge_d2_baby_es` | 23 | `nudge_d3_baby_es` |
| 18 | `nudge_d4_baby_es` | 24 | `nudge_d5_baby_es` |

Footer for all 12 nudges (identical, plain text): `Responde BAJA para dejar de recibir mensajes.`

## Copy-paste bodies

### 1–2 · trial_confirm (Utility)

**`trial_confirm_es`** (Spanish)
```
¡Hola {{1}}! 🥋 Tu clase de prueba en MD Condesa quedó confirmada. Estamos en Av. México 49, 1º piso, Condesa. Trae ropa cómoda y una botella de agua — el equipo te lo prestamos nosotros. ¡Nos vemos!
```

**`trial_confirm_en`** (English)
```
Hi {{1}}! 🥋 Your trial class at MD Condesa is confirmed. We're at Av. México 49, 1st floor, Condesa. Bring comfortable clothes and a water bottle — we'll lend you any gear. See you soon!
```

### 3–4 · trial_reminder_day_before (Utility)

**`trial_reminder_day_before_es`**
```
¡Hola {{1}}! Te recordamos tu clase de prueba mañana en MD Condesa (Av. México 49, 1º piso, Condesa). Llega 10 min antes para registrarte. ¿Nos vemos? 🥋
```

**`trial_reminder_day_before_en`**
```
Hi {{1}}! A reminder about your trial class tomorrow at MD Condesa (Av. México 49, 1st floor, Condesa). Please arrive 10 min early to check in. See you there? 🥋
```

### 5–6 · trial_reminder_same_day (Utility + quick-reply buttons)

**`trial_reminder_same_day_es`** — Buttons: `Ahí estaré` · `Necesito reagendar`
```
¡Hoy es tu clase de prueba, {{1}}! 🥋 Te esperamos en Av. México 49, 1º piso, Condesa. Confírmanos si vienes:
```

**`trial_reminder_same_day_en`** — Buttons: `I'll be there` · `I need to reschedule`
```
Today's your trial class, {{1}}! 🥋 We'll be waiting at Av. México 49, 1st floor, Condesa. Let us know:
```

### 7–8 · no_show_followup (Utility)

**`no_show_followup_es`**
```
¡Hola {{1}}! Te extrañamos ayer en MD Condesa. Sabemos que la vida se atraviesa 🙂 ¿Te reagendamos tu clase de prueba? Solo dinos qué día te queda bien.
```

**`no_show_followup_en`**
```
Hi {{1}}! We missed you yesterday at MD Condesa. Life happens 🙂 Want us to rebook your trial class? Just tell us which day works for you.
```

### 9–10 · reengage_lead (Marketing + Footer)

**`reengage_lead_es`** — Footer: `Responde BAJA para no recibir más mensajes.`
```
¡Hola {{1}}! Seguimos con un lugar para ti en MD Condesa 🥋 Clases de defensa personal, jiu jitsu y más en el corazón de la Condesa. ¿Agendamos tu clase de prueba gratis esta semana?
```

**`reengage_lead_en`** — Footer: `Reply BAJA to stop receiving messages.`
```
Hi {{1}}! We still have a spot for you at MD Condesa 🥋 Self-defense, jiu jitsu and more in the heart of Condesa. Shall we book your free trial class this week?
```

### 11–12 · human_followup (Utility)

**`human_followup_es`**
```
¡Hola {{1}}! Retomamos tu mensaje en MD Condesa. ¿Seguimos por aquí? Con gusto te ayudo. 🙌
```

**`human_followup_en`**
```
Hi {{1}}! Circling back on your message to MD Condesa. Still around? Happy to help. 🙌
```

### 13–16 · nudge adults (Marketing + Footer, Spanish)

**`nudge_d2_adults_es`**
```
¡Hola {{1}}! 👋 ¿Pudiste encontrar algún horario que te quede bien para venir a probar tu día gratuito en MD Condesa? 🙌 Si quieres, agéndalo aquí: https://mdcondesa.com/clase-prueba-adultos/
```

**`nudge_d3_adults_es`**
```
¡Hola {{1}}! Por si te sirve saberlo: no necesitas estar en forma ni tener experiencia para empezar. Justo por eso existe el día gratuito — vienes, pruebas unas clases reales, conoces la academia y ves si el reto se siente como algo que sí puedes sostener 💪 ¿Lo agendamos? https://mdcondesa.com/clase-prueba-adultos/
```

**`nudge_d4_adults_es`**
```
¡Hola {{1}}! A veces el cambio no empieza con una decisión enorme… empieza con una clase. Una hora. Un primer paso. Si buscas más condición, más confianza, más comunidad y más disciplina, esta puede ser una gran forma de empezar 🥋 ¿Te gustaría probar una clase gratis? https://mdcondesa.com/clase-prueba-adultos/
```

**`nudge_d5_adults_es`**
```
¡Hola {{1}}! Parece que por ahora quizá no es el momento, y está bien 🙂 Este será nuestro último mensaje de seguimiento por ahora. Si algo cambia y te gustaría ponerte en forma, aprender a defenderte y ganar confianza, aquí puedes agendar tu día gratuito cuando quieras: https://mdcondesa.com/clase-prueba-adultos/
```

### 19–22 · nudge kids (Marketing + Footer, Spanish)

**`nudge_d2_kids_es`**
```
¡Hola {{1}}! 👋 ¿Pudiste ver algún horario que le funcione a tu peque para su clase de prueba en MD Condesa? 🙌 Si quieres, aparta su lugar aquí: https://mdcondesa.com/clase-prueba-ninos/
```

**`nudge_d3_kids_es`**
```
¡Hola {{1}}! Muchos papás nos buscan porque su peque es un poco tímido o ha tenido problemas de bullying. Justo ahí es donde más vemos el cambio: aprenden a defenderse, a poner límites sanos y a creer más en sí mismos 💪 ¿Le agendamos su clase gratis? https://mdcondesa.com/clase-prueba-ninos/
```

**`nudge_d4_kids_es`**
```
¡Hola {{1}}! Además de moverse y salir un rato de las pantallas, los niños hacen amigos, ganan disciplina y se divierten muchísimo 🙌 Es de las cosas que más nos gusta ver clase con clase. Si ves un horario que les funcione, aparta su clase gratis aquí: https://mdcondesa.com/clase-prueba-ninos/
```

**`nudge_d5_kids_es`**
```
¡Hola {{1}}! Parece que quizá no es el momento, y está perfecto 🙂 Este será nuestro último mensaje por ahora. Si más adelante te gustaría que tu peque pruebe una clase, con gusto le apartamos su lugar aquí: https://mdcondesa.com/clase-prueba-ninos/
```

### 17–18, 23–24 · nudge baby (Marketing + Footer, Spanish)

**`nudge_d2_baby_es`**
```
¡Hola {{1}}! Algo que nos ha encantado ver en Baby Fight Club es cómo algunos bebés llegan tímidos al inicio y, después de unas clases, empiezan a moverse con más confianza y hasta se adueñan del tatami 😄 Si todavía les interesa probar, cuéntame y apartamos su clase gratis, o resérvala aquí: https://mdcondesa.com/clase-prueba-ninos/
```

**`nudge_d3_baby_es`**
```
¡Hola de nuevo {{1}}! Además de la clase, al final tenemos 10 minutos de juego libre. Esa parte ha sido increíble para que los bebés exploren, convivan y empiecen a socializar en un espacio seguro 🙌 ¿Quieres que te ayude a apartar su clase gratuita? https://mdcondesa.com/clase-prueba-ninos/
```

**`nudge_d4_baby_es`**
```
¡Hola {{1}}! A esta edad, estimular movimiento, equilibrio, coordinación y confianza puede hacer una gran diferencia. En Baby Fight Club tu bebé se mueve, juega, explora y gana seguridad, siempre acompañado por mamá o papá 💪 Para apartar su clase gratis, resérvala aquí: https://mdcondesa.com/clase-prueba-ninos/
```

**`nudge_d5_baby_es`**
```
¡Hola {{1}}! Parece que quizá no es el momento para ustedes, y está bien 🙂 Este será nuestro último mensaje de seguimiento por el momento. Si más adelante te gustaría que tu bebé pruebe Baby Fight Club, con gusto les apartamos una clase gratuita aquí: https://mdcondesa.com/clase-prueba-ninos/
```

## After submitting

Approval is usually minutes–hours. Once **approved** in WhatsApp Manager, nothing else is needed — the worker already tries free-form first and falls back to these automatically. Until then, out-of-window d2–d5 sends are skipped with a once-daily Slack note.
