# WhatsApp AI agent (multi-client engine)

A productized WhatsApp agent engine, born as the in-house bot for **MD Self
Defense Academy Condesa** (which remains the default client). It answers
inquiries bilingually (ES-MX / EN) from a compiled knowledge base, optionally
qualifies leads and books trials into Airtable, runs anti-no-show +
re-engagement sequences, and escalates to a human via a Slack approval flow.
One Cloudflare Worker + D1 database **per client**, zero runtime npm deps —
raw `fetch` to Meta Graph, Anthropic, Slack, and Airtable. Coexistence-aware
(goes quiet when a human replies from the WhatsApp Business app) with a Slack
kill switch.

## Clients

Everything business-specific lives in `clients/<id>/` (config + persona +
knowledge base + wrangler config); `src/` is the shared engine. Features are
flags per client: `booking`, `nudges`, `airtableSync`, `safety` (deterministic
crisis gate for emotionally sensitive products).

```
node tools/new-client.mjs <id>     # scaffold a new client
CLIENT=<id> npm run build          # compile that client's KB + config
npm run deploy:client <id>         # deploy that client's worker
```

- **clients/md-condesa/** — the academy (booking + nudges + Airtable ON)
- **clients/iasmin/** — IAsmin, Yasmin Cahuich's between-sessions companion
  (all sales features OFF, crisis-safety gate ON)
- **[docs/new-client.md](docs/new-client.md)** — the onboarding runbook

## Where to look

- **[docs/architecture.md](docs/architecture.md)** — the binding spec: routes, D1
  schema, pipeline, brain, tools, followup engine, env vars.
- **[docs/phase0-checklist.md](docs/phase0-checklist.md)** — Evan's one-time
  manual setup (Meta app, Anthropic key, Slack app, Cloudflare D1 + secrets,
  Airtable). Click-by-click. Start here.
- **[docs/cutover-runbook.md](docs/cutover-runbook.md)** — the Sunday-night
  ManyChat → own-app migration, with rollback.
- **[docs/templates.md](docs/templates.md)** — the 6 WhatsApp templates (ES + EN)
  to submit to Meta.
- **[scripts/simulate.md](scripts/simulate.md)** — 10 test personas for
  phase-gate testing.

## Dev commands

Node 24 (`~/.local/share/node24/bin` on PATH). No runtime deps; `npm install`
only pulls dev tooling.

```
npm run typecheck   # tsc over the worker
npm test            # rebuilds md-condesa, then compile + node --test
npm run build       # regenerate generated files for $CLIENT (default md-condesa)
npm run deploy      # md-condesa build + wrangler deploy
npm run deploy:client <id>   # build + deploy any client (clients/<id>/wrangler.jsonc)
```

Local end-to-end run (offline; dummy creds in `.dev.vars`):

```
npx wrangler d1 execute wa-agent-db --local --file src/db/schema.sql
npx wrangler dev --local
```

`TRAINING_WHEELS=1` (the default) routes every reply through Slack approval —
keep it there until the drafts are consistently trustworthy, then flip to `0`.
