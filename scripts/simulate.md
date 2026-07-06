# Simulation script — 10 test personas (phase-gate testing)

Use these to sanity-check the bot before each phase gate. During
`TRAINING_WHEELS=1`, "expected behavior" describes the **draft** you should see in
#wa-leads (you still approve it). The point is to confirm the bot reasons and
routes correctly — books when it should, escalates when it should, never invents
prices/schedule.

Send each message from a test WhatsApp to the business number, one persona per
fresh conversation where possible (or wait out the 8s debounce between turns).

Reference facts the bot should stay consistent with:
- Address: **Av. México 49, 1º piso, Condesa**.
- Booking pages: `mdcondesa.com/clase-prueba-adultos/` /
  `mdcondesa.com/clase-prueba-ninos/`.
- Adult pricing: Diamond $999 / Gold $749 / Silver $625 / Bronze $499 MXN per
  week; inscription waived online. (Kids/drop-in pricing come from `kb/intake.md`
  — if a persona asks and you left those TODOs blank, the bot SHOULD go low-
  confidence rather than invent a number.)

---

### 1. Adult BJJ lead (English)
**Send:** "Hi! Do you have adult jiu jitsu classes? I'm a total beginner."
**Expect:** Warm EN reply (mirrors language), confirms adult BJJ exists, invites a
trial, starts qualifying (name / when they can come). Confidence high. No invented
schedule beyond the KB. Nudges toward booking a trial.

### 2. Mom asking about kids Muay Thai (Spanish)
**Send:** "Hola, tienen muay thai para niños? mi hijo tiene 8 años"
**Expect:** ES reply, confirms kids programming, asks day/time that suits them,
moves toward a kids trial (`audience: kid`). If kids pricing was left as a TODO in
intake.md, it should NOT invent a price — either omit it or go low-confidence and
offer to confirm.

### 3. Price shopper
**Send:** "cuánto cuesta la mensualidad? nada más el precio porfa"
**Expect:** Gives the adult weekly tiers from the KB (Diamond/Gold/Silver/Bronze),
mentions the online-inscription-waived promo, then pivots to inviting a free trial.
Should NOT negotiate. If pushed to negotiate ("¿me haces descuento?") → see #7.

### 4. Direct booking, same day ("hoy a las 6pm")
**Send:** "quiero ir hoy a las 6pm a jiu jitsu, me llamo Carlos"
**Expect:** Bot resolves "hoy" against the CDMX date in context, checks the
schedule. If BJJ runs today at 18:00 → calls `book_trial` (you'll see a "📅 Clase
de prueba agendada" FYI card in Slack) and drafts a confirmation with the address
+ what to bring. If there's no 6pm BJJ today → it should NOT book; instead it
offers the real same-day options or another day.

### 5. Direct booking, next day ("mañana 7am")
**Send:** "mañana a las 7am puedo? para probar box"
**Expect:** Resolves "mañana" to tomorrow's date, validates a 07:00 boxing slot.
Books if it exists (FYI card + confirmation draft), otherwise proposes valid
alternatives. Confirms name if not yet known.

### 6. Reschedule an existing trial
**Send:** (after a booking) "oye necesito cambiar mi clase de prueba, no puedo ese
día"
**Expect:** Bot is accommodating, asks for the new day/time, and re-books to a
valid slot (or sends the booking link). Should not leave the lead hanging. If it's
unsure how to move an existing record, low-confidence draft is acceptable.

### 7. Angry current student (complaint)
**Send:** "llevo 3 meses y nadie me ha dado seguimiento, pésimo servicio"
**Expect:** `escalate_to_human`. Bot does NOT try to resolve the complaint itself —
it pings Slack (⚠️ Escalar) and pauses for that conversation (human override).
Same trigger for refund/price-negotiation/anger.

### 8. Injury / medical question
**Send:** "tengo una lesión en la rodilla, puedo entrenar jiu jitsu?"
**Expect:** `escalate_to_human` (injuries are a hard-escalate per policy). It
should NOT give medical advice or a definitive yes/no. A warm "let me get a coach
to answer that properly" tone in the escalation summary.

### 9. Spam / irrelevant
**Send:** "🎰🎰 GANA DINERO RÁPIDO clic aquí bit.ly/xxxx"
**Expect:** Bot does not engage the spam or click anything. Best case it produces a
low-confidence/no-op draft or a neutral "¿en qué te podemos ayudar con las clases?"
that you can just discard. It must not book, escalate as if a real lead, or follow
links.

### 10. BAJA opt-out
**Send:** "BAJA"
**Expect:** Immediate opt-out handling (before the brain even runs): contact set to
`opted_out`, all scheduled followups cancelled, ONE confirmation message sent
("Listo, no te enviaremos más mensajes…"), and nothing after. Verify a later
normal message from that number does NOT resume automated followups until they
re-engage. (STOP and ALTO trigger the same path.)

---

## What "graceful" looks like even when things break

- If Anthropic/Slack/Airtable are down or misconfigured, the bot must NOT 500 or
  drop the webhook. It drafts a safe apology ("¡Gracias por escribir! 🙌 Dame un
  momento…") into the approval queue and logs the error. You still see something in
  Slack (or, if Slack is the thing that's down, the approval row is at least saved
  in the database for retry). No customer gets a broken/blank message.
- Duplicate webhook deliveries (Meta retries) are deduped on `wamid` — the same
  message is never answered twice.
