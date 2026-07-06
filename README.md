# MD Condesa WhatsApp AI agent

An in-house WhatsApp agent for **MD Self Defense Academy Condesa** that replaces
ManyChat on the academy's number. It answers lead inquiries bilingually (ES-MX /
EN) from a compiled knowledge base, qualifies leads and books trial classes into
Airtable, runs anti-no-show + re-engagement sequences, and escalates to a human
via a Slack approval flow. It runs as a single Cloudflare Worker (D1 for state,
a `*/5` cron for followups) with zero runtime npm dependencies — raw `fetch` to
Meta Graph, Anthropic, Slack, and Airtable. Coexistence-aware: the bot goes quiet
when Evan replies from the WhatsApp Business app, and has a Slack kill switch.

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
npm test            # compile + node --test (parser, brain, cron, slack, verify)
npm run build       # regenerate kb/compiled/kb.md from kb/intake.md + the site
npm run deploy      # build + wrangler deploy (usually Cloudflare does this on push)
```

Local end-to-end run (offline; dummy creds in `.dev.vars`):

```
npx wrangler d1 execute wa-agent-db --local --file src/db/schema.sql
npx wrangler dev --local
```

`TRAINING_WHEELS=1` (the default) routes every reply through Slack approval —
keep it there until the drafts are consistently trustworthy, then flip to `0`.
