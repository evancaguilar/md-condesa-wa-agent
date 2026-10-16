# WhatsApp message templates (submit verbatim to Meta)

Twelve templates, ES + EN each (one template per language — the code appends `_es` /
`_en` to the base name). All bodies use `{{1}}` = contact first name; the sender
passes `""` when the name is unknown, so keep the greeting readable without it.

Category per the spec. Same-day reminder uses quick-reply buttons; reengage_lead
and the two Marketing post-trial ones carry the BAJA opt-out footer.

Template name mapping (base → sent name):
- `trial_confirm` → `trial_confirm_es` / `trial_confirm_en`
- `trial_reminder_day_before` → `trial_reminder_day_before_es` / `_en`
- `trial_reminder_same_day` → `trial_reminder_same_day_es` / `_en`
- `no_show_followup` → `no_show_followup_es` / `_en`  (**retired 2026-10-11**:
  replaced by `no_show_hoy` / `no_show_d2` / `no_show_d7`, §11–§13)
- 2026-10-11 v2 chain drafts (§11–§16, pending owner review): `no_show_hoy`,
  `no_show_d2`, `no_show_d7`, `post_trial_d3`, `post_trial_d6` (each with `_kids` and
  `_baby` twins since 2026-10-15, submitted by src/cron/template-seed-chains.ts) and `reschedule_offer`
- `reengage_lead` → `reengage_lead_es` / `_en`
- `human_followup` → `human_followup_es` / `_en`  (owned/sent by C's late-approval
  path; copy included here for convenience)
