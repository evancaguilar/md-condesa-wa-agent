# Welcome copy — DRAFT for owner approval (WP3, 2026-10-11)

Status: **proposal only.** Nothing here is live. `src/cron/seed-campaigns.ts` and the
campaign rows in D1 are unchanged; Evan pastes the approved text into Campañas →
«Respuesta automática» when he is happy with it.

## Why

Audit 2026-10:

- **welcome_resend** — a Reto lead mid-booking wrote "Jueves está bien ☺️7:00am"
  and got the Reto welcome *again* ("Dime qué día te gustaría venir…"). Booking lost.
- **joss_bfc_mini** — "Info … de una niña de 4 años" got the Baby Fight Club pitch
  for 12–36 months.
- Every welcome ends with an open "¿qué día?" question, which the lead then has to
  answer from scratch.

The code side is already fixed (see below); this copy removes the open question
and offers ONE concrete slot instead.

## The `{{slot}}` placeholder (implemented)

`firstReplyFor()` (src/pipeline/campaigns.ts) replaces every `{{slot}}` with the
soonest bookable slot, computed **at send time** by `nextTrialSlot()` for the
campaign's grid (`slotQueryForCampaign`: name contains "baby" → Baby Fight Club,
"kids/niños" → kids grid, else adults). Example value: `mañana sábado 2:00 pm`.
If the grid has no slot in the next two weeks the canned welcome is **not sent**
and the brain answers instead — never a half-filled sentence.

## Code rules that already apply to every welcome

- Bare prefill only → instant welcome (ManyChat parity).
- First message already carries a **child's age**, a **weekday/hour**, or a
  **discipline the welcome doesn't cover** → no canned text; the brain answers alone.
- Returning lead (re-click) with real text of their own → brain, never the welcome again.

## Proposed copy

### Reto Gladiador (adults)

> ¡Hola! 💪 Qué gusto que te interese el Reto Gladiador. Estamos en Av. México 49,
> 1er piso, Condesa.
>
> Empiezas con una clase de prueba GRATIS. No necesitas experiencia, y si tienes guantes y vendas tráelos; si no, nosotros te prestamos.
>
> La próxima es {{slot}} — ¿te la aparto? Si prefieres otro horario, dime cuál y lo vemos. 🙌

### Kids (6–12 años)

> ¡Hola! 🥋 Qué gusto que quieran probar Kids en MD Condesa: disciplina, confianza
> y mucha energía bien usada.
>
> La primera clase es gratis. La próxima es {{slot}} — ¿se la apartamos?
>
> Si me dicen el nombre y la edad del peque, lo dejo listo. 😊

(If the parent already gave the age, the code skips this welcome entirely, so the
age question never repeats.)

### Baby Fight Club (12–36 meses)

> ¡Hola! 🙌 Baby Fight Club es movimiento, juego y desarrollo físico inspirado en
> artes marciales, siempre con mamá o papá. Es para peques de 1 a 3 años.
>
> La primera clase es gratis. La próxima es {{slot}} — ¿se la apartamos?
>
> ¿Cómo se llama el peque? 😊

## Questions for Evan

1. OK to use "¿te la aparto?" (the brain still runs `book_trial` once the lead says
   yes — the welcome itself books nothing)?
2. Baby Fight Club: KB says "miércoles 1 pm o sábado 2 pm" in the booking rules but
   the schedule lists 12:00 pm Wed and 3:00/3:45 pm Sat. `{{slot}}` reads the slot
   grid, so the grid has to be right before this copy goes live.
3. Kids campaign name must contain "kids" or "niños" for the kids grid to be used.
