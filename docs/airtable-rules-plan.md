# Airtable Lead-Sync + Rules Engine for the WA Agent Dashboard

## Context

Evan wants the dashboard to drive Airtable automatically with natural-language rules: "si un lead llega del anuncio 'promo matutino' → tag #promomatutino", "si es de baby → Actividad = 'Baby Fight Club'" — targeting ANY Airtable field, defined conversationally in the existing Editor chat, extensible over time. Prerequisite he approved: EVERY lead gets an Airtable row on first contact (today only bookings create rows). Full design in the Plan agent output this session; this is the executive copy.

## Confirmed decisions (Evan)

- Every new lead → Airtable Leads row (Phone E164, Name fill-if-empty, Source WhatsApp, Ad, Campaña) — Airtable becomes the full CRM.
- General rules engine, not just tags: triggers v1 = campaign | program (adults/kids/baby) | always; actions = set/add(multi-select)/clear on any field.
- Rules created via Editor chat (propose → Confirmar, like KB edits); dashboard shows list + pause/delete (Reglas section inside Campañas tab, no manual form v1).
- Editor chat gets live Airtable schema (metadata API, PAT already has schema.bases:read; 1h kv cache, ≤600-token summary) so proposals only reference real fields/options; unknown select options allowed via typecast (UI toasts "se creará la opción").

## Key design points (full detail in Plan output §1–§8)

- **airtable.ts additions**: findLeadByPhone (filterByFormula {Phone E164}), updateRecord PATCH, upsertLead (find→PATCH else POST; Name only-if-empty so manual Airtable edits never clobbered), getBaseSchema + schemaSummary, pure buildPatchFields (multi-select add = read-modify-write union, unit-tested). All reuse existing airtableFetch 429 backoff.
- **bookTrial becomes upsert-by-phone** — structurally kills duplicate rows (bot vs web-form vs lead-sync). recordId contract unchanged.
- **lead-sync.ts orchestrator**: syncLead(env, phone, event) for lead_created | campaign_matched | booking_created; hooks in pipeline/inbound.ts (waitUntil, best-effort, never blocks replies); stores contacts.airtable_lead_id; evaluates rules → one combined PATCH; applied-once per rule+lead (kv rule_applied:<id>:<phone>). Gated on CLIENT.features.airtableSync.
- **Fix found during design**: setQualification exists but has ZERO callers — wire it in routeResult's book branch so classifyProgram has real data (program rules fire on booking or /baby/i campaign match; mid-chat program detection deferred).
- **Rules storage**: new D1 table airtable_rules (trigger_json, actions_json, enabled, last_error) + contacts.airtable_lead_id column. Pure evaluator module airtable-rules.ts (parseRule, ruleMatches, ruleSummaryEs — shared by chat card + dashboard).
- **kb-editor.ts**: new tool propose_airtable_rule; Proposal union + applyProposal validation (field exists, add only on multipleSelects, campaign exists; fail reasons unknown_field/bad_trigger/bad_action → mapped HTTP statuses); block 2 gains schema summary + current rules. UI: proposal card "SI <trigger> ENTONCES <acciones>" + fix proposalTypeLabel ordering bug.
- **Failure policy**: everything best-effort; schema drift surfaces as amber last_error chip on the rule + max-one-per-day Slack note (pattern cloned from tmpl_missing_note).

## Migration (Evan pastes in D1 console BEFORE deploy)

```sql
CREATE TABLE IF NOT EXISTS airtable_rules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE contacts ADD COLUMN airtable_lead_id TEXT;
```
(Also mirrored into schema.sql for fresh installs.) Plus: confirm AIRTABLE_PAT is set as a secret (it's the one we skipped!) with scopes data.records:read/write + schema.bases:read, and the Leads table has a multi-select **Tags** field.

## Build (sequential Opus agents)

- **WS-1 Backend**: airtable.ts §1, lead-sync.ts, airtable-rules.ts, types.ts, queries additions, inbound.ts hooks + setQualification wiring, schema.sql, /admin/api/rules routes, unit tests.
- **WS-2 Editor + UI** (after WS-1): kb-editor.ts tool/validation/block2, admin.html Reglas section + proposal card + proposalTypeLabel fix, tests.
- Respect the in-flight multi-client refactor (CLIENT config generated — never hand-edit client.gen.ts; gate on features.airtableSync).

## Verification

- Unit: buildPatchFields (set/add-union/dedupe/clear), ruleMatches per trigger, parseRule bad JSON, schemaSummary token cap, applyAirtableRule validation matrix, upsert fill-if-empty. All 164 existing tests stay green; typecheck/build/dry-run pass.
- Manual on test number: Editor chat → create tag rule → message with campaign trigger → ONE Leads row with Tags containing the tag; second message → still one row; book "para mi bebé" with a program rule → Actividad set; pause rule → no tag on next lead; rename field in Airtable → Slack note + warning chip.

## Risks

Schema drift (surfaced via last_error + daily note; 1h schema cache self-heals proposals), duplicate rows (killed by upsert-by-phone), rate limits (≤3 calls/event at 10-30 leads/day vs 5 rps), Editor token growth (schema block hard-capped).
