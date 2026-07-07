# WhatsApp message templates (submit verbatim to Meta)

Six templates, ES + EN each (one template per language — the code appends `_es` /
`_en` to the base name). All bodies use `{{1}}` = contact first name; the sender
passes `""` when the name is unknown, so keep the greeting readable without it.

Category per the spec. Same-day reminder uses quick-reply buttons; reengage_lead
carries the BAJA opt-out footer.

Template name mapping (base → sent name):
- `trial_confirm` → `trial_confirm_es` / `trial_confirm_en`
- `trial_reminder_day_before` → `trial_reminder_day_before_es` / `_en`
- `trial_reminder_same_day` → `trial_reminder_same_day_es` / `_en`
- `no_show_followup` → `no_show_followup_es` / `_en`
- `reengage_lead` → `reengage_lead_es` / `_en`
- `human_followup` → `human_followup_es` / `_en`  (owned/sent by C's late-approval
  path; copy included here for convenience)

Address string used across templates: **Av. México 49, 1º piso, Condesa**.

---

## 1. trial_confirm — Utility

Fallback when the free-form confirmation can't be sent (24h window closed).

**ES (`trial_confirm_es`)**
> ¡Hola {{1}}! 🥋 Tu clase de prueba en MD Condesa quedó confirmada. Estamos en Av. México 49, 1º piso, Condesa. Trae ropa cómoda y una botella de agua — el equipo te lo prestamos nosotros. ¡Nos vemos!

**EN (`trial_confirm_en`)**
> Hi {{1}}! 🥋 Your trial class at MD Condesa is confirmed. We're at Av. México 49, 1st floor, Condesa. Bring comfortable clothes and a water bottle — we'll lend you any gear. See you soon!

Variables: {{1}} name.

---

## 2. trial_reminder_day_before — Utility

**ES (`trial_reminder_day_before_es`)**
> ¡Hola {{1}}! Te recordamos tu clase de prueba mañana en MD Condesa (Av. México 49, 1º piso, Condesa). Llega 10 min antes para registrarte. ¿Nos vemos? 🥋

**EN (`trial_reminder_day_before_en`)**
> Hi {{1}}! A reminder about your trial class tomorrow at MD Condesa (Av. México 49, 1st floor, Condesa). Please arrive 10 min early to check in. See you there? 🥋

Variables: {{1}} name.

---

## 3. trial_reminder_same_day — Utility (quick-reply buttons)

**ES (`trial_reminder_same_day_es`)**
> ¡Hoy es tu clase de prueba, {{1}}! 🥋 Te esperamos en Av. México 49, 1º piso, Condesa. Confírmanos si vienes:

Buttons (quick reply):
- `Ahí estaré`
- `Necesito reagendar`

**EN (`trial_reminder_same_day_en`)**
> Today's your trial class, {{1}}! 🥋 We'll be waiting at Av. México 49, 1st floor, Condesa. Let us know:

Buttons (quick reply):
- `I'll be there`
- `I need to reschedule`

Variables: {{1}} name. Button taps arrive as inbound messages (reopen 24h window,
routed through the brain).

---

## 4. no_show_followup — Utility (may be recategorized Marketing)

Sent the morning after a missed class (only when attendance was marked "no").

**ES (`no_show_followup_es`)**
> ¡Hola {{1}}! Te extrañamos ayer en MD Condesa. Sabemos que la vida se atraviesa 🙂 ¿Te reagendamos tu clase de prueba? Solo dinos qué día te queda bien.

**EN (`no_show_followup_en`)**
> Hi {{1}}! We missed you yesterday at MD Condesa. Life happens 🙂 Want us to rebook your trial class? Just tell us which day works for you.

Variables: {{1}} name.

---

## 5. reengage_lead — Marketing (BAJA opt-out footer required)

Sent once, 7 days after the lead went cold.

**ES (`reengage_lead_es`)**
> ¡Hola {{1}}! Seguimos con un lugar para ti en MD Condesa 🥋 Clases de defensa personal, jiu jitsu y más en el corazón de la Condesa. ¿Agendamos tu clase de prueba gratis esta semana?
>
> _Responde BAJA para no recibir más mensajes._

**EN (`reengage_lead_en`)**
> Hi {{1}}! We still have a spot for you at MD Condesa 🥋 Self-defense, jiu jitsu and more in the heart of Condesa. Shall we book your free trial class this week?
>
> _Reply BAJA to stop receiving messages._

Variables: {{1}} name. Footer text must be the template FOOTER component.

---

## 6. human_followup — Utility (reopens window when approval landed late)

Owned by workstream C's late-approval path; included here so all six live in one
place for Meta submission.

**ES (`human_followup_es`)**
> ¡Hola {{1}}! Retomamos tu mensaje en MD Condesa. ¿Seguimos por aquí? Con gusto te ayudo. 🙌

**EN (`human_followup_en`)**
> Hi {{1}}! Circling back on your message to MD Condesa. Still around? Happy to help. 🙌

Variables: {{1}} name.

---

# Extended-drip templates (nudge_d2 … nudge_d5) — Marketing

Sequences-v2 (R3). These are the WINDOW-CLOSED fallback for the extended
multi-day drip: the engine tries a free-form send first (CTWA 72h windows make
that the common path) and only falls back to a template when the 24h window is
closed. Until these are submitted + approved in Meta, the fallback fails and the
engine SKIPS the send and posts one Slack note per day (kv `tmpl_missing_note`).

