-- D1 schema for the MD Condesa WhatsApp agent. Idempotent.

CREATE TABLE IF NOT EXISTS contacts(
  phone TEXT PRIMARY KEY,            -- digits only, e.g. 5215512345678
  name TEXT, lang TEXT DEFAULT 'es',
  status TEXT DEFAULT 'lead',        -- lead|student|opted_out
  qualification TEXT,                -- JSON {discipline, audience:'kid'|'adult', goal, name}
  human_override_until INTEGER,      -- epoch seconds; bot silent until then
  last_inbound_at INTEGER,           -- drives 24h-window logic
  campaign_id INTEGER,               -- campaigns.id the lead arrived through (nullable)
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages(
  wamid TEXT PRIMARY KEY,            -- INSERT OR IGNORE = webhook-retry dedupe
  phone TEXT, direction TEXT,        -- in|out_bot|out_human_echo
  body TEXT, ts INTEGER, meta TEXT
);

CREATE TABLE IF NOT EXISTS pending_approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, draft TEXT, context TEXT,
  confidence TEXT, slack_ts TEXT,
  status TEXT DEFAULT 'pending',     -- pending|approved|edited|taken_over|expired|discarded
  holding_sent INTEGER DEFAULT 0,
  created_at INTEGER, resolved_at INTEGER, final_text TEXT
);

CREATE TABLE IF NOT EXISTS followups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, kind TEXT,             -- trial_confirm|day_before|same_day|attendance_check|no_show_1|reengage_7d|custom
  due_at INTEGER, status TEXT DEFAULT 'scheduled', -- scheduled|sent|cancelled|skipped_optout
  airtable_record_id TEXT, note TEXT, created_at INTEGER,
  UNIQUE(phone, kind, airtable_record_id)
);

CREATE TABLE IF NOT EXISTS outbound_wamids(wamid TEXT PRIMARY KEY, ts INTEGER);

CREATE TABLE IF NOT EXISTS edits(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, draft TEXT, final TEXT, ts INTEGER);

CREATE TABLE IF NOT EXISTS usage_log(day TEXT PRIMARY KEY, input_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0);

CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);  -- bot_enabled flag, airtable sync cursor, budget alert marks, training_wheels override, admin login rate-limit

-- ---- Admin dashboard: KB overlay, revision audit log, and campaigns ----

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
