// Backfill of the "declined" stop (2026-11-11). The stop shipped 2026-11-10;
// leads who declined BEFORE that have no `declined:<phone>` marker and kept
// being chased (verified: 3 messaged after the release, 5 with 7 scheduled
// chase rows). This re-reads the last N days with the SAME deterministic
// detectors the inbound path runs (detectDecline: not-interested / distance /
// price) plus our own "no te escribimos más" promises (promisesNoMoreMessages),
// and applies the stop with applyDecline — the exact live code path.
//
// Conservative: a phone is only stopped when its LATEST hit is not followed by
// a real message from the lead (anything beyond "gracias" / "ok" / an emoji
// means they re-engaged — the brain decides then), the contact is still a
// lead, and no marker exists yet. Owner-only route, dryRun by default.
//
// Rows-read: two range scans on idx_messages_direction_ts (direction, ts) over
// a bounded window, contacts by PK, markers by kv PK IN-lists (≤90), and per
// candidate one phone-prefixed followups probe (sqlite_autoindex_followups_1).

import { normalizeText } from "../pipeline/campaigns.js";
import {
  DECLINE_CANCEL_KINDS,
  detectDecline,
  promisesNoMoreMessages,
  type DeclineSource,
} from "../pipeline/decline.js";
import { applyDecline, getDeclineMarkers } from "./decline-stop.js";
import { DAY, cdmxDateStr, cdmxParts } from "../cron/time.js";

export interface BackfillMsg {
  phone: string;
  direction: string;
  body: string | null;
  ts: number;
}

export interface BackfillHit {
  phone: string;
  source: Extract<DeclineSource, "not_interested" | "objection" | "promise">;
  text: string;
  ts: number;
}

export interface BackfillOptions {
  dryRun: boolean;
  sinceDays: number;
  /** Max candidates processed (sample + apply). */
  limit: number;
}

export const BACKFILL_DEFAULTS = { sinceDays: 14, limit: 500 } as const;
export const BACKFILL_MAX = { sinceDays: 30, limit: 2000 } as const;
/** Hard cap on messages read per direction (the scan stays bounded). */
export const BACKFILL_SCAN_CAP = 25_000;
export const BACKFILL_SAMPLE = 25;

/** Pure. Body → options; dryRun unless `dryRun: false` is explicit. */
export function parseBackfillBody(
  body: Record<string, unknown> | null | undefined,
): { ok: true; opts: BackfillOptions } | { ok: false; error: string } {
  const b = body ?? {};
  const days = b.sinceDays === undefined ? BACKFILL_DEFAULTS.sinceDays : Number(b.sinceDays);
  if (!Number.isInteger(days) || days < 1 || days > BACKFILL_MAX.sinceDays) {
    return { ok: false, error: `sinceDays: entero 1–${BACKFILL_MAX.sinceDays}` };
  }
  const limit = b.limit === undefined ? BACKFILL_DEFAULTS.limit : Number(b.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > BACKFILL_MAX.limit) {
    return { ok: false, error: `limit: entero 1–${BACKFILL_MAX.limit}` };
  }
  return { ok: true, opts: { dryRun: b.dryRun !== false, sinceDays: days, limit } };
}

const COURTESY = new Set([
  "gracias", "muchas gracias", "mil gracias", "ok", "okey", "okay", "va", "vale", "sale", "si", "no",
  "igualmente", "gracias igualmente", "ok gracias", "va gracias", "sale gracias", "de nada", "bye",
  "saludos", "buen dia", "buenas noches", "excelente", "perfecto", "listo", "entendido", "entiendo",
  "gracias por la informacion", "gracias por la info", "thanks", "thank you", "no gracias",
]);

/** Pure. A message that does not re-open the conversation (courtesy, emoji, reaction). */
export function isCourtesy(body: string | null | undefined): boolean {
  const raw = (body ?? "").trim();
  if (!raw) return true;
  if (/^\[(?:reaction|reacción|sticker)/i.test(raw)) return true;
  const n = normalizeText(raw);
  if (!n) return true; // emoji / punctuation only
  return COURTESY.has(n);
}

/**
 * Pure. One hit per phone: its LATEST decline (inbound detector) or promise
 * (our outbound), dropped when the lead wrote anything real after it.
 */
export function planDeclineBackfill(
  inbound: readonly BackfillMsg[],
  outbound: readonly BackfillMsg[],
): { hits: BackfillHit[]; reengaged: number } {
  const latest = new Map<string, BackfillHit>();
  const consider = (h: BackfillHit): void => {
    const prev = latest.get(h.phone);
    if (!prev || h.ts > prev.ts) latest.set(h.phone, h);
  };
  for (const m of inbound) {
    const src = detectDecline(m.body ?? "");
    if (src) consider({ phone: m.phone, source: src, text: (m.body ?? "").slice(0, 160), ts: m.ts });
  }
  for (const m of outbound) {
    if (promisesNoMoreMessages(m.body ?? "")) {
      consider({ phone: m.phone, source: "promise", text: (m.body ?? "").slice(0, 160), ts: m.ts });
    }
  }
  const lastReal = new Map<string, number>();
  for (const m of inbound) {
    if (isCourtesy(m.body) || detectDecline(m.body ?? "")) continue;
    lastReal.set(m.phone, Math.max(lastReal.get(m.phone) ?? -1, m.ts));
  }
  const hits: BackfillHit[] = [];
  let reengaged = 0;
  for (const h of latest.values()) {
    if ((lastReal.get(h.phone) ?? -1) > h.ts) reengaged++;
    else hits.push(h);
  }
  hits.sort((a, b) => b.ts - a.ts);
  return { hits, reengaged };
}

/** "…5678" — never the full number in a response or a note. */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return `…${d.slice(-4)}`;
}

