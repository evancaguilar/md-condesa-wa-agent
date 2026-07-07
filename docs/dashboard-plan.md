# Admin Dashboard — Implementation Spec

Binding spec for the /admin dashboard build. Workstreams W1–W4 + integrator build against THIS document plus docs/architecture.md. Owner decisions: served by this worker at `/admin`, password auth, approvals in dashboard synced with Slack, campaigns = AI reply with campaign knowledge, UI es-MX mobile-first, zero build step, zero runtime npm deps.

## 0. Frozen contracts (types.ts — W1 lands these FIRST)

```ts
// Env gains:
ADMIN_PASSWORD: string; // secret

export interface KbSection { id: number; title: string; content: string; sort: number; enabled: number; created_at: number; updated_at: number; }
export interface KbRevision { id: number; section_id: number | null; action: "create"|"update"|"delete"|"revert"; title: string; content: string | null; prev_content: string | null; reason: string | null; source: "manual"|"chat"; created_at: number; }
export interface Campaign { id: number; name: string; trigger_phrase: string; trigger_norm: string; info: string; status: "active"|"paused"|"ended"; ends_at: number | null; created_at: number; updated_at: number; }
// Contact gains: campaign_id: number | null
// ConvoContext gains: campaign?: { name: string; info: string }
```

## 1. File ownership

| File | Owner |
|---|---|
| src/db/schema.sql (additions), src/types.ts, src/db/queries-admin.ts, src/routes/admin-auth.ts, src/services/approvals.ts, src/routes/slack.ts (refactor to thin wrappers only), src/index.ts (/admin routing), test/admin-auth.test.ts | W1 |
| src/brain/overlay.ts, src/brain/prompt.ts, src/brain/claude.ts, src/brain/index.ts, src/pipeline/campaigns.ts, src/pipeline/inbound.ts, src/services/kb-editor.ts, test/overlay.test.ts, test/campaigns.test.ts | W2 |
| src/routes/admin-api.ts, src/routes/admin-ui.ts | W3 |
| src/ui/admin.html | W4 |
| wrangler.jsonc, src/text-modules.d.ts, tsconfig.test.json, docs updates | Integrator |

## 2. D1 schema additions (append to schema.sql; also add `campaign_id INTEGER` to the contacts CREATE)

```sql
CREATE TABLE IF NOT EXISTS kb_sections(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_revisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER,
  action TEXT NOT NULL,              -- create|update|delete|revert
  title TEXT NOT NULL,
  content TEXT,                      -- after (NULL on delete)
  prev_content TEXT,                 -- before (NULL on create)
  reason TEXT, source TEXT NOT NULL DEFAULT 'manual',  -- manual|chat
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger_phrase TEXT NOT NULL,
  trigger_norm TEXT NOT NULL,
  info TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active|paused|ended
  ends_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_trigger ON campaigns(trigger_norm);
```

Prod migration (Evan pastes in D1 console): the 3 CREATEs + index above, plus `ALTER TABLE contacts ADD COLUMN campaign_id INTEGER;` (duplicate-column on rerun = harmless).

New kv keys: `training_wheels` ("1"/"0"; overrides env.TRAINING_WHEELS when present), `admin_rl:<ip>` (login rate-limit JSON).

## 3. W1 details

- **queries-admin.ts** (stateless `(db, ...)`, mirror queries.ts style): kb_sections CRUD (`listKbSections`, `createKbSection`, `updateKbSection`, `deleteKbSection`, `getKbSection`), `insertKbRevision`, `listKbRevisions`, `getKbRevision`; campaigns CRUD + `getActiveCampaigns` (status active AND (ends_at null OR > now)), `getCampaign`; `setContactCampaign`, `clearHumanOverride`; **`claimApproval(db, id, status, finalText?)`** — atomic `UPDATE pending_approvals SET status=?2, resolved_at=?, final_text=? WHERE id=?1 AND status='pending'`, returns boolean from meta.changes; `listConversations(db, limit, offset)` (contacts LEFT JOIN last message + pending count + campaign name); `listEdits(db, limit)`; `statsOverview(db)` (MTD usage_log sums, convos today/week via messages with CDMX day boundaries); `getTrainingWheels(env)` helper (kv override, env fallback).
- **admin-auth.ts** (pure, dep-free, unit-tested): `signAdminCookie(secret, expEpoch)` / `verifyAdminCookie(secret, cookieHeader, now)` — HMAC-SHA256 over `admin:<exp>` via WebCrypto, value `md_admin=<exp>.<hexhmac>`, constant-time compare (copy timingSafeEqual convention from routes/verify.ts); `parseCookies(header)`; `buildSetCookie(value, maxAge)` (HttpOnly; Secure; SameSite=Lax; Path=/admin); `decideLoginRateLimit(stateJson, now)` — 5 fails / 15 min sliding.
- **services/approvals.ts**: `approveAndSend(env, id)`, `editAndSend(env, id, finalText)` (also insertEdit), `discardApproval(env, id)`, `takeoverApproval(env, id)`, `markStudentFromApproval(env, id)`. Flow: claimApproval first (lost race → `{ok:false, reason:"not_pending"}`); then wa.sendText; WindowClosedError → set status expired + markWindowClosedCard, return `{ok:false, reason:"window_closed"}`; other send errors → revert row to pending, rethrow. Slack card updates via stored slack_ts (no-op when null).
- **slack.ts**: onApprove/onViewSubmission/onTakeover/onMarkStudent/onDiscard become thin wrappers over approvals.ts. Keep modal, attendance, control-panel code as-is.
- **index.ts**: before 404 — `GET /admin` → handleAdminUi; `/admin/api/*` → handleAdminApi(req, env, ctx, makePorts(env)). (W3 owns those handlers; W1 wires imports and may stub until W3 lands.)