- `post_trial_d0` / `post_trial_d2` / `post_trial_d5` → `…_es` / `…_en`
  (2026-09-21, attended-and-didn't-sign-up chain — see the section below)
- `student_welcome` → `student_welcome_es` / `_en`  (2026-10-03, enrolment
  welcome when the 24h window is closed — see §10; the ONE template with no {{1}})
- `student_qr` → `student_qr_es` / `_en`  (2026-10-13, the new student's check-in
  QR as an IMAGE header — see §17)
- `student_responsiva` → `student_responsiva_es` / `_en`  (2026-10-13, waiver
  signing link on a URL button — see §18)

**§10, §17 and §18 are submitted by the worker itself** (src/cron/template-seed-student.ts,
one-shot, kv `tpl_seed:student_kit:2026-10-13`): whatever name+language the WABA
does not already hold is created, and one Slack note in #bot-ops lists what was
sent to review, what already existed and what failed. Nobody submits them by hand.

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

## 1b. trial_confirm_v2 — Utility (replaces §1 once approved; owner-approved 2026-10-11)

Meta templates cannot be edited, so the gear line ships as a new template. The
old "no necesitas equipo, nosotros te lo prestamos" read as "don't bring yours";
the owner wants leads to bring their own gloves and wraps when they have them.

**ES (`trial_confirm_v2_es`)**
> ¡Hola {{1}}! 🥋 Tu clase de prueba en MD Condesa quedó confirmada. Estamos en Av. México 49, 1º piso, Condesa. Trae ropa cómoda, agua, y si tienes guantes y vendas tráelos; si no, sin bronca, nosotros te prestamos. ¡Nos vemos!

**ES familia (`trial_confirm_v2_fam_es`, Kids/Teens)**
> ¡Hola {{1}}! 🥋 La clase de prueba en MD Condesa quedó confirmada. Estamos en Av. México 49, 1º piso, Condesa. Ropa cómoda, agua, y si su peque ya tiene guantes y vendas tráiganlos; si no, nosotros se los prestamos. ¡Nos vemos!

**ES bebés (`trial_confirm_v2_baby_es`, Baby Fight Club / Mini Muay Thai)**
> ¡Hola {{1}}! 🙌 La clase de prueba en MD Condesa quedó confirmada. Estamos en Av. México 49, 1º piso, Condesa. Ropa cómoda para el peque y para ti, chanclas y agua. ¡Nos vemos!

**EN (`trial_confirm_v2_en`)**
> Hi {{1}}! 🥋 Your trial class at MD Condesa is confirmed. We're at Av. México 49, 1st floor, Condesa. Bring comfortable clothes, water, and your gloves and wraps if you have them; if not, no worries, we lend them. See you there!

Variables: {{1}} name. Code switch: `tpl("trial_confirm")` → `trial_confirm_v2` once Meta approves (see followups.ts).

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

# Post-trial templates (post_trial_d0 … d5)

Shipped 2026-09-21 for the lead who CAME to the free class and did not sign up
(163 of them since July, previously untouched by the bot). Same shape as the
extended drip: the engine sends free-form first — most of these leads are still
inside the 24h window, having just been in the gym — and only falls back to a
template when the window is closed. Until these are approved the fallback fails,
the send is SKIPPED and one Slack note goes out per day (kv `tmpl_missing_note`).

- Base names → sent name: `post_trial_d0` → `post_trial_d0_es` / `_en`, same for
  `post_trial_d2` and `post_trial_d5` (6 templates).
- Variables: **{{1}}** = contact first name (sender substitutes `👋` when the
  push name is junk/unknown — keep {{1}} where that still reads naturally).
- **All three are Marketing**, with the **BAJA opt-out footer** (FOOTER
  component): _Responde BAJA para dejar de recibir mensajes._ (EN: _Reply BAJA to
  stop receiving messages._) d0 was briefly written as Utility, but with the
  offer gone it is a plain re-engagement follow-up and would not survive review
  as Utility — and Meta recategorizes on its own anyway. The send code does not
  care which category comes back.
- **NO price, NO discount, NO deadline in any of the three** (owner,
  2026-09-21): the inscription discount is **same-day-only** at the academy, so
  a follow-up that holds it open for 48h promises something the gym will not
  honor. These messages open a conversation; the humans quote the numbers.

## 7. post_trial_d0 — Marketing (BAJA opt-out footer required)

Sent 30 min after the attended card (card = class start + 3h; 19:00+ classes →
09:00 next day; anything at/after 21:00 → 09:30 the next morning).
**`post_trial_d0` fires only when d0 lands on the SAME CDMX calendar day as the
class.** When it lands on a later day (every class from ~17:30 on, or a result
marked late the next morning) the row is armed with note `ayer` and uses
`post_trial_d0_ayer_es` / `_en` below instead (free-form: `copy.postTrialD0Ayer*`).

**ES (`post_trial_d0_es`)**
> ¡Hola {{1}}! Qué gusto verte hoy en el tatami 🥋 ¿Cómo te sentiste en la clase? Si te quedó alguna duda de horarios o paquetes, aquí estamos. ¿Te apartamos tu lugar para tu siguiente clase?
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d0_en`)**
> Hi {{1}}! So good to have you on the mats today 🥋 How did the class feel? If you have any questions about schedules or packages, we're right here. Want us to save you a spot for your next class?
>
> _Reply BAJA to stop receiving messages._

Variables: {{1}} name. Footer text must be the template FOOTER component.

### 7b. post_trial_d0_ayer — Marketing (BAJA opt-out footer required)

Same shape as post_trial_d0; used when d0 goes out the day AFTER the class.
Added 2026-10-07 — **pending submission/approval**.

**ES (`post_trial_d0_ayer_es`)**
> ¡Hola {{1}}! Qué gusto verte ayer en la academia 🥋 ¿Qué te pareció la experiencia? Vi que todavía no queda tu inscripción — ¿ya te decides a dar el paso? Te ayudo a dejarla lista hoy mismo.
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d0_ayer_en`)**
> Hi {{1}}! So good to have you at the academy yesterday 🥋 How was the experience? I noticed you haven't signed up yet — ready to take the step? I can get your enrollment done today.
>
> _Reply BAJA to stop receiving messages._

Variables: {{1}} name. Footer text must be the template FOOTER component.

---

## 8. post_trial_d2 — Marketing (BAJA opt-out footer required)

11:00 CDMX two days after the trial.