function cdmxStamp(ts: number): string {
  const p = cdmxParts(ts);
  return `${cdmxDateStr(ts)} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export const BACKFILL_SQL = {
  inbound: `SELECT phone, direction, body, ts FROM messages WHERE direction = 'in' AND ts >= ?1 ORDER BY ts LIMIT ?2`,
  outbound: `SELECT phone, direction, body, ts FROM messages
              WHERE direction IN ('out_bot', 'out_human', 'out_human_echo') AND ts >= ?1 ORDER BY ts LIMIT ?2`,
  contact: `SELECT status FROM contacts WHERE phone = ?1`,
  pending: (n: number) =>
    `SELECT COUNT(*) AS n FROM followups WHERE phone = ?1 AND status IN ('scheduled', 'paused') AND kind IN (${Array.from(
      { length: n },
      (_, i) => `?${i + 2}`,
    ).join(", ")})`,
  sentAfter: (n: number) =>
    `SELECT COUNT(*) AS n FROM followups WHERE phone = ?1 AND status = 'sent' AND due_at > ?2 AND kind IN (${Array.from(
      { length: n },
      (_, i) => `?${i + 3}`,
    ).join(", ")})`,
};

export interface BackfillResult {
  dryRun: boolean;
  sinceDays: number;
  scanned: { inbound: number; outbound: number; truncated: boolean };
  hits: number;
  skipped: { reengaged: number; alreadyDeclined: number; notLead: number; overLimit: number };
  candidates: number;
  bySource: Record<string, number>;
  /** Candidates that still have scheduled/paused chase rows, and how many rows. */
  withPendingRows: number;
  pendingRows: number;
  /** Candidates we messaged (chasing kinds) AFTER their decline. */
  messagedAfterDecline: number;
  applied: number;
  cancelledRows: number;
  sample: { phone: string; source: string; at: string; text: string; pending: number; sentAfter: number }[];
}

/** Scan + (unless dryRun) apply. Never throws per phone; one summary note when applied. */
export async function runDeclineBackfill(
  db: D1Database,
  opts: BackfillOptions,
  now: number,
  deps: { postNote?: (text: string) => Promise<void> } = {},
): Promise<BackfillResult> {
  const since = now - opts.sinceDays * DAY;
  const inbound = (await db.prepare(BACKFILL_SQL.inbound).bind(since, BACKFILL_SCAN_CAP).all<BackfillMsg>()).results ?? [];
  const outbound = (await db.prepare(BACKFILL_SQL.outbound).bind(since, BACKFILL_SCAN_CAP).all<BackfillMsg>()).results ?? [];
  const truncated = inbound.length >= BACKFILL_SCAN_CAP || outbound.length >= BACKFILL_SCAN_CAP;
  const { hits, reengaged } = planDeclineBackfill(inbound, outbound);

  const markers = await getDeclineMarkers(db, hits.map((h) => h.phone));
  const result: BackfillResult = {
    dryRun: opts.dryRun,
    sinceDays: opts.sinceDays,
    scanned: { inbound: inbound.length, outbound: outbound.length, truncated },
    hits: hits.length,
    skipped: { reengaged, alreadyDeclined: 0, notLead: 0, overLimit: 0 },
    candidates: 0,
    bySource: {},
    withPendingRows: 0,
    pendingRows: 0,
    messagedAfterDecline: 0,
    applied: 0,
    cancelledRows: 0,
    sample: [],
  };
  const kinds = [...DECLINE_CANCEL_KINDS];
  for (const h of hits) {
    if (markers.has(h.phone)) {
      result.skipped.alreadyDeclined++;
      continue;
    }
    const c = await db.prepare(BACKFILL_SQL.contact).bind(h.phone).first<{ status: string }>();
    if (!c || c.status !== "lead") {
      result.skipped.notLead++;
      continue;
    }
    if (result.candidates >= opts.limit) {
      result.skipped.overLimit++;
      continue;
    }
    result.candidates++;
    result.bySource[h.source] = (result.bySource[h.source] ?? 0) + 1;
    const pending = Number(
      (await db.prepare(BACKFILL_SQL.pending(kinds.length)).bind(h.phone, ...kinds).first<{ n: number }>())?.n ?? 0,
    );
    const sentAfter = Number(
      (await db.prepare(BACKFILL_SQL.sentAfter(kinds.length)).bind(h.phone, h.ts, ...kinds).first<{ n: number }>())?.n ?? 0,
    );
    if (pending > 0) {
      result.withPendingRows++;
      result.pendingRows += pending;
    }
    if (sentAfter > 0) result.messagedAfterDecline++;
    if (result.sample.length < BACKFILL_SAMPLE) {
      result.sample.push({ phone: maskPhone(h.phone), source: h.source, at: cdmxStamp(h.ts), text: h.text, pending, sentAfter });
    }
    if (!opts.dryRun) {
      const r = await applyDecline(db, h.phone, h.source, { text: h.text, now });
      result.applied++;
      result.cancelledRows += r.cancelled;
    }
  }
  if (!opts.dryRun && result.applied > 0 && deps.postNote) {
    try {
      await deps.postNote(
        `🤚 Backfill del stop «declinó» (${opts.sinceDays} días): ${result.applied} lead(s) marcados, ` +
          `${result.cancelledRows} envío(s) pendientes cancelados. Fuente: ${Object.entries(result.bySource)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")}.`,
      );
    } catch (err) {
      console.warn(`[decline-backfill] note failed: ${String(err)}`);
    }
  }
  return result;
}
