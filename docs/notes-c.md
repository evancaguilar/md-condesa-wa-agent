# Workstream C (Slack approval layer) — integration notes for E

Files owned/created by C:
- `src/services/slack.ts` — Web API client, Block Kit builders, `SlackPort`, control panel, card-update helpers, `runApprovalTimeouts`.
- `src/services/slack-timeouts.ts` — **pure** helpers (no Env/Workers types): signature verify, payload parse, business-hours + timeout decision logic. Unit-testable under `node --test`.
- `src/routes/slack.ts` — POST `/slack/interactive` handler.
- `test/slack.test.ts` — unit tests (18 cases).

## Wiring E must apply

### 1. `src/index.ts` — replace the bare-200 Slack placeholder
```ts
import { handleSlackInteractive } from "./routes/slack.js";
import { makeSlackPort } from "./services/slack.js";

// ports.slack should be the real port, not stubSlack:
const ports: Ports = { brain: ..., slack: makeSlackPort(env), airtable: ... };
// NOTE: makeSlackPort needs `env`, so build `ports` inside fetch()/scheduled()
// (env isn't available at module scope). Alternatively keep a small factory.

if (pathname === "/slack/interactive" && req.method === "POST") {
  return handleSlackInteractive(req, env, ctx);
}
```
`makeSlackPort(env)` returns `{ postDraft, postNote }` implementing `SlackPort`.
Because `env` is only available inside handlers, either construct `ports` per-request
or change the pipeline to accept a `SlackPort` built from env. (C left `stubs.ts`/`index.ts`
untouched per ownership rules.)

### 2. Control panel bootstrap (optional, recommended)
Call `ensureControlPanel(env)` from `src/index.ts` startup path or the cron
(D's dispatcher) so the pinned "🤖 Bot MD Condesa" card exists. Idempotent
(stores ts in kv key `control_panel_ts`).

## Exports for other workstreams

### For D (cron/dispatcher) — import from `src/services/slack.js`:
- `runApprovalTimeouts(env, queries?, deps?)` — spec §Slack timeouts. Defaults
  wire the real `queries`/`sendText`; pass overrides only for tests. **This is the
  function the cron dispatcher must call** (spec's `AirtablePort.runApprovalTimeouts`
  contract). Import path: `../services/slack.js`.
- `postAttendanceCheck(env, name, phone, recordId): Promise<string>` — "¿Llegó {name}?"
  card with `attended_yes|<recordId>` / `attended_no|<recordId>` buttons. D's T+3h
  cron posts this.
- `postBookingFyi(env, booking: BookTrialInput)` — FYI card when `book_trial` fires.
- `ensureControlPanel(env)` / `updateControlPanel(env)`.
- `postHoldingPing(env, approvalId)` — used internally by `runApprovalTimeouts`; also exported.

### Attendance → cron handshake (D must read this)
When Evan taps the attendance buttons, C's route writes a kv note:
`kv[attendance:<recordId>] = "yes" | "no"`.
D's no-show cron reads `kvGet(db, "attendance:" + recordId)`:
- `"no"`  ⇒ schedule/send `no_show_followup` next morning 10:00.
- `"yes"` ⇒ no no-show followup.
- `null`  ⇒ not answered yet; leave pending.

## Slack app config (E must document in phase0-checklist)
- App name: "MD WA Agent".
- Bot token scopes: `chat:write`, `chat:write.public`, `pins:write`.
- Interactivity: **enabled**, Request URL = `https://<worker-host>/slack/interactive`.
- Secrets already in `types.ts`/wrangler: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID` (var).
- The bot must be **invited to `#wa-leads`** (SLACK_CHANNEL_ID) for postMessage + pins.add.

## WhatsApp template dependency
- The window-closed / expired paths offer a `send_template|<id>` button that calls
  `wa.sendTemplate(env, phone, "human_followup", lang)`. Template name `human_followup`
  (ES + EN) must exist and be approved (already in spec §WhatsApp specifics).

## KNOWN TEST-BUILD CONFLICT (E to reconcile)
`tsconfig.test.json` is shared. C added `src/services/slack-timeouts.ts` to `include`.
D concurrently added `src/cron/time.ts`, `src/cron/followups.ts`, `src/cron/budget.ts`,
`src/services/airtable.ts`. `airtable.ts` (via `queries.ts`/`types.ts`/`wa.ts`) references
Workers globals (`D1Database`, `fetch`, `URL`, `console`, `RequestInit`) which are absent
under the test config's `types: []` — so the **combined** `npm test` build currently fails
on D's files, not C's.

C's files are verified independently:
- `npm run typecheck` (full worker build, all files) → **passes**.
- `test/slack.test.ts` + `src/services/slack-timeouts.ts` compiled+run in isolation
  (`types: []`) → **18 tests pass** (part of the 29 total when the build succeeds).

Fix options for E: (a) exclude Env-dependent modules from the test include and keep only
pure modules there, or (b) add a Workers-types ambient shim for the test build. C only
requires `src/services/slack-timeouts.ts` in the test include.

C did **not** stage `tsconfig.test.json` (it now carries D's edits too). E should ensure
the final include contains `src/services/slack-timeouts.ts`.
