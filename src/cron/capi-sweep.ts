// Airtable-driven funnel sweep for the Conversions API (docs/meta-capi.md).
//
// Every 15 minutes (the metrics slot, right after the student-link sweep so a
// fresh Alumno link is already reflected in {Cerró}) read the Leads rows that
// still owe Meta an event and ENQUEUE them. The live hooks (finalizeBooking,
// syncBookings, the result watcher) stay — they are faster and carry the exact
// trial time — but this sweep is what catches everything they cannot see:
// a purchase that only exists as `Ingresos Lead > 0`, a booking staff typed by
// hand, a result marked while the worker was down. The kv claim inside
// enqueueCapiEvent makes the two sources safe together: whichever enqueues
// first wins, the other is a "duplicate" no-op.
//
// Cost: ONE Airtable list call per tick (≤100 rows) + D1 writes. Nothing here
// talks to Meta — src/cron/capi.ts does, and marks Airtable after the 2xx.

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";
import { cdmxDateStr } from "./time.js";
import { leadsMap, normalizeMxPhone } from "../services/airtable.js";
import { MetricsSchemaError, listRecords } from "../services/metrics-airtable.js";
import { CAPI_MAX_EVENT_AGE_SEC, capiConfig, enqueueCapiEvent } from "../services/meta-capi.js";
import {
  capiEventsForLead,
  capiLeadColumns,
  capiSweepFields,
  capiSweepFormula,
} from "../services/capi-airtable.js";

export const CAPI_SWEEP_MAX_RECORDS = 100;
export const KV_CAPI_SWEEP_LAST_OK = "capi_sweep_last_ok";
export const KV_CAPI_SWEEP_ERROR = "capi_sweep_error";
const KV_NOTE_PREFIX = "capi_sweep_note:";

export interface CapiSweepResult {
  scanned: number;
  queued: number;
  duplicate: number;
  tooOld: number;
  noClid: number;
  skipped: "disabled" | "map_incomplete" | null;
  error: string | null;
}

export async function runCapiFunnelSweep(
  env: Env,
  nowSec: number,
  deps: { postNote: (text: string) => Promise<void> },
  list: typeof listRecords = listRecords,
): Promise<CapiSweepResult> {
  const out: CapiSweepResult = {
    scanned: 0,
    queued: 0,
    duplicate: 0,
    tooOld: 0,
    noClid: 0,
    skipped: null,
    error: null,
  };
  if (!capiConfig(env).enabled) return { ...out, skipped: "disabled" };
  const map = leadsMap();
  const cols = capiLeadColumns(map);
  if (!cols) return { ...out, skipped: "map_incomplete" };

  // Same window Meta enforces on event_time; rows touched earlier can only
  // yield events we would have to drop anyway.
  const sinceIso = new Date((nowSec - CAPI_MAX_EVENT_AGE_SEC) * 1000).toISOString();
  const formula = capiSweepFormula(sinceIso, map);
  if (!formula) return { ...out, skipped: "map_incomplete" };

  try {
    const rows = await list(env, env.AIRTABLE_TRIALS_TABLE, {
      filterByFormula: formula,
      fields: capiSweepFields(cols),
      maxRecords: CAPI_SWEEP_MAX_RECORDS,
    });
    for (const r of rows) {
      out.scanned++;
      const rawPhone = r.fields[cols.phone];
      const phone = typeof rawPhone === "string" ? normalizeMxPhone(rawPhone.trim()) : "";
      const rawClid = r.fields[cols.ctwaClid];
      const clid = typeof rawClid === "string" ? rawClid.trim() : "";
      if (!phone || !clid) {
        out.noClid++;
        continue;
      }
      for (const ev of capiEventsForLead(r.fields, cols, nowSec, map)) {
        const res = await enqueueCapiEvent(
          env,
          {
            kind: ev.kind,
            phone,
            recordId: r.id,
            ctwaClid: clid,
            eventTimeSec: ev.eventTimeSec,
            ...(ev.kind === "purchase" ? { value: ev.value ?? null } : {}),
          },
          nowSec,
        );
        if (res === "queued") out.queued++;
        else if (res === "duplicate") out.duplicate++;
        else if (res === "too_old") out.tooOld++;
        else if (res === "no_clid") out.noClid++;
      }
    }
    await kvSet(
      env.DB,
      KV_CAPI_SWEEP_LAST_OK,
      `${new Date(nowSec * 1000).toISOString()} scanned=${out.scanned} queued=${out.queued}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.error = msg;
    await kvSet(env.DB, KV_CAPI_SWEEP_ERROR, `${new Date(nowSec * 1000).toISOString()} ${msg}`);
    if (err instanceof MetricsSchemaError) {
      // A missing column is a config problem, not a transient one: say it once
      // a day instead of every 15 minutes, and keep the rest of the tick alive.
      const key = `${KV_NOTE_PREFIX}${cdmxDateStr(nowSec)}`;
      if (!(await kvGet(env.DB, key))) {
        await kvSet(env.DB, key, "1");
        await deps
          .postNote(
            `⚠️ Conversions API sweep detenido: falta una columna en Airtable (${msg}). Revisa airtableLeads en client.mjs (docs/meta-capi.md).`,
          )
          .catch(() => {});
      }
    }
  }
  return out;
}
