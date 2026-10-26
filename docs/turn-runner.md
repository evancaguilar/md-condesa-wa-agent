# Turn runner: running brain turns outside the webhook's 30 s `waitUntil`

Status: **built on branch `turn-runner`, ships dark** (2026-10-26). Turned on by Evan (setup steps at the end).

## The problem

Every inbound turn runs inside `ctx.waitUntil` after the webhook has already returned 200 (`src/routes/whatsapp.ts` → `processInbound`). Cloudflare gives `waitUntil` **30 s after the response**, then cancels whatever is still pending, without an error or a log line. A turn is: the gates (~1–3 s, a voice note adds Whisper), then **8 s of debounce**, then `runBrainTurn`. `runBrainTurn` is one Anthropic call, often a tool round trip (`book_trial` → Airtable), sometimes a retry. Any turn longer than about 30 s dies silently: no reply, no Aprobar card, no ops_log. Over 6 days of approval latencies (2026-10-23), the curve stops dead at 30 s.

`missed-turn-rescue` (f812c0d, unpushed) is the safety net: a cron re-runs a dead turn 4+ min later. This document is the actual fix, so turns stop dying in the first place.

## Options

| | **Durable Object per phone (alarm)** ✅ | Cloudflare Queues (`delaySeconds: 8`) | Workflows | Self-fetch / service binding |
|---|---|---|---|---|
| Time limit for the turn | Alarm: **15 min wall**, 30 s CPU | Consumer: **15 min wall**, 30 s CPU | No limit per step | **Still 30 s** (see below) |
| Free plan | Yes, SQLite-backed only: 100k req/day, 100k row writes/day, 13,000 GB-s/day | Yes: 10k ops/day; 1 message = 3 ops (~3.3k msgs/day); 24 h retention | Yes | Yes |
| Debounce | `setAlarm(due)`, exact per-message semantics | `delaySeconds: 8` on send | `step.sleep` | n/a |
| **Serializes one lead's turns** | **Yes:** alarms never overlap in one object | No (or `max_concurrency: 1`, which serializes *all* leads) | No | No |
| Setup outside the repo | **None:** binding + migration live in wrangler.jsonc and deploy with the push | Queue must be created first (dashboard / `wrangler queues create`) or the deploy fails | None | None |
| Retry hazard (double send) | Alarm retries only on throw. We never throw, and we drop the entry before the brain runs. | At-least-once delivery. Needs explicit `ack()` + `max_retries: 0`. | Steps retry by default (`retries.limit: 0` needed per step) | n/a |
| Code shape | One small class, legacy DO API (no imports) | Producer + `queue()` handler | `WorkflowEntrypoint` from `cloudflare:workers`, every step result must be serializable | n/a |

**Why self-fetch doesn't work.** A service-binding call to ourselves is a subrequest of the webhook's invocation. If the callee keeps its response open while it works, the caller's `waitUntil` (30 s) cancels it. If the callee answers right away and works in *its own* `waitUntil`, it gets a fresh 30 s window, which is the same cap. Fetching our own workers.dev URL is blocked as a loop. The best this buys is one extra 30 s window, not a fix.

**Recommendation: a Durable Object per phone.** It is the only option that also fixes the debounce race. Today the 8 s debounce is check-then-act: two messages a few seconds apart can both pass the newest-wamid check and run brain turns at the same time. That race is behind the triple replies (Axel, 2026-08-28), the duplicate confirmations (…2064, 2026-10-20) and the patches written against it (superseded-mid-brain check, `isStaleBookingRestatement`, `confirm-once`). It also needs no dashboard step and no queue to pre-create, and the free plan covers our volume many times over.

## Design

```
webhook ─ waitUntil ─ processInbound: media → dedupe → kill switch → opt-out → reto
                       → campaign → student → override → crisis → first-reply
                       → step 6: offloadTurn(env, turn) ──ok──► return
                                   │ off / error
                                   ▼
                       inline: sleep 8 s → newest? → runPendingTurn   (today's path)

TurnRunner DO (idFromName(phone))
  fetch /enqueue: pending += {wamid, dueAt: now+8 s, turn}; setAlarm(min dueAt)
  alarm(): split due/keep → store keep, re-arm → newest inbound? → runPendingTurn
```

