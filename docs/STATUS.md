# Project status

> Update this file whenever something ships or a pending item completes. Last updated: **2026-08-04**.

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
- [ ] Phase 2 backlog: two-number send routing, support bot on 0813 (needs coexistence build), IG/FB DM adapter, EN templates.
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
