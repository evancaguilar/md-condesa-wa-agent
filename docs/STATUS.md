# Project status

> Update this file whenever something ships or a pending item completes. Last updated: **2026-08-25**.

### KB pack — confidence rewrite + mined rules + nudge overhaul (2026-08-25, later)

Part A: persona.md gained the 8-box confidence checklist ("high" is the default when every box ticks; low is priced at "up to 12h delay"), the 19 style rules mined from Evan's 128 edits, schedule corrections (Kids 4pm arrival, Friday warning, Sunday adults-only, Mini MT exact days, BFC-only price exception, positive price reframe), a "Datos que preguntan seguido" facts section (verbatim-sourced from edit finals; Mini MT + adult class DURATIONS still need Evan wording), BFC minimum age ruled 12 months. Code: `guardUnverifiedSlotClaim` (full day+time+discipline claims that don't resolve to a SLOTS row force draft/low), campaign first-reply question passthrough (canned welcome + brain answers the appended question), KB TOKEN_LIMIT 9000→11000 (KB now 9,838).
Part B: nudges propose a REAL next slot (`nextTrialSlot` over generated SLOTS, sparring skipped, ≥2h buffer), plural voice + kids link for kids/baby leads, day-1 cadence 3→2 (dropped nudge_6h), open-question guard (never nudge over the bot's own <2h-old question). Also: one-time in-worker migration created `idx_pending_approvals_created` and force-refreshed the Slack control panel (auto-send button now visible).

### Hardening slice — precision fixes from an external review (2026-08-25)

Five tightenings, no behavior changes beyond the ones described. Tests 573 → **586**, green; no D1 migration (kv + an existing table only).

- **Slot-exact capture guard** (booking-core/booking-guard): `booking_recorded:<phone>` now stores `{"ts","trialDate","trialTime"}` instead of a bare epoch (the reader still accepts legacy bare-epoch rows, which back any claim for their 72h life). `auditHumanSend` parses the sent text FIRST; when the copy names a date, only a marker for that same date/time or an anti-no-show sequence armed for it counts as backed — a fresh booking no longer masks a NEW unbacked promise for a different class. Dateless copy keeps the old "any fresh marker" rule (no false positives on vague texts). A mismatch card carries `⚠️ Ya hay un registro para <fecha> <hora> — esto parece OTRA clase`. Followup→trial-date mapping is derived from `computeTrialSequence` (same_day ⇒ its CDMX due date; day_before ⇒ +1 day; trial_confirm carries no date signal).
- **Slot-exact nightly reconciliation** (booking-recon): a dated claim now needs a booking on that same CDMX calendar day (day granularity — the digest's job is "does this class exist at all"); dateless claims keep the ±7/14d window. Digest lines gained `— prometido <fecha>, en Airtable: <fecha|ninguna clase>`.
- **Airtable schema drift can't drop essentials** (airtable.ts): an `UNKNOWN_FIELD_NAME` 422 on the phone or trial-datetime column now throws `AirtableWriteError` ("booking aborted, fix the base or client.gen mapping") instead of dropping the field and reporting a dateless "successful" booking. Everything else keeps drop-and-retry.
- **finalizeBooking step isolation**: Slack FYI / sequence / qualification / lead sync each get their own try/catch, so a Slack outage can never cost the lead their anti-no-show reminders.
- **Atomic auto-send cap + pre-send re-check**: `tryClaimAutoSendSlot` (INSERT OR IGNORE + guarded UPDATE) replaces the read-modify-write bump and is claimed immediately before delivery (released if delivery degrades to an approval); the pure gate's count is now only a pre-screen. The Slack holding line re-reads the approval's status after winning `claimHoldingSend` and stays quiet if a human resolved it in between — best-effort narrowing, not elimination (no transaction spans D1 and the Graph API).

### 15-day conversation audit — findings + pending actions (2026-08-25)

Full report (artifact): "Radiografía del Agente". 185 convos / 226 approvals / 128 edits reviewed by a 22-agent fleet; every critical finding verified against raw transcripts (56 confirmed, 9 adjusted, 0 refuted). Headlines: only 9.7% of leads reach an evidenced booking; 23% of approval drafts EXPIRE unanswered (65% die overnight); ALL 226 approvals were confidence:low (structural — the persona's "high" definition is unreachable); link-push campaigns (Reto 7.6%, Kids 4.5%) convert half of the in-chat-booking baby flow (16.1%); overlay §1 actively instructed offering Thursday sparring ("ni menciones que uno es sparring"); 18/128 owner edits are schedule corrections (Friday afternoons invented, Sunday kids offered, Mini MT days wrong).

Shipped this same day (7 slices, 573 tests green): atomic holding/expire claims; approvals-history endpoint (+ IN()-chunking 500 fix); slot hardening (sparring `trial:false`, Mini MT dual-audience, defensa-personal mapping, contract tests); booking-failure Slack alerts; human-booking capture cards (detect + 1-click Registrar); multi-person bookings; gated auto-send lane (inert); nightly booking reconciliation digest.

- [ ] **Evan**: paste the corrected overlay §1 (sparring exception) — text in the report and in the session scratchpad (`overlay-fix-section1.md`).
- [ ] **Evan**: check mdcondesa.com/clase-prueba-adultos/ (lead reported it broken 08-24) and confirm the canonical booking URLs (`/agendar-clase-prueba-adultos/` vs the stale ones intake.md ships).
- [ ] **Evan**: say "aplica el paquete de KB" → one slice deploys the confidence checklist (high-as-default with 8 verifiable boxes + code backstop), 19 mined style rules, schedule corrections, missing facts (Reto prize, WellHub, class size, duration, Del Valle), campaign fixes (answer appended question + in-chat booking for Reto/Kids/mañanas), nudge copy rewrite. Requires raising the KB TOKEN_LIMIT (at 8,921/9,000).
- [ ] **Evan**: rule on Baby Fight Club minimum age — his edits say 11 months, intake/campaign say 12.
- [ ] **Evan**: after the KB pack deploys and Probar shows FAQ replies rating "high" — arm auto-send (Slack panel → 🤖 Activar auto-envío).
- [ ] **Evan**: paste in D1 console: `CREATE INDEX IF NOT EXISTS idx_pending_approvals_created ON pending_approvals(created_at);`

### Slice 6 — gated auto-send: a narrow always-on lane under training wheels (2026-08-25)

Training wheels still route every reply through Slack. This adds ONE exception: a reply that is obviously safe **and** lands in a chat a human already signed off on goes out immediately instead of waiting for an approval. Ships **inert** — the kv key is absent, which means disabled; Evan arms it from the Slack panel (or `POST /admin/api/autosend`).

- **`src/services/auto-send.ts`** — `decideAutoSend()` is the whole safety contract, pure and unit-tested. Gates, first failure wins (`blockedBy`): `switch` (kv `auto_send_enabled` !== "1", **missing = OFF**) → `action` (only the brain's plain `send`) → `confidence` (only `high`) → `booking_claim` (shared `claimsBooking` regex — anything promising a real class gets human eyes) → `price` (`PRICE_PROMO_RE`: `$`, precio/costo/promo/descuento/mxn/inscripci*/mensualidad/membres*) → `first_contact` (the phone needs ≥1 approval a human resolved as approved|edited — the FIRST reply of a conversation is never auto-sent) → `cap` (**20 auto-sends per CDMX day**, kv `auto_send_count:<YYYY-MM-DD>`, rolls over on its own). `evaluateAutoSendLane()` wraps the D1 reads (switch first, per-lead queries only for a message that is eligible on its own text) so the pipeline stays a thin call.
- **`routeResult`** (src/pipeline/inbound.ts): unchanged when wheels are OFF. With wheels ON and the old `autoSend` false, it evaluates the lane; on `auto` it delivers through the SAME `deliverOrDraft` as the wheels-off path (outbound row stored, nudge drip armed, closed window still degrades to an approval), bumps the counter and posts an FYI. Anything the lane refuses falls through to `queueApproval` exactly like before — no other behavior change.
- **Slack**: silent FYI card `🤖 Auto-enviado (alta confianza) — nombre · teléfono` + the text + `n/20 hoy`, with **🙋 Tomar control** (new `takeover_phone|<phone>` verb — an auto-sent reply has no approval row to claim, so it just applies the same `HUMAN_SNOOZE_HOURS` pause). Control panel gained an **Activar/Apagar auto-envío** button pair (`autosend_on`/`autosend_off`) plus a status line; every flip posts an audit note naming who clicked (`ParsedInteraction.user` is now parsed).
- **Admin API**: `GET /admin/api/autosend` → `{enabled, todayCount, cap}`; `POST /admin/api/autosend {enabled}` sets the kv and returns the new state (also refreshes the Slack panel). No dashboard UI yet — the Slack button is the switch.
- Master override unchanged: `getTrainingWheels(env) === false` (night mode / TRAINING_WHEELS=0) ⇒ the old path already auto-sends and this lane never runs.
- Tests 530 → **555**, all green. No D1 migration (kv only).
- [ ] **Evan**: arm it when ready — Slack `#wa-leads` control panel → 🤖 Activar auto-envío. Turning it off is the same button (or `POST /admin/api/autosend {"enabled":false}`).

### Slice 4 — human-booking gap closure: detect + 1-click Registrar (2026-08-25)

Until now the **only** thing that wrote a trial to Airtable was the brain's `book_trial`. Every class a human confirmed over WhatsApp — Aprobar/Editar on a Slack draft, a dashboard staff reply, a scheduled "send later" — left the CRM empty and the anti-no-show sequence unarmed. Slice 7's nightly digest reported the damage; this closes the loop in real time.

- **`src/services/booking-core.ts`** is now the one place a booking is finalized. `finalizeBooking` (Slack FYI + anti-no-show sequence with `includeConfirm:false` + qualification + `booking_created` sync) was lifted verbatim out of `routeResult`'s `book` branch, which now calls it — zero behavior change, except it no longer throws out of the reply path. `registerBooking` is the human entry point: validateSlot (skippable via `force`) → Airtable `bookTrial` → `finalizeBooking` → booking video, plus a `booking_recorded:<phone>` kv marker.
- **`src/services/booking-guard.ts` — `auditHumanSend(env, phone, text, source, by?)`**: fire-and-forget post-send audit, never throws, always awaited. Gates: `claimsBooking` → already-backed check (fresh `booking_recorded` marker <72h, or a scheduled booking-kind followup) → one capture per lead per CDMX day → parse → validate → Slack capture card. Hooked into `approveAndSend`/`editAndSend` (skipped for booking-origin drafts, which already wrote Airtable), the dashboard composer and the `staff_later` cron dispatch.
- **Parsing** is regex-first (`parseBookingHints` in booking-claims.ts — hoy/mañana/pasado mañana, weekday→next occurrence, `7 pm`/`11 am`/`19:00`/`3:15 pm`→15:15, disciplines via CLIENT.services + Baby Fight Club / Mini Muay Thai special cases). Only a non-`full` parse spends **one** cheap `propose_booking` model call (300 max tokens, no KB) to fill the gaps; regex always wins on what it read.
- **Slack card**: `⚠️ Confirmaste una clase sin registro en Airtable` with the quoted send, the parsed fields, a ✅/⚠️ schedule verdict, and **Registrar en Airtable** (label becomes "Registrar de todos modos" when the verdict failed) / **Corregir datos** (5-field modal) / **No era un agendado**. Registering is at-most-once via a kv claim, released on failure so a fixable cause can be retried.
- **Dashboard endpoints (no UI yet)**: `POST /admin/api/conversations/:phone/booking/parse` (read-only: hints + verdict for the last outbound) and `POST /admin/api/conversations/:phone/booking` (registers; `{name, childName?, discipline, audience, trialDate, trialTime, force?}`).
- `accrueChatUsage` moved to `src/services/usage.ts` (kb-editor.ts re-exports it) so a caller that just logs tokens no longer drags the whole compiled KB in behind it.
- Tests 473 → **530**, all green. No D1 migration (kv only).

### Attribution v2: trigger-first precedence + ad-name lookup + staleness fixes (2026-08-04, later)

Root-caused the "mananas-999 ad answered as Reto Gladiador" incident (Evan's own test click): (1) Meta LOCALIZED the prefill (English phone ⇒ "Hello! Can I get more info on this?") so the Spanish trigger never matched; (2) the new mananas campaigns had no keywords/ad-ids; (3) the contact carried a STALE July Reto attribution (campaign_id + ad_ref) that the brain was briefed with. Fixes:

- **Precedence reordered: trigger phrase FIRST**, then exact ad-id, then keywords. One ad's several ice-breaker prefills can route to DIFFERENT campaigns (mananas "probar" vs "inscribirse"), so the designed phrase must outrank the shared ad id.
- **Ad-name tier**: `lookupAdMeta` (src/services/ad-meta.ts) resolves referral ad id → Ads-Manager ad name + Meta campaign name via Graph API (kv-cached `ad_meta:<id>`, miss retries daily, fail-soft). Normalized name feeds the keyword matcher — keyword `mananas 999` matches ad "mananas-999 cafe comparison". Token: optional `ADS_ACCESS_TOKEN` secret (needs ads_read), falls back to WA_ACCESS_TOKEN — if the WA system-user token lacks ad-account access the tier silently skips; add the secret to enable it.
- **Fresh `<ad_info>`**: the brain now sees THIS click's referral, not the contact's first-ever ad_ref (CRM keeps first-touch).
- **Stale-tag clear**: a referral click matching NO campaign clears contact.campaign_id instead of leaving the old campaign's info to mislead the brain.
- [ ] Optional (Evan): create a Meta token with ads_read on act_1334257084455191 and `wrangler secret put ADS_ACCESS_TOKEN` (or Cloudflare dashboard) if the WA token turns out not to cover ad lookups — check for `ad_meta:*` kv rows or the 🎯 line correctness after the next new-ad click.

### IG/FB DM adapter (shipped DARK 2026-08-04 — flags off, plan: ~/.claude/plans/now-that-the-app-replicated-cat.md)

The bot can now answer **Instagram DMs + Facebook Messenger** through the same pipeline (brain → training-wheels approval → reply on the right channel). Everything ships behind `features.instagram` / `features.messenger` in clients/md-condesa/client.mjs (**both false** — IG/FB webhook events are logged + dropped until flipped). WA behavior unchanged; 380 tests green.

How it works: IG/FB contacts live in the existing `phone` column as namespaced ids (`ig:<IGSID>` / `fb:<PSID>`, zero D1 migration); the webhook parser dispatches on the payload's `object` field (same endpoint — `/webhook/meta` is an alias of `/webhook/whatsapp`, same verify token + app secret since the products share app 2215578122600171); sends go through the new `src/services/send.ts` facade → `messenger.ts` (`POST /<FB_PAGE_ID>/messages`, page token). **No templates on IG/FB**: 24h–7d sends auto-use the HUMAN_AGENT tag (needs its own App Review permission), >7d = cancelled + one throttled Slack note; cron reminders send free-form equivalents (`messengerReminderText`). Airtable syncs IG/FB leads with exact-string identity + Canal=IG/FB (the last-10-digit fuzzy match is guarded — an unguarded IG id could have cross-matched and corrupted a real lead's row; that guard is live NOW regardless of flags). Dashboard shows IG/FB chips, renders CDN media (urls expire — accepted v1), composer stays open 7d on IG/FB, attachments are WA-only v1.

### ⚠️ Evan's checklist (IG/FB — Meta console, in order)

- [ ] Confirm @mdcondesa (IG professional) is linked to the academy's **FB Page** (Page ↔ IG link; separate axis from the IG↔WhatsApp-0813 pending decision below, which does NOT block IG DMs).
- [ ] App 2215578122600171 → add **Messenger** + **Instagram** products. Webhooks callback: `https://md-condesa-wa-agent.evancaguilar.workers.dev/webhook/meta`, verify token = the existing `WA_VERIFY_TOKEN`. Subscribe fields on BOTH products: `messages`, `messaging_postbacks`, `message_echoes` (echoes = replying from the IG/page inbox pauses the bot; without them it double-answers).
- [ ] Subscribe the **Page** to the app; generate a **Page access token** (page-scoped — NOT the WABA system-user token) with `pages_messaging` + `instagram_manage_messages`.
- [ ] Cloudflare dashboard (local wrangler = wrong account): add secrets **`PAGE_ACCESS_TOKEN`** and **`FB_PAGE_ID`**.
- [ ] Airtable: add **`IG`** and **`FB`** options to the Canal select (missing option = loud daily sync-failure note, never a wrong "WA").
- [ ] Tester phase: flip `features.instagram/messenger: true` in client.mjs → `npm run build` → push. App still in Standard Access ⇒ only app-role testers' DMs arrive; TRAINING_WHEELS gates every reply anyway. Verify: text round-trip IG+FB, voice note transcribed, echo takeover from the IG inbox, full booking (Canal=IG row + anti-no-show armed), timestamps sane.
- [ ] **App Review round 2**: `instagram_manage_messages`, `pages_messaging` + the **Human Agent** permission (7-day tag; until approved >24h sends degrade into the WindowClosed→approval path). Screencast the tester flow. Per the 2026-07 lesson: after submitting, hunt ALL Meta surfaces for undismissed forms — silence = a form waiting somewhere, not a slow queue.
- [ ] Approved → real IG/FB users flow in automatically (flags already on from tester phase). Watch Slack sync notes + cancelled-followup counts the first week.

### Inbox v2 (shipped 2026-08-04 morning — 4 commits, 10be1ad..1a0aaa7)

The /admin Chats inbox is now a team tool. Built via multi-agent workflow + 3-verifier adversarial pass (which caught 1 real BLOCKER pre-push — the verify-fixes commit).

- **/health `rev`** — content hash of src/** (tools/gen-rev.mjs → src/rev.gen.ts). THE deploy fingerprint for code-only deploys (kbVersion can't see them). Verify: `node tools/gen-rev.mjs` at a commit == served `rev`.
- **Draft cards capped** (#pendWrap/.pbody scroll) — the transcript is always visible.
- **Assign to anyone**: header dropdown (— Sin asignar — / roster from `GET /admin/api/staff`); action row memoized so the open dropdown survives the 5s poll. Needs fer/vale accounts created in Usuarios.
- **Shared read/unread**: `contacts.read_at` (⚠️ migration below), 📩 No leído header action (works even when the last message is ours), "No leídos" filter chip, open chats advance the shared watermark. Pre-migration: falls back to per-browser localStorage, zero regression.
- **Send later ⏰**: composer button + presets (Mañana 8:00 / Hoy 18:00 / En 1h) + datetime; rides `followups` kind `staff_later` (no migration). Auto-cancels if the lead writes first (text preserved on a 🚫 card with 📋 Usar en composer); quiet-hours clamp; window-closed at fire time = LOUD Slack note; sends as staff (pauses bot like any staff reply). At-most-once with claim-release-on-failure (the BLOCKER fix: a transient Graph error now retries instead of laundering into a fake 'sent').
- **🪄 Reescribir (guided rewrite)**: tell the bot how to change a pending draft ("ofrécele el horario de mañana"); `POST /approvals/:id/rewrite` runs a bare no-tools model call (book_trial can't fire); result lands in the edit box for review; sending via the normal edit path logs the draft→final pair for the edit tuner. In Chats pendcards + Aprobaciones.
- **Opt-out hardening**: `sendTemplate` throws OptedOutError for baja'd contacts (universal backstop incl. future broadcasts); result-watcher sends skip baja; a baja discards pending drafts (gate 3 + claimAndSend race defense); staff sends soft-block with clear toasts; **manual 🚫 baja via the existing status control** (`POST .../status {status:"opted_out"}`) with gate-3 side effects + kv audit + Slack note; unknown status values 400 (no more silent un-baja).
- **📝 Historial de ediciones** panel in the Editor view (lazy, diff cards, phone links into Chats) — completes the edit-tuner loop UI.
- Tests 339 → **360**, all green.

### ⚠️ Evan's checklist (Inbox v2)

- [ ] **D1 migration** (console paste; mirrored at end of schema.sql): `ALTER TABLE contacts ADD COLUMN read_at INTEGER;` — until then read/unread is per-browser like before.
- [ ] Create **fer/vale** accounts in /admin → Usuarios (needs the inbox-v1 admin_users migration) so the assign dropdown has people.
- [ ] **Mark `oswinvaldes` +52 55 1909 4323 as baja** ("No y bloqueame", 2026-08-03 23:03 — NOT one of the 9 exact opt-out phrases, so the gate did NOT flag him; the polite reply was the brain). One tap now: his chat → status → 🚫 baja.
- [ ] **Submit the template pack on WABA 1582515279931864 + payment method** — still the highest-leverage item: day-before/same-day reminders silently do nothing until then. Answer to the confirmation question: day-of confirm for a booking made days earlier REQUIRES a template (window closed) → `trial_reminder_same_day` (Utility) already covers it in the pack.
- [ ] Cloudflare → Workers Builds: confirm last night's + this morning's builds deployed (/health `rev` should be `40056eea736b`).

Deferred by decision: broadcast/plantillas panels (phase 2, after templates+payment), profile photos (Meta doesn't expose them — skipped), nightly auto-arm of night mode (stays manual).

### Keyword campaign matching + edit-learning loop (shipped 2026-08-04)

**Ad-keyword matching kills the ad-id treadmill.** Campaign attribution is now three-tier (gate 3b): exact ad-id → **ad-creative keywords** (`campaigns.ad_keywords`, comma-separated phrases matched normalized/whole-phrase against the referral headline+body) → trigger phrase. A keyword/trigger match on an ad referral **auto-learns** the new ad id into the campaign's `ad_id` (race-safe append + one-time Slack note "🔗 Anuncio … vinculado"). New ads self-attribute + self-register — no more manual id entry. Campañas UI has the keywords field (create + edit, 🔑 chip); Probar has "📣 Simular anuncio" (headline/texto/ad id, no auto-learn from sandbox); the Editor's propose_campaign can set keywords.

- [ ] ⚠️ **D1 migration (keywords)** — Evan pastes in D1 console (mirrored at end of src/db/schema.sql; code fail-softs until then — keyword tier inert, dashboard field a silent no-op). Also confirm the older `first_reply` ALTER ran (listed at line ~"first_reply" below):
```sql
ALTER TABLE campaigns ADD COLUMN ad_keywords TEXT;
```
- [ ] After the ALTER: add keywords to each campaign in /admin → Campañas (e.g. Reto: `reto gladiador, reto`). That supersedes the "add ad id 120249684011870518 manually" item below — the next click on any Reto ad auto-attributes and registers its id.

**Edit tuner (training-wheels feedback loop) is live.** D1 `edits` (every ✏️ Editar diff) now has a consumer: `src/services/edit-tuner.ts` (+ pure `edit-tuner-core.ts`, unit-tested). Cron: inside the daily 10:00 block, self-gated to ≥6.5 days since last run AND ≥5 new edits past the kv watermark (`edit_tuner_watermark`, `edit_tuner_last_run`); analyzes the most recent ≤30 pairs (draft→final) against the current overlay, proposes ≤3 overlay edits (propose_kb_edit/delete only), posts a 🧠 summary + per-proposal Slack cards with **✅ Aplicar / 🗑 Descartar** buttons (`tune_apply|` / `tune_discard|` / `tune_force|`; records in kv `tuning_proposal:<epoch>:<n>`, double-tap claim-guarded, stale-section warning with explicit force). Apply reuses kb-editor `applyProposal` (2000-token overlay cap enforced). On-demand: **🧠 Analizar ediciones** button in the Editor tab (`POST /admin/api/kb/analyze-edits`, watermark-untouched) renders proposals in the existing chat/Confirmar UI. No migration needed (kv only).

### CTWA ads → 2274 repoint + result-watcher staleness guard (2026-08-04)

**Ads were NOT all pointing at 2274** (contrary to the note below from cutover day) — at least one ad set was bound to the dead eSIM debris number **7197** (leads messaging it = black hole). Repointed via Ads Manager. The saga, for next time:

- The Page-level "Connect WhatsApp number" OTP dialog (Page settings) can **NEVER** accept 2274 — it only verifies numbers running the WhatsApp/WA Business *phone app*; a pure Cloud API number always errors "isn't associated with a WhatsApp account". That's expected, not a problem. **NEVER click "create a new account" there** — it would register the number in the app and destroy the Cloud API registration (1–2 month re-entry cooldown).
- Working path: WhatsApp Manager → 2274 → Profile → Social accounts → connect the FB Page, then facebook.com/settings?tab=linked_whatsapp → **Set as Primary**. After that (plus a hard refresh + a few min of propagation), the Ads Manager ad-set "Message destination" dropdown lists Cloud API numbers — pick **+52 1 56 4199 2274 (Cloud API number)**. Ad IDs don't change on edit, so campaign attribution is untouched.
- **Legacy ad sets freeze their WhatsApp binding at creation.** Some old ad sets keep showing the "You'll need WhatsApp Business" wizard even after the Page fix (new ad sets in the same campaign show the dropdown fine). Try: Manual destination → uncheck WhatsApp → save → re-check. If the wizard persists, rebuild: new ad set + duplicate the ads into it → **new ad IDs** → APPEND them to the campaign's ad-id list in /admin → Campañas (keep the old IDs listed so late-tapping leads still match).
- Dropdown number cheat-sheet: 2274 = bot (sales, correct). 0813 = humans/support (never for ads). 7197 = dead debris. +1 555… = Meta test number.
- **IG ↔ WhatsApp pending decision:** @mdcondesa Instagram is still linked to 0813's WA Business app (that's why "Connect Instagram" for 2274 errors "already connected to another WhatsApp account"). NOT needed for ads (Page connection covers IG placements); it only controls the IG-profile WhatsApp button. Moving it to 2274 = first disconnect on the academy phone (WA Business app → Business tools → Facebook e Instagram), then connect in WhatsApp Manager. Evan's call, unhurried.

**Result-watcher staleness guard** (code rode along inside commit 85a451b "R2: media in/out"): `processResult` now only sends the welcome/no-show reaction when the record's Trial DateTime is **same-day CDMX**; older or dateless records still get status=student/cancel/KV-marker treatment silently. Root cause: lead-sync bumps an old Airtable row's modified time whenever that contact writes in again → syncBookings re-surfaced months-old "Se inscribió" results → ghost "¡Bienvenid@ a la familia!" (happened to Valeria Nava, Feb enrollee, 2026-08-03). Each pre-guard record could still fire at most once; guard is live as of the 2026-08-03 20:19 deploy.

### Ad-context awareness (shipped 2026-08-04)

- **Brain sees the clicked ad**: the contact's `ad_ref` (headline + creative text) now rides into the per-turn `<context>` as an `<ad_info>` block, even when the ad id isn't mapped to any campaign — the model infers program/audience from the creative (e.g. Reto Gladiador ⇒ adult) instead of asking "¿para ti o para un peque?".
- **Slack draft card shows attribution**: `🎯 Campaña: <name>` (or `_sin asignar_` when an ad lead has no campaign match — the cue to add that ad id in /admin → Campañas) + `📣 Anuncio: headline — «body snippet» (ad id)`.
- **Adults with a usable WA profile name skip name confirmation**: persona rule — if `<context>` already carries a real-looking `name`, book_trial uses it directly and goes straight to the confirmation message; only ask when the name is missing or junk (emojis/numbers/handles).
- [ ] ⚠️ Ad id `120249684011870518` (¡Agenda tu Día Gratis! / Reto Gladiador) was NOT matched to a campaign on 2026-08-03 (lead Ricardo) — add it to the Reto campaign's ad ids in /admin → Campañas so the canned first-reply + campaign info fire.

## 🟢 LIVE (2026-08-03) — read this first

**THE AGENT IS LIVE ON THE SALES NUMBER.** Full loop verified end-to-end on 2026-08-03: lead messages +52 1 56 4199 2274 → worker → Claude brain → Slack #wa-leads card (campaign attribution working, real ad lead captured same day) → Aprobar → reply delivered. TRAINING_WHEELS=1 (every reply needs approval).

### Current number topology (changed a LOT on 2026-08-03 — trust this, not older sections)

- **SALES (bot): +52 1 56 4199 2274** — phone-number-id **`1159187097288000`**, on WABA **1582515279931864** ("MD Self Defense Condesa WhatsApp Business App" — ManyChat's first-attempt WABA, now ours; app 2215578122600171 subscribed; NO ManyChat partner). Pure Cloud API number — NOT in any phone app, and cannot be put back in one without deregistering (coexistence re-entry has a 1–2 month cooldown). Two-step PIN: **152683**. Registered + verified 2026-08-03. Display name "MD Self Defense Condesa" (was in review at go-live; sends worked anyway).
- **SUPPORT (humans): +52 55 3426 0813** — on the academy phone in WA Business app. Was BANNED ~2026-07-28 (bulk group-adds — NEVER bulk-add to groups, invite links only); appeal WON same day. Its Cloud API registration dropped during the ban and it is now SMB-classified (app-linked) → API sends give #133010 and /register is blocked ("SMB businesses"). It stays human-only until/unless we build embedded-signup coexistence (phase 2, maybe never).
- **DEAD/DEBRIS:** WABA 890463570149597 (coexistence WABA from the eSIM ManyChat era) was DESTROYED when the app account was deleted — its phone-number-id 1208573689006666 is gone; +52 1 55 4132 7197 (first abandoned eSIM) sits Offline on WABA 1582515279931864; WABA 1895136994223683 holds unknown unverified number +52 1 55 2497 9988. Old real WABA 2227852814309146 holds only the banned-then-unbanned 0813.

### How we got here (2026-08-03, the cutover saga — lessons inline)

1. Meta App Review APPROVED (all three permissions Advanced Access). Access Verification had approved earlier.
2. Removing ManyChat as WABA **partner** (Partners tab) was required even after their disconnect — leftover partner grant caused #200 on sends while management calls worked.
3. Coexistence numbers CANNOT be API-registered (`Register endpoint is not available for SMB businesses`). Meta's documented escape: delete the account in the phone app, then /register. **BUT deleting the app account also destroyed the coexistence-created WABA** — the number came off Meta entirely and had to be re-added (SMS verify) to another WABA. Cost: ~2.5 weeks of app chat history on the eSIM number.
4. "Add phone number" was greyed out on WABA 2227852814309146 (likely due to the banned number on it) — used WABA 1582515279931864 instead, which worked fine.
5. Brain `api_error` at first live test = Anthropic credits ran out. Topped up; consider auto-reload — this failure is silent except for fallback holding-line replies.

### ManyChat is GONE (2026-08-03)

Disconnected + removed as partner. Before disconnecting we exported all contacts: **~6,019 WhatsApp contacts (name, phone, subscribed date) in `~/Downloads/manychat-master.csv`** + Google Sheet "ManyChat Export". Tags were NOT exportable (ManyChat has no bulk tag export; API phone-lookup can't see WhatsApp IDs). Blast idea parked — if revived: needs approved marketing template + payment method + throttled sender (not built).

### Dashboard inbox v1 (shipped 2026-08-03, same day as go-live)

The /admin Chats view is now a WhatsApp-style live inbox — the human reply surface for the API-only sales number: 5s polling, real scroll pane, composer (staff replies log as `direction:"out_human"` with `meta.by`), inline pending-draft cards (Aprobar/Editar/Descartar in-chat), unread dots + tab badge + title flash + beep (mute 🔔/🔕), per-chat assignment (Asignarme/Liberar + Míos/Sin asignar filters), read-marks to the lead (blue ticks) on open. **A staff reply pauses the bot on that conversation INDEFINITELY (1-year override) until ▶ Reanudar** — amber banner shows in-chat (Evan's decision). Sends are idempotent (client token claimed in kv pre-send; 24h-window closed → composer disabled with hint).

**Per-user accounts:** login now takes usuario+contraseña. `admin_users` table (PBKDF2-SHA256 100k), cookie v2 carries the username (old sessions force one re-login). Master `ADMIN_PASSWORD` = permanent break-glass, logs in as evan/owner only (cannot impersonate staff). Owner-only Usuarios view (Inicio → 👥 card): create fer/vale, reset passwords, disable. Dashboard approvals post attribution notes to Slack ("por <user> desde el panel").

- [ ] ⚠️ **D1 migration (inbox v1)** — Evan pastes in D1 console (also mirrored at the end of schema.sql). Until it runs: only evan (master password) can log in, assignment is a silent no-op, everything else works:
```sql
CREATE TABLE IF NOT EXISTS admin_users(
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_phone_ts ON messages(phone, ts);
ALTER TABLE contacts ADD COLUMN assigned_to TEXT;
```
- [ ] After migration: Inicio → Usuarios → create `fer` + `vale`; they log in on their phones.
**R2 shipped (2026-08-03, same day):** media + ad-context.
- Inbound image/video/document/sticker now parsed + stored (caption = body, else placeholder; `meta {type, mediaId, mimeType, filename}`) and rendered in the chat (img inline, video/audio players, 📄 doc link) via the auth-gated proxy `GET /admin/api/media/:id` (Graph 2-hop, streamed). Voice notes keep the transcript AND are playable.
- **Ad context is visible**: each inbound that carried a CTWA referral shows "📣 Respondió a un anuncio: <headline>" (+ creative thumbnail when Meta sends one) on the bubble (`meta.adRef`), and the chat header shows the contact's original attribution card ("📣 Llegó por el anuncio…", `contacts.ad_ref`, now also storing thumbnailUrl). So "quiero más información" from a kids ad is identifiable at a glance.
- 📎 attach in the composer: jpg/png/webp, mp4, pdf (≤16MB) → `POST .../send-media` (multipart) → Graph /media upload → send; same idempotency token + indefinite-pause takeover as text sends; logs `out_human` with `meta.by`.
- R3 next (✓✓ ticks via status webhooks + template picker once templates/payment exist). Plan: ~/.claude/plans/i-want-to-go-ancient-milner.md

### Open items (post-go-live)

- [ ] ⚠️ **Payment method on WABA 1582515279931864** — blocked earlier by a shared-credit-line error on the old WABA; without it, template sends (d2–d5 drips, anti-no-show out-of-window, any blast) silently fail. In-window free-form replies are unaffected.
- [ ] ⚠️ **Submit templates** (docs/template-submission.md) under WABA **1582515279931864** (templates are WABA-scoped; the pack was aimed at the old WABA).
- [ ] CTWA repoint to 2274 (2026-08-04, see section at top): most ad sets repointed + re-live; **verify every remaining active ad set's WhatsApp number** (at least one legacy ad set was stuck on the connect wizard — toggle destination or rebuild; a rebuild's new ad IDs must be appended in /admin → Campañas).
- [ ] Anthropic auto-reload ON (avoid silent brain outage).
- [ ] Watch display-name review status for 2274; watch quality rating (starts UNKNOWN).
- [ ] Old contact backfill: manychat-master.csv → Airtable (leads 7/16–8/03 missing from CRM).
- [ ] Phase 2 backlog: two-number send routing, support bot on 0813 (needs coexistence build), ~~IG/FB DM adapter~~ (shipped dark 2026-08-04, see top), EN templates.
- [ ] Old-number spam-ban lesson is now a standing team rule: **never bulk-add students to WhatsApp groups; invite links/QR only.**

## ⚡ PREVIOUS SITUATION (2026-07-18) — historical, superseded above

**App Review SUBMITTED** (2026-07-15) for `whatsapp_business_messaging` + `whatsapp_business_management` + `public_profile` on app 2215578122600171. Both required videos attached (msg-send via API + template creation in WhatsApp Manager), API test calls show **Completed**, own-business reviewer note included. Status: **In review** — Meta quotes "most within 20 days" but clean own-business submissions usually land in 1–5 business days. Business Support ticket filed in parallel (WABA 2227852814309146, own-business #200, expedite request).

**ManyChat involuntarily disconnected from the real number** (2026-07-18). When we subscribed our app to the real WABA, ManyChat's link to +52 55 3426 0813 broke and **will not reconnect** — its onboarding wizard throws `#2388002 "failed to check phone number eligibility"` because the number is already registered to the Cloud API under our WABA with our app subscribed. The number itself is **healthy**: WABA 2227852814309146, status Connected, quality rating back to **High**. So: we still RECEIVE every lead (worker webhooks → Slack + Airtable, name + campaign captured), but neither ManyChat nor our app can SEND until App Review lands. Effectively the receive-side cutover happened early; only send permission is missing.

### New TWO-NUMBER architecture (decided 2026-07-18)

Turning the disruption into the sales/support split Evan already wanted (~100 sales convos/day were drowning student-support messages like "left my gloves at the academy"):

- **NEW number = permanent SALES number.** Onboard a genuinely fresh MX number (new SIM/eSIM/virtual, never had WhatsApp recently) into **ManyChat** now → restores sales coverage in ~1 day (fresh onboarding has no eligibility conflict). Point all active CTWA ad campaigns at this new number (per-campaign in Ads Manager; **ad IDs stay the same**, so worker campaign-matching keeps working post-cutover untouched). When App Review lands, cut the NEW number over to the worker (add to a WABA we control → subscribe our app → set `WA_PHONE_NUMBER_ID`). ManyChat's role ends there.
- **OLD number (+52 55 3426 0813) = STUDENT SUPPORT number.** Already registered under our WABA with our app receiving webhooks; existing students already have it saved = perfect support audience. Bot can answer support there in phase 2, or staff handles it.

End-state: sales + support separated at the number level, both eventually on the worker. Two-number *send* support in the worker is a modest phase-2 code change (today it handles one send number via `WA_PHONE_NUMBER_ID`).

**Caveats logged:** (1) ManyChat leads on the new number won't flow into our Airtable/Slack pipeline until cutover (same as old ManyChat days; backfill later or rewire MC's own Airtable push). (2) In-flight leads on the old number keep replying there — cover manually for a few days, volume decays fast once ads move. (3) Do NOT touch the old number registration or app 2215578122600171 while App Review is in flight. (4) Keep review pressure on: update support ticket noting the business number has no automated-reply capability (operational-impact tickets get escalated).

## Where we are

**LIVE end-to-end on the Meta TEST number** (+1 555 089 6235), verified with 3 test recipient numbers. Full loop works: WhatsApp → worker → Claude brain → Slack #wa-leads approval card → Aprobar/Editar → reply + booking video land on the lead's phone. TRAINING_WHEELS=1 (every reply needs approval). The REAL leads number (+52 55 3426 0813) still runs ManyChat via coexistence — cutover is the final step (docs/cutover-runbook.md).

Everything shipped: brain + KB, Slack approvals, admin dashboard (/admin), anti-no-show sequence, lead-nudge drips (day-1 + extended 7-touch per program), quiet hours 21:30–08:00, booking video, ad attribution, voice-note transcription, Airtable lead-sync + natural-language rules engine, campaign inline editing, KB rewrite (Evan's copy, 2026-07-07/08: positioning, all programs, Curso de Verano, Reto Gladiador, two-step price deflection → range only, horarios phrasing).

Recent fixes (2026-07-08/09): stale pending approvals auto-supersede when the lead keeps writing (kills duplicate holding lines); Slack **Editar** no longer turns spaces into `+` (form-encoding decode); Editor chat no longer 500s pre-migration.

**Shipped 2026-07-11 (phase-1 ManyChat parity):**
- **Campaign first-reply** (new gate 5c): a brand-new ad lead whose message matches a campaign with `first_reply` set gets the pre-written welcome instantly — no brain, no approval; ⚡ FYI note in Slack; nudge drip arms off it; AI takes over from the lead's next message. Editable per campaign in /admin → Campañas ("Respuesta automática"). Requires the migration below; code fail-softs until it runs.
- **Multi-ad-id campaigns**: `campaigns.ad_id` now accepts a comma-separated list (one concept = many live Meta ads).
- **Opt-out hardening**: broader exact-match set (baja/stop/alto/unsubscribe + "ya no me manden mensajes" variants, accent/punctuation-tolerant, src/pipeline/opt-out.ts), 🚫 Slack note, and best-effort `Tags += "Baja"` on the Airtable lead.
- **Template submission pack**: docs/template-submission.md — copy-paste doc for Evan to submit all 24 templates in WhatsApp Manager.
- **First-reply RE-send on ad re-click** (Evan request, same day): a known lead who clicks an ad again (inbound carries a referral) and has no trial booked gets the same campaign welcome again, at most once per 24h (`kvClaimIfAbsentOrOlder` cooldown claim). Typing trigger-like text mid-chat never re-welcomes. Slack note: 🔁.
- **🧹 Reiniciar (prueba)** button in Chats detail: wipes messages/followups/approvals/kv claims + resets the contact so a test phone acts like a brand-new lead (POST /admin/api/conversations/:phone/reset).
- The 4 campaigns are LOADED in /admin with welcomes + ad ids (curso de verano ends 14-ago; BFC active but ad-less, ads paused on purpose).

## Evan's pending setup (blockers marked ⚠️)

- [x] D1 migration: `airtable_rules` table + `contacts.airtable_lead_id` (ran 2026-07-09)
- [x] **AIRTABLE_PAT secret** — set on the worker (confirmed 2026-07-11). If Airtable writes ever fail, verify the token still has scopes `data.records:read`, `data.records:write`, `schema.bases:read` on base `appcX38TBVltyxHR6`.
- [x] Airtable field mapping (2026-07-09): the bot now writes Evan's REAL Spanish CRM columns (`# de Teléfono`, `Nombre de Lead`, `Fecha Clase Prueba`, `Actividad`, `Programa`, `Canal`="WA", `Campaña`, `Ad`, `Resultado Clase Prueba`, `Tags`) via `airtableLeads` map in clients/md-condesa/client.mjs. Phone lookup matches last-10-digits regardless of stored format. No English fields needed.
- [ ] ⚠️ **D1 migration for campaign first replies**: `ALTER TABLE campaigns ADD COLUMN first_reply TEXT;` — until it runs, saved first replies are silently dropped (soft-fail) and gate 5c never fires.
- [ ] Earlier D1 migrations if not yet run: `ALTER TABLE contacts ADD COLUMN ad_ref TEXT; ALTER TABLE campaigns ADD COLUMN ad_id TEXT;` + dashboard tables (docs/phase0-checklist.md Step 6c).
- [ ] Create the 4 campaigns in /admin → Campañas (Curso de Verano, Baby Fight Club, Kids, Reto) with trigger phrase, ad id(s), info, and first reply. Active Meta ad ids pulled 2026-07-11: Curso de Verano = 120248879929990518, 120248879930930518, 120248879925940518, 120248879928990518; Kids = 120245400639450518, 120245400692660518, 120245396039730518, 120245400408310518, 120245400081370518, 120245400540790518, 120245197707210518, 120245198063240518, 120245197395390518, 120244434754400518; Reto = 120244947083620518, 120244434043620518, 120244433794140518. **Baby Fight Club has NO active ads right now** — confirm with Evan. Prefilled phrases must come from Ads Manager (not exposed via API).
- [ ] Confirm WA_ACCESS_TOKEN is the permanent System User token (temp tokens 401 after ~24h).
- [ ] Submit WhatsApp templates (docs/template-submission.md — 24 copy-paste-ready; source docs/templates.md) — Evan chose to do this NOW, pre-cutover, so d2–d5 drips work from day one.
- [ ] ⚠️ **Blocked on Meta App Review** — SUBMITTED 2026-07-15 (see CURRENT SITUATION at top). Root cause was `whatsapp_business_messaging` at **Standard access**; new apps must pass App Review for production sends even for their own business. Proof on record: identical token sends fine via TEST number (`1208228772369686`), fails via real one (`919322911268999`) with `(#200) permissions on behalf of this WABA`. Token verified clean (System User waagentsystem, messaging+management, granular = all objects, never expires). `WA_PHONE_NUMBER_ID` is set in the **Cloudflare dashboard** (Settings → Variables), NOT wrangler.jsonc — currently = real number id `919322911268999`; takes effect on next request, no redeploy. Ignore duplicate app id 1327983355704061 (empty shell).
- [ ] **Onboard NEW sales number into ManyChat + repoint ads** (two-number plan, see top) — restores sales coverage while App Review pends. Fresh number only.
- [ ] After approval: cut the NEW sales number over to the worker (add to controlled WABA → subscribe app → set `WA_PHONE_NUMBER_ID`). NOTE: add own payment method to the WABA before relying on template sends (was ManyChat's credit line).
- [ ] Phase-2 code: two-number *send* support in the worker (sales vs. student-support routing); old number +52 55 3426 0813 becomes the support line.

## Known bugs / next work

1. ~~trial_confirm mis-timed for web-form bookers~~ **FIXED 2026-07-09**: `computeTrialSequence` now fires trial_confirm at booking-detection time (clamped to the send window) instead of at class time; chat bookings pass `includeConfirm: false` since the bot confirms inline (src/cron/followups.ts, src/pipeline/inbound.ts).
2. Meta test-number quirk (not a code bug): outbound to non-verified recipients fails; Mexico numbers may need the `521…` form in the allowlist. Disappears on the real number.
3. Tune the brain weekly from Slack Editar diffs while training wheels are on (edits are logged to D1 `edits`).

## Key IDs

- Worker: md-condesa-wa-agent (account: evancaguilar — local wrangler CLI is logged into the WRONG account)
- D1: wa-agent-db `c57b17de-9e0c-4a48-adc7-7cb791372cdc`
- Slack channel #wa-leads `C0BFKQ6AU9F` · Airtable base `appcX38TBVltyxHR6` / table `Leads`
- Meta test number ID `1208228772369686`, WABA `1545530463899885`; real leads number +52 55 3426 0813
