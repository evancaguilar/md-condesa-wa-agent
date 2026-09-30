# WhatsApp message templates (submit verbatim to Meta)

Nine templates, ES + EN each (one template per language — the code appends `_es` /
`_en` to the base name). All bodies use `{{1}}` = contact first name; the sender
passes `""` when the name is unknown, so keep the greeting readable without it.

Category per the spec. Same-day reminder uses quick-reply buttons; reengage_lead
and the two Marketing post-trial ones carry the BAJA opt-out footer.

Template name mapping (base → sent name):
- `trial_confirm` → `trial_confirm_es` / `trial_confirm_en`
- `trial_reminder_day_before` → `trial_reminder_day_before_es` / `_en`
- `trial_reminder_same_day` → `trial_reminder_same_day_es` / `_en`
- `no_show_followup` → `no_show_followup_es` / `_en`  (BOTH no-show touches:
  the immediate one and `no_show_d3` three days later)
- `reengage_lead` → `reengage_lead_es` / `_en`
- `human_followup` → `human_followup_es` / `_en`  (owned/sent by C's late-approval
  path; copy included here for convenience)
- `post_trial_d0` / `d1` / `d2` / `d4` / `d7` / `d14` / `d5` (the +30d goodbye) → `…_es` / `…_en`
  (2026-09-21, attended-and-didn't-sign-up chain — see the section below)

Address string used across templates: **Av. México 49, 1º piso, Condesa**.

**Name variables ({{1}}) — read before submitting.** The WhatsApp push name is
user-typed and is frequently NOT a person's name (emails, `@handles`, fancy-font
text, emoji). `greetingName()` (src/cron/display-name.ts) drops those, so {{1}}
is empty for a meaningful share of leads. Meta rejects an empty body parameter,
so the sender substitutes `👋`. Keep {{1}} in a position where that still reads
naturally ("¡Hola {{1}}!" ✅) and avoid mid-sentence vocatives if you reword.

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


---

# Post-trial templates (post_trial_d0 … d30)

Shipped 2026-09-21 (d0 / d2 / d5) for the lead who CAME to the free class and
did not sign up, extended 2026-09-30 to a six-touch, one-month arc after the
first version signed up two people on its first live day. Spec:
docs/post-trial-sequence.md. Same shape as the extended drip: the engine sends
free-form first — most of these leads are still inside the 24h window, having
just been in the gym — and only falls back to a template when the window is
closed. Until a template is approved that fallback fails, the send is SKIPPED
and one Slack note goes out per day (kv `tmpl_missing_note`).

- Base names → sent name: `post_trial_d0` → `post_trial_d0_es` / `_en`, same for
  `post_trial_d1` (the first touch when it fires the morning AFTER the class —
  "ayer" instead of "hoy"), `post_trial_d2`, `post_trial_d4`, `post_trial_d7`,
  `post_trial_d14` (12 templates). The +30d goodbye reuses `post_trial_d5_es` /
  `_en` unchanged (the 2026-09-21 goodbye body, already approved).
- Variables: **{{1}}** = contact first name (sender substitutes `qué tal` /
  `there` when the push name is junk/unknown — keep {{1}} where that still reads
  naturally). One variable per template: "hoy"/"ayer" are two templates, not a
  second parameter.
- **All are Marketing**, with the **BAJA opt-out footer** (FOOTER component):
  _Responde BAJA para dejar de recibir mensajes._ (EN: _Reply BAJA to stop
  receiving messages._) Meta recategorizes on its own anyway; the send code does
  not care which category comes back.
- **NO price, NO discount, NO deadline in any of them** (owner, 2026-09-21):
  the inscription discount is **same-day-only** at the academy, so a follow-up
  that holds it open for 48h promises something the gym will not honor. These
  messages open a conversation; the humans quote the numbers.
- The 2026-09-30 batch (d1, d4, d7, d14 × es/en) is submitted automatically by
  the cron on the first tick after deploy (`createPostTrialV2Templates`, kv
  `tpl_create:post_trial_v2:2026-09-30`); manual path:
  `POST /admin/api/blast/templates/create`.

## 7. post_trial_d0 — Marketing (BAJA opt-out footer required)

Sent ~3h after the class starts, when that is still the same CDMX day.

**ES (`post_trial_d0_es`)**
> ¡Hola {{1}}! Qué gusto verte hoy en la academia 🥋 ¿Qué te pareció la experiencia? Vi que todavía no queda tu inscripción — ¿ya te decides a dar el paso? Te ayudo a dejarla lista hoy mismo.
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d0_en`)**
> Hi {{1}}! So good to have you at the academy today 🥋 How was the experience? I noticed you haven't signed up yet — ready to take the step? I can get your enrollment done today.
>
> _Reply BAJA to stop receiving messages._

Variables: {{1}} name. Footer text must be the template FOOTER component.

---

## 8. post_trial_d1 — Marketing (BAJA opt-out footer required)

The same first touch when it fires the morning after (evening class whose +3h
spills past 21:00 → 09:30 next day, or a result marked the next morning).

**ES (`post_trial_d1_es`)**
> ¡Hola {{1}}! Qué gusto verte ayer en la academia 🥋 ¿Qué te pareció la experiencia? Vi que todavía no queda tu inscripción — ¿ya te decides a dar el paso? Te ayudo a dejarla lista hoy mismo.
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d1_en`)**
> Hi {{1}}! So good to have you at the academy yesterday 🥋 How was the experience? I noticed you haven't signed up yet — ready to take the step? I can get your enrollment done today.
>
> _Reply BAJA to stop receiving messages._

