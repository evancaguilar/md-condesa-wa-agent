# Slack channels: first-principles review (#wa-leads + #ventas)

> Written 2026-10-06 after Evan: "the #wa-leads channel is overwhelming. I think it's getting ignored by the team and me because of it. We have to start from first principles, review how everything's been used up to this point, and think about the best way to manage the channel moving forward (especially in conjunction with #ventas)."
>
> Status: **proposal, nothing changed yet.** Evan decides; the implementation sketch at the end is ~1 day.

## 1. What actually lands in the channels today

Sample: every message in **#wa-leads** from 2026-10-04 20:05 to 2026-10-06 12:47 (≈41 h, 104 messages, ≈60/day) and every message in **#ventas** from 2026-10-03 11:17 to 2026-10-06 11:18 (≈72 h, 50 messages, all from the Airtable app).

### #wa-leads (the bot)

| Type | ≈ count / 41 h | Needs a human? | Where else it lives |
| --- | --- | --- | --- |
| ⚡ "Nuevo lead — campaña X. Respuesta automática enviada" | 58 | No | Chats tab, Airtable `Leads` |
| 📅 "Clase de prueba agendada" | 14 | No | Airtable (+ #ventas posts it again) |
| Reply echoes: ✅ Enviada · ⏱ Enviada automáticamente · ⏯ Reemplazada · ✏️ Editada y enviada | 7 | No | Aprobaciones tab history |
| Reports: 🌙 auditor nocturno (very long) · 📊 gasto · 📈 funnel · 🕵️ reconciliación | 7 | Read once a day | — |
| Ops/debug: 🔬 best-bet, 🔗 ad linked, template/welcome failures, panel-reply echoes, opt-out, "alumno conocido escribió" | 13 | Only Evan, sometimes | Logs |
| **Action required**: ⏳ "lleva rato pendiente" · ⚠️ Escalar · 💳 quiere pagar · 🔥 asistió y no se inscribió | **5** | **Yes, now** | Aprobar tab (approvals/escalations) |

≈5 % of the channel is a task. The rest is a live log. The approval cards themselves (Aprobar / Editar / Tomar control) are posted and then edited in place, so they are not visible as separate rows above, but they sit inside the same stream.

### #ventas (Airtable automations)

| Type | ≈ count / 72 h | Problem |
| --- | --- | --- |
| "¿Llegó X?" + Asistió / No asistió / Reprogramó | 27 | Fires at 07:17 for a 07:00 class and again the next morning; the same lead asked twice (Roami Soto 18:17 and 07:17). This is the attendance source of truth since the bot's own card was retired on 2026-09-18. |
| "X acaba de agendar un día gratuito! toca esta liga para mandarle un mensaje confirmando…" | 9 | Asks staff to **hand-send a WhatsApp confirmation the bot already sends** (`trial_confirm`). The wa.me prefill still says "la promoción que termina este viernes 31" (stale). Posted twice for Gabriel medina with two different phones. |
| "Xllegó a su clase de prueba! ¿Se queda a 2 clases o sólo a una?" | 14 | Missing space (`Julienllegó`), posted twice for Julien (09:57 and 11:18, "Julien copy"). It is a question nobody answers in-thread (1 reply in 14). |

Both channels announce the same booking (bot 📅 card + Airtable "acaba de agendar"), and attendance is asked by Airtable while the bot posts the 🔥 "asistió y no se inscribió" card for the same lead 3 h later. A team member who wants to know "what do I have to do right now" has to read ~80 messages a day across two channels to find ~8.

## 2. First principles

1. **A channel is a promise about what reading it gets you.** If #wa-leads mixes tasks with a log, the only rational behaviour is to mute it, which is what happened. One channel = one reader + one kind of obligation.
2. **A task channel is a queue.** Every message in it is something a named person must do, with a visible done-state (button pressed, ✅ reaction, card edited to "resuelto"). If an item can sit there with nothing to do, it is not a task channel anymore.
3. **Every event has exactly one source.** Bot *or* Airtable, never both. Today bookings and attendance have two.
4. **@here is for deadlines only.** Today it fires for "lleva rato pendiente", escalations, payment intent, student-on-the-lead-line, D1/brain outages. That is fine *if* the channel is quiet otherwise. Target: ≤ 5 pings/day.
5. **The dashboard already is the queue.** Aprobar + No leídos + Inicio hold the real state. Slack's job is to pull a human into the dashboard at the right moment, not to mirror it.
6. **Reports are read once, in the morning.** Three separate morning posts (audit, gasto, funnel) plus two recon posts should be one digest with details in a thread.

## 3. Proposed layout

| Channel | Reader | Content | Pings |
| --- | --- | --- | --- |
| **#wa-leads → task queue** (keep the name, people know it) | Front desk / sales, Evan | Approval cards that need a human (escalations ⚠️, guarded drafts, anything pending > 10 min), 💳 wants to pay, 🔥 attended-not-enrolled, 🥋 attendance to mark (ONE source, see §4), 🆘 crisis, "alumno escribió en la línea de leads". Plus ONE pinned/rolling **status line** edited in place every 5 min: `Pendientes: 3 aprobaciones (más antigua 42 min) · 2 asistencias por marcar · 1 escalación`. | @here when the oldest pending > 30 min, on escalations, crisis, payment intent. |
| **#wa-feed** (new, muted by default) | Nobody in real time; searchable | ⚡ nuevo lead, 📅 agendada, ✅/⏱/⏯/✏️ reply echoes, 🧑‍💻 panel replies, 🚫 opt-outs, 🔗 ad linked. | Never. |
| **#bot-ops** (new) | Evan + whoever maintains the bot | 🛑 infra alerts (D1, Anthropic, Meta), 🧠⚠️ brain outage, template/welcome send failures, 🔬 best-bet debug, 📝 template sync, 🕵️ reconciliación, 📊 gasto. | @here on 🛑 / 🧠⚠️ only. |
| **#reportes** (new, or a daily thread in #ventas) | Evan, coaches | 08:00 one digest: funnel brief + gasto + nightly audit summary; audit detail in the thread. | Never. |
| **#ventas** | Humans | Back to a human conversation channel. Airtable automations pruned to what the bot does not cover (§4). | — |

Why not fold #ventas into #wa-leads: #ventas is where people talk; a bot stream kills that. Why not DM Evan for ops: it hides outages from whoever is on shift when Evan is not.

## 4. Who owns which event (de-duplication)

| Event | Today | Proposed owner | Why |
| --- | --- | --- | --- |
| New trial booked | Bot 📅 card + Airtable "acaba de agendar" (asks for a manual WhatsApp) | **Bot → #wa-feed**; Airtable automation **off**. | The bot already sends `trial_confirm` and the anti-no-show sequence. The Airtable post asks staff to redo it by hand with stale promo text. |
| "¿Llegó X?" attendance | Airtable (bot card retired 2026-09-18) | **Airtable → #wa-leads** (task), fix: fire at class start + 60 min, once per record, dedupe by record id. Or re-enable the bot's card and turn Airtable's off: the bot's button can also trigger the no-show follow-up. Pick one. | One source. |
| "¿Se queda a 2 clases o sólo a una?" | Airtable, no one answers | **Drop**, or make it a third button on the attendance card. | A question with no owner is noise. |
| Attended, did not enrol | Bot 🔥 card (3 h after class) | Bot → #wa-leads (task). | Already a task with a button. |
| Pending approval ageing | Bot ⏳ @here | Replace per-card pings with the rolling status line + one @here when oldest > 30 min. | 3 pings in 41 h for 3 cards → 1 line. |
| Nuevo lead / replies sent | Bot, per event | #wa-feed, no ping. | Not a task. |
| Reports | 5 posts/morning | 1 digest, details in thread. | Read once. |

## 5. Implementation sketch (worker side, ~1 day)

- `wrangler.jsonc` vars: `SLACK_CHANNEL_ID` (tasks, unchanged), `SLACK_CHANNEL_FEED_ID`, `SLACK_CHANNEL_OPS_ID`, `SLACK_CHANNEL_REPORTS_ID`. **Unset ⇒ falls back to `SLACK_CHANNEL_ID`**, so the rollout is one channel at a time and nothing breaks.
- `src/services/slack.ts`: `postNote(env, text, kind?: "task" | "feed" | "ops" | "report")` → channel by kind. Default stays `task` so untouched call sites keep today's behaviour; then move call sites one by one (the inventory in §1 is the checklist). Cards with buttons (approvals, escalations, 🔥, attendance) stay in the task channel because the interactivity handler assumes one channel.
- Status line: kv `status_line_ts`; cron edits the message in place each tick (`chat.update`), pings via a separate short message only when the oldest pending crosses 30 min (kv-throttled like `brain_outage_alert`).
- Morning digest: `runMetricsBrief`, `runBudgetReport`, `runNightlyAudit` write their text to kv; one 08:00 job posts the digest and threads the long audit under it.
- Airtable: turn off the "acaba de agendar" automation; fix the attendance automation's timing and dedupe (or re-enable the bot card and turn Airtable's off).
- Tests: routing table is pure (kind → channel with fallback) → unit test; status-line text builder → unit test.

## 6. Open decisions for Evan

1. Attendance owner: Airtable (fix timing/dedupe) or bot (re-enable the retired card)?
2. Three new channels or two (#bot-ops could absorb #reportes)?
3. Rolling status line: yes/no? It is the single biggest noise cut (every ⏳ ping and every echo goes away).
4. Who is the named owner of #wa-leads during opening hours? A queue with no owner is the channel we have now.
