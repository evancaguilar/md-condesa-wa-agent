# Phase 0 — manual setup checklist (Evan)

This is the one-time setup you do by hand before the bot can run. It's ordered so
nothing blocks anything after it. Most of it is clicking around in dashboards.
The only terminal command you personally run is `git push` (Step 5) — everything
else is a website.

Set aside ~2 focused hours. A couple of steps (Meta business verification,
template approval) then run in the background for hours/days — that's normal.

Legend: 📋 = copy this value somewhere safe (you'll paste it into Cloudflare in
Step 6). Keep a scratch note (Apple Notes is fine) titled "WA bot secrets".

---

## Step 1 — Meta developer app + WhatsApp test number

1. Go to **developers.facebook.com** → log in with the Facebook account that
   manages the MD Condesa business.
2. Top-right **My Apps** → **Create App**.
3. "What do you want your app to do?" → choose **Other** → **Next**.
4. App type: choose **Business** → **Next**.
5. Name it `MD Condesa WA Agent`, pick your Business Portfolio, **Create app**
   (it may ask for your Facebook password).
6. In the app dashboard, find **WhatsApp** in the product list → **Set up**.
7. You're now on **WhatsApp → API Setup**. Meta gives you a **free test phone
   number** and a **temporary access token** (24h). You'll see:
   - 📋 **Phone number ID** (a long number under the test number) → this is
     `WA_PHONE_NUMBER_ID`.
   - 📋 **Temporary access token** (top of the page, "Temporary" — expires in
     24h) → this is `WA_ACCESS_TOKEN` for now. (We swap it for a permanent one
     once everything works; the temp token is fine for first tests.)
   - The test number itself is what you'll message from your own WhatsApp to
     test.
8. Left sidebar → **App settings → Basic**. Click **Show** next to **App
   secret**:
   - 📋 **App secret** → this is `META_APP_SECRET`.
9. Make up a random word/phrase (e.g. `md-condesa-verify-7431`) and save it:
   - 📋 **Verify token** → this is `WA_VERIFY_TOKEN`. (You invent this; it just
     has to match on both sides. Meta uses it during the webhook handshake.)

> We'll come back to Meta in Step 8 to point the webhook at your worker and in
> Step 9 to submit templates — but only after the worker exists.

## Step 2 — Start Meta business verification (runs in background)

1. In the app dashboard, go to **App settings → Basic** and scroll to
   **Business verification**, OR open **business.facebook.com → Settings →
   Business info → Security Center**.
2. Start **Business Verification**. Upload the requested business docs
   (registration / proof of address). This takes Meta anywhere from a few hours
   to a few days.
3. You do NOT need to wait for this to finish to test on the free test number.
   You DO need it approved before you can message real customers at scale. Start
   it now so it's ready by cutover (Step: cutover-runbook).

## Step 3 — Anthropic API key

1. Go to **console.anthropic.com** → sign in (or create the org for MD Condesa).
2. Left sidebar → **API Keys** → **Create Key**. Name it `wa-agent`.
   - 📋 **API key** (starts `sk-ant-...`) → this is `ANTHROPIC_API_KEY`. You only
     see it once — copy it now.
3. Left sidebar → **Billing / Limits** → add a payment method.
4. Suggested: set an **org spend limit of ~$100/month** and a budget alert.
   - **Important:** these are informational only for you. The bot NEVER stops
     replying because of spend — it just posts a Slack heads-up when the month
     crosses $30 and $50. Expected cost is ~$22/mo at 300 conversations. The
     $100 limit is a safety net, not an expected number.

## Step 4 — Slack app (approval console)

1. Go to **api.slack.com/apps** → **Create New App** → **From scratch**.
2. Name `MD WA Agent`, pick the MD Condesa Slack workspace → **Create App**.
3. Left sidebar → **OAuth & Permissions** → scroll to **Scopes → Bot Token
   Scopes** → **Add an OAuth Scope** three times, adding exactly:
   - `chat:write`
   - `chat:write.public`
   - `pins:write`