**ES (`post_trial_d2_es`)**
> ¡Hola {{1}}! ¿Cómo amaneció el cuerpo después de tu clase? 😄 Lo más difícil ya lo hiciste: venir la primera vez. ¿Qué te falta saber para decidirte? Te ayudamos a elegir horario y paquete.
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d2_en`)**
> Hi {{1}}! How's the body feeling after your class? 😄 The hardest part is already done: showing up the first time. What else do you need to know to decide? We'll help you pick a schedule and a plan.
>
> _Reply BAJA to stop receiving messages._

Variables: {{1}} name. Footer text must be the template FOOTER component.

---

## 9. post_trial_d5 — Marketing (BAJA opt-out footer required)

The goodbye, 11:00 CDMX five days after the trial.

**ES (`post_trial_d5_es`)**
> ¡Hola {{1}}! No queremos insistir más 🙂 Este es nuestro último mensaje. Nos dio mucho gusto tenerte en clase y aquí seguimos cuando quieras volver — estos son los horarios: https://mdcondesa.com/#horarios
>
> _Responde BAJA para dejar de recibir mensajes._

**EN (`post_trial_d5_en`)**
> Hi {{1}}! We won't keep writing 🙂 This is our last message. We loved having you in class and we're here whenever you want to come back — here's the schedule: https://mdcondesa.com/#horarios
>
> _Reply BAJA to stop receiving messages._

Variables: {{1}} name. Footer text must be the template FOOTER component.

**Superseded 2026-10-11:** the no-show chain is now `no_show_hoy` / `no_show_d2`
/ `no_show_d7` (§11–§13); legacy `no_show_d3` rows are sent as `no_show_d2`.

---

## 10. student_welcome — Utility (enrolment welcome, window closed)

Sent by the Airtable result watcher when the front desk marks a trial
"Se inscribió" and the lead's 24h window is already closed (open window → the
same copy goes free-form from `CLIENT.copy.welcomeEs/En`). Utility: it follows a
completed enrolment and carries no promo. **Keep the body identical to
`copy.welcomeEs/En` in clients/md-condesa/client.mjs** — one source of copy, two
delivery paths. Until Meta approves it the code falls back to `human_followup` (the
old generic text) and posts one Slack note saying so.

**ES (`student_welcome_es`)**
> ¡Bienvenid@ a la familia MD Condesa! 🥋🎉 Nos da mucho gusto tenerte.
>
> Lo primero: únete al grupo de WhatsApp de la academia. Ahí avisamos cambios de horario, eventos y dudas rápidas: https://chat.whatsapp.com/J72ov37T8BuBp6u1eJwSg9?mode=gi_t
>
> Y guarda tu guía de nuevo miembro: horarios, lo básico de cada disciplina, qué incluye tu plan y cómo pedir tu equipo Venum con 25% de descuento: https://mdcondesa.com/bienvenida/
>
> Un dato: este WhatsApp es el de ventas. Puedes seguir escribiendo aquí para dudas generales, pero para hablar con el equipo administrativo o recepción escribe al +52 55 3426 0813.
>
> ¡Nos vemos en el tatami!

**EN (`student_welcome_en`)**
> Welcome to the MD Condesa family! 🥋🎉 So glad to have you.
>
> First thing: join the academy WhatsApp group. That's where we post schedule changes, events and quick answers: https://chat.whatsapp.com/J72ov37T8BuBp6u1eJwSg9?mode=gi_t
>
> And save your new-member guide: schedule, the basics of each discipline, what your plan includes and how to order Venum gear at 25% off: https://mdcondesa.com/bienvenida/
>
> One note: this WhatsApp is our sales line. You can keep writing here for general questions, but to reach the admin team or front desk, message +52 55 3426 0813.
>
> See you on the mats!

Variables: **none** (owner 2026-10-03: push names are too often junk, so no
{{1}} here — the sender passes no body parameters). No footer (Utility). Links
are plain body text so the template needs no URL-button sample.

---

# v2 chains — DRAFTS for owner review (2026-10-11, NOT submitted)

Added by the post-trial / no-show chain v2 (src/cron/post-trial.ts, audit
2026-10-09). Submitted by the worker since 2026-10-15 (see below).
Until a template is approved the code only sends the free-form twin
(`CLIENT.copy.*` in clients/md-condesa/client.mjs) inside the 24h window; with
the window closed and the template unknown it **skips silently** (a console
line, no Slack note, never a fallback to the old "ayer" template).

All of them: **Category Marketing**, FOOTER component
_Responde BAJA para dejar de recibir mensajes._ / _Reply BAJA to stop receiving
messages._ `{{1}}` = first name (sender substitutes "qué tal" / "there" when
unknown). `{{2}}` (no_show_d2 only; no_show_hoy carries the booking link) = ONE
concrete slot of the lead's age band, rendered by the code as "<class> <when>", e.g. `Muay Thai el sábado 10:00 am`,
`Mini Muay Thai mañana martes 3:15 pm` (never an adult slot for a minor, never
Kids for a mini/baby lead). If the code has no slot to offer, the template is
not sent.

**Three bodies per step (2026-10-15):** the base name is the adult (singular)
text; `_kids` is the parent (plural) text for mini / kids / teens leads;
`_baby` is the Baby Fight Club text (plural, the parent takes the class WITH
the baby — never "tu cuerpo", never "what did the baby think"). Sent names
append `_es` / `_en`: e.g. `no_show_hoy_es`, `no_show_hoy_kids_en`,
`post_trial_d3_baby_es`. The old `_fam` names were never submitted and are gone.

**Submitted by the worker** (src/cron/template-seed-chains.ts, one-shot, kv
`tpl_seed:chains:2026-10-15`, once `WA_WABA_ID` is set): the 34 names below
(§11–§15 × 3 programs + `post_trial_d0_kids` / `_baby`, × es / en) are created
when the WABA does not already hold them, with footer + examples, and one Slack
note lists what went to review. The bodies are DERIVED from the client.mjs
free-form copy ({kid} → "su peque" / "su bebé", {cta} → "Tenemos {{2}}."), so
edit client.mjs — not this file — and bump the seed key to resubmit new names.
The bodies below are the generated output (2026-10-15).

`no_show_followup` (§4) is **retired** by these: it said "Te extrañamos ayer"
whatever the day was (…9340 got it two hours after a 7 am class, and again
three days later).

## 11. no_show_hoy — Marketing (class start + 2 h, ONLY on the class day)

The code never sends this template on a later day (its text says "hoy").
`{{2}}` = the program's booking page (adults vs kids / baby), since 2026-10-15.

**ES adults (`no_show_hoy_es`)**
> ¡Hola {{1}}! Parece que hoy no pudiste llegar a tu clase de prueba 🙏 Sin bronca, pasa seguido. ¿La reagendamos? Aquí puedes elegir otro día: {{2}} 🥋

**EN adults (`no_show_hoy_en`)**
> Hi {{1}}! Looks like you couldn't make it to your trial class today 🙏 No worries, it happens. Want to reschedule? You can pick another day here: {{2}} 🥋

**ES kids — mini / kids / teens, to the parent (`no_show_hoy_kids_es`)**
> ¡Hola {{1}}! Parece que hoy no pudieron llegar a la clase de prueba de su peque 🙏 Sin bronca, pasa seguido. ¿Se la reagendamos? Aquí pueden elegir otro día: {{2}} 🥋

**EN kids — mini / kids / teens, to the parent (`no_show_hoy_kids_en`)**
> Hi {{1}}! Looks like you couldn't make it to your little one's trial class today 🙏 No worries, it happens. Want to reschedule? You can pick another day here: {{2}} 🥋

**ES baby — Baby Fight Club, to the parent (`no_show_hoy_baby_es`)**
> ¡Hola {{1}}! Parece que hoy no pudieron llegar a la clase de prueba de su bebé en Baby Fight Club 🙏 Sin bronca, pasa seguido. ¿Se la reagendamos? Aquí pueden elegir otro día: {{2}} 🥋

**EN baby — Baby Fight Club, to the parent (`no_show_hoy_baby_en`)**
> Hi {{1}}! Looks like you couldn't make it to your baby's Baby Fight Club trial class today 🙏 No worries, it happens. Want to reschedule? You can pick another day here: {{2}} 🥋

Variables: {{1}} name, {{2}} booking link.

## 12. no_show_d2 — Marketing (11:00 CDMX, two days after the missed class)

**ES adults (`no_show_d2_es`)**
> ¡Hola {{1}}! Te seguimos guardando tu día de prueba gratis en MD Condesa 🥋 Elige el día que te quede mejor aquí: {{2}} 🥋

**EN adults (`no_show_d2_en`)**
> Hi {{1}}! We're still holding your free trial day at MD Condesa 🥋 Pick the day that works best for you here: {{2}} 🥋

**ES kids — mini / kids / teens, to the parent (`no_show_d2_kids_es`)**
> ¡Hola {{1}}! Les seguimos guardando el día de prueba gratis de su peque en MD Condesa 🥋 Elijan el día que les quede mejor aquí: {{2}} 🥋

**EN kids — mini / kids / teens, to the parent (`no_show_d2_kids_en`)**
> Hi {{1}}! We're still holding your little one's free trial day at MD Condesa 🥋 Pick the day that works best for you here: {{2}} 🥋

**ES baby — Baby Fight Club, to the parent (`no_show_d2_baby_es`)**
> ¡Hola {{1}}! Les seguimos guardando el día de prueba gratis de su bebé en Baby Fight Club 🥋 Elijan el día que les quede mejor aquí: {{2}} 🥋

**EN baby — Baby Fight Club, to the parent (`no_show_d2_baby_en`)**
> Hi {{1}}! We're still holding your baby's free Baby Fight Club trial day 🥋 Pick the day that works best for you here: {{2}} 🥋

Variables: {{1}} name, {{2}} the program booking page. (Legacy `no_show_d3` rows still pending
at deploy are sent with this template too.)

## 13. no_show_d7 — Marketing (11:00 CDMX, seven days after; the goodbye)

After this step the bot posts a Slack TASK "Marcar Perdido: <nombre> · <tel>"
— a human writes Perdido; the bot never does.

**ES adults (`no_show_d7_es`)**
> ¡Hola {{1}}! Es la última vez que te escribimos por aquí 🙂 Si todavía quieres agendar tu clase de prueba gratis en MD Condesa, mándanos un mensaje y te agendamos. ¡Que estés muy bien!

**EN adults (`no_show_d7_en`)**
> Hi {{1}}! This is the last time we'll write here 🙂 If you still want to book your free trial class at MD Condesa, just message us and we'll book you in. Take care!

**ES kids — mini / kids / teens, to the parent (`no_show_d7_kids_es`)**
> ¡Hola {{1}}! Es la última vez que les escribimos por aquí 🙂 Si todavía quieren agendar la clase de prueba gratis de su peque en MD Condesa, mándennos un mensaje y les agendamos. ¡Que estén muy bien!

**EN kids — mini / kids / teens, to the parent (`no_show_d7_kids_en`)**
> Hi {{1}}! This is the last time we'll write here 🙂 If you still want to book your little one's free trial class at MD Condesa, just message us and we'll book you in. Take care!

**ES baby — Baby Fight Club, to the parent (`no_show_d7_baby_es`)**
> ¡Hola {{1}}! Es la última vez que les escribimos por aquí 🙂 Si todavía quieren agendar la clase de prueba gratis de su bebé en Baby Fight Club, mándennos un mensaje y les agendamos. ¡Que estén muy bien!

**EN baby — Baby Fight Club, to the parent (`no_show_d7_baby_en`)**
> Hi {{1}}! This is the last time we'll write here 🙂 If you still want to book your baby's free Baby Fight Club trial class, just message us and we'll book you in. Take care!

Variables: {{1}} name.

## 14. post_trial_d3 — Marketing (11:00 CDMX, three days after an attended trial)

Replaces `post_trial_d2` (§8) for chains armed from 2026-10-11 on — and since
2026-10-15 legacy `post_trial_d2` rows of kids / baby leads use the `_kids` /
`_baby` twin here (adults keep the approved §8 template). No price, no
discount, no deadline (same rule as §7–§9). Since 2026-10-15 no slot offer:
"ready to join?".

**ES adults (`post_trial_d3_es`)**
> ¡Hola {{1}}! Ya tuviste unos días para pensarlo 🙂 ¿Te animas a dar el paso y unirte a la academia? Si tienes alguna duda, aquí estoy para ayudarte.

**EN adults (`post_trial_d3_en`)**
> Hi {{1}}! You've had a few days to think it over 🙂 Ready to take the step and join the academy? If you have any questions, I'm here to help.

**ES kids — mini / kids / teens, to the parent (`post_trial_d3_kids_es`)**
> ¡Hola {{1}}! Ya tuvieron unos días para pensarlo 🙂 ¿Se animan a dar el paso e inscribir a su peque en la academia? Si tienen alguna duda, aquí estoy para ayudarles.

**EN kids — mini / kids / teens, to the parent (`post_trial_d3_kids_en`)**
> Hi {{1}}! You've had a few days to think it over 🙂 Ready to take the step and enroll your little one at the academy? If you have any questions, I'm here to help.

**ES baby — Baby Fight Club, to the parent (`post_trial_d3_baby_es`)**
> ¡Hola {{1}}! Ya tuvieron unos días para pensarlo 🙂 ¿Se animan a dar el paso e inscribir a su bebé en Baby Fight Club? Si tienen alguna duda, aquí estoy para ayudarles.

**EN baby — Baby Fight Club, to the parent (`post_trial_d3_baby_en`)**
> Hi {{1}}! You've had a few days to think it over 🙂 Ready to take the step and enroll your baby in Baby Fight Club? If you have any questions, I'm here to help.

Variables: {{1}} name.

## 15. post_trial_d6 — Marketing (11:00 CDMX, six days after; the goodbye)

Replaces `post_trial_d5` (§9); legacy `post_trial_d5` rows of kids / baby leads
use the twin here. Since 2026-10-15: "what could we improve?", no link.

**ES adults (`post_trial_d6_es`)**
> ¡Hola {{1}}! Vi que todavía no te has inscrito. ¿Hay algo en particular que podríamos mejorar para que te hubieras animado a inscribirte? Tu opinión nos ayuda mucho 🙏

**EN adults (`post_trial_d6_en`)**
> Hi {{1}}! I noticed you haven't signed up yet. Is there anything in particular we could improve that would have made you want to sign up? Your feedback helps us a lot 🙏

**ES kids — mini / kids / teens, to the parent (`post_trial_d6_kids_es`)**
> ¡Hola {{1}}! Vi que todavía no han inscrito a su peque. ¿Hay algo en particular que podríamos mejorar para que se hubieran animado a inscribirse? Su opinión nos ayuda mucho 🙏

**EN kids — mini / kids / teens, to the parent (`post_trial_d6_kids_en`)**
> Hi {{1}}! I noticed you haven't enrolled your little one yet. Is there anything in particular we could improve that would have made you want to sign up? Your feedback helps us a lot 🙏

**ES baby — Baby Fight Club, to the parent (`post_trial_d6_baby_es`)**
> ¡Hola {{1}}! Vi que todavía no han inscrito a su bebé en Baby Fight Club. ¿Hay algo en particular que podríamos mejorar para que se hubieran animado a inscribirse? Su opinión nos ayuda mucho 🙏

**EN baby — Baby Fight Club, to the parent (`post_trial_d6_baby_en`)**
> Hi {{1}}! I noticed you haven't enrolled your baby in Baby Fight Club yet. Is there anything in particular we could improve that would have made you want to sign up? Your feedback helps us a lot 🙏

Variables: {{1}} name.

### post_trial_d0_kids / post_trial_d0_baby — Marketing (same evening; kids / baby d0)

No `_ayer` twin: these bodies carry no day word (free-form copy keeps
"hoy" / "ayer"). Adults keep §7 / §7b.

**ES kids — mini / kids / teens, to the parent (`post_trial_d0_kids_es`)**
> ¡Hola {{1}}! Qué gusto tenerlos en la academia 🥋 ¿Cómo les fue? ¿Qué le pareció la clase a su peque? Si se quedaron con ganas de más, les ayudo a dejar lista su inscripción.

**EN kids — mini / kids / teens, to the parent (`post_trial_d0_kids_en`)**
> Hi {{1}}! So good to have you at the academy 🥋 How did it go? What did your little one think of the class? If you'd like to keep going, I can help you get enrolled.

**ES baby — Baby Fight Club, to the parent (`post_trial_d0_baby_es`)**
> ¡Hola {{1}}! Qué gusto tenerlos en Baby Fight Club 🥋 ¿Cómo les fue a su bebé y a ustedes moviéndose juntos? Si se quedaron con ganas de más, les ayudo a dejar lista su inscripción.

**EN baby — Baby Fight Club, to the parent (`post_trial_d0_baby_en`)**
> Hi {{1}}! So good to have you at Baby Fight Club 🥋 How did it go for your baby and you, moving together? If you'd like to keep going, I can help you get enrolled.

Variables: {{1}} name.

## 16. reschedule_offer — Marketing (WP3: "Necesito reagendar" out of window)

Used by the reschedule flow (another work package) when the lead asked to
reschedule and the 24h window has closed. One body works for adults and
parents. Quick-reply buttons: the two options (`{{2}}`, `{{3}}` texts).

**ES (`reschedule_offer_es`)**
> Claro {{1}}, reagendamos sin bronca 🙌 Las próximas opciones son {{2}} o {{3}}. ¿Cuál les queda mejor?

**EN (`reschedule_offer_en`)**
> Sure {{1}}, happy to reschedule 🙌 The next options are {{2}} or {{3}}. Which one works best?

Variables: {{1}} name, {{2}} first slot, {{3}} second slot.

---

## 17. student_qr — Utility (IMAGE header, check-in QR)

Student kit (src/cron/student-kit.ts), ~90 s after the enrolment welcome, when
the 24h window is closed (open window → the same text goes free-form as the
caption of the QR image, from `CLIENT.copy.studentQrEs/En`). The header image is
the student's personal check-in QR — a PNG the worker generates for
`https://mdcondesa.com/checkin?Alumno=<Alumnos record id>` (same content as the
Airtable `QR Code` formula; not Airtable's `qr.gif`, WhatsApp takes JPEG/PNG
only) — uploaded per send and passed as `{type:"header", parameters:[{type:"image",
image:{id}}]}`. Submission sample: the QR for `…?Alumno=sample`, uploaded through
the Resumable Upload API (`uploadHeaderSample`).