- **Category: Marketing** (all 12). **BAJA opt-out footer required** (FOOTER
  component). **es only for now** — the code sends `<base>_es`; an `_en` variant
  is not authored yet, so English leads whose window is closed are skipped until
  cutover.
- Base names → sent name: `nudge_d2_adults` → `nudge_d2_adults_es`, … through
  `nudge_d5_baby` → `nudge_d5_baby_es` (12 templates).
- Variables: **{{1}}** = contact first name (sender passes `""` when unknown —
  keep the greeting readable without it).
- Footer (identical on all 12): _Responde BAJA para dejar de recibir mensajes._
- **TODO (Evan, at cutover):** submit these 12 to Meta; the free-form path covers
  most sends in the meantime.

Booking links (static, in body): adults → https://mdcondesa.com/clase-prueba-adultos/ ·
kids & baby → https://mdcondesa.com/clase-prueba-ninos/

## Adults

**`nudge_d2_adults_es`**
> ¡Hola {{1}}! 👋 ¿Pudiste encontrar algún horario que te quede bien para venir a probar tu día gratuito en MD Condesa? 🙌 Si quieres, agéndalo aquí: https://mdcondesa.com/clase-prueba-adultos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d3_adults_es`**
> ¡Hola {{1}}! Por si te sirve saberlo: no necesitas estar en forma ni tener experiencia para empezar. Justo por eso existe el día gratuito — vienes, pruebas unas clases reales, conoces la academia y ves si el reto se siente como algo que sí puedes sostener 💪 ¿Lo agendamos? https://mdcondesa.com/clase-prueba-adultos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d4_adults_es`**
> ¡Hola {{1}}! A veces el cambio no empieza con una decisión enorme… empieza con una clase. Una hora. Un primer paso. Si buscas más condición, más confianza, más comunidad y más disciplina, esta puede ser una gran forma de empezar 🥋 ¿Te gustaría probar una clase gratis? https://mdcondesa.com/clase-prueba-adultos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d5_adults_es`**
> ¡Hola {{1}}! Parece que por ahora quizá no es el momento, y está bien 🙂 Este será nuestro último mensaje de seguimiento por ahora. Si algo cambia y te gustaría ponerte en forma, aprender a defenderte y ganar confianza, aquí puedes agendar tu día gratuito cuando quieras: https://mdcondesa.com/clase-prueba-adultos/
>
> _Responde BAJA para dejar de recibir mensajes._

## Kids

**`nudge_d2_kids_es`**
> ¡Hola {{1}}! 👋 ¿Pudiste ver algún horario que le funcione a tu peque para su clase de prueba en MD Condesa? 🙌 Si quieres, aparta su lugar aquí: https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d3_kids_es`**
> ¡Hola {{1}}! Muchos papás nos buscan porque su peque es un poco tímido o ha tenido problemas de bullying. Justo ahí es donde más vemos el cambio: aprenden a defenderse, a poner límites sanos y a creer más en sí mismos 💪 ¿Le agendamos su clase gratis? https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d4_kids_es`**
> ¡Hola {{1}}! Además de moverse y salir un rato de las pantallas, los niños hacen amigos, ganan disciplina y se divierten muchísimo 🙌 Es de las cosas que más nos gusta ver clase con clase. Si ves un horario que les funcione, aparta su clase gratis aquí: https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d5_kids_es`**
> ¡Hola {{1}}! Parece que quizá no es el momento, y está perfecto 🙂 Este será nuestro último mensaje por ahora. Si más adelante te gustaría que tu peque pruebe una clase, con gusto le apartamos su lugar aquí: https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._

## Baby (Baby Fight Club)

**`nudge_d2_baby_es`**
> ¡Hola {{1}}! Algo que nos ha encantado ver en Baby Fight Club es cómo algunos bebés llegan tímidos al inicio y, después de unas clases, empiezan a moverse con más confianza y hasta se adueñan del tatami 😄 Si todavía les interesa probar, cuéntame y apartamos su clase gratis, o resérvala aquí: https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d3_baby_es`**
> ¡Hola de nuevo {{1}}! Además de la clase, al final tenemos 10 minutos de juego libre. Esa parte ha sido increíble para que los bebés exploren, convivan y empiecen a socializar en un espacio seguro 🙌 ¿Quieres que te ayude a apartar su clase gratuita? https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d4_baby_es`**
> ¡Hola {{1}}! A esta edad, estimular movimiento, equilibrio, coordinación y confianza puede hacer una gran diferencia. En Baby Fight Club tu bebé se mueve, juega, explora y gana seguridad, siempre acompañado por mamá o papá 💪 Para apartar su clase gratis, resérvala aquí: https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._

**`nudge_d5_baby_es`**
> ¡Hola {{1}}! Parece que quizá no es el momento para ustedes, y está bien 🙂 Este será nuestro último mensaje de seguimiento por el momento. Si más adelante te gustaría que tu bebé pruebe Baby Fight Club, con gusto les apartamos una clase gratuita aquí: https://mdcondesa.com/clase-prueba-ninos/
>
> _Responde BAJA para dejar de recibir mensajes._
