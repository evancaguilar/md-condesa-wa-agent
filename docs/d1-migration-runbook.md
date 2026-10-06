# D1 migration runbook: move wa-agent-db to a fresh database

> Written 2026-10-06 during the D1 "overloaded" incident. Plan B if Cloudflare support is slow: the
> database's backing process is sick (SELECT 1 = 0.3 ms of work, 6 s of queueing; total load ≈ 2.6 s
> of DB time per hour), a fresh database is a fresh process. Data is ~25 MB, 13 tables.
>
> Do it in quiet hours (21:30–08:00 CDMX): leads are rare, the cron is mostly idle. Total ≈ 15 min.
> Everything runs on Evan's Mac inside `~/md-condesa-wa-agent`.

## 0. Log the CLI into the RIGHT account (one-time)

The local wrangler has always been logged into the fighterwebsites account (CLAUDE.md §3), which is why
`wrangler tail` / `d1 execute` fail with "not found".

```bash
npx wrangler logout
npx wrangler login          # browser opens: pick the account that owns md-condesa-wa-agent (evancaguilar@gmail.com)
npx wrangler whoami         # must list that account
npx wrangler d1 list        # must show wa-agent-db  c57b17de-9e0c-4a48-adc7-7cb791372cdc
```

## 1. Export the current database (full: schema + data)

```bash
npx wrangler d1 export wa-agent-db --remote --output=/tmp/wa-agent-full.sql
ls -la /tmp/wa-agent-full.sql          # expect ~25 MB
grep -c '^INSERT' /tmp/wa-agent-full.sql
```

If the export itself fails with "overloaded", retry; it reads in one pass and usually gets through. Note
the time of the successful export — the delta step below covers everything written after it.

## 2. Create the new database and import

```bash
npx wrangler d1 create wa-agent-db-2
# → prints the new database_id. Copy it.
npx wrangler d1 execute wa-agent-db-2 --remote --file=/tmp/wa-agent-full.sql
```

Sanity checks (compare the counts with the old DB in the dashboard Console or with the same commands
against `wa-agent-db`):

```bash
npx wrangler d1 execute wa-agent-db-2 --remote --command "SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM contacts) AS contacts, (SELECT COUNT(*) FROM pending_approvals) AS approvals, (SELECT COUNT(*) FROM followups) AS followups, (SELECT COUNT(*) FROM kv) AS kv"
```

## 3. Indexes (idempotent, run even if the export carried them)

The worker's own index migration is kv-guarded (`migr_idx_2026_09_17` is in the exported kv table), so
it will NOT recreate them on the new database. Run them by hand:

```bash
npx wrangler d1 execute wa-agent-db-2 --remote --command "
CREATE INDEX IF NOT EXISTS idx_messages_phone_ts ON messages(phone, ts);
CREATE INDEX IF NOT EXISTS idx_messages_direction_ts ON messages(direction, ts);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_phone ON pending_approvals(phone);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_created ON pending_approvals(created_at);
CREATE INDEX IF NOT EXISTS idx_followups_status_due ON followups(status, due_at);
CREATE INDEX IF NOT EXISTS idx_followups_kind_status_due ON followups(kind, status, due_at);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at);
SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name;"
```

Expect the 8 `idx_*` names back. The inbox query uses `INDEXED BY` on two of them and would error without.

## 4. Switch the worker

In `wrangler.jsonc`, `d1_databases[0]`:

- `database_name`: `wa-agent-db-2`
- `database_id`: the new id from step 2

```bash
npm run typecheck && npx wrangler deploy --dry-run
git commit -am "D1: switch to wa-agent-db-2 (fresh database, 2026-10-06 incident)"
git push                 # = deploy via Workers Builds (~1 min)
curl -s https://md-condesa-wa-agent.evancaguilar.workers.dev/health
```

`/health` must show `dbOk:true` and the new `rev`. Open the dashboard: Chats should load instantly.

## 5. Delta: everything written to the OLD database between step 1 and step 4

```bash
npx wrangler d1 export wa-agent-db --remote --no-schema --output=/tmp/wa-agent-delta.sql
sed -i '' 's/^INSERT INTO/INSERT OR IGNORE INTO/' /tmp/wa-agent-delta.sql      # macOS sed
npx wrangler d1 execute wa-agent-db-2 --remote --file=/tmp/wa-agent-delta.sql
```

Why this is safe: the export carries every row with its primary key (`messages.wamid`, `contacts.phone`,
`pending_approvals.id`, `followups.id`, `kv.key`, …), so `INSERT OR IGNORE` adds only the rows the new
database does not have yet and never duplicates. Rows UPDATED in the old DB during the window (a contact's
`read_at`, an approval resolved from the old DB) are not carried over; that window is minutes long at night
and nothing in it is a lead's message.

## 6. Afterwards

- Keep `wa-agent-db` for a week (Time Travel history), then delete it in the dashboard.
- Tell Cloudflare support on the ticket that the database was migrated and whether the symptoms stopped.
- Update docs/STATUS.md.

## Rollback

Put the old `database_name` / `database_id` back in `wrangler.jsonc` and push. Rows written to the new
database meanwhile can be moved back with the same delta recipe in the other direction.