## 4. W2 details

- **overlay.ts** (pure): `assembleOverlay(sections)` → "" when empty, else header `# ACTUALIZACIONES Y CORRECCIONES\nSi algo aquí contradice la base de conocimiento, ESTO manda.` + `## <title>\n<content>` per enabled section sorted by (sort, id); `estimateTokens(s)` = ceil(chars/3.5).
- **prompt.ts**: `buildSystem(kb, overlay?: string)` — block 1 unchanged; if overlay non-empty append block 2 `{type:"text", text: overlay, cache_control:{type:"ephemeral", ttl:"1h"}}`. `buildContextBlock`: when ctx.campaign, add `<campaign_info>\ncampaña: <name>\n<info>\nEl lead llegó por esta campaña; úsala para responder.\n</campaign_info>`.
- **claude.ts**: BrainDeps gains `loadOverlay?: () => Promise<string>`; respond() assembles system per call: `buildSystem(kb, deps.loadOverlay ? await deps.loadOverlay() : "")`. Export `callAnthropic` (add optional `tools` and `maxTokens` params, defaults preserved) for kb-editor reuse.
- **brain/index.ts**: `createBrainWithKb` passes loadOverlay through; new `makeOverlayLoader(db)` = listKbSections → assembleOverlay.
- **pipeline/campaigns.ts** (pure): `normalizeText(s)` — NFD, strip diacritics, lowercase, strip punctuation, collapse whitespace; `matchCampaign(bodyNorm, campaigns)` → campaign id | null (trigger_norm equality OR bodyNorm startsWith trigger_norm).
- **inbound.ts**: after opt-out gate: if body matches an active campaign → setContactCampaign + re-read contact. Context build: if contact.campaign_id → getCampaign → ctx.campaign. Replace direct env.TRAINING_WHEELS read with `getTrainingWheels(env)`.
- **kb-editor.ts**: `runKbChat(env, messages: {role, content}[]) → {reply, proposals: Proposal[]}` — single callAnthropic (claude-sonnet-5, max_tokens 2000, thinking disabled) with 2 system blocks (1: static es-MX instructions + compiled KB base, cached 1h; 2: current overlay WITH section ids + campaigns list + token count) and proposal-only tools `propose_kb_edit {section_id|null, title, new_content, reason}`, `propose_kb_delete {section_id, reason}`, `propose_campaign {name, trigger_phrase, info, ends_at?}`. Tool_use blocks are NOT executed and NOT round-tripped — collected as proposals, enriched with prevContent/prevTitle from D1 for diffs. `applyProposal(env, proposal)` validates (section exists, overlay ≤2000 tok, trigger unique) and writes kb_sections/kb_revisions(source:'chat') or campaigns. Instructions: propose MINIMAL edits, prefer editing existing overlay sections over duplicates, flag contradictions with the base, keep overlay under ~1500 tokens, NEVER apply — only propose.

## 5. W3 details — API routes (all JSON; signed-cookie auth except login/UI)

