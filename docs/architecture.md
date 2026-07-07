# MD Condesa WhatsApp AI Agent — Architecture Spec

Single source of truth for the build. Workstreams A–E build against this document.

## Purpose

Replace ManyChat on MD Self Defense Academy Condesa's WhatsApp number (+52 55 3426 0813, coexistence with the WA Business app) with an in-house AI agent that:
1. Answers lead inquiries (Meta click-to-WhatsApp ads + organic) bilingually (ES-MX primary, EN secondary) from a compiled knowledge base. **#1 priority: answer ad leads fast and get them booked into a trial class.**
2. Qualifies leads (name, discipline, kid/adult, goal) and books trial classes — either directly into Airtable (`book_trial` tool) or by sending the booking-page link.
3. Runs anti-no-show and re-engagement sequences via WhatsApp template messages.
4. Escalates to a human (Slack approval flow) whenever unsure; uncertain drafts require approval.
5. Goes quiet when Evan replies from the WA Business app (coexistence echo detection), and has a **global kill switch** in Slack.

Current students move to a separate human-run number; if a known student writes to the lead line, the bot stays silent and pings Slack.

## Verified facts

- Canonical contact/NAP: `/Users/evanaguilar/md-condesa-site/content/site.js` — `whatsappNumber: "525534260813"`, address Av. México 49, 1º piso, Condesa; booking pages live at `https://mdcondesa.com/clase-prueba-adultos/` and `https://mdcondesa.com/clase-prueba-ninos/` (also `/agendar-clase-prueba-adultos/`, `/agendar-clase-de-ninos/`).
- Schedule: `/Users/evanaguilar/md-condesa-site/js/schedule-data.js` — browser IIFE assigning `window.MD_SCHEDULE` + `window.MD_SCHEDULE_I18N` (compact model: `n` program, `v` gi/nogi, `a` kids/teens/mini, `s` sparring). Needs a `window` shim to evaluate in Node.
- Pricing in `/Users/evanaguilar/md-condesa-site/index.html` (~lines 1527–1603): Diamond $999 / Gold $749 / Silver $625 / Bronze $499 MXN per week; "$999 inscription waived online" promo. NOT structured — transcribed into `kb/intake.md`.
- FAQs/discipline copy: `/Users/evanaguilar/md-condesa-site/content/pages/*.js`, `/Users/evanaguilar/md-condesa-site/content/en-hub.js`; founder/trust: `content/founder.js`.
- Airtable base already live: `appcX38TBVltyxHR6` (trial-class forms from the website already write here).
- Anthropic: model `claude-sonnet-5` ($3/$15 per MTok; intro $2/$10 through 2026-08-31). Cache reads ~0.1× input; 1h-TTL cache writes 2×. Sonnet 5: adaptive thinking is ON unless `thinking: {type:"disabled"}` is sent explicitly; temperature/top_p are rejected; min cacheable prefix ~2048 tokens.
- Deployment: Cloudflare Workers Builds (git push-to-deploy). Local Node v24 available for dev/tests at `~/.local/share/node24/bin` (on PATH).

## Repo layout

```
wrangler.jsonc                 # worker config: D1 binding, cron trigger, vars
package.json                   # devDeps only (typescript, wrangler, @cloudflare/workers-types); zero runtime deps
tools/compile-kb.mjs           # KB compiler (zero-dep Node, mirrors site's tools/build.js ethos)
kb/intake.md                   # human-filled gaps (kids pricing, drop-in, parking, domiciliado)
kb/compiled/kb.md              # generated AND committed (worker imports this as text)
src/index.ts                   # fetch router + scheduled() cron dispatcher
src/routes/whatsapp.ts         # GET verify + POST webhook
src/routes/slack.ts            # POST /slack/interactive (Block Kit actions + modal submits)
src/routes/admin.ts            # GET /health, GET /kb-version
src/pipeline/inbound.ts        # dedupe → contact upsert → gates → brain → route reply
src/brain/claude.ts            # Anthropic Messages API loop (raw fetch)
src/brain/prompt.ts            # system prompt assembly + cache_control placement
src/brain/tools.ts             # tool definitions + executors
src/services/wa.ts             # Graph API send (text, template), mark-read; 24h-window enforcement
src/services/slack.ts          # chat.postMessage, views.open, Block Kit builders
src/services/airtable.ts       # REST client (PAT), booking create, booking poll, student list
src/cron/dispatcher.ts         # single */5 cron: due followups, stale approvals, syncs
src/db/schema.sql              # D1 schema
src/db/queries.ts              # typed query layer (contract shared by all workstreams)
src/types.ts                   # shared types (contract shared by all workstreams)
test/fixtures/*.json           # Meta webhook payloads for replay tests
test/*.test.ts                 # unit tests
docs/phase0-checklist.md       # Evan's manual setup runbook
docs/cutover-runbook.md        # ManyChat → own app coexistence migration
```

