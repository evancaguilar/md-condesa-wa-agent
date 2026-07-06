# Cutover runbook — ManyChat → your own WhatsApp AI agent

**When:** a quiet Sunday night (fewest incoming leads, most time to react).
**Who:** Evan.
**Big reassurance up front:** your **WhatsApp Business app on your phone never
stops working**. This whole setup is "coexistence" — your phone and the bot share
the same number. If anything feels wrong, you keep answering from your phone like
always, and the rollback below reconnects ManyChat in minutes. Nothing here can
lock you out of your own number.

Before you start, confirm Phase 0 is done: worker deployed, all secrets/vars set,
D1 schema applied, Meta business verification approved, all 6 templates approved
in ES + EN, Slack #wa-leads has the bot, and `TRAINING_WHEELS=1`.

---

## Part A — pre-flight (do earlier Sunday, in daylight)

1. Open Slack **#wa-leads**. Confirm the pinned **🤖 Bot MD Condesa** control
   panel card is there and shows **✅ Activo**. If it's missing, hit
   `https://<worker-host>/health` in a browser — you should see
   `{"ok":true,...,"botEnabled":true}`. (The control-panel card also auto-creates
   on the daily 10:00 sync.)
2. From your own phone, send a test message to the business number
   ("hola, info de clases"). Within ~10s a **draft card** should appear in
   #wa-leads (because `TRAINING_WHEELS=1`). Tap **✅ Aprobar** and confirm the
   reply lands on your phone. This proves the full loop works before you touch
   ManyChat.
3. Send **BAJA** from the test phone — confirm you get the opt-out confirmation
   and no more bot drafts. Then send a normal message again to re-enable.

## Part B — the cutover (Sunday night)

The bot is ALREADY receiving webhooks (Meta was pointed at your worker in Phase 0
Step 8). ManyChat is still also connected. "Cutover" means **disconnecting
ManyChat** so it stops auto-replying and the bot becomes the only automation.

1. **Announce nothing to customers** — this is invisible to them. The number
   doesn't change.
2. Open **ManyChat → Settings → the WhatsApp channel / integration**.
3. **Disconnect / pause the WhatsApp automation** in ManyChat (turn off its
   flows, or disconnect the WhatsApp number from ManyChat). This is the single
   switch that hands automation over to your bot. Do NOT delete anything — pausing
   is reversible; deleting is what makes rollback slower.
4. Send one more test from your phone ("cuánto cuesta jiu jitsu"). Confirm:
   - a draft appears in #wa-leads (and NOT a ManyChat auto-reply),
   - you approve it, and it sends.
   If you see a ManyChat reply instead, its automation is still on — go back to
   step 3.
5. You're live. Leave `TRAINING_WHEELS=1`. For the next **1–2 weeks** every
   customer reply waits for your **Aprobar** tap in Slack. Watch the drafts. When
   they're consistently good, we flip `TRAINING_WHEELS` to `0` in Cloudflare (that
   step is deliberately NOT part of tonight).

## Part C — first-night watch

- Keep Slack #wa-leads open for the evening. Approve/Edit drafts as leads come in.
- If you answer a lead **from your phone's WhatsApp app** instead of Slack, the
  bot notices (coexistence echo) and automatically goes quiet for that person for
  8 hours — you'll see a "Evan respondió desde el teléfono — bot en pausa hasta
  HH:MM" note in Slack. That's expected and good.
- If the bot ever gets noisy or wrong across the board, hit **⏸️ Pausar bot** on
  the pinned control panel. Every message then just gets surfaced to Slack and you
  answer from your phone. Tap **▶️ Reanudar** when ready.

---

## Rollback (if you want ManyChat back)

Takes ~5 minutes. Customers never notice.

1. **Fastest safety move first:** in Slack, tap **⏸️ Pausar bot** on the control
   panel. The AI now stays silent; you answer from your phone. This alone buys you
   time — you're never stuck.
2. **Reconnect ManyChat:** ManyChat → the WhatsApp channel → **reconnect / turn
   the flows back on** (the reverse of Part B step 3). Since you paused rather than
   deleted, its flows are intact.
3. **(Optional) Stop the bot receiving entirely:** in
   developers.facebook.com → WhatsApp → Webhooks, unsubscribe the `messages`
   field (or point the callback URL back to ManyChat's). Leaving the bot subscribed
   but **paused** is usually enough and easier to undo.
4. Send yourself a test message and confirm ManyChat replies again.

Your phone's WhatsApp Business app worked the whole time and keeps working. The
number, your chats, and your customers are never at risk in either direction.