4. Scroll up on the same page → **Install to Workspace** → **Allow**.
   - 📋 **Bot User OAuth Token** (starts `xoxb-...`) → this is `SLACK_BOT_TOKEN`.
5. Left sidebar → **Basic Information** → **App Credentials** → **Signing
   Secret** → **Show**:
   - 📋 **Signing Secret** → this is `SLACK_SIGNING_SECRET`.
6. In Slack itself: create (or pick) the channel **#wa-leads**. Then invite the
   bot: in that channel type `/invite @MD WA Agent` and send. (The bot must be a
   member to post cards and pin the control panel.)
7. Get the channel ID: in Slack, click the channel name → scroll to the bottom of
   the **About** tab → **Channel ID** (starts `C...`).
   - 📋 **Channel ID** → this is `SLACK_CHANNEL_ID`.
8. **Interactivity** — do this AFTER Step 6 gives you a worker URL. Come back
   here: left sidebar → **Interactivity & Shortcuts** → toggle **On** →
   **Request URL** = `https://<your-worker-host>/slack/interactive` → **Save
   Changes**. (Without this, the Aprobar/Editar buttons won't do anything.)

## Step 5 — GitHub repo + first push

You already have the code locally at `~/md-condesa-wa-agent`. You just need it on
GitHub so Cloudflare can auto-deploy on every push.

1. Go to **github.com** → top-right **+** → **New repository**.
2. Name `md-condesa-wa-agent`, set **Private**, do NOT add a README/gitignore
   (the repo already has them) → **Create repository**.
3. GitHub shows a "push an existing repository" box. You can run those two lines
   in Terminal (you're comfortable with `git push`). From the project folder:
   ```
   git remote add origin https://github.com/<your-user>/md-condesa-wa-agent.git
   git branch -M main
   git push -u origin main
   ```
   If it asks you to authenticate, use your GitHub username + a Personal Access
   Token as the password (github.com → Settings → Developer settings → Personal
   access tokens → generate one with `repo` scope). No `gh` CLI needed.

## Step 6 — Cloudflare: D1 database + connect the repo

1. Go to **dash.cloudflare.com** → **Workers & Pages** → **D1 SQL Database** →
   **Create database**. Name it exactly **`wa-agent-db`** → **Create**.
2. On the database page, 📋 copy the **Database ID** (a UUID).
3. Open `wrangler.jsonc` in the repo, find the line
   `"database_id": "PASTE_D1_DATABASE_ID_HERE"` and replace the placeholder with
   the UUID you just copied. Commit + push that one-line change (`git push`).
4. Back in Cloudflare → **Workers & Pages** → **Create** → **Workers** →
   **Import a repository / Connect to Git** → pick `md-condesa-wa-agent`.
5. Cloudflare detects the Worker. Keep the defaults (build command runs
   `npm run build`, deploy runs from `wrangler.jsonc`). Deploy.
6. After the first deploy, note your **worker URL**
   (`https://md-condesa-wa-agent.<your-subdomain>.workers.dev`). This is the
   `<your-worker-host>` used in Steps 4.8 and 8.

### Step 6b — add ALL secrets + vars in Cloudflare

On the Worker → **Settings → Variables and Secrets**. Add each of these. Use the
**Encrypt / Secret** option for the secrets (the first 8); the vars can be plain.

Secrets (from your scratch note):
- `META_APP_SECRET`
- `WA_ACCESS_TOKEN`
- `WA_PHONE_NUMBER_ID`
- `WA_VERIFY_TOKEN`
- `ANTHROPIC_API_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `AIRTABLE_PAT`  (you create this in Step 7 — add it once you have it)
- `ADMIN_PASSWORD` — invent a **strong** password (this logs you into the
  `/admin` dashboard, Step 10). 📋 Save it in your scratch note. Use the
  **Encrypt / Secret** option.

Vars (plain text):
- `SLACK_CHANNEL_ID` = the `C...` id from Step 4.7
- `AIRTABLE_BASE_ID` = `appcX38TBVltyxHR6` (already the default; confirm it)
- `AIRTABLE_TRIALS_TABLE` = the exact name of your trial-class table in Airtable
  (see Step 7)
- `TRAINING_WHEELS` = `1`  (KEEP THIS AT 1 for the first 1–2 weeks — every reply
  waits for your approval in Slack. We only flip to `0` once you trust it.)
- `HUMAN_SNOOZE_HOURS` = `8`

Then apply the database schema once (Cloudflare D1 → your database → **Console**
tab → paste the contents of `src/db/schema.sql` → **Execute**). This creates the
tables. (Advanced/optional: the same can be done from a terminal with
`npx wrangler d1 execute wa-agent-db --file src/db/schema.sql --remote`.)

### Step 6c — admin-dashboard migration (run once, in the same D1 Console)

If you pasted the FULL `src/db/schema.sql` above you're already done — it includes
these tables. This block is here so you can also apply JUST the dashboard tables to
an existing database without re-running the whole schema. Everything below is
idempotent (safe to re-run; the `ALTER` errors harmlessly with "duplicate column"
if `campaign_id` already exists — ignore that one error). Paste it into the D1
**Console** and **Execute**:

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

ALTER TABLE contacts ADD COLUMN campaign_id INTEGER;
```

### Step 6c — Pack migrations (follow-ups & attribution pack)

Run these ONCE on the existing production D1, in the same **Console** → **Execute**.
Idempotent-ish: if a column already exists the `ALTER` errors harmlessly with
"duplicate column" — ignore that one error. (A fresh install from the full
`src/db/schema.sql` already includes both columns; this block is only for
migrating the live database in place.)

```sql
ALTER TABLE contacts ADD COLUMN ad_ref TEXT;
ALTER TABLE campaigns ADD COLUMN ad_id TEXT;
```

- `contacts.ad_ref` — JSON click-to-WhatsApp referral captured on first inbound
  (`{sourceId, headline, body, sourceUrl, ctwaClid}`); surfaced on Slack draft
  cards as "📣 Anuncio: …".
- `campaigns.ad_id` — Meta ad id. When a lead's referral `source_id` equals a
  campaign's `ad_id`, that campaign auto-attaches (ad-id match beats trigger phrase).

**Also enable Workers AI** for voice-note transcription (F5): the worker now
declares an `"ai": { "binding": "AI" }` binding in `wrangler.jsonc`. Workers AI is
enabled per-account in the Cloudflare dashboard (**AI** → **Workers AI**); once the
account has it, the binding deploys automatically — no extra secret. If the account
does not have Workers AI, transcription degrades gracefully (voice notes store
"[nota de voz — no se pudo transcribir]" and the bot asks the lead to write it).

**Optional Airtable field** for booking attribution: add a single-line-text field
named **`Ad`** to the Leads/Trials table. `bookTrial` writes `"headline (id)"` there
for ad-sourced trials; if the field is absent the create call drops it automatically
(unknown-field 422 → core-fields retry), so this is optional.

## Step 7 — Airtable: token, fields, students table

1. Go to **airtable.com/create/tokens** → **Create new token**.
   - Name `wa-agent`.
   - **Scopes**: add `data.records:read`, `data.records:write`,
     `schema.bases:read`.
   - **Access**: restrict to the single base **`appcX38TBVltyxHR6`** (the one the
     website trial forms already write to). Don't grant all-workspace access.
   - **Create token** → 📋 copy it → this is `AIRTABLE_PAT` (add it to Cloudflare
     secrets, Step 6b).
2. In that base, open the **trial-class table** (the one the website form fills).
   Note its exact name → that's `AIRTABLE_TRIALS_TABLE`. Add these fields if they
   don't already exist (exact names matter):
   - `Source` — single select, options `Web` and `WhatsApp`.
   - `Phone E164` — single line text.
   - `Attendance` — checkbox.
   - `Trial DateTime` — date field **with the time option turned on**.
3. Create a new table named **`Students`** with fields:
   - `Name` — single line text.
   - `Phone E164` — single line text.
   This is the roster of current students; the bot syncs it daily so it stays
   silent when a known student writes to the lead line.

## Step 8 — Point Meta's webhook at the worker

1. Back in **developers.facebook.com** → your app → **WhatsApp → Configuration**
   (or **Webhooks**).
2. **Edit** the webhook:
   - **Callback URL** = `https://<your-worker-host>/webhook/whatsapp`
   - **Verify token** = the `WA_VERIFY_TOKEN` word you invented in Step 1.9.
   - **Verify and save** — Meta calls your worker and expects the token to match.
     A green check means it worked.
3. **Manage / subscribe** to webhook fields — turn ON: `messages`,
   `smb_message_echoes`, `smb_app_state_sync`, `message_template_status_update`,
   `account_update`. (The echo + app_state fields are what make coexistence with
   your phone's WhatsApp Business app work — the bot goes quiet when you reply
   from your phone.)

## Step 9 — Fill the KB gaps, then submit the 6 templates

1. Open `clients/md-condesa/intake.md` and fill every `<!-- TODO(Evan) -->`: kids pricing,
   drop-in / visitor rate, parking, and payment methods. Save. (If you can't run
   the build yourself, just commit + push the intake file — but the compiled KB
   won't update until `npm run build` runs; ask whoever set this up to regenerate
   `kb/compiled/kb.md`, or it regenerates on the next Cloudflare deploy since
   build runs `npm run build`.)
2. **Templates.** In **developers.facebook.com → WhatsApp → Message Templates**
   (make sure you're on the **test WABA**), click **Create template** and submit
   all six from `docs/templates.md`, each in ES and EN (12 submissions total —
   the code appends `_es` / `_en` to each base name, so name them exactly
   `trial_confirm_es`, `trial_confirm_en`, etc.). Copy the body text verbatim.
   The same-day reminder needs the two quick-reply buttons; `reengage_lead` needs
   the BAJA opt-out line as a **Footer** component. Approval usually takes minutes
   to a few hours.

## Step 10 — Open the admin dashboard

Prerequisites: `ADMIN_PASSWORD` secret set (Step 6b) + the dashboard tables applied
(Step 6b full schema, or Step 6c) + the worker deployed (Step 6).

1. On your phone (or desktop) go to
   `https://<your-worker-host>/admin`.
2. Log in with the `ADMIN_PASSWORD` you invented in Step 6b. (Five wrong tries in
   15 minutes locks that device out for a bit — that's the brute-force guard.)
3. Quick smoke test:
   - **Inicio**: the big "Bot activo / ⏸ pausado" toggle should flip the same
     kill-switch as the pinned Slack control-panel card (tap it, check Slack, tap
     it back).
   - **Probar**: send a test message — it runs the real bot with NO real send,
     booking, or DB write ("SANDBOX" bookings are simulated).
   - **Campañas**: create a campaign (a phrase from an ad + info for the bot).
   - **Editor / KB**: ask the AI for a small correction, confirm the proposal, and
     confirm it shows up in **Probar**.

Add `/admin` to your phone's home screen for one-tap access.

---

## The 5 things to do FIRST (if you only have 30 minutes today)

1. **Step 1** — create the Meta app and grab the App secret, Phone number ID,
   temp token, and invent the verify token. Everything downstream needs these.
2. **Step 2** — kick off Meta business verification now, because it runs for
   hours/days in the background and would otherwise block real-customer launch.
3. **Step 3** — create the Anthropic API key (and set the ~$100 limit).
4. **Step 4** — create the Slack app, install it, invite it to #wa-leads, and
   grab the bot token + signing secret + channel ID.
5. **Step 5 + 6** — push the repo to GitHub and connect it to Cloudflare so a
   worker URL exists; you need that URL to finish the Slack interactivity (4.8)
   and Meta webhook (8) steps.

Keep `TRAINING_WHEELS=1` the whole time. Nothing the bot drafts gets sent to a
customer until you tap **Aprobar** in Slack.
