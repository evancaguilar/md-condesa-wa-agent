# New-client onboarding — runbook

One engine, one folder per client. Each client is its **own** Cloudflare Worker +
D1 database + WhatsApp number + Slack channel + Anthropic key, configured
entirely from `clients/<id>/`. Nothing in `src/` changes per client.

Time budget once you've done it twice: **~1 hour of your work** + Meta's
verification wait. The slow parts (Meta business verification, template
approval) run in the background — start them first.

---

## 0. What you need from the client (one call / one form)

1. **Business facts** → `intake.md`: services, prices, schedule, address,
   links, FAQs, policies. (This is the bot's ONLY source of truth.)
2. **Voice** → `persona.md`: how they talk, 3–5 real example replies, what the
   bot must NEVER do, which cases always go to a human.
3. **Access / assets**: a WhatsApp number that is NOT tied to a personal
   account (or a new one), their Meta Business Manager (or create one), a logo,
   and who reviews drafts (their Slack or yours).
4. **Feature decisions** (map to `client.mjs > features`):
   - Does the bot book appointments? (`booking` — needs slots + Airtable)
   - Cold-lead re-engagement drip? (`nudges`)
   - Airtable pipeline sync? (`airtableSync`)
   - Emotionally sensitive conversations? (`safety` — **mandatory** for
     therapy/coaching/companion products; see `clients/iasmin/`)

## 1. Scaffold the client folder

```bash
node tools/new-client.mjs <client-id>        # e.g. acme-dental
```

Fill in, in this order:

1. `clients/<id>/client.mjs` — names, links, features, copy. If `safety: true`,
   fill the `safety` block (patterns + containment message with REAL local
   crisis lines + `pauseHours`).
2. `clients/<id>/persona.md` — the system-prompt voice. Iterate here the most;
   short + concrete beats long + abstract. Keep the trailing
   "# BASE DE CONOCIMIENTO" section — the KB is appended right after it.
3. `clients/<id>/intake.md` — the knowledge base (~6000-token hard cap).
4. (Only if the client needs a computed KB — scraped site, schedule flattening,
   booking slots): add `clients/<id>/kb-build.mjs` exporting
   `buildKb({ intake, cfg }) → { body, slots, sources }`.
   See `clients/md-condesa/kb-build.mjs`.

Validate continuously:

```bash
CLIENT=<id> npm run build     # compiles KB + config; fails over token cap
CLIENT=<id> npm run chat      # talk to the bot locally (needs ANTHROPIC_API_KEY)
```

## 2. Voice test (gate — do NOT skip)

Before any infra: the owner asks the bot 10 real questions their customers ask
(via `npm run chat` or the dashboard sandbox after deploy) and scores each
reply with one question: **"Would I say this, exactly like this?"**
8/10 = ready. Below that → iterate `persona.md` / `intake.md`, not code.

## 3. Infrastructure (per client)

Follow **docs/phase0-checklist.md** — it's click-by-click; everything applies
per-client. Summary of what gets created:

| Piece | Per client | Notes |
|---|---|---|
| Meta app + WABA + number | ✅ | Start business verification FIRST (slowest) |
| Cloudflare Worker | ✅ | `clients/<id>/wrangler.jsonc` (name = `<id>-wa-agent`) |
| D1 database | ✅ | `npx wrangler d1 create <id>-wa-agent-db` → paste id into wrangler.jsonc → run `src/db/schema.sql` against it |
| Secrets | ✅ | `wrangler secret put <NAME> --config clients/<id>/wrangler.jsonc` for each: META_APP_SECRET, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN, ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, AIRTABLE_PAT (dummy if unused), ADMIN_PASSWORD |
| Slack channel + app | ✅ channel (app reusable) | Set SLACK_CHANNEL_ID in wrangler.jsonc vars |
| Anthropic API key | ✅ (separate key = per-client cost visibility) | |
| Airtable base | only if `booking`/`airtableSync` | |
| WhatsApp templates | only if `booking` | docs/templates.md, submit early |

## 4. Deploy + wire the webhook

```bash
npm run deploy:client <id>
```

(The script refuses to deploy while `REPLACE_WITH_*` placeholders remain.)
Then point the Meta webhook at `https://<worker-url>/webhook/whatsapp`
(phase0-checklist step 8) and open `/admin` to confirm the dashboard.

## 5. Pilot protocol

1. `TRAINING_WHEELS=1` (template default): every reply goes through Slack
   approval. Keep it until drafts are consistently right, then flip to `0`
   (auto-send high-confidence only) in wrangler.jsonc vars + redeploy.
2. First users: a small allowlisted pilot group, not the public number.
3. Review the Slack channel daily the first two weeks; feed corrections into
   the dashboard KB overlay (no redeploy needed) or `intake.md` (rebuild).
4. For `safety: true` clients: send test crisis phrases from a test number and
   verify the containment message + 🚨 Slack escalation + 24h pause fire.

## Rules of the road

- Committed generated files (`src/client.gen.ts`, `kb/compiled/*`,
  `src/brain/slots.gen.ts`) always reflect **md-condesa** (the default build).
  `npm test` and `npm run deploy` enforce this; if you built another client,
  run `npm run build` before committing.
- Engine changes (`src/`) affect ALL clients — run `npm test` plus a
  `CLIENT=<id> npm run build && npm run typecheck` for any client with unusual
  config (e.g. `services: []`) before deploying them.
- Per-client business changes never touch `src/` — if you find yourself editing
  engine code for one client, stop and move it into `ClientConfig`.
