# Workstream D → E integration notes (airtable / cron / followups)

Files D owns and built:
- `src/services/airtable.ts` — REST client (bookTrial, listRecentBookings, listStudents, normalizeMxPhone, makeAirtablePort)
- `src/cron/time.ts` — pure CDMX↔UTC helpers + clampToWindow
- `src/cron/deps.ts` — local cron dependency interfaces (CronDeps, CronSlackDeps)
- `src/cron/followups.ts` — scheduleTrialSequence, computeTrialSequence, runDueFollowups, syncBookings, syncStudents
- `src/cron/budget.ts` — runBudgetReport
- `src/cron/dispatcher.ts` — runCron (filled in) + setCronDeps injector
- `docs/templates.md` — 6 templates ES+EN for Meta
- `test/cron.test.ts`, `test/cron-shims.d.ts` — unit tests + ambient shims for the test build
- `tsconfig.test.json` include array — appended D's src files (kept C's `slack-timeouts.ts` entry)

## What E MUST wire

### 1. Inject real cron deps (dispatcher.setCronDeps)
`runCron(env, ports)` keeps A's signature. The cron needs three things NOT on the
`Ports`/`SlackPort` interface, injected via `setCronDeps(...)` at startup (index.ts):

```ts
import { setCronDeps } from "./cron/dispatcher.js";
import { postNote, postAttendanceCheck } from "./services/slack.js";      // C
import { runApprovalTimeouts } from "./services/slack-timeouts.js";       // C
import { ensureControlPanel } from "./services/slack.js";                 // C

setCronDeps({
  slack: { postNote, postAttendanceCheck },
  runApprovalTimeouts,   // (env, pendingApprovals) => Promise<void>
  ensureControlPanel,    // (env) => Promise<void>
});
```

**Pending on C** — confirm the exact exported names/paths when C lands:
- `postAttendanceCheck({ phone, name, recordId })` — posts the "¿Llegó {name}?" Sí/No
  card. Its Sí/No buttons MUST write kv `attendance:<recordId>` = `'yes'|'no'` (that's
  what the `no_show_1` followup reads). **Flag this contract to C.**
- `runApprovalTimeouts(env, approvals)` — D passes the pending approvals list (from
  `getPendingApprovals(env.DB)`); C sends holding line / expires per the spec.
- `ensureControlPanel(env)` — idempotent pinned pause/resume card.

Until C's real functions are wired, the dispatcher uses safe no-op defaults
(postNote → console), so cron runs without throwing.

### 2. Wire the AirtablePort into `ports` (index.ts)
Replace `stubAirtable` with the real port:
```ts
import { makeAirtablePort } from "./services/airtable.js";   // (also re-exported from cron/dispatcher.js)
const ports: Ports = { brain, slack, airtable: makeAirtablePort(env) };
```
Note `Ports` is constructed at module scope today (no `env`). If E needs `env` to
build the port, move `ports` construction into `fetch`/`scheduled` or a lazy factory.

### 3. bookTrial must ALSO schedule the followup sequence
`airtable.bookTrial(input)` (the port) only creates the Airtable record and returns
the id — it does NOT schedule followups (kept pure; no `env.DB` in the port signature).
The `book_trial` **tool executor** (workstream B, `src/brain/tools.ts`) must, after
calling `airtable.bookTrial`, call:
```ts
import { scheduleTrialSequence } from "./cron/followups.js";
await scheduleTrialSequence(env, phone, recordId, cdmxIso(trialDate, trialTime));
```
`scheduleTrialSequence`/`cdmxIso` are exported from `src/cron/followups.ts`. This is
idempotent (UNIQUE constraint), and syncBookings re-processing WhatsApp records is a
harmless no-op. **Flag to B** — or E can add this call at the tool-executor seam.

## Schema / type change REQUESTS (E applies; D did not edit shared files)

1. **`no_show_1` scheduling has no producer yet.** The spec's sequence ends the D-owned
   part at the attendance check (T+3h → Slack card). The `no_show_followup` next-morning
   send (`kind='no_show_1'`, due 10:00 next day) should be scheduled when the attendance
   card's **"No"** button is tapped (C's handler), keyed by the same `airtable_record_id`:
   ```ts
   scheduleFollowup(env.DB, { phone, kind: "no_show_1", dueAt: <10:00 CDMX next day>, airtableRecordId: recordId });
   ```
   Same for `reengage_7d` (schedule +7d when a lead goes cold — decide the producer;
   currently unscheduled). `runDueFollowups` already handles both kinds correctly once
   they exist. **Decide owner (C button handler vs. a D-scheduled +7d row at booking time).**

2. **Optional type addition (not required):** the attendance check rides on
   `kind='custom'` + `note='attendance_check'` to avoid a blocking `FollowupKind` change.
   If you prefer a first-class member, add `"attendance_check"` to the `FollowupKind`
   union in `src/types.ts` and swap the two references in `followups.ts`
   (`computeTrialSequence` step + the `case "custom"` note check). Purely cosmetic.

3. **Attempt tracking uses the `followups.note` field** (`attempts:N` suffix). No schema
   change needed — `note TEXT` already exists. Just noting the field is now dual-purpose
   (holds `attendance_check`, custom copy, AND retry counters).

## Full-build typecheck status
`npm run typecheck` currently fails ONLY inside C's in-progress `src/services/slack.ts`
(+ `slack-timeouts.ts`) — parse errors from a mid-edit file, unrelated to D. All D
files typecheck clean and all D + pre-existing tests pass via `tsconfig.test.json`.
Re-run `npm run typecheck` after C's file compiles.

## kv keys D introduced
- `airtable_sync_cursor` — ISO timestamp, hourly booking sync watermark
- `daily_cron_mark` — `YYYY-MM-DD` (CDMX) guard so the 10:00 daily block fires once
- `budget_alert_30:<YYYY-MM>` / `budget_alert_50:<YYYY-MM>` — one-shot budget alerts
- `attendance:<recordId>` — `'yes'|'no'`, written by C's attendance card, read by `no_show_1`
