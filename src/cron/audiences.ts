// Daily customer-list audience sync (docs/meta-audiences.md).
//
// Read Alumnos once, split into PAID / ACTIVE, hash, diff against the previous
// upload (kv snapshot of hashes), push adds + removes, store the new snapshot.
// A diff — not a full replace — so a lapsed member leaves the ACTIVE audience
// the next day, and a quiet day costs zero Graph writes.
//
// Budget: ≤3 Airtable pages + 1 audience list + ≤2 creates + a few /users
// calls. Runs inside the 10:00 CDMX daily block; the owner route runs the same
// function on demand (and as a dry run that touches nothing).

import type { Env } from "../types.js";
import { CLIENT } from "../client.gen.js";
import { kvGet, kvSet } from "../db/queries.js";
import { cdmxDateStr } from "./time.js";
import { listRecords, metricsMap, MetricsSchemaError } from "../services/metrics-airtable.js";
import {
  audienceToken,
  createCustomAudience,
  diffMembers,
  hashMembers,
  listCustomAudiences,
  selectActiveStudents,
  selectPaidStudents,
  sendAudienceUsers,
  type AudienceMember,
  type FetchLike,
  type StudentColumns,
} from "../services/meta-audiences.js";

export const KV_AUD_LAST_OK = "meta_aud_last_ok";
export const KV_AUD_LAST_ERROR = "meta_aud_last_error";
/** `meta_aud:<slug>` → audience id; `meta_aud_members:<slug>` → JSON string[] of row hashes. */
export const KV_AUD_ID_PREFIX = "meta_aud:";
export const KV_AUD_MEMBERS_PREFIX = "meta_aud_members:";
const KV_NOTE_PREFIX = "meta_aud_note:";

export type AudienceSlug = "paid" | "active";

export interface AudienceSyncOne {
  slug: AudienceSlug;
  name: string;
  audienceId: string | null;
  created: boolean;
  members: number;
  rows: number;
  adds: number;
  removes: number;
  invalid: number;
  error: string | null;
}

export interface AudienceSyncResult {
  skipped: "feature_off" | "no_token" | "no_account" | "map_incomplete" | null;
  dryRun: boolean;
  students: number;
  audiences: AudienceSyncOne[];
  error: string | null;
}

export interface AudienceSyncConfig {
  enabled: boolean;
  reason: AudienceSyncResult["skipped"];
  token: string | null;
  accountId: string | null;
  columns: StudentColumns | null;
  names: { paid: string; active: string } | null;
}

/** Resolve everything the sync needs; `reason` names the first thing missing. */
export function audienceConfig(env: Env): AudienceSyncConfig {
  const token = audienceToken(env);
  const accountId = (env.META_AD_ACCOUNT_ID ?? "").trim() || null;
  const s = metricsMap().students;
  const columns: StudentColumns | null =
    s.email && s.status && s.activeFlag
      ? {
          phone: s.phone,
          email: s.email,
          totalPaid: s.totalPaid,
          status: s.status,
          activeFlag: s.activeFlag,
          excludedStatuses: s.excludedStatuses ?? [],
        }
      : null;
  const names = CLIENT.metaAudiences ?? null;
  const reason: AudienceSyncResult["skipped"] =
    CLIENT.features.metaAudiences !== true
      ? "feature_off"
      : !token
        ? "no_token"
        : !accountId
          ? "no_account"
          : !columns || !names
            ? "map_incomplete"
            : null;
  return { enabled: reason === null, reason, token, accountId, columns, names };
}

export interface AudienceSyncOpts {
  /** Compute everything, touch nothing (no Graph calls, no kv writes). */
  dryRun?: boolean;
  /** Bypass the feature flag (the owner route's "run once now"). */
  force?: boolean;
  doFetch?: FetchLike;
  list?: typeof listRecords;
}

