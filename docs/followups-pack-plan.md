# Follow-ups & Attribution Pack — Implementation Spec

Binding spec. Extends the live system (see docs/architecture.md, docs/dashboard-plan.md). Zero runtime npm deps, D1, existing followups engine (*/5 cron) and hourly Airtable sync are the substrate.

## Features

### F1 — Lead-nudge drip (replicates ManyChat)
- When: a LEAD (status='lead', not opted out, no future trial booked) receives a bot reply and does NOT respond.
- Schedule on every bot outbound to a lead without an active/future booking: nudges at **+1h, +6h, +8h** after the lead's LAST INBOUND (all inside the 24h window → free-form). Followup kinds: `nudge_1h`, `nudge_6h`, `nudge_8h`.
- Copy: deterministic es/en strings (light personalization: name, discipline if known; escalating warmth; final one mentions the free trial + booking link). Keep in a new pure module `src/cron/nudges.ts` so copy is easy to edit.
- Cancel ALL pending nudges when: lead sends any new inbound (re-armed after the bot's next reply), a booking exists (bot book_trial OR web-form record via sync — matched by normalized phone), status becomes student/opted_out, or human override set.
- Cap: max 3 nudges per contact per 7 days (kv `nudge_count:<phone>` with window) to avoid loops.
- Post-24h template re-engagement stays the existing `reengage_7d` path (needs approved templates; attempt sendTemplate, on 4xx failure mark cancelled and Slack-note once).

### F2 — Web-link booking closes the loop
- `syncBookings` (existing hourly poll; bump cron to every 15 min — reuse the */5 tick, sync when minute % 15 < 5) already schedules the trial sequence. ADD: on new booking record, normalize `Phone E164` → contact phone; upsert contact; CANCEL pending nudges (`cancelFollowups` for nudge_* kinds); ensure `trial_confirm` sends (existing behavior) — so a link-booker gets the confirmation, never the drip.

### F3 — Ad referral attribution
- Webhook: parse `messages[].referral` (click-to-WhatsApp): `{source_url, source_type, source_id (ad id), headline, body, ctwa_clid}`. Store on first capture: `contacts.ad_ref` TEXT (JSON) — new column (migration: `ALTER TABLE contacts ADD COLUMN ad_ref TEXT;`).
- Surface: Slack draft card gets a context line "📣 Anuncio: <headline> (id <source_id>)"; dashboard conversation detail shows it (API already returns full contact row; UI reads contact.ad_ref if present — OPTIONAL tiny UI tweak, keep graceful if absent).
- Campaign auto-match: if a campaign's trigger doesn't match by phrase, also try matching `source_id` against a campaign field — ADD optional column `campaigns.ad_id TEXT` (migration + dashboard campaign form gains optional "ID del anuncio (opcional)"). Match precedence: ad_id > trigger phrase.
- Airtable: bookTrial writes `Ad` field (headline + id) when ad_ref present — tolerate unknown-field 422 (existing retry pattern).

### F4 — Airtable `Resultado clase prueba` watcher
- Env var `AIRTABLE_RESULT_FIELD` default `"Resultado clase prueba"`.
- In the sync poll: for modified records with a `Phone E164` and a result value, normalize (lowercase, strip accents) and act ONCE per record+value (kv mark `resultado:<recordId>` = normalized value):
  - contains "no asistio" → send reschedule message (free-form if window open: warm "te esperamos y no pudiste llegar, ¿reagendamos?" + concrete next-slot suggestion is NOT needed — simple question + booking link; else `no_show_followup` template; template missing → Slack note).
  - contains "se inscribio" → send welcome message (free-form if window open: felicitación + qué sigue + horario link; else `human_followup` template fallback → Slack note if unavailable). Also set contact status='student' (stops future nudges/marketing).
  - Also cancel any pending followups for that phone in both cases except the one being sent.
- This complements the existing Slack "¿Llegó?" card (both surfaces write the same kv attendance mark to stay idempotent — reuse `attendance:<recordId>` where sensible).

### F5 — Voice notes (Workers AI Whisper)
- wrangler.jsonc: add `"ai": { "binding": "AI" }`; Env gains `AI: Ai` (types from @cloudflare/workers-types; if the Ai type is unavailable in the pinned version, declare minimal `interface Ai { run(model: string, input: Record<string, unknown>): Promise<unknown> }`).
- Webhook parse: `type:"audio"` messages → extract `audio.id`. Pipeline: fetch media URL `GET https://graph.facebook.com/v21.0/<media_id>` (bearer WA_ACCESS_TOKEN) → download binary → `env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: [...bytes] })` (fall back to `@cf/openai/whisper` if turbo rejects) → transcript becomes the message body; meta JSON `{voice:true}`; Slack context lines and dashboard show "🎤 " prefix for voice-transcribed messages.
- Failure path: transcription error → store body "[nota de voz — no se pudo transcribir]", bot responds asking them to write it or escalates (existing low-confidence path covers it); never crash the webhook.
- Sandbox/local: guard `env.AI` undefined → skip transcription gracefully.

## Migrations (Evan pastes in D1 console; also appended to schema.sql for fresh installs)
```sql
ALTER TABLE contacts ADD COLUMN ad_ref TEXT;
ALTER TABLE campaigns ADD COLUMN ad_id TEXT;
```
New FollowupKind values: `nudge_1h`, `nudge_6h`, `nudge_8h` (types.ts union + schema comment).
New env vars: `AIRTABLE_RESULT_FIELD` (default in code). New binding: `AI`.

## Build split (sequential to avoid file conflicts)
- **Agent A (drip + Airtable watchers)**: types.ts FollowupKind additions, cron/nudges.ts (copy + pure scheduling logic, unit-tested), pipeline hook to arm drip after bot outbound to lead (in pipeline/inbound.ts routeResult area) + cancel on inbound, cron/followups.ts (nudge kinds in runDueFollowups, cancel-on-booking in syncBookings, resultado watcher, 15-min sync cadence), services/airtable.ts (result field in listRecentBookings fields), queries additions if needed (cancelFollowups by kinds).
- **Agent B (referral + voice + surfacing)**: webhook-parse.ts (referral + audio), pipeline/inbound.ts (ad_ref store, campaign ad_id match precedence, voice transcription call), services/wa.ts or new services/media.ts (media fetch), wrangler.jsonc AI binding + types.ts Env.AI + ad_ref/ad_id fields, campaigns matcher ad_id support, services/slack.ts ad line + 🎤, routes/admin-api.ts campaign ad_id passthrough, ui/admin.html campaign form ad_id field (minimal), migrations in schema.sql.
- Then integrator pass: typecheck/tests/build/dry-run + fixture replay incl. referral + audio payloads; update docs/architecture.md + phase0 checklist migration block; commit; push after verification.

## Verification
- Unit: nudge scheduling/cancel/cap logic, resultado-value normalization, referral parse fixture, audio parse fixture.
- Local e2e (wrangler dev --local): inbound → bot reply → nudge rows exist; second inbound cancels them; fake Airtable booking record via mocked poll → nudges cancelled; referral fixture → ad_ref stored; audio fixture with dummy creds → graceful fallback body.
- All existing 105 tests stay green.