**ES (`student_qr_es`)** — header: IMAGE
> Este es tu código QR de acceso 🥋 Guárdalo en tus fotos y escanéalo en recepción al llegar a cada clase.
>
> Con eso registramos tu asistencia, y es lo que usamos para seguir tu avance: grados, graduaciones y quién está listo para competir.

**EN (`student_qr_en`)** — header: IMAGE
> This is your check-in QR code 🥋 Save it to your photos and scan it at the front desk when you arrive for each class.
>
> That's how we log your attendance, and it's what we use to track your progress: stripes, promotions and who's ready to compete.

Variables: **none** in the body. No footer, no buttons.

---

## 18. student_responsiva — Utility (URL button with dynamic suffix)

Student kit, right after the QR, only when the Alumno's `Responsiva OK` is not
"✅". Open window → free-form `CLIENT.copy.studentResponsivaEs/En` with the
Alumno's full prefilled `Link Responsiva`; closed → this template. The body is
the free-form copy WITHOUT the "👉 {link}" line: the link is the button, whose
`{{1}}` suffix is the Alumnos record id (the responsiva worker links a signed
waiver by `rid` alone). Sent as `{type:"button", sub_type:"url", index:"0",
parameters:[{type:"text", text:<alumnoId>}]}`.

**ES (`student_responsiva_es`)**
> Último paso: tu responsiva. Toma 2 minutos desde tu cel y la necesitamos firmada antes de tu siguiente clase 📝

