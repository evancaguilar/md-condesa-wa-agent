# ManyChat follow-up flows (transcribed from screenshots 2026-07-07)

Source: `/Users/evanaguilar/md-condesa-site/follow up screenshots/` (adults/, kids/, baby fight club/, booked/).
Transcription is verbatim Spanish from the ManyChat flow-editor screenshots, emojis preserved.

**Important caveats (apply to the whole doc):**

- **Timing/delay info is almost entirely NOT visible in the screenshots.** No "Smart Delay" durations, "Wait X hours" values, or trigger conditions were captured, with one exception: the first Baby Fight Club screenshot shows the edge of a Smart Delay node (clock icon, label cut off at "Smart D…") after message 1 — **duration unreadable**. All delays below are marked `delay: not visible`.
- **Step grouping is partially inferred.** Sequence order follows the screenshot capture order (filename timestamps) plus message-numbering labels visible in the editor (e.g. the last Adults message is labeled "Send Message #5"). Where several bubbles may belong to one ManyChat Send Message node vs. separate nodes, that is flagged.
- Buttons rendered truncated in the editor (e.g. "Agendar Día Gr…") are transcribed with their most likely full label noted; exact full label not always verifiable.
- CTR percentages shown next to buttons are ManyChat live stats, noted for reference only — they are not part of the message copy.

---

## Adults — sequence

7 message bubbles captured; the final one is labeled **"Send Message #5"** in ManyChat, so the flow has 5 Send Message nodes and some nodes contain multiple bubbles. Exact node grouping for bubbles 1–6 is **not verifiable from the screenshots** — flagged as ambiguous. Bubble order below follows capture order.

- **Bubble 1** (delay: not visible):
  > Hola! Me parece que todavía no has agendado tu día gratuito.
  >
  > Hay algo con lo que te pueda ayudar o alguna duda que quieras resolver antes de reservar?

  Button: "Agendar Día Gr…" (truncated; presumably "Agendar Día Gratuito") — URL button, CTR 6%.

- **Bubble 2** (delay: not visible):
  > Muchos de nuestros alumnos nos han dicho que entrar a la academia les cambió la vida — ya sea por el peso que han perdido o por la confianza que han desarrollado al aprender a defenderse.
  >
  > Esperamos que te des la oportunidad de vivir eso también 🙌 El primer paso es tocar el botón para agendar tu día gratuito.

  (No button visible in this screenshot crop; one may exist below the crop — unverified.)

- **Bubble 3** (delay: not visible):
  > Te dejo también nuestro horario para que veas las opciones.
  >
  > Tenemos clases en la mañana, tarde y noche, así que normalmente sí encontramos algo que se acomode a tu rutina.
  >
  > Si ves un horario que te queda bien, puedes agendar tu día gratis aquí:

  Button: "Agendar Día Gr…" (truncated) — URL button, CTR 0%.
  Attachment: image of the class schedule ("HORARIO DE CLASES — MD Self Defense Academy Condesa").

- **Bubble 4** (delay: not visible; starts with a greeting, likely opens a new day/node):
  > Hola 👋
  >
  > Pudiste encontrar algún horario que te quede bien para venir a probar tu día gratuito en MD Condesa? 🙌

- **Bubble 5** (delay: not visible):
  > Por si te sirve saberlo, no necesitas estar en forma ni tener experiencia para empezar.
  >
  > Justo por eso existe el día gratuito. Vienes, pruebas unas clases reales, conoces la academia y ves si el reto se siente como algo que sí puedes sostener.
  >
  > Te gustaría agendar tu día gratuito?

  Button: "Agendar Día Gratuito" — URL button (full label visible here).

- **Bubble 6** (delay: not visible):
  Attachment: group photo of students on the mats (the `big_145b82f7ea020c2e7f9188757ea9c488.jpg` in the folder is this photo).
  > A veces el cambio no empieza con una decisión enorme.
  >
  > Empieza con una clase. Una hora. Un primer paso.
  >
  > Si estás buscando más condición, más confianza, más comunidad y más disciplina, nuestras clases pueden ser una buena forma de empezar.
  >
  > Te gustaría probar una clase gratis?

  Quick replies: "Sí!" (CTR 5%) / "Ya no. Gracias." (CTR 1%) — each wired to a next step (edges visible but destinations not captured).

