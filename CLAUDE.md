# MD Condesa WhatsApp AI Agent

WhatsApp AI agent for MD Self Defense Academy Condesa (martial-arts gym, CDMX). Replaces ManyChat on the leads number. Answers Meta-ad leads from a knowledge base, qualifies them, books free trial classes, and routes everything through human approval in Slack (#wa-leads) while training wheels are on.

**This is the repo to work from for anything bot/agent/dashboard related** (`~/md-condesa-wa-agent`). The academy's website lives in the sibling repo `~/md-condesa-site` — the KB compiler reads it, but site edits happen there, not here.

## Stack & architecture (details: docs/architecture.md)

- **Cloudflare Worker** (TypeScript) + **D1** (`wa-agent-db`). Deployed by **git push to main** → Workers Builds CI. Live at https://md-condesa-wa-agent.evancaguilar.workers.dev
- **ZERO runtime npm dependencies.** Raw `fetch` + WebCrypto only. Don't add packages.
- Brain: `claude-sonnet-5` via raw fetch (src/brain/claude.ts). Two cached system blocks (persona+KB, then D1 overlay), 1h-TTL `cache_control`, `thinking: disabled`, NO temperature/top_p. Volatile data (time, contact) goes in a per-turn `<context>` block, never in system.
- Inbound pipeline (src/pipeline/inbound.ts) gate order is contractual: dedupe → kill switch → opt-out → campaign tagging → student → human override → crisis → campaign first-reply (instant pre-written welcome, no brain/approval) → debounce → brain → route.
- Slack approval flow (src/services/slack.ts, approvals.ts): Aprobar/Editar/Tomar control. TRAINING_WHEELS=1 → every reply needs approval.
- Cron (*/5 min): anti-no-show sequence, lead-nudge drips (day-1 + extended d2–d5), Airtable syncBookings + result watcher, approval timeouts. Quiet hours 21:30–08:00 CDMX for all unsolicited sends.
- Admin dashboard `/admin` (src/ui/admin.html, single inline-script SPA): Inicio, Chats, Aprobaciones, KB overlay, Editor (IA proposes KB edits/campaigns/rules), Campañas (+ Reglas), Probar sandbox.
- Airtable base `appcX38TBVltyxHR6`, table `Leads` = CRM. Lead-sync upserts by `Phone E164`; rules engine (docs/airtable-rules-plan.md) applies natural-language rules to any field.

## Multi-client layout (do not fight it)

- `clients/md-condesa/` holds client config: `client.mjs`, `persona.md` (behavior), `intake.md` (knowledge, inserted VERBATIM into the KB), `kb-build.mjs`.
- `npm run build` (tools/compile-kb.mjs, CLIENT=md-condesa) compiles site data + intake.md → `kb/compiled/kb.md` and generates `src/client.gen.ts`. **NEVER hand-edit `client.gen.ts` or `kb/compiled/kb.md`.**
- KB edits = edit `persona.md`/`intake.md` (or site content), run `npm run build`, commit BOTH source and compiled output.

## Verification protocol (non-negotiable, learned the hard way)

1. Before every push: `npm run typecheck` && `npm test` && `npm run build` && `npx wrangler deploy --dry-run`. All tests green, no exceptions.
2. **Verify deploys by probing for a NEW string/route/behavior, not `/health` liveness.** Workers Builds once failed silently for hours while the old build kept serving and `/health` kept returning ok. `/health` now returns `kbVersion` — use it when the KB changed.
3. Local wrangler CLI is logged into the WRONG Cloudflare account (fighterwebsites). `wrangler tail`/`d1 execute` fail with "not found" — use the Cloudflare dashboard (Workers → md-condesa-wa-agent → Logs) or ask Evan.
4. Admin SPA is one big inline script — after editing admin.html, syntax-check it (`new Function(scriptBlock)`) before pushing; one syntax error bricks the whole dashboard.
5. Pure logic goes in pure modules with unit tests (`node --test` via tsconfig.test.json; fake clocks for CDMX time math).

## Hard rules

- **Secrets:** only Cloudflare encrypted secrets (ANTHROPIC_API_KEY, WA_ACCESS_TOKEN, WA_VERIFY_TOKEN, WA_APP_SECRET, SLACK_*, ADMIN_PASSWORD, AIRTABLE_PAT). Never in wrangler.jsonc, git, or ANY file — never persist the Anthropic key to disk, even scratch scripts.
- Never invent prices/schedule in KB copy — source of truth is the site repo + Evan.
- D1 schema changes: additive SQL that Evan pastes in the D1 console + mirrored in schema.sql. Code must fail SOFT if a migration hasn't run yet (see listAirtableRules).
- Mexico phone quirk: always `normalizeMxPhone()` (521 mobile shape) for Airtable-sourced phones; replies always go to the exact webhook `wa_id`.
- WhatsApp 24h window: free-form only in-window; out-of-window = approved template or nothing. Templates live in docs/templates.md (submit at cutover).
- Evan owns go-live decisions. Never bulk-send, never flip TRAINING_WHEELS, never touch the real number cutover without his explicit OK.

## Key commands

```bash
npm run typecheck && npm test        # gates
npm run build                        # compile KB + client.gen
npx wrangler deploy --dry-run        # bundle check
git push                             # = deploy (Workers Builds)
npm run chat                         # local brain REPL (needs ANTHROPIC_API_KEY inline, never saved)
curl -s https://md-condesa-wa-agent.evancaguilar.workers.dev/health
```

## Where things stand

Current status, pending setup steps, and known bugs: **docs/STATUS.md** (keep it updated when shipping). Specs for each subsystem are in docs/ (architecture, dashboard-plan, followups-pack-plan, sequences-v2-plan, airtable-rules-plan, manychat-flows, templates, cutover-runbook, phase0-checklist).