Button (URL): **Firmar responsiva** → `https://responsiva.mdcondesa.com/?rid={{1}}`
(sample: `https://responsiva.mdcondesa.com/?rid=recJGBLgxBbsGqrf0`)

**EN (`student_responsiva_en`)**
> Last step: your waiver. It takes 2 minutes from your phone and we need it signed before your next class 📝

Button (URL): **Sign waiver** → `https://responsiva.mdcondesa.com/?rid={{1}}`
(same sample)

Variables: **none** in the body; one in the button URL. No footer.

---

## 19. cuestionario_invite / cuestionario_invite_kids — Utility (URL button with dynamic suffix)

Pre-trial questionnaire (docs/cuestionario.md) for a lead whose 24 h window is
closed — typically a web-form booker. Open window → free-form
`CLIENT.copy.cuestionario*` with the link inline; closed → this template. Body =
the free-form copy WITHOUT the name and WITHOUT the link (the link is the
button); `{{1}}` = class day + time, kids also `{{2}}`/`{{3}}` = the child's name
(or "tu peque" / "your little one"). bfc uses the kids template. Button `{{1}}`
= the questionnaire token. **Submitted by the worker** (src/cron/
template-seed-cuestionario.ts, one-shot, kv `tpl_seed:cuestionario_invite:2026-10-13`).
Sent as body params + `{type:"button", sub_type:"url", index:"0",
parameters:[{type:"text", text:<token>}]}`.