- **Bubble 7 — "Send Message #5"** (delay: not visible; final follow-up, presumably fires on "Ya no. Gracias." or no reply — condition not visible):
  > Parece que por ahora quizá ya no es el momento para ti.
  >
  > Entonces este será nuestro último mensaje de seguimiento por ahora.
  >
  > Si algo cambia y te gustaría ponerte en forma, aprender a defenderte y desarrollar más confianza y disciplina, aquí puedes agendar tu día gratuito:

  Button: "Agendar Día Gratis" — URL button.

---

## Kids — sequence (NOTE: only 3 same-day steps exist; extended steps to be authored)

3 message bubbles captured. No delays or conditions visible.

- **Step 1** (delay: not visible):
  > Hola! Me parece que todavía no has agendado el día gratuito para tu hijo.
  >
  > Hay algo con lo que te pueda ayudar o alguna duda que quieras resolver antes de reservar?

  Button: "Agendar Día Gr…" (truncated) — URL button, CTR 6%.

- **Step 2** (delay: not visible):
  > Uno de los cambios más bonitos que vemos en los niños es cómo empiezan a ganar confianza poco a poco.
  >
  > No solo aprenden técnicas, también aprenden a pararse más seguros, escuchar mejor y creer más en sí mismos.
  >
  > Puedes reservar su clase gratis aquí:

  Button: "Agendar Día Gr…" (truncated) — URL button, CTR 7%.

- **Step 3** (delay: not visible):
  > También es una gran forma de sacarlos un rato de las pantallas 🙌
  >
  > En vez de estar sentados, se mueven, juegan, entrenan, conviven con otros niños y desarrollan habilidades reales.
  >
  > Si ves un horario que les funciona, puedes revisar la disponibilidad actual y agendar su clase gratis aquí:

  Button: "Agendar Día Gr…" (truncated) — URL button, CTR 4%.
  Attachment: image of the class schedule (same "HORARIO DE CLASES" graphic, with GI / NO GI legend).

---

## Baby Fight Club — sequence

7 message bubbles captured. A **Smart Delay node exists after Step 1** (clock icon visible, label cut off — **duration unreadable**). Order follows capture order; the day-grouping of steps 3–6 is inferred, not confirmed.

- **Step 1** (delay: not visible):
  > Hola! Me parece que todavía no has agendado la clase gratuita para tu bebé.
  >
  > Hay algo con lo que te pueda ayudar o alguna duda que quieras resolver antes de reservar?

  Button: "Agendar Día Gr…" (truncated) — URL button, CTR 7%.
  Followed by: Smart Delay node (duration not readable in screenshot).

- **Step 2** (delay: not visible):
  > A esta edad, cada nueva experiencia cuenta mucho 🙌
  >
  > Baby Fight Club es una forma divertida de darle a tu bebé movimiento, convivencia y confianza desde pequeñito, sin presión y acompañado por ti.
  >
  > Puedes reservar su clase gratis aquí:

  Button: "Agendar Día Gr…" (truncated) — URL button, CTR 9%.

- **Step 3** (delay: not visible; may be same node as Step 2 — ambiguous):
  > Si les interesa probar, el siguiente paso es muy sencillo: dime si te queda mejor miércoles 11 am o sábado 2 pm y apartamos su clase gratis 💪

- **Step 4** (delay: not visible; starts with greeting, likely a new day):
  > Hola! Algo que nos ha encantado ver en Baby Fight Club es cómo algunos bebés llegan tímidos o incómodos al inicio y, después de unas clases, empiezan a moverse con más confianza y hasta se adueñan del tatami 😄
  >
  > Si todavía les interesa probar, dime si prefieres miércoles 11 am o sábado 2 pm y revisamos disponibilidad 🙌

  Quick replies: "Miércoles 11 AM" (CTR 1%) / "Sábado 2 PM" (CTR 1%).

- **Step 5** (delay: not visible):
  > Hola de nuevo! Además de la clase, al final tenemos 10 minutos de juego libre.
  >
  > Esa parte ha sido increíble para que los bebés exploren, convivan y empiecen a socializar con otros bebés en un espacio seguro.
  >
  > Quieres que te ayude a apartar su clase gratuita?

  Quick replies: "Sí por favor" (CTR 0%) / "Ya no nos interes…" (truncated; presumably "Ya no nos interesa") (CTR 8%).

