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
