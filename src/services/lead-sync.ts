// Lead-sync orchestrator: every synced lead gets an Airtable Leads row (upsert
// by phone), and enabled rules are evaluated → one combined PATCH. Best-effort,
// gated on CLIENT.features.airtableSync, fully try/caught: it must NEVER block
// the reply path (pipeline calls it via ctx.waitUntil / an isolated try). See
// docs/airtable-rules-plan.md.

import type { AirtableRule, Contact, Env, RuleAction } from "../types.js";
import { CLIENT } from "../client.gen.js";
import { getContact, kvGet, kvSet, setContactAirtableLeadId } from "../db/queries.js";
import { getCampaign, listAirtableRules, setRuleLastError } from "../db/queries-admin.js";
import {
  AirtableWriteError,
  buildLeadFields,
  buildPatchFields,
  extractUnknownFieldName,
  findLeadByPhone,
  leadsMap,
  updateRecord,
  upsertLead,
} from "./airtable.js";
import { parseRule, ruleMatches } from "./airtable-rules.js";
import { classifyProgram } from "../cron/nudge-copy.js";
import { postNote } from "./slack.js";
import { cdmxDateStr } from "../cron/time.js";

/** What triggered a sync — only used for logging/Slack context. */
export type SyncEvent = "lead_created" | "campaign_matched" | "booking_created" | "opted_out";

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Local copy of the brain's ad-label formatter (brain/claude.ts is read-only):
 * "headline (id)" from a contact's ad_ref JSON, or null. Tolerant of bad JSON.
 */
function adLabelFromRef(adRef: string | null): string | null {
  if (!adRef) return null;
  try {
    const r = JSON.parse(adRef) as { headline?: string | null; sourceId?: string | null };
    const headline = (r.headline ?? "").trim();
    const id = (r.sourceId ?? "").trim();
    if (headline && id) return `${headline} (${id})`;
    if (headline) return headline;
    if (id) return id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Sync a lead to Airtable and apply matching rules. Gated + fully swallowed:
 * any failure surfaces as a throttled daily Slack note, never an exception.
 */
export async function syncLead(env: Env, phone: string, event: SyncEvent): Promise<void> {
  if (!CLIENT.features.airtableSync) return;
  try {
    const contact = await getContact(env.DB, phone);
    if (!contact) return;

    let campaignName: string | null = null;
    if (contact.campaign_id !== null) {
      const c = await getCampaign(env.DB, contact.campaign_id);
      if (c) campaignName = c.name;
    }
    const ad = adLabelFromRef(contact.ad_ref);

    // One find: used for fill-if-empty of base fields AND to skip upsertLead's
    // own lookup. upsertLead returns the authoritative post-write fields.
    const current = await findLeadByPhone(env, phone);
    const baseFields = buildLeadFields(current?.fields ?? null, {
      phone,
      name: contact.name,
      campaignName,
      ad,
    });
    const res = await upsertLead(env, phone, baseFields, baseFields, current);
    if (contact.airtable_lead_id !== res.id) {
      await setContactAirtableLeadId(env.DB, phone, res.id);
    }

    await applyRules(env, phone, contact, campaignName, res.id, res.fields);
  } catch (err) {
    await noteSyncFailure(env, phone, event, err);
  }
}

/**
 * Adds the opt-out tag to the lead's Tags multi-select. Best-effort + gated
 * like syncLead; no row yet (opt-out on the lead's very first message) is a
 * silent no-op — there's nothing to tag.
 */
export async function flagOptOutInAirtable(env: Env, phone: string): Promise<void> {
  if (!CLIENT.features.airtableSync) return;
  try {
    const current = await findLeadByPhone(env, phone);
    if (!current) return;
    const map = leadsMap();
    const patch = buildPatchFields(current.fields, [
      { op: "add", field: map.tags, value: map.optOutTag },
    ]);
    await updateRecord(env, env.AIRTABLE_TRIALS_TABLE, current.id, patch);
  } catch (err) {
    await noteSyncFailure(env, phone, "opted_out", err);
  }
}

interface MatchedRule {
  rule: AirtableRule;
  actions: RuleAction[];
  mark: string; // kv rule_applied:<id>:<phone>
}

/**
 * Evaluate enabled rules against this lead, apply the union of their actions in
 * ONE combined PATCH, and record per-rule outcomes: applied-once kv marks on
 * success (clearing any stale last_error), amber last_error on schema drift.
 */
async function applyRules(
  env: Env,
  phone: string,
  contact: Contact,
  campaignName: string | null,
  recordId: string,
  currentFields: Record<string, unknown>,
): Promise<void> {
  const rules = await listAirtableRules(env.DB, { enabledOnly: true });
  if (rules.length === 0) return;

  const program = classifyProgram(contact, campaignName);
  const matched: MatchedRule[] = [];
  for (const rule of rules) {
    const parsed = parseRule(rule.trigger_json, rule.actions_json);
    if (!parsed) continue;
    if (!ruleMatches(parsed.trigger, { campaignId: contact.campaign_id, program })) continue;
    const mark = `rule_applied:${rule.id}:${phone}`;
    if (await kvGet(env.DB, mark)) continue; // applied-once per rule+lead
    matched.push({ rule, actions: parsed.actions, mark });
  }
  if (matched.length === 0) return;

  const allActions = matched.flatMap((m) => m.actions);
  let patch = buildPatchFields(currentFields, allActions);

  // One combined PATCH, with schema-drift tolerance: drop unknown fields and
  // retry, tracking which fields failed so we can attribute last_error per rule.
  const failedFields = new Set<string>();
  for (let i = 0; i < 5 && Object.keys(patch).length > 0; i++) {
    try {
      await updateRecord(env, env.AIRTABLE_TRIALS_TABLE, recordId, patch);
      break;
    } catch (e) {
      if (e instanceof AirtableWriteError && e.unknownField) {
        const bad = extractUnknownFieldName(e.message);
        if (bad && bad in patch) {
          failedFields.add(bad);
          delete patch[bad];
          continue;
        }
      }
      throw e; // non-recoverable → outer catch → daily Slack note
    }
  }

  for (const m of matched) {
    const badForRule = m.actions
      .map((a) => a.field)
      .filter((f) => failedFields.has(f));
    if (badForRule.length > 0) {
      await setRuleLastError(
        env.DB,
        m.rule.id,
        `Campo inexistente en Airtable: ${[...new Set(badForRule)].join(", ")}`,
      );
    } else {
      await kvSet(env.DB, m.mark, "1");
      if (m.rule.last_error) await setRuleLastError(env.DB, m.rule.id, null);
    }
  }
}

/** At most one Slack note per CDMX day about sync failures (schema drift etc.). */
async function noteSyncFailure(
  env: Env,
  phone: string,
  event: SyncEvent,
  err: unknown,
): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[lead-sync] ${event} failed for ${phone}: ${detail}`);
  const dayKey = `airtable_sync_note:${cdmxDateStr(nowSec())}`;
  if (await kvGet(env.DB, dayKey)) return;
  await kvSet(env.DB, dayKey, "1");
  await postNote(
    env,
    `Sync a Airtable falló hoy (${event}, ${phone}): ${detail}. Puede ser un cambio de esquema en la tabla de Leads; revisa los campos.`,
  );
}