- **Step 6** (delay: not visible; position in sequence inferred from capture order — could plausibly belong earlier in the flow):
  > A esta edad, estimular movimiento, equilibrio, coordinación y confianza corporal puede hacer una gran diferencia.
  >
  > Baby Fight Club busca justo eso: que tu bebé se mueva, juegue, explore y gane seguridad, siempre acompañado por mamá o papá.
  >
  > Para apartar su clase gratis solo necesito:
  >
  > 1. Si prefieren miércoles 11 am o sábado 2 pm
  > 2. Tu nombre
  > 3. El nombre y edad de tu bebé

- **Step 7 — final** (delay: not visible):
  > Parece que quizá no es el momento correcto para ustedes, y está bien 🫶
  >
  > Este será nuestro último mensaje de seguimiento por el momento.
  >
  > Si más adelante te gustaría que tu bebé pruebe Baby Fight Club, con gusto les apartamos una clase gratuita.

  (Emoji after "está bien" is a small yellow heart-hands-style glyph — transcribed as 🫶 but rendered tiny in the screenshot; **verify**.)

---

## Booked — confirmation message (sent with video Confirmar reserva.mp4)

Five confirmation variants were captured. ManyChat variables appear as pills in the editor; transcribed here in `{{variable}}` form: **{{name}}** (subscriber first name), **{{dia_bonito}}** (human-friendly booked date), **{{clases}}** (booked class/classes), **{{nombre_nino}}** (child's name).

The location link renders literally as `https://mc.ht/s/XXXXXX` in the screenshots (ManyChat short link — appears redacted/placeholder; real slug not visible).

Which variant accompanies the `Confirmar reserva.mp4` video is not labeled in the screenshots; presumably the adult variants (captured from the Chrome flow editor alongside the video node). **Flagged: video-to-message pairing not explicitly visible.**

### Variant A — Adult, 2 classes booked

> Perfecto! Ya quedó tu lugar 🙌
>
> 📅 Te esperamos el {{dia_bonito}}.
>
> Vas a probar 2 clases seguidas: {{clases}}. Cada clase dura una hora, así conoces bien la academia y puedes vivir la experiencia completa 🔥
>
> Te recomendamos llegar 10 minutos antes y traer:
>
> 👕 Ropa deportiva cómoda
> 🩴 Chanclas o sandalias para fuera del tatami
> 💧 Botella de agua
> 🥊 (Opcional si vas a tomar muay thai) Guantes y vendas de box si tienes. Si no, te los prestamos.
>
> Si quieres usar el ice bath / baño de hielo, solo necesitas avisarnos antes y traer toalla y traje de baño.
>
> La clase es completamente gratuita, pero te recomendamos traer tu tarjeta por si quieres aprovechar nuestra promoción especial para nuevos alumnos que se inscriban en su primera visita.
>
> Si tienes cualquier otra duda, aquí estamos 💪 Y si quieres invitar a un amigo o familiar, ¡será más que bienvenido! 🙌

### Variant B — Adult, 1 class booked

> Perfecto! Ya quedó tu lugar 🙌
>
> 📅 Te esperamos el {{dia_bonito}}.
>
> Vas a probar la clase de {{clases}} 🔥
>
> 💡 Si te gustaría conocer 2 disciplinas en tu visita, dime y con gusto te paso opciones para probar 2 clases seguidas.
>
> Te recomendamos llegar 10 minutos antes y traer:
>
> 👕 Ropa deportiva cómoda
> 🩴 Chanclas o sandalias para fuera del tatami
> 💧 Botella de agua
> 🥊 (Opcional si vas a tomar muay thai) Guantes y vendas de box si tienes. Si no, te los prestamos.
>
> Si quieres usar el ice bath / baño de hielo, solo necesitas avisarnos antes y traer toalla y traje de baño.
>
> La clase es completamente gratuita, pero te recomendamos traer tu tarjeta por si quieres aprovechar nuestra promoción especial para nuevos alumnos que se inscriban en su primera visita.
>
> Si tienes cualquier otra duda, aquí estamos 💪 Y si quieres invitar a un amigo o familiar, ¡será más que bienvenido! 🙌

### Variant C — Kids trial class

> ¡Listo, {{name}}! Ya quedó su lugar 🙌
>
> 📅 Te esperamos con {{nombre_nino}} el {{dia_bonito}} para su clase de prueba.
>
> Para su primera visita:
>
> 👕 Ropa cómoda para entrenar
>
> 🩴 Sandalias/chanclas para fuera del tatami
>
> 💧 Botella de agua
>
> 😄 Muchas ganas de aprender y divertirse — no necesita experiencia
>
> Por favor lleguen 10 min antes para recibirlos bien y mostrarles la academia.
>
> 📍 Ubicación:
>
> https://mc.ht/s/XXXXXX
>
> ¡Nos vemos en MD Condesa! 💪

### Variant D — Baby Fight Club

> ¡Listo, {{name}}! Ya quedó su lugar 🙌
>
> 📅 Te esperamos con {{nombre_nino}} el {{dia_bonito}} para Baby Fight Club.
>
> Esta clase es para que tu bebé se mueva, explore y gane confianza… pero mamá/papá también participan 😄
>
> Así que vengan listos para moverse, jugar y acompañar a {{nombre_nino}} durante la clase.
>
> Qué traer?
>
> 👕 Ropa cómoda para tu bebé
>
> 🩴 Sandalias/chanclas para fuera del tatami
>
> 💧 Agua
>
> No necesitan experiencia. Todo es a través de juegos, movimiento y ejercicios seguros para su edad.
>
> Por favor lleguen 10 min antes para recibirlos bien y mostrarles la academia.
>
> 📍 Ubicación:
>
> https://mc.ht/s/XXXXXX
>
> ¡Nos vemos en MD Condesa! 👶🥋

### Variant E — Young kids (parent-assisted; likely 3–5 años)

> ¡Listo, {{name}}! Ya quedó 🙌
>
> 📅 Te esperamos con {{nombre_nino}} el {{dia_bonito}} para su clase de prueba.
>
> En esta etapa, mamá/papá pueden participar para ayudar a que {{nombre_nino}} se sienta con más confianza.
>
> Vengan listos para moverse un poco, acompañarlo y ayudarlo a integrarse a la clase.
>
> Para su primera visita:
>
> 👕 Ropa cómoda para entrenar
>
> 🩴 Sandalias/chanclas para fuera del tatami
>
> 💧 Botella de agua
>
> 😄 Muchas ganas de aprender y divertirse — no necesita experiencia
>
> Por favor lleguen 10 min antes para recibirlos bien y mostrarles la academia.
>
> 📍 Ubicación:
>
> https://mc.ht/s/XXXXXX
>
> ¡Nos vemos en MD Condesa! 💪

Notes on Variants C–E: captured from Finder Quick Look previews of editor screenshots; a "Send Message #…" node label is visible on Variant C but the number is cut off. The calendar emoji renders as the Apple calendar glyph showing "17" — transcribed as 📅 (could be 🗓; indistinguishable at screenshot size).

---

## Ambiguities / unreadable items (summary)

1. **No delay durations anywhere** — the only delay node visible is a cut-off "Smart D…" after Baby Fight Club Step 1; its duration is unreadable. All step timings need to be pulled from ManyChat directly.
2. **No branch conditions visible** (e.g. "if no reply", quick-reply routing destinations). Adults Bubble 7 ("Send Message #5") and BFC Step 7 read as no-reply/opt-out finales, but the trigger condition is not in the screenshots.
3. **Adults node grouping**: 7 bubbles vs. "Send Message #5" label → some nodes contain multiple bubbles; exact grouping unknown.
4. **BFC Step 6 position** inferred from capture order only; content-wise it could sit earlier in the flow.
5. **Truncated button labels**: "Agendar Día Gr…" (most instances) and BFC "Ya no nos interes…" — full text presumed but not confirmed.
6. **`https://mc.ht/s/XXXXXX`** is what the screenshots literally show — real short-link slug not captured.
7. **BFC Step 7 emoji** after "está bien" transcribed as 🫶 — glyph too small to be certain.
8. **Which booked variant pairs with Confirmar reserva.mp4** is not labeled in the screenshots.