**ES (`cuestionario_invite_es`)**
> Listo, quedó tu clase el {{1}}. Una cosa más - contéstanos esto en 3 minutos para que tu coach te reciba sabiendo qué buscas. Es lo que hace que tu primera clase sea para ti y no una clase genérica.

**EN (`cuestionario_invite_en`)**
> All set, your class is booked for {{1}}. One more thing - answer this in 3 minutes so your coach meets you already knowing what you're looking for. It's what makes your first class about you instead of a generic class.

**ES (`cuestionario_invite_kids_es`)**
> Listo, quedó tu clase el {{1}}. Una cosa más - contéstanos esto en 3 minutos para que tu coach reciba a {{2}} sabiendo qué buscan ustedes. Es lo que hace que su primera clase sea para {{3}} y no una clase genérica.

**EN (`cuestionario_invite_kids_en`)**
> All set, the class is booked for {{1}}. One more thing - answer this in 3 minutes so the coach meets {{2}} already knowing what you're looking for as a family. It's what makes the first class about {{3}} instead of a generic class.

Samples: `{{1}}` "viernes 16 de octubre a las 7:00 PM" / "Friday, October 16 at
7:00 PM"; `{{2}}`/`{{3}}` "Mateo".

Button (URL): **Contestar** / **Answer** → `https://mdcondesa.com/cuestionario/?t={{1}}`
(sample: `https://mdcondesa.com/cuestionario/?t=v1.eyJyIjoicmVjSkdCTGd4QmJzR3FyZjAiLCJ2IjoiYWR1bHRvcyIsImUiOjE3OTMyMDk2MDB9.aH_y4qlARj7FDpNrqeZx2w`)

