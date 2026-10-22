# Slack routing (2026-10-22): #wa-leads, #evan-alerts, ops_log

This replaces the two-channel layout from docs/slack-channels-review.md (2026-10-06: #wa-leads for tasks, #bot-ops for everything else). #bot-ops is retired, and the bot's mechanical notes now live in D1.

| Destination | Reader | Contents | Code |
|---|---|---|---|
| **#wa-leads** (`SLACK_CHANNEL_ID`) | The team | Only what the team must act on: approval cards, booking FYIs, human-task notes ("mándale el QR a mano", "agrega la etiqueta en Airtable"), the queue scoreboard and its ping, and the control panel. When the daily closing queue ships, it goes here too. | `postTaskNote`, `postDraft`, the card builders |
| **#evan-alerts** (`SLACK_CHANNEL_ALERTS_ID` = C0C0YSLS622) | Evan | Only what needs Evan: the nightly-audit summary (one message), sales escalations past their SLA, template approved/rejected notices from Meta, and a one-line post for every `level=critical` event. When they ship, the Monday scoreboard and the "en negociación X días sin contacto" escalation go here too. | `postAlert` / `alertNote()` |
| **D1 `ops_log`**, shown in /admin → Logs (owner-only) | Evan, when debugging | Everything else: sync FYIs, template seeding, reports (budget, funnel brief), panel echoes, opt-outs, non-blocking failures, debug. | `postNote(text, { kind, level, meta })` |

**Rules**

- **One channel per event.** No event posts to two Slack channels. `postAlert` also writes an ops_log row, but ops_log is not Slack.
- **`level=critical` means a failure that blocks sends.** It writes ops_log and also posts one line to #evan-alerts. That line is the message's first line plus a `detail` link to `/admin#logs/<kind>`. The post is deduped per kind for 30 minutes (kv `ops_crit:<kind>`) and fails open when D1 is down, because infra alerts fire exactly when D1 is down.
- **Default `level`** comes from the note's leading emoji (`inferLevel`): ❌/🛑/🚨 → error, ⚠️ → warn, anything else → info. `critical` is never inferred.
- **Default `kind`** is `misc`. Bind a real kind at the wiring site.
- **`ops_log` fails soft.** Before the migration, or on any D1 error, the row goes to `console` (Cloudflare → Workers → Logs) and the caller never sees an error.
- **Retention.** Rows older than 30 days are pruned daily at 04:00 CDMX (`pruneOpsLog`, kv `ops_log_prune_mark`). The prune also creates the three ops_log indexes from the worker.
- **Legacy cards.** `SLACK_CHANNEL_OPS_ID` (#bot-ops) is never posted to. It is kept only so buttons on cards already in #bot-ops (the old auto-sent "Tomar control" FYIs) can still be edited.

## Routing table (event → old → new)

### → #evan-alerts

| Event | Old | New | ops_log kind / level |
|---|---|---|---|
| Nightly audit report | #bot-ops: a header plus 1–N chunks | One summary to #evan-alerts (resumen, números, problem and suggestion counts, link to the full report). The full report goes to ops_log. | audit / info |
| Nightly audit: no conversations; audit failed for the day | #bot-ops | #evan-alerts | audit |
| Escalation unanswered past its SLA (step 2) | DM to `SLACK_OWNER_USER_ID` (usually unset, so skipped) | #evan-alerts. The task itself and the 45-minute re-ping stay in #wa-leads. | approvals |
| **New:** template APPROVED / REJECTED / PAUSED / DISABLED / FLAGGED / REINSTATED (`message_template_status_update`) | Ignored | #evan-alerts | template |
| Infra alarm (D1 saturated or failing, Anthropic, Meta 5xx/429), from cron, webhook, admin and Slack routes | #bot-ops `<!here>` | One critical line | infra / critical |
| **New:** WhatsApp token invalid or expired (401/403, code 190, OAuthException) | console only | One critical line | infra / critical |
| Brain (Anthropic) `api_error` alarm | #bot-ops `<!here>` | One critical line | brain / critical |
| Blast auto-paused (template or account error) | #bot-ops | One critical line | blast / critical |
| Follow-up template missing or failing (at most once a day) | #bot-ops | One critical line | template / critical |
| `cuestionario_invite` template unavailable (at most once a day) | #bot-ops | One critical line | template / critical |

### → #wa-leads (moved here)

| Event | Old | New |
|---|---|---|
| 📅 Trial class booked (bot FYI) | #bot-ops | #wa-leads, silent |
| Student kit: Alumno unreadable or not found, or QR/responsiva not deliverable (send by hand) | #bot-ops | #wa-leads |
| IG/FB student needs the QR by hand | #bot-ops | #wa-leads |
| Scheduled staff message NOT sent (24h window closed) | #bot-ops | #wa-leads |
| Both welcome templates failed | #bot-ops | #wa-leads |
| 🕵️ Booking reconciliation: confirmations with no Airtable record | #bot-ops | #wa-leads |
| "❌ No se pudo registrar" (booking guard, no card) | #bot-ops | #wa-leads |
| Reto login: couldn't reply to the lead; number lacks the `fundamentos` tag | #bot-ops | #wa-leads |
| 📥 Message NOT saved (D1 down; reply from the WA app) | #bot-ops | #wa-leads (plain Slack, no D1) |
| 🚫 "Plantilla NO enviada" (reply to a button click: opted out / IG-FB) | #bot-ops | #wa-leads |

### → #wa-leads (unchanged)

Draft approval cards, escalation tasks and their re-ping, the scoreboard and its hourly ping, the control panel, the 🔥 post-trial card, the booking capture card, 💳 buy intent, 📝 Marcar Perdido, kill-switch messages, "alumno conocido escribió", 🚨 crisis, trial cancellations, booking alerts (Airtable rejected the booking / invalid slot), ⚠️ Horario a revisar, cuestionario completed, and the edit-tuner summary and proposal cards.

### → ops_log only (was #bot-ops)

| Event | kind |
|---|---|
| 🤖 Auto-sent reply FYI (its "Tomar control" button is gone; take over from the dashboard chat, which is linked in meta) | autosend |
| Night mode on/off, auto-send on/off | autosend |
| 📊 Budget report and threshold crossed | budget |
| 📈 Funnel brief, link sweeps, ad-spend errors and backfill | metrics |
| CAPI sweep and drain | capi |
| Meta audiences sync | audiences |
| Template seeding, sync, and submit/edit from the panel; student_welcome failing with human_followup sent | template |
| Template status PENDING / IN_APPEAL / DELETED / … | template |
| Campaign seeds and trigger updates | seed |
| Blast finished, expired, queued, paused, resumed, cancelled (by a human) | blast |
| Panel echoes (text and media, scheduled sends), "lead wrote first", duplicate claim, takeover | panel |
| Opt-outs (inbound, AI-detected, manual set and clear) | optout |
| Override "(bot en pausa por override)", approval resolved from the panel, 🔬 best-bet diagnostic | approvals |
| Duplicate confirmation suppressed, booking registered from the panel, booking record not found | booking |
| Reto: site failed but fallback sent | reto / warn |
| ⚡ New lead welcome, 🔗 ad auto-linked | campaign |
| "Evan respondió desde el teléfono" echo | webhook |
| Cuestionario send failures | cuestionario |
| 🎟️ QR sent, "Se inscribió" hook failure (cron retries) | student_kit |
| IG/FB 7-day window closed | followup |
| Lead-sync failure, edit-tuner notes, redrive done, sales-audio notes, D1 migration delta | lead_sync, tuner, redrive, sales_audio, infra |

## Setup (Evan)

1. Paste the ops_log SQL at the end of `src/db/schema.sql` into the D1 console. Until then, notes go to console logs and the Logs tab shows "Migración pendiente".
2. Invite the bot to **#evan-alerts**: `/invite @<bot>` in the channel. `chat.postMessage` fails with `not_in_channel` otherwise.
3. Meta App → WhatsApp → Configuration → Webhook fields: subscribe **`message_template_status_update`**. Without it, Meta never sends approval or rejection notices.
4. After a week, #bot-ops can be archived. Keep `SLACK_CHANNEL_OPS_ID` in wrangler.jsonc until no old card there needs its buttons.
