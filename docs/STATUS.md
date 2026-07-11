# Project status

> Update this file whenever something ships or a pending item completes. Last updated: **2026-07-11**.

## Where we are

**LIVE end-to-end on the Meta TEST number** (+1 555 089 6235), verified with 3 test recipient numbers. Full loop works: WhatsApp → worker → Claude brain → Slack #wa-leads approval card → Aprobar/Editar → reply + booking video land on the lead's phone. TRAINING_WHEELS=1 (every reply needs approval). The REAL leads number (+52 55 3426 0813) still runs ManyChat via coexistence — cutover is the final step (docs/cutover-runbook.md).

Everything shipped: brain + KB, Slack approvals, admin dashboard (/admin), anti-no-show sequence, lead-nudge drips (day-1 + extended 7-touch per program), quiet hours 21:30–08:00, booking video, ad attribution, voice-note transcription, Airtable lead-sync + natural-language rules engine, campaign inline editing, KB rewrite (Evan's copy, 2026-07-07/08: positioning, all programs, Curso de Verano, Reto Gladiador, two-step price deflection → range only, horarios phrasing).

Recent fixes (2026-07-08/09): stale pending approvals auto-supersede when the lead keeps writing (kills duplicate holding lines); Slack **Editar** no longer turns spaces into `+` (form-encoding decode); Editor chat no longer 500s pre-migration.

**Shipped 2026-07-11 (phase-1 ManyChat parity):**
- **Campaign first-reply** (new gate 5c): a brand-new ad lead whose message matches a campaign with `first_reply` set gets the pre-written welcome instantly — no brain, no approval; ⚡ FYI note in Slack; nudge drip arms off it; AI takes over from the lead's next message. Editable per campaign in /admin → Campañas ("Respuesta automática"). Requires the migration below; code fail-softs until it runs.
- **Multi-ad-id campaigns**: `campaigns.ad_id` now accepts a comma-separated list (one concept = many live Meta ads).
- **Opt-out hardening**: broader exact-match set (baja/stop/alto/unsubscribe + "ya no me manden mensajes" variants, accent/punctuation-tolerant, src/pipeline/opt-out.ts), 🚫 Slack note, and best-effort `Tags += "Baja"` on the Airtable lead.
- **Template submission pack**: docs/template-submission.md — copy-paste doc for Evan to submit all 24 templates in WhatsApp Manager.

## Evan's pending setup (blockers marked ⚠️)

- [x] D1 migration: `airtable_rules` table + `contacts.airtable_lead_id` (ran 2026-07-09)
- [ ] ⚠️ **AIRTABLE_PAT secret** — until set, NOTHING writes to Airtable (no lead rows, no chat-booking `Trial DateTime`, no rules). Token at airtable.com/create/tokens, scopes `data.records:read`, `data.records:write`, `schema.bases:read` on base `appcX38TBVltyxHR6`; add as Secret on the worker.
- [x] Airtable field mapping (2026-07-09): the bot now writes Evan's REAL Spanish CRM columns (`# de Teléfono`, `Nombre de Lead`, `Fecha Clase Prueba`, `Actividad`, `Programa`, `Canal`="WA", `Campaña`, `Ad`, `Resultado Clase Prueba`, `Tags`) via `airtableLeads` map in clients/md-condesa/client.mjs. Phone lookup matches last-10-digits regardless of stored format. No English fields needed.
- [ ] ⚠️ **D1 migration for campaign first replies**: `ALTER TABLE campaigns ADD COLUMN first_reply TEXT;` — until it runs, saved first replies are silently dropped (soft-fail) and gate 5c never fires.
- [ ] Earlier D1 migrations if not yet run: `ALTER TABLE contacts ADD COLUMN ad_ref TEXT; ALTER TABLE campaigns ADD COLUMN ad_id TEXT;` + dashboard tables (docs/phase0-checklist.md Step 6c).
- [ ] Create the 4 campaigns in /admin → Campañas (Curso de Verano, Baby Fight Club, Kids, Reto) with trigger phrase, ad id(s), info, and first reply. Active Meta ad ids pulled 2026-07-11: Curso de Verano = 120248879929990518, 120248879930930518, 120248879925940518, 120248879928990518; Kids = 120245400639450518, 120245400692660518, 120245396039730518, 120245400408310518, 120245400081370518, 120245400540790518, 120245197707210518, 120245198063240518, 120245197395390518, 120244434754400518; Reto = 120244947083620518, 120244434043620518, 120244433794140518. **Baby Fight Club has NO active ads right now** — confirm with Evan. Prefilled phrases must come from Ads Manager (not exposed via API).
- [ ] Confirm WA_ACCESS_TOKEN is the permanent System User token (temp tokens 401 after ~24h).
- [ ] Submit WhatsApp templates (docs/template-submission.md — 24 copy-paste-ready; source docs/templates.md) — Evan chose to do this NOW, pre-cutover, so d2–d5 drips work from day one.
- [ ] ManyChat → real-number cutover (docs/cutover-runbook.md) — LAST step, Evan triggers.

## Known bugs / next work

1. ~~trial_confirm mis-timed for web-form bookers~~ **FIXED 2026-07-09**: `computeTrialSequence` now fires trial_confirm at booking-detection time (clamped to the send window) instead of at class time; chat bookings pass `includeConfirm: false` since the bot confirms inline (src/cron/followups.ts, src/pipeline/inbound.ts).
2. Meta test-number quirk (not a code bug): outbound to non-verified recipients fails; Mexico numbers may need the `521…` form in the allowlist. Disappears on the real number.
3. Tune the brain weekly from Slack Editar diffs while training wheels are on (edits are logged to D1 `edits`).

## Key IDs

- Worker: md-condesa-wa-agent (account: evancaguilar — local wrangler CLI is logged into the WRONG account)
- D1: wa-agent-db `c57b17de-9e0c-4a48-adc7-7cb791372cdc`
- Slack channel #wa-leads `C0BFKQ6AU9F` · Airtable base `appcX38TBVltyxHR6` / table `Leads`
- Meta test number ID `1208228772369686`, WABA `1545530463899885`; real leads number +52 55 3426 0813