No footer. Bodies are generated from client.mjs copy — keep them in sync (a
copy change needs a new SEED_KEY + Meta re-review).

---

## 20. primera_clase / primera_clase_kids / primera_clase_bfc — Utility (URL button with dynamic suffix)

THE trial-booking confirmation for a lead whose 24 h window is closed (web-form
bookers; owner copy 2026-10-16, docs/cuestionario.md). Open window → the same
copy free-form with the signed link inline (`CLIENT.copy.primeraClase*` +
`confirmClosing*`); closed → this template, then the booking video. Replaces
`trial_confirm(_v2)` + `cuestionario_invite*` for these leads once APPROVED
(until then the code falls back to those). One template per page because the
URL button's base differs. Body = the copy WITHOUT the name (Meta rejects an
empty parameter and no filler reads right in "Listo ___,") and WITHOUT the
link (it is the button); variables in order of appearance. **Submitted by the
worker** (src/cron/template-seed-cuestionario.ts `seedConfirmTemplates`,
one-shot, kv `tpl_seed:primera_clase:2026-10-16`).

**ES (`primera_clase_es`)** — `{{1}}` = day + time
> Listo, ya tienes tu lugar! 🙌🔥 Te esperamos el {{1}} en MD Condesa para tu primera clase. Aquí está todo lo que necesitas saber, y 3 minutos de preguntas para que tu coach te reciba sabiendo qué buscas y prepare tu clase pensando en ti 💪
>
> Si quieres invitar a un amigo o pariente, estaría súper 👊 Cualquier duda, aquí estoy 🙏