export async function runAudienceSync(
  env: Env,
  nowSec: number,
  deps: { postNote: (text: string) => Promise<void> },
  opts: AudienceSyncOpts = {},
): Promise<AudienceSyncResult> {
  const cfg = audienceConfig(env);
  const out: AudienceSyncResult = {
    skipped: null,
    dryRun: opts.dryRun === true,
    students: 0,
    audiences: [],
    error: null,
  };
  const blocked = cfg.reason === "feature_off" && opts.force ? null : cfg.reason;
  if (blocked || !cfg.token || !cfg.accountId || !cfg.columns || !cfg.names) {
    return { ...out, skipped: blocked ?? "map_incomplete" };
  }
  const { token, accountId, columns, names } = cfg;
  const doFetch = opts.doFetch ?? ((u, i) => fetch(u, i));
  const list = opts.list ?? listRecords;
  const m = metricsMap();

  try {
    // One walk of Alumnos, narrowed to rows that can belong to either audience.
    const rows = await list(env, m.tables.students, {
      filterByFormula: `OR({${columns.totalPaid}} > 0, {${columns.activeFlag}} = 1)`,
      fields: [
        columns.phone,
        columns.email,
        columns.totalPaid,
        columns.status,
        columns.activeFlag,
      ],
    });
    out.students = rows.length;

    const targets: { slug: AudienceSlug; name: string; members: AudienceMember[] }[] = [
      { slug: "paid", name: names.paid, members: selectPaidStudents(rows, columns) },
      { slug: "active", name: names.active, members: selectActiveStudents(rows, columns) },
    ];

    // Audience ids: kv cache → account listing by name → create.
    let listing: { id: string; name: string }[] | null = null;
    for (const t of targets) {
      const one: AudienceSyncOne = {
        slug: t.slug,
        name: t.name,
        audienceId: null,
        created: false,
        members: t.members.length,
        rows: 0,
        adds: 0,
        removes: 0,
        invalid: 0,
        error: null,
      };
      out.audiences.push(one);

      const next = await hashMembers(t.members);
      one.rows = next.length;
      const prevRaw = await kvGet(env.DB, `${KV_AUD_MEMBERS_PREFIX}${t.slug}`);
      const prev = parseSnapshot(prevRaw);
      const diff = diffMembers(prev, next);
      one.adds = diff.adds.length;
      one.removes = diff.removes.length;
      one.audienceId = await kvGet(env.DB, `${KV_AUD_ID_PREFIX}${t.slug}`);
      if (out.dryRun) continue;

      if (!one.audienceId) {
        if (listing === null) {
          const l = await listCustomAudiences(token, accountId, doFetch);
          if (!l.ok) {
            one.error = l.error;
            continue;
          }
          listing = l.data ?? [];
        }
        const found = listing.find((a) => a.name === t.name);
        if (found) {
          one.audienceId = found.id;
        } else {
          const c = await createCustomAudience(
            token,
            accountId,
            t.name,
            "Sincronizada diariamente desde Airtable por el agente de WhatsApp.",
            doFetch,
          );
          if (!c.ok || !c.data) {
            one.error = c.error;
            continue;
          }
          one.audienceId = c.data.id;
          one.created = true;
        }
        await kvSet(env.DB, `${KV_AUD_ID_PREFIX}${t.slug}`, one.audienceId);
      }

      if (diff.adds.length > 0) {
        const r = await sendAudienceUsers(token, one.audienceId, "add", diff.adds, doFetch);
        one.invalid += r.invalid;
        if (!r.ok) {
          one.error = r.error;
          continue;
        }
      }
      if (diff.removes.length > 0) {
        const r = await sendAudienceUsers(token, one.audienceId, "remove", diff.removes, doFetch);
        if (!r.ok) {
          one.error = r.error;
          continue;
        }
      }
      // Both writes landed: this is now what Meta holds.
      await kvSet(env.DB, `${KV_AUD_MEMBERS_PREFIX}${t.slug}`, JSON.stringify(next));
    }

    const failed = out.audiences.filter((a) => a.error);
    const stamp = new Date(nowSec * 1000).toISOString();
    if (!out.dryRun) {
      if (failed.length === 0) {
        await kvSet(
          env.DB,
          KV_AUD_LAST_OK,
          `${stamp} ${out.audiences.map((a) => `${a.slug}=${a.rows}(+${a.adds}/-${a.removes})`).join(" ")}`,
        );
      } else {
        out.error = failed.map((a) => `${a.slug}: ${a.error}`).join("; ");
        await kvSet(env.DB, KV_AUD_LAST_ERROR, `${stamp} ${out.error}`);
        await noteOncePerDay(env, deps, nowSec, `⚠️ Audiencias Meta: ${out.error} (docs/meta-audiences.md).`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.error = msg;
    if (!out.dryRun) {
      await kvSet(env.DB, KV_AUD_LAST_ERROR, `${new Date(nowSec * 1000).toISOString()} ${msg}`);
      if (err instanceof MetricsSchemaError) {
        await noteOncePerDay(
          env,
          deps,
          nowSec,
          `⚠️ Audiencias Meta detenidas: falta una columna en Alumnos (${msg}). Revisa airtableMetrics.students en client.mjs.`,
        );
      }
    }
  }
  return out;
}

function parseSnapshot(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function noteOncePerDay(
  env: Env,
  deps: { postNote: (text: string) => Promise<void> },
  nowSec: number,
  text: string,
): Promise<void> {
  const key = `${KV_NOTE_PREFIX}${cdmxDateStr(nowSec)}`;
  if (await kvGet(env.DB, key)) return;
  await kvSet(env.DB, key, "1");
  await deps.postNote(text).catch(() => {});
}

/** Read-only state for the owner probe: config + last run, never the token. */
export async function audienceProbe(env: Env): Promise<{
  enabled: boolean;
  reason: AudienceSyncResult["skipped"];
  featureFlag: boolean;
  tokenSet: boolean;
  accountId: string | null;
  names: { paid: string; active: string } | null;
  audienceIds: Record<string, string | null>;
  lastOk: string | null;
  lastError: string | null;
}> {
  const cfg = audienceConfig(env);
  const [paid, active, lastOk, lastError] = await Promise.all([
    kvGet(env.DB, `${KV_AUD_ID_PREFIX}paid`),
    kvGet(env.DB, `${KV_AUD_ID_PREFIX}active`),
    kvGet(env.DB, KV_AUD_LAST_OK),
    kvGet(env.DB, KV_AUD_LAST_ERROR),
  ]);
  return {
    enabled: cfg.enabled,
    reason: cfg.reason,
    featureFlag: CLIENT.features.metaAudiences === true,
    tokenSet: !!cfg.token,
    accountId: cfg.accountId,
    names: cfg.names,
    audienceIds: { paid, active },
    lastOk,
    lastError,
  };
}