| Method + path | Req → Res |
|---|---|
| GET /admin | HTML (no auth; SPA calls /admin/api/me) |
| POST /admin/api/login | {password} → {ok} + Set-Cookie. SHA-256 both sides + timingSafeEqual; kv rate limit per CF-Connecting-IP (5/15min) → 429 |
| POST /admin/api/logout | → {ok} + expired cookie |
| GET /admin/api/me | → {ok:true} / 401 |
| GET /admin/api/overview | → {botEnabled, trainingWheels, pendingCount, convosToday, convosWeek, month:{inputTokens,cachedTokens,outputTokens,costUsd}, overlayTokens} |
| POST /admin/api/bot | {enabled} → {ok} (kvSet bot_enabled + updateControlPanel) |
| POST /admin/api/training-wheels | {enabled} → {ok} (kvSet training_wheels) |
| GET /admin/api/conversations?limit&offset | → {items:[{phone,name,status,lastBody,lastTs,lastDirection,paused,pendingCount,campaignName}]} |
| GET /admin/api/conversations/:phone | → {contact, messages (last 100), pending} |
| POST /admin/api/conversations/:phone/pause | {hours?} → {ok, until} |
| POST /admin/api/conversations/:phone/resume | → {ok} (clearHumanOverride) |
| POST /admin/api/conversations/:phone/status | {status:"student"|"lead"} → {ok} |
| GET /admin/api/approvals | → {items:[{id,phone,name,draft,context,createdAt}]} |
| POST /admin/api/approvals/:id/approve | → {ok} \| {ok:false, reason:"not_pending"|"window_closed"} |
| POST /admin/api/approvals/:id/edit | {text} → same |
| POST /admin/api/approvals/:id/discard | → {ok} |
| GET /admin/api/kb | → {base:{version,text}, sections:[KbSection], overlayTokens} |
| POST /admin/api/kb/sections | {title,content,sort?} → {section, overlayTokens}; >2000 tok → 400 {error:"overlay_too_large"} |
| PUT /admin/api/kb/sections/:id | {title?,content?,sort?,enabled?} → {section, overlayTokens} |
| DELETE /admin/api/kb/sections/:id | → {ok} |
| GET /admin/api/kb/revisions?limit | → {items} |
| POST /admin/api/kb/revisions/:id/revert | → {ok, section} |
| POST /admin/api/kb/chat | {messages} → {reply, proposals} |
| POST /admin/api/kb/confirm | {proposal} → {ok, section?|campaign?, overlayTokens?} |
| GET /admin/api/campaigns | → {items} |
| POST /admin/api/campaigns | {name,trigger,info,endsAt?} → {campaign}; dup trigger → 409 |
| PUT /admin/api/campaigns/:id | {name?,trigger?,info?,endsAt?,status?} → {campaign} |
| GET /admin/api/edits?limit | → {items:[{phone,draft,final,ts}]} |
| POST /admin/api/sandbox | {messages:[{role,body}]} → {action, message?, confidence?, reason?, booking?} |

Sandbox: synthetic ConvoContext (phone "sandbox", lang es, status lead, windowOpen true, trainingWheels false, history from client turns, real nowCdmx/weekday); dedicated brain built per request via createBrainWithKb with SAME loadOverlay + real accrueUsage + stub AirtablePort `{bookTrial: async () => "sandbox-record"}`; never calls pipeline/routeResult — zero messages/followups/Slack/WA side effects. admin-ui.ts serves src/ui/admin.html text module, `content-type: text/html; charset=utf-8`, `cache-control: no-store`.

## 6. W4 details — UI (src/ui/admin.html, es-MX, vanilla JS, zero deps)

Hash-router tabs; <768px bottom icon tab bar, desktop left sidebar; system fonts; 30s polling for overview/approvals when visible; fetch with credentials same-origin. Views:
- **Inicio**: big toggle "Bot activo/⏸ pausado" (red when paused), toggle "Modo supervisión (aprobar todo)", cards Costo del mes / Conversaciones hoy y semana / Pendientes (tap → Aprobaciones).
- **Chats**: rows (name/phone, preview, chips Lead/Alumno/Baja, ⏸ Pausado, ⏳ Pendiente, 📣 campaña) → transcript bubbles + Pausar aquí/Reanudar/Marcar alumno. Mobile full-screen detail w/ back; desktop two-pane.
- **Aprobaciones**: cards w/ contexto, respuesta propuesta, ✅ Aprobar / ✏️ Editar (inline textarea) / 🗑 Descartar; `not_pending` → "Ya resuelta (probablemente desde Slack)".
- **KB**: collapsible "Base compilada (vX)" read-only; overlay sections editable inline + "+ Nueva sección"; token meter (amber ≥1200); Historial subview with before/after + ↩ Revertir.
- **Editor**: chat; proposal cards with green/red line diff + Confirmar/Descartar → confirmed flips to "✅ Aplicado".
- **Campañas**: list + form (Nombre, Frase del anuncio, Información para el bot, Termina el) + Pausar/Reactivar/Finalizar.
- **Probar**: sandbox chat; reply chips `Enviaría directo` / `Pediría aprobación` / `Escalaría`; bookings "📋 SANDBOX — Reservaría: … (sin registro real)"; 🧹 Reiniciar.

## 7. Cache economics

Static block 1 + tools cache untouched by overlay edits. Overlay block 2: ~1.5K tok — cache write on change ≈ $0.006, steady reads ≈ $0.0003/msg. Negligible.

## 8. Integrator checklist

wrangler.jsonc Text rule globs → ["**/*.md", "**/*.html"] (same rule; verify `npx wrangler deploy --dry-run`); `declare module "*.html"`; tsconfig.test.json include += admin-auth/overlay/campaigns; typecheck+test+build green; wrangler dev --local smoke: login (bad pw ×6 → 429), KB section CRUD + revert, kb/chat → proposal → confirm applies, sandbox has zero DB side effects, concurrent approve race → one ok/one not_pending, /admin/api/bot toggle reflected in isBotEnabled; docs/architecture.md addendum; docs/phase0-checklist.md gains ADMIN_PASSWORD + migration SQL steps.

## 9. Evan's manual steps post-deploy

1. Cloudflare secret `ADMIN_PASSWORD` (strong password).
2. Paste §2 migration SQL in D1 console (3 CREATEs + index + ALTER).
3. Push → deploy → open /admin, log in on phone + desktop.
4. Smoke: bot toggle syncs Slack panel; sandbox message; create campaign; KB edit via Editor visible in sandbox.
