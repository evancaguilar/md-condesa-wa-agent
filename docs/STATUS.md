# Project status

> Update this file whenever something ships or a pending item completes. Last updated: **2026-07-09**.

## Where we are

**LIVE end-to-end on the Meta TEST number** (+1 555 089 6235), verified with 3 test recipient numbers. Full loop works: WhatsApp → worker → Claude brain → Slack #wa-leads approval card → Aprobar/Editar → reply + booking video land on the lead's phone. TRAINING_WHEELS=1 (every reply needs approval). The REAL leads number (+52 55 3426 0813) still runs ManyChat via coexistence — cutover is the final step (docs/cutover-runbook.md).

Everything shipped: brain + KB, Slack approvals, admin dashboard (/admin), anti-no-show sequence, lead-nudge drips (day-1 + extended 7-touch per program), quiet hours 21:30–08:00, booking video, ad attribution, voice-note transcription, Airtable lead-sync + natural-language rules engine, campaign inline editing, KB rewrite (Evan's copy, 2026-07-07/08: positioning, all programs, Curso de Verano, Reto Gladiador, two-step price deflection → range only, horarios phrasing).

Recent fixes (2026-07-08/09): stale pending approvals auto-supersede when the lead keeps writing (kills duplicate holding lines); Slack **Editar** no longer turns spaces into `+` (form-encoding decode); Editor chat no longer 500s pre-migration.

## Evan's pending setup (blockers marked ⚠️)

- [x] D1 migration: `airtable_rules` table + `contacts.airtable_lead_id` (ran 2026-07-09)
- [ ] ⚠️ **AIRTABLE_PAT secret** — until set, NOTHING writes to Airtable (no lead rows, no chat-booking `Trial DateTime`, no rules). Token at airtable.com/create/tokens, scopes `data.records:read`, `data.records:write`, `schema.bases:read` on base `appcX38TBVltyxHR6`; add as Secret on the worker.
- [ ] ⚠️ Airtable Leads table fields the code writes: `Phone E164`, `Name`, `Source`, `Ad`, `Campaña`, `Discipline`, `Audience`, `Trial DateTime`, `Resultado clase prueba` (watcher), multi-select `Tags` (rules). Missing fields degrade gracefully (drift retry) but data is lost.
- [ ] Earlier D1 migrations if not yet run: `ALTER TABLE contacts ADD COLUMN ad_ref TEXT; ALTER TABLE campaigns ADD COLUMN ad_id TEXT;` + dashboard tables (docs/phase0-checklist.md Step 6c).
- [ ] Confirm WA_ACCESS_TOKEN is the permanent System User token (temp tokens 401 after ~24h).
- [ ] Submit WhatsApp templates (docs/templates.md: 6 base + 12 extended nudges) — at cutover.
- [ ] ManyChat → real-number cutover (docs/cutover-runbook.md) — LAST step, Evan triggers.

## Known bugs / next work

1. **trial_confirm mis-timed for web-form bookers**: `computeTrialSequence` schedules the confirmation text+video at the CLASS time, not at booking time (src/cron/followups.ts:76). Chat bookings mask it (bot confirms inline); form bookers get their "confirmed" message when class starts. Fix: fire trial_confirm at booking-detection time (clamped to send window), skip for chat bookings. Identified 2026-07-09, approved-to-fix pending.
2. Meta test-number quirk (not a code bug): outbound to non-verified recipients fails; Mexico numbers may need the `521…` form in the allowlist. Disappears on the real number.
3. Tune the brain weekly from Slack Editar diffs while training wheels are on (edits are logged to D1 `edits`).

## Key IDs

- Worker: md-condesa-wa-agent (account: evancaguilar — local wrangler CLI is logged into the WRONG account)
- D1: wa-agent-db `c57b17de-9e0c-4a48-adc7-7cb791372cdc`
- Slack channel #wa-leads `C0BFKQ6AU9F` · Airtable base `appcX38TBVltyxHR6` / table `Leads`
- Meta test number ID `1208228772369686`, WABA `1545530463899885`; real leads number +52 55 3426 0813