**EN (`primera_clase_en`)** — `{{1}}` = day + time
> All set, your spot is saved! 🙌🔥 We'll see you on {{1}} at MD Condesa for your first class. Here's everything you need to know, plus 3 minutes of questions so your coach meets you knowing what you're after and plans your class around you 💪
>
> If you'd like to invite a friend or family member, that'd be awesome 👊 Any questions, I'm here 🙏

**ES (`primera_clase_kids_es`)** — `{{1}}`/`{{3}}` = child, `{{2}}` = day + time
> Listo, {{1}} ya tiene su lugar! 🙌🔥 Los esperamos el {{2}} en MD Condesa para su primera clase. Aquí está todo lo que necesitan saber, y 3 minutos de preguntas para que su coach reciba a {{3}} sabiendo qué buscan ustedes 💪
>
> Si quieres invitar a un amigo o pariente, estaría súper 👊 Cualquier duda, aquí estoy 🙏

**EN (`primera_clase_kids_en`)** — `{{1}}`/`{{3}}` = child, `{{2}}` = day + time
> All set, {{1}} has a spot! 🙌🔥 We'll see you on {{2}} at MD Condesa for the first class. Here's everything you need to know, plus 3 minutes of questions so the coach meets {{3}} already knowing what you're looking for 💪
>
> If you'd like to invite a friend or family member, that'd be awesome 👊 Any questions, I'm here 🙏

**ES (`primera_clase_bfc_es`)** — `{{1}}` = child, `{{2}}` = day + time
> Listo, {{1}} ya tiene su lugar en Baby Fight Club! 🙌 Los esperamos a los dos el {{2}} en MD Condesa. Aquí está todo lo que necesitan saber para su primera clase, y 2 minutos de preguntas para que el coach los conozca antes de llegar 🥋
>
> Si quieres invitar a un amigo o pariente, estaría súper 👊 Cualquier duda, aquí estoy 🙏

**EN (`primera_clase_bfc_en`)** — `{{1}}` = child, `{{2}}` = day + time
> All set, {{1}} has a spot in Baby Fight Club! 🙌 We'll see you both on {{2}} at MD Condesa. Here's everything you need to know for the first class, plus 2 minutes of questions so the coach gets to know you before you arrive 🥋
>
> If you'd like to invite a friend or family member, that'd be awesome 👊 Any questions, I'm here 🙏

Samples: day + time "viernes 16 de octubre a las 7:00 PM" / "Friday, October 16
at 7:00 PM" ("a la 1:00 PM" for 1 PM); child "Mateo" (sent as the child's name,
else "tu peque" / "your little one").

Button (URL): **Ver mi primera clase** / **See my first class** →
`https://mdcondesa.com/tu-primera-clase/?t={{1}}` (adultos),
`…/tu-primera-clase-ninos/?t={{1}}` (kids), `…/tu-primera-clase-bebes/?t={{1}}`
(bfc); `{{1}}` = the signed token. No footer. Bodies are generated from
client.mjs copy — a copy change needs a new seed key + Meta re-review.

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
