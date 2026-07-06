// Single */5 cron entry point. Workstream D fills this in; kept as a no-op so
// scheduled() wires and typechecks today.

import type { Env, Ports } from "../types.js";

export async function runCron(_env: Env, _ports: Ports): Promise<void> {
  // TODO(D): due followups (queries.dueFollowups → wa.sendTemplate/sendText)
  // TODO(D): approval timeouts (holding line + expiry; calls C's card helpers)
  // TODO(D): hourly Airtable booking sync (filterByFormula on LAST_MODIFIED_TIME)
  // TODO(D): daily 10:00 CDMX student sync → contacts.status='student'
  // TODO(D): daily budget report (usage_log month-to-date → Slack at $30 / $50)
}