Runtime: TypeScript, ZERO npm runtime dependencies — raw `fetch` to Meta Graph, Anthropic, Slack, Airtable. Workers Free plan.

## Routes

| Route | Behavior |
|---|---|
| `GET /webhook/whatsapp` | Meta verification handshake: echo `hub.challenge` when `hub.verify_token === env.WA_VERIFY_TOKEN` |
| `POST /webhook/whatsapp` | Validate `X-Hub-Signature-256` (HMAC-SHA256, `env.META_APP_SECRET`); return 200 immediately; process in `ctx.waitUntil()` |
| `POST /slack/interactive` | Verify Slack signing secret (v0 HMAC, 5-min replay window); ack <3s; process in `waitUntil` |
| `GET /health` | `{ok, kbVersion, dbOk, botEnabled}` |
| `scheduled()` | `*/5 * * * *` → `cron/dispatcher.ts` |

## D1 schema

```sql
CREATE TABLE contacts(
  phone TEXT PRIMARY KEY,            -- digits only, e.g. 5215512345678
  name TEXT, lang TEXT DEFAULT 'es',
  status TEXT DEFAULT 'lead',        -- lead|student|opted_out
  qualification TEXT,                -- JSON {discipline, audience:'kid'|'adult', goal, name}
  human_override_until INTEGER,      -- epoch seconds; bot silent until then
  last_inbound_at INTEGER,           -- drives 24h-window logic
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE messages(
  wamid TEXT PRIMARY KEY,            -- INSERT OR IGNORE = webhook-retry dedupe
  phone TEXT, direction TEXT,        -- in|out_bot|out_human_echo
  body TEXT, ts INTEGER, meta TEXT
);
CREATE TABLE pending_approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, draft TEXT, context TEXT,
  confidence TEXT, slack_ts TEXT,
  status TEXT DEFAULT 'pending',     -- pending|approved|edited|taken_over|expired|discarded
  holding_sent INTEGER DEFAULT 0,
  created_at INTEGER, resolved_at INTEGER, final_text TEXT
);
CREATE TABLE followups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, kind TEXT,             -- trial_confirm|day_before|same_day|no_show_1|reengage_7d|custom
  due_at INTEGER, status TEXT DEFAULT 'scheduled', -- scheduled|sent|cancelled|skipped_optout
  airtable_record_id TEXT, note TEXT, created_at INTEGER,
  UNIQUE(phone, kind, airtable_record_id)
);
CREATE TABLE outbound_wamids(wamid TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE edits(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, draft TEXT, final TEXT, ts INTEGER);
CREATE TABLE usage_log(day TEXT PRIMARY KEY, input_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0);
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT);  -- bot_enabled flag, airtable sync cursor, budget alert marks
```

## Inbound pipeline (`src/pipeline/inbound.ts`)

Gate order:
1. **Dedupe**: `INSERT OR IGNORE INTO messages(wamid,…)`; existing row ⇒ drop event.
2. **Global kill switch**: `kv.bot_enabled === 'false'` ⇒ log + surface to Slack, no reply.
3. **Opt-out**: body matches `BAJA|STOP|ALTO` (case-insensitive, trimmed) ⇒ `status='opted_out'`, cancel followups, send one confirmation, done.
4. **Student**: `status='student'` ⇒ Slack note "known student wrote on lead line", no bot reply.
5. **Human override**: `human_override_until > now` ⇒ log + silent Slack surface, no reply.
6. **Debounce**: after storing, wait ~8s in `waitUntil`, re-check for a newer inbound from same phone; only the latest event calls the brain (consuming all unanswered messages).
7. **Brain** → route result: auto-send (confidence high AND `TRAINING_WHEELS=0`) or draft→Slack approval.

## Global kill switch

- `kv` key `bot_enabled` (`'true'` default). Pinned "control panel" message in `#wa-leads` with ⏸️ **Pausar bot** / ▶️ **Reanudar** buttons + current status; buttons flip the flag and update the card. While paused, every inbound is logged and surfaced to Slack (so Evan can answer from the WA Business app) but never auto-answered and no drafts are generated.
- Per-conversation auto-pause: coexistence echo (below).