- **Gate order is untouched.** Only step 6 (debounce → brain) moves. Everything before it still runs in the webhook's `waitUntil`, which takes a few seconds.
- `runPendingTurn` (inbound.ts) is the old step-6 tail, moved into a function: clear the override check, re-read the burst's cancel and origin markers, then `runBrainTurn`. The inline path and the DO alarm call the same function.
- `PendingTurn` = `{ msg, nowSec, justSentWelcome?, reschedule?, leadCancel?, originAnswer? }`. These are the locals processInbound carried past the debounce, all of them JSON. The media rider is dropped; the stored row already has the transcript.
- **Same debounce semantics.** Each message is due 8 s after it passed the gates, and at its due time it runs only if it is still the phone's newest inbound (`turn-queue-core.ts`, pure and unit-tested). A newer message that ended at a gate (override, opt-out…) still supersedes the older one, as it does inline.
- **Serialization.** If message B arrives while A's turn is thinking, B's alarm waits for A to finish. A's existing post-brain "superseded" check sees B and drops A's reply (booking turns excepted), then B runs with the full history. Same outcome as today, with no overlap. Cost: B's reply can start up to one turn later (~10–20 s).
- **At most once.** Due entries leave storage *before* the brain runs, and `alarm()` never rethrows; errors go to `reportInfraError` like the webhook path. A turn cut short by a deploy (deploys restart DOs) or an eviction is not re-run by the alarm retry. The missed-turn rescue cron covers it, as it does for the inline path, so **keep both**.
- **Fail-soft.** `turnRunnerEnabled(env)` = `TURN_RUNNER === "1"` and the `TURNS` binding exists. If either is missing, or the enqueue throws or returns non-2xx, the turn runs inline exactly as before. One edge: the enqueue reaches the DO but the response is lost, so both paths run. The existing duplicate guards cover that, and it is far rarer than today's race.
- `/health` gains `turnRunner: true|false`. That is the deploy probe.

### Budget (free plan)

Per inbound message: 1 DO request (enqueue) + 1 alarm, and ~4 row writes (put, setAlarm, put/delete, setAlarm). Duration: a 20 s turn at 128 MB ≈ 2.5 GB-s, so 13,000 GB-s covers ~5,000 turns/day. Row writes allow ~25k messages/day. Today's volume is in the low hundreds.

## Files

- `src/pipeline/turn-queue-core.ts`: pure queue logic (enqueue / due split / newest pick / alarm time). Tests: `test/turn-queue.test.ts`.
- `src/pipeline/turn-offload.ts`: `turnRunnerEnabled`, `offloadTurn` (the worker side, fail-soft).
- `src/pipeline/turn-runner.ts`: the `TurnRunner` DO class. It is built by `turnRunnerClass(makePorts)` so the alarm gets the same ports as a webhook. It is exported from `src/index.ts`.
- `src/pipeline/inbound.ts`: step 6 hands off, and `PendingTurn` + `runPendingTurn` are exported.
- `wrangler.jsonc`: `durable_objects` + `migrations` + the `TURN_RUNNER` var, **commented out**. `npx wrangler deploy --dry-run` was run with them uncommented too, and the bundle reports `TURNS: TurnRunner`.

The binding ships commented because a deploy that fails on the new migration would fail silently in Workers Builds and block every later push (it has happened before; see CLAUDE.md, verification protocol). Turning it on is a separate, verifiable push.

## Evan's setup steps

1. **Merge `turn-runner`** (dark: `/health` shows `turnRunner: false`, behavior unchanged). Merge or push `missed-turn-rescue` too; it stays the net for deploy-time kills.
2. **Turn it on.** In `wrangler.jsonc`, uncomment the `durable_objects` block, the `migrations` line and `,"TURN_RUNNER": "1"`, then push. Nothing to do in the dashboard: the push creates the DO namespace (SQLite-backed, free plan).
3. **Verify the deploy by behavior.** `curl -s https://md-condesa-wa-agent.evancaguilar.workers.dev/health` must show `"turnRunner":true` (and a new `rev`). If it still says false or the old rev, the build failed: check Workers → md-condesa-wa-agent → Deployments / Builds.
4. **Verify a turn.** Send a test message from your phone. Within ~10 s the Aprobar card appears as usual. In Workers → md-condesa-wa-agent → Logs, the turn now shows as an *alarm* invocation of `TurnRunner`, not inside the webhook request. Durable Objects → `TurnRunner` lists one object per phone that has written.
5. **Watch for a week.** Approval latencies past 30 s should now appear (they were cut off before), and the rescue cron's "rescued" count should drop to deploy-time stragglers only.
6. **Rollback:** set `"TURN_RUNNER": "0"` and push. Turns go back inline immediately. **Do not delete the `migrations` entry**: a migration tag that has been deployed must stay in the file.