---

## 9. post_trial_d2 — Marketing (BAJA opt-out footer required)

11:00 CDMX two days after the trial.

**ES (`post_trial_d2_es`)**
> ¡Hola {{1}}! ¿Cómo amaneció el cuerpo después de tu clase? 😄 Lo más difícil ya lo hiciste: venir la primera vez. ¿Qué te falta saber para decidirte? Te ayudamos a elegir horario y paquete.
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d2_en`)**
> Hi {{1}}! How's the body feeling after your class? 😄 The hardest part is already done: showing up the first time. What else do you need to know to decide? We'll help you pick a schedule and a plan.
>
> _Reply BAJA to stop receiving messages._

---

## 10. post_trial_d4 — Marketing (BAJA opt-out footer required)

18:00 CDMX four days after the trial. Objection discovery.

**ES (`post_trial_d4_es`)**
> ¡Hola {{1}}! Por aquí seguimos 🙂 Cuéntame con confianza: ¿qué es lo que te frena — el horario, el paquete o alguna otra duda? Lo vemos juntos y buscamos la forma de que sí te acomode.
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d4_en`)**
> Hi {{1}}! Still here 🙂 Tell me honestly: what's holding you back — the schedule, the plan, or some other question? Let's work through it together and find a way that fits you.
>
> _Reply BAJA to stop receiving messages._

---

## 11. post_trial_d7 — Marketing (BAJA opt-out footer required)

11:00 CDMX one week after the trial (same weekday as the class).

**ES (`post_trial_d7_es`)**
> ¡Hola {{1}}! Ya pasó una semana desde tu clase 🥋 Sé cómo es: la rutina se lo come todo. Si quieres retomarlo, te ayudo a armar un horario que sí te funcione y dejamos tu inscripción lista en cinco minutos. ¿Le entramos?
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d7_en`)**
> Hi {{1}}! It's been a week since your class 🥋 I know how it goes: life gets in the way. If you want to pick it back up, I'll help you build a schedule that actually works and get your enrollment done in five minutes. Shall we?
>
> _Reply BAJA to stop receiving messages._

---

## 12. post_trial_d14 — Marketing (BAJA opt-out footer required)

18:00 CDMX two weeks after the trial. Soft check-in with the schedule.

**ES (`post_trial_d14_es`)**
> ¡Hola {{1}}! Solo paso a saludar 🙂 Tu lugar en la academia sigue aquí. Si estas semanas te queda mejor, dime qué días te acomodan y te comparto el horario: https://mdcondesa.com/#horarios
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d14_en`)**
> Hi {{1}}! Just checking in 🙂 Your spot at the academy is still here. If the next few weeks work better for you, tell me which days suit you and I'll send the schedule: https://mdcondesa.com/#horarios
>
> _Reply BAJA to stop receiving messages._

---

## 13. post_trial_d5 — the +30d goodbye (Marketing, BAJA footer)

Sent by kind `post_trial_d30`, 11:00 CDMX thirty days after the trial. The
template keeps its 2026-09-21 name — it is already approved with this body.

**ES (`post_trial_d5_es`)**
> ¡Hola {{1}}! No queremos insistir más 🙂 Este es nuestro último mensaje. Nos dio mucho gusto tenerte en clase y aquí seguimos cuando quieras volver — estos son los horarios: https://mdcondesa.com/#horarios
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d5_en`)**
> Hi {{1}}! We won't keep writing 🙂 This is our last message. We loved having you in class and we're here whenever you want to come back — here's the schedule: https://mdcondesa.com/#horarios
>
> _Reply BAJA to stop receiving messages._

Variables: {{1}} name. Footer text must be the template FOOTER component.

**The second no-show touch needs NO new template.** `no_show_d3` (11:00 CDMX
three days after a missed class) reuses `no_show_followup_es` / `_en` from §4 —
only the free-form body differs between the two touches.

---

# Blast templates (bulk sends, docs/blasts.md) — Marketing

The dashboard's **Envíos** tab sends ANY approved template on the live WABA
(`1717538906028335`), so these are guidelines, not a fixed list. What the sender
supports and what Meta needs:

- **Category: Marketing.** **Footer (FOOTER component):** _Responde BAJA para
  dejar de recibir mensajes._ — the inbound pipeline opts the lead out on that
  exact word and every queued blast row for them is skipped.
- **Language: plain "Spanish" (`es`)** unless you deliberately create `es_MX`;
  the dashboard reads the exact code from Meta, so either works — but the name +
  language pair must be unique and is what you pick in the dropdown.
- **Body variables:** any number of `{{n}}`. The tab creates one field per
  variable; write `{nombre}` in a field to insert the contact's first name
  (sender substitutes `👋` when the push name is junk/unknown — keep `{{1}}`
  where that still reads naturally, e.g. "¡Hola {{1}}!"). In the sample field
  Meta asks for, use `Ana`. Meta strips a body that is ONLY a variable — keep
  real copy around them.
- **Header:** none, or TEXT without variables, or IMAGE / VIDEO / DOCUMENT
  (the tab asks for an https link at send time; Meta needs a sample file on
  submission). Header text variables are NOT supported by the sender.
- **Buttons:** URL and quick-reply buttons work (no variables in URLs).
- Naming: lowercase + underscores, e.g. `promo_octubre_es`, `reto_noviembre_es`,
  `bfc_regreso_es`. Avoid names that look like the system's utility templates.

Suggested first three (copy TBD by Evan): a monthly promo (adults), a kids /
Baby Fight Club invitation, and a "te esperamos de vuelta" reactivation for
leads who never booked.