## Coexistence echo handling

Subscribe `smb_message_echoes`. On echo:
- wamid ∈ `outbound_wamids` ⇒ our own API send, ignore.
- Else ⇒ Evan replied from the WA Business app: log `out_human_echo`, set `human_override_until = now + env.HUMAN_SNOOZE_HOURS*3600` (default 8h), cancel pending approvals for that phone (status `taken_over`), post Slack note ("Evan respondió desde el teléfono — bot en pausa hasta HH:MM").
Also subscribe `smb_app_state_sync` (required for coexistence) — log and ignore payloads. Other fields: `messages`, `message_template_status_update`, `account_update`.

## Claude brain

Request: `claude-sonnet-5`, `max_tokens: 1024`, `thinking: {type:"disabled"}` explicitly, NO temperature/top_p.

System prompt = ONE static block with `cache_control: {type:"ephemeral", ttl:"1h"}`:
- Persona: warm, concise, bilingual (mirror the lead's language; default es-MX) front-desk for MD Self Defense Academy Condesa. WhatsApp style: short messages, light emoji, no walls of text.
- Hard policies: never invent prices/schedule beyond KB; complaints/refunds/injuries/anger/price-negotiation ⇒ `escalate_to_human`; goal of every qualified convo = book a trial class (directly when day/time is clear, else send the booking link).
- Full compiled KB (`kb/compiled/kb.md` imported as text at build time).

NOTHING volatile in system (no date, no name — cache invalidators). Per-turn `<context>` block inside the latest user message: **current date + time in America/Mexico_City (weekday included — this is what lets the model resolve "hoy a las 6 pm" / "mañana a las 7 am" against the KB schedule)**, known contact info, qualification state, 24h-window status.

Conversation history: last 20 messages or 48h, capped ~1,000 tokens.

### Model tools

- `send_reply(message, language, confidence: "high"|"low", escalation_reason?)` — terminal tool; every turn ends with it. `low` ⇒ draft-approval path. TRAINING_WHEELS=1 forces approval regardless.
- `book_trial(name, discipline, audience, trial_date, trial_time, phone_confirmed)` — executor validates the slot against the compiled schedule (reject + tell the model if no such class), calls `airtable.bookTrial()`, schedules anti-no-show followups, returns confirmation data; always posts FYI card to Slack. Model is instructed to resolve relative dates ("hoy", "mañana", "el sábado") using the `<context>` date before calling.
- `escalate_to_human(reason, summary)` — immediate Slack ping + human_override.
- `set_followup(kind:'custom', hours_from_now, note)` — e.g. "les escribo la próxima semana".
- `get_schedule` — NOT in v1 (schedule lives in cached KB); keep drafted behind a flag.

### Budget telemetry (NO degradation — Evan's explicit call)

KB + system ≈ 5K tokens (compiler fails build >6K). Per-conversation ≈ $0.07 at intro pricing ⇒ 300 convos/mo ≈ $22. `usage_log` accrues real cost daily from API `usage` fields. Daily cron: post month-to-date spend to Slack when it crosses $30 and again at $50 (marks in `kv` so each fires once/month). **Never** switch models, force approval mode, or stop replying because of spend. Haiku triage is documented as a future lever only.

## WhatsApp specifics

- 24h window enforced IN `services/wa.ts`: free-form only if `now - last_inbound_at < 24h`; otherwise the send function refuses and requires a template name.
- Templates (ES + EN each): `trial_confirm` (Utility), `trial_reminder_day_before` (Utility), `trial_reminder_same_day` (Utility, quick-reply buttons "Ahí estaré"/"Necesito reagendar"), `no_show_followup` (Utility, may be recategorized Marketing), `reengage_lead` (Marketing, footer "Responde BAJA para no recibir más mensajes"), `human_followup` (Utility, reopens window when approval came late).
- Button taps arrive as inbound messages ⇒ reopen 24h window and route through the brain.

## Slack approval flow

App "MD WA Agent", scopes `chat:write`, `chat:write.public`, `pins:write`; interactivity URL = worker `/slack/interactive`; channel `#wa-leads` (`env.SLACK_CHANNEL_ID`).

Draft card blocks: header (phone, name, chips: nuevo lead / en calificación / ⏱ ventana cierra en Xh) → context (last ~6 messages labeled) → proposed reply (quote) + confidence/reason → buttons `approve|<id>`, `edit|<id>`, `takeover|<id>`, overflow (Marcar como alumno, Descartar).

- Approve ⇒ `wa.send` draft, update card in place ("✅ enviada …").
- Edit ⇒ `views.open` modal, prefilled `plain_text_input`; on submit send edited text, INSERT into `edits`, update card.
- Takeover ⇒ set human_override, expire approval, update card.
- Control panel card (pinned): bot status + Pausar/Reanudar buttons (`bot_pause`, `bot_resume` actions).
- Handlers ack <3s, work in `waitUntil`, card updates via `response_url` or `chat.update`.

Timeouts (cron): pending >10 min in business hours (09–21 CDMX) & !holding_sent & in-window ⇒ send holding line "¡Gracias por escribir! 🙌 Dame un momento y te confirmo enseguida." once, mark holding_sent, re-ping Slack `<!here>`. Pending >12h ⇒ expired; if window closed, card offers "send human_followup template" button.

## Airtable + followup engine

Base `appcX38TBVltyxHR6`. Discover exact trial-table name/fields via metadata API at runtime OR configure via env `AIRTABLE_TRIALS_TABLE`. Fields to rely on (added manually in Phase 0): `Source` (Web/WhatsApp), `Phone E164`, `Attendance` (checkbox), `Trial DateTime`. New `Students` table (Name, Phone E164) synced daily into `contacts.status='student'`.

- Bot bookings: `bookTrial()` creates record (Source=WhatsApp) + followup rows.
- Web-form bookings: hourly poll `filterByFormula` on `LAST_MODIFIED_TIME()` > cursor (stored in `kv`), upsert followups keyed by airtable_record_id (UNIQUE constraint = idempotent).
- Sequence (America/Mexico_City, sends clamped 09:00–21:00): T+0 `trial_confirm` (free-form if in-window); day-before 18:00; same-day −4h with buttons; T+3h after class ⇒ Slack "¿Llegó {name}?" Sí/No card; No ⇒ `no_show_followup` next morning 10:00; +7d silent ⇒ `reengage_lead` once, then cold.
- Opt-out cancels all scheduled followups.

Cron dispatcher (every 5 min): due followups → approval timeouts → hourly booking sync → daily 10:00 CDMX student sync + budget report.

## Env vars & secrets

Secrets: `META_APP_SECRET`, `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN`, `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `AIRTABLE_PAT`, `ADMIN_PASSWORD` (dashboard login).
Vars: `SLACK_CHANNEL_ID`, `AIRTABLE_BASE_ID=appcX38TBVltyxHR6`, `AIRTABLE_TRIALS_TABLE`, `TRAINING_WHEELS=1`, `HUMAN_SNOOZE_HOURS=8`.

## Admin dashboard (`/admin`)

Mobile-first es-MX SPA served by this same worker so Evan can run the academy's bot from his phone — no separate app, zero build step, zero runtime deps. Full spec: `docs/dashboard-plan.md` (historical/binding). Views: Inicio (kill-switch + supervision toggle + cost/convos/pending cards), Chats (transcripts, per-convo pause/resume, mark-student), Aprobaciones (approve/edit/discard, synced with the Slack cards), KB (overlay sections + revision history/revert), Editor (AI chat that PROPOSES overlay/campaign edits Evan confirms), Campañas (ad-trigger → extra bot knowledge), Probar (sandbox that runs the real brain with zero side effects).

**Auth.** `POST /admin/api/login` compares SHA-256 of the submitted password against `env.ADMIN_PASSWORD` via `timingSafeEqual`, rate-limited per `CF-Connecting-IP` (5 fails / 15 min sliding → 429; state in `kv` key `admin_rl:<ip>`). Success sets an HttpOnly/Secure/SameSite=Lax cookie `md_admin=<exp>.<hmac>` — HMAC-SHA256 of `admin:<exp>` keyed by `ADMIN_PASSWORD` (30-day expiry). Every other `/admin/api/*` route verifies that cookie (`routes/admin-auth.ts`, pure + unit-tested); `GET /admin` itself is unauthed HTML and the SPA calls `/admin/api/me`.

**Routes.** `GET /admin` → SPA shell (text module, `no-store`). `/admin/api/*` (JSON, all cookie-authed except login): `login`/`logout`/`me`, `overview`, `bot` + `training-wheels` toggles, `conversations[/:phone[/pause|resume|status]]`, `approvals[/:id/approve|edit|discard]`, `kb` (+ `sections` CRUD, `revisions[/:id/revert]`, `chat`, `confirm`), `campaigns[/:id]`, `edits`, `sandbox`. See `docs/dashboard-plan.md §5` for the full request/response table. Handlers live in `src/routes/admin-api.ts` (+ `admin-ui.ts` for the shell); shared approval logic in `src/services/approvals.ts` is called by BOTH this API and the Slack route, made concurrency-safe by `claimApproval` (atomic conditional `UPDATE … WHERE status='pending'`) so a Slack tap and a dashboard tap can't double-send.

**New D1 tables** (append-only in `schema.sql`; migration in `docs/phase0-checklist.md`):
- `kb_sections` — the editable **overlay**: correction/update snippets layered on top of the compiled (read-only) KB. `id, title, content, sort, enabled, timestamps`.
- `kb_revisions` — audit log for every overlay create/update/delete/revert (`action, title, content, prev_content, reason, source` where source is `manual`|`chat`), powering before/after diffs and one-click revert.
- `campaigns` — `name, trigger_phrase, trigger_norm, info, status, ends_at`; `trigger_norm` (NFD-stripped, lowercased, punctuation-collapsed) is UNIQUE. An inbound whose normalized body matches an active campaign's `trigger_norm` (equality or prefix) stamps `contacts.campaign_id`, and that campaign's `info` is injected into the brain's per-turn context.
- `contacts.campaign_id` — the campaign a lead arrived through (nullable). New `kv` keys: `training_wheels` (overrides `env.TRAINING_WHEELS`), `admin_rl:<ip>`.

**Overlay design.** `assembleOverlay(sections)` concatenates enabled sections (sorted by `sort`, then `id`) under a header telling the model "si algo aquí contradice la base, ESTO manda". It rides as a **second** cached system block (`cache_control: ephemeral, ttl:"1h"`) appended after the static KB block — so overlay edits invalidate only the small overlay cache, never the large KB/tools prefix (steady-state cost ≈ $0.0003/msg). A hard 2000-estimated-token cap (`ceil(chars/3.5)`) is enforced before any write; over-cap → HTTP 400 `overlay_too_large`. `makeOverlayLoader(db)` reads the live sections each brain turn, so edits take effect on the next reply with no redeploy. The **Editor** and **Sandbox** both reuse this exact loader and the real usage accrual; the Editor's model can only PROPOSE changes (proposal-only tools, never round-tripped/executed) which `applyProposal` writes after re-validation on explicit confirm.

## Rollout phases (booking prioritized)

P0 manual setup (docs/phase0-checklist.md) → **P1 Q&A + booking** on Meta test number, all-approval, both booking paths live → P2 crons/templates (anti-no-show, re-engagement) → P3 ManyChat cutover (docs/cutover-runbook.md, Sunday night, rollback = reconnect ManyChat) + 1–2 weeks TRAINING_WHEELS=1 on real ad traffic → P4 confident auto-send. Kill-switch card live from P1.

## Workstream contracts

- **A (core)** exposes: `db/queries.ts` typed layer, `types.ts`, `services/wa.ts` (`sendText(phone, body)`, `sendTemplate(phone, name, lang, components)`, both returning wamid + recording to outbound_wamids/messages), pipeline skeleton calling `brain.respond(ctx)` / `slack.postDraft(…)` stubs.
- **B (brain)** exposes: `respond(ctx: ConvoContext): Promise<BrainResult>` pure module (deps injected), `tools/compile-kb.mjs`, `kb/compiled/kb.md`, `kb/intake.md` template.
- **C (slack)** exposes: `postDraft(approval): Promise<slack_ts>`, `handleInteractive(payload)`, control-panel card + pause/resume, card-update helpers, holding-message hook for cron.
- **D (airtable/cron)** exposes: `bookTrial(input): Promise<recordId>`, `syncBookings()`, `syncStudents()`, `runDueFollowups()`, `runApprovalTimeouts()` (calls C's helpers), budget report.
- **E (integrator)**: wiring, fixture replay tests, docs, simulation script.

## File-ownership rules for parallel agents

A creates the scaffold and shared contracts first. B, C, D then work in parallel and may ONLY create/edit files they own (B: `src/brain/*`, `tools/compile-kb.mjs`, `kb/*`; C: `src/routes/slack.ts`, `src/services/slack.ts`; D: `src/services/airtable.ts`, `src/cron/*`). If a parallel workstream needs a change to a shared file (`types.ts`, `queries.ts`, `schema.sql`, `index.ts`, `package.json`), it writes the request to its own `docs/notes-<letter>.md` instead of editing; E applies them at integration.
