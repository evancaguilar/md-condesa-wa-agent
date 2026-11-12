// No-send preview of the AI-written day-1 follow-ups (owner-only route
// POST /admin/api/nudges/ai-followup-preview). The feature ships dark
// (features.aiFollowups false): this runs EXACTLY the code path processNudge
// uses — draftDayOne (plan + fixed copy), dayOneStop, composeDayOneAi (brief →
// <seguimiento> instruction → one brain call → validateAiFollowup) — whatever
// the shipped flag says, with ZERO side effects: no send, no message row, no
// kv write (gap claim, proposed-slot memory, nudge count), no followups row,
// no ops note. The brain call accrues usage_log like any turn.
//
// Candidates (no `phones`): the most recent ENGAGED leads (nudgePolicy class,
// src/db/nudge-engagement.ts) whose LAST message is ours — conversations that
// actually went quiet — and that are not booked, declined, opted out, student
// or under a human override. Rows-read: one bounded range on
// idx_messages_direction_ts (direction, ts), contacts by PK, the newest message
// per phone on idx_messages_phone_ts, the batched engagement statement, the
// same per-phone probes processNudge runs. Phones are masked to the last 4.

import type { Contact, Env, FollowupWrite } from "../types.js";
import { getContact } from "../db/queries.js";
import { hasScheduledFollowupOfKind } from "../db/queries-admin.js";
import { engagementByPhone } from "../db/nudge-engagement.js";
import { isDeclined } from "./decline-stop.js";
import {
  BOOKING_KINDS,
  bookedBefore,
  composeDayOneAi,
  dayOneStop,
  draftDayOne,
} from "../cron/nudges.js";
import { AI_FOLLOWUP_GUARD_REASONS, AI_FOLLOWUP_KINDS, type AiFollowupKind } from "../cron/ai-followup.js";

export interface PreviewOptions {
  kind: AiFollowupKind;
  /** Explicit phones (≤ 5): previewed even when a stop applies (the stop is reported). */
  phones: string[] | null;
  limit: number;
  sinceHours: number;
}

export const PREVIEW_DEFAULTS = { limit: 3, sinceHours: 48 } as const;
export const PREVIEW_MAX = { phones: 5, limit: 5, sinceHours: 168 } as const;
/** Inbound rows read to find candidate phones (bounded range scan). */
export const PREVIEW_SCAN_ROWS = 400;
/** Distinct phones examined before giving up. */
export const PREVIEW_MAX_CANDIDATES = 40;
const TEXT_MAX = 300;

/** Pure. Body → options. */
export function parsePreviewBody(
  body: Record<string, unknown> | null | undefined,
): { ok: true; opts: PreviewOptions } | { ok: false; error: string } {
  const b = body ?? {};
  const kind = b.kind === undefined ? "nudge_1h" : b.kind;
  if (!(AI_FOLLOWUP_KINDS as readonly unknown[]).includes(kind)) {
    return { ok: false, error: `kind: ${AI_FOLLOWUP_KINDS.join(" | ")}` };
  }
  let phones: string[] | null = null;
  if (b.phones !== undefined) {
    if (!Array.isArray(b.phones) || b.phones.length === 0 || b.phones.length > PREVIEW_MAX.phones) {
      return { ok: false, error: `phones: lista de 1–${PREVIEW_MAX.phones} teléfonos` };
    }
    phones = [];
    for (const p of b.phones) {
      const digits = String(p ?? "").replace(/[^\d]/g, "");
      if (digits.length < 10 || digits.length > 15) return { ok: false, error: "phones: teléfono inválido" };
      if (!phones.includes(digits)) phones.push(digits);
    }
  }
  const limit = b.limit === undefined ? PREVIEW_DEFAULTS.limit : Number(b.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PREVIEW_MAX.limit) {
    return { ok: false, error: `limit: entero 1–${PREVIEW_MAX.limit}` };
  }
  const sinceHours = b.sinceHours === undefined ? PREVIEW_DEFAULTS.sinceHours : Number(b.sinceHours);
  if (!Number.isFinite(sinceHours) || sinceHours <= 0 || sinceHours > PREVIEW_MAX.sinceHours) {
    return { ok: false, error: `sinceHours: 1–${PREVIEW_MAX.sinceHours}` };
  }
  return { ok: true, opts: { kind: kind as AiFollowupKind, phones, limit, sinceHours } };
}

export interface PreviewLead {
  /** "…1234" — never the full number. */
  phone: string;
  lastLead: string;
  lastOurs: string;
  hoursSilent: number;
  fixedCopy: string;
  ai: { ok: boolean; text?: string; reason?: string; guard?: string };
  cta: string | null;
  slot: { date: string; time: string; discipline: string } | null;
}

export interface PreviewResult {
  kind: AiFollowupKind;
  /** Candidate phones examined (auto-pick) or requested. */
  examined: number;
  leads: PreviewLead[];
}

/** Pure. "…1234". */
export function maskPhone(phone: string): string {
  return `…${phone.replace(/[^\d]/g, "").slice(-4)}`;
}

/** Pure. Query strings / fragments off every URL, capped, phone digits masked. */
export function sanitizePreviewText(text: string, max = TEXT_MAX): string {
  const t = text
    .replace(/(https?:\/\/[^\s?#<>]+)[?#][^\s<>]*/gi, "$1")
    .replace(/\+?\d[\d\s-]{9,}\d/g, (m) => maskPhone(m));
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const SQL_RECENT_INBOUND = `SELECT phone, ts FROM messages INDEXED BY idx_messages_direction_ts
  WHERE direction = 'in' AND ts >= ?1 ORDER BY ts DESC LIMIT ?2`;
const SQL_LAST_MESSAGE = `SELECT direction, body, ts FROM messages INDEXED BY idx_messages_phone_ts
  WHERE phone = ?1 ORDER BY ts DESC LIMIT 1`;
const SQL_LAST_INBOUND = `SELECT body, ts FROM messages INDEXED BY idx_messages_phone_ts
  WHERE phone = ?1 AND direction = 'in' ORDER BY ts DESC LIMIT 1`;

/** Exported for the index-plan test. */
export const PREVIEW_SQL = { SQL_RECENT_INBOUND, SQL_LAST_MESSAGE, SQL_LAST_INBOUND } as const;

interface Row {
  direction: string;
  body: string | null;
  ts: number;
}

/** Why this contact is not a quiet, chaseable lead (null ⇒ it is). Read-only. */
async function contactStop(env: Env, c: Contact | null, now: number): Promise<string | null> {
  if (!c) return "no_contact";
  if (c.status === "opted_out") return "opted_out";
  if (c.status !== "lead") return c.status === "student" ? "student" : "not_lead";
  if (c.human_override_until && c.human_override_until > now) return "human_override";
  if (await hasScheduledFollowupOfKind(env.DB, c.phone, BOOKING_KINDS)) return "booked";
  if (await bookedBefore(env, c.phone)) return "booked";
  if (await isDeclined(env.DB, c.phone)) return "declined";
  return null;
}

/** The newest message of the thread is OURS (bot or staff) — the lead went quiet. */
async function lastMessage(env: Env, phone: string): Promise<Row | null> {
  return (await env.DB.prepare(SQL_LAST_MESSAGE).bind(phone).first<Row>()) ?? null;
}

/**
 * The preview. `write` is the SAME writer the cron uses (pipeline/inbound
 * followupWriter); nothing here writes to D1.
 */
export async function runAiFollowupPreview(
  env: Env,
  opts: PreviewOptions,
  now: number,
  deps: {
    write: (env: Env, phone: string, instruction: string) => Promise<FollowupWrite>;
    campaignName?: (env: Env, campaignId: number) => Promise<string | null>;
    timeoutMs?: number;
  },
): Promise<PreviewResult> {
  const since = now - Math.round(opts.sinceHours * 3600);
  let picked: { phone: string; contact: Contact | null; stop: string | null }[] = [];
  let examined = 0;

  if (opts.phones) {
    examined = opts.phones.length;
    for (const phone of opts.phones) {
      const contact = await getContact(env.DB, phone);
      let stop = await contactStop(env, contact, now);
      if (!stop && contact) {
        const eng = (await engagementByPhone(env.DB, [phone]).catch(() => new Map())).get(phone);
        if (!eng?.engaged) stop = "silent";
      }
      picked.push({ phone, contact, stop });
    }
  } else {
    const { results } = await env.DB.prepare(SQL_RECENT_INBOUND).bind(since, PREVIEW_SCAN_ROWS).all<{ phone: string }>();
    const phones: string[] = [];
    for (const r of results ?? []) {
      if (!phones.includes(r.phone)) phones.push(r.phone);
      if (phones.length >= PREVIEW_MAX_CANDIDATES) break;
    }
    const quiet: { phone: string; contact: Contact }[] = [];
    for (const phone of phones) {
      examined++;
      const contact = await getContact(env.DB, phone);
      if (await contactStop(env, contact, now)) continue;
      const last = await lastMessage(env, phone);
      if (!last || last.direction === "in") continue;
      quiet.push({ phone, contact: contact! });
    }
    let eng = new Map<string, { engaged: boolean }>();
    try {
      eng = await engagementByPhone(env.DB, quiet.map((q) => q.phone));
    } catch (err) {
      console.warn(`[ai-preview] engagement lookup failed: ${String(err)}`);
    }
    picked = quiet.filter((q) => eng.get(q.phone)?.engaged).map((q) => ({ ...q, stop: null }));
  }

  const leads: PreviewLead[] = [];
  for (const p of picked) {
    if (leads.length >= (opts.phones ? opts.phones.length : opts.limit)) break;
    const lastIn = await env.DB.prepare(SQL_LAST_INBOUND).bind(p.phone).first<{ body: string | null; ts: number }>();
    const lastOut = await lastMessage(env, p.phone);
    const lastInTs = p.contact?.last_inbound_at ?? lastIn?.ts ?? now;
    const base = {
      phone: maskPhone(p.phone),
      lastLead: sanitizePreviewText(lastIn?.body ?? ""),
      lastOurs: lastOut && lastOut.direction !== "in" ? sanitizePreviewText(lastOut.body ?? "") : "",
      hoursSilent: Math.max(0, Math.round(((now - lastInTs) / 3600) * 10) / 10),
    };
    if (p.stop || !p.contact) {
      leads.push({ ...base, fixedCopy: "", ai: { ok: false, reason: `stop:${p.stop ?? "no_contact"}` }, cta: null, slot: null });
      continue;
    }
    const d = await draftDayOne(env, p.phone, opts.kind, p.contact, now, deps.campaignName);
    const slot = d.plan.slot ? { date: d.plan.slot.date, time: d.plan.slot.time, discipline: d.plan.slot.discipline } : null;
    const common = { ...base, fixedCopy: sanitizePreviewText(d.fixedBody, 1000), cta: d.plan.cta, slot };
    const stop = dayOneStop(d, now);
    if (stop) {
      if (!opts.phones) continue; // auto-pick: a nudge that would not go out is not a useful sample
      leads.push({ ...common, ai: { ok: false, reason: `stop:${stop}` } });
      continue;
    }
    const { outcome } = await composeDayOneAi(env, p.phone, opts.kind, d, now, deps.write, deps.timeoutMs);
    const ai: PreviewLead["ai"] = outcome.ok
      ? { ok: true, text: sanitizePreviewText(outcome.text, 1000) }
      : {
          ok: false,
          reason: outcome.reason,
          ...(outcome.draft ? { text: sanitizePreviewText(outcome.draft, 1000) } : {}),
          ...(outcome.detail
            ? { guard: sanitizePreviewText(outcome.detail, 500) }
            : AI_FOLLOWUP_GUARD_REASONS.includes(outcome.reason)
              ? { guard: outcome.reason }
              : {}),
        };
    leads.push({ ...common, ai });
  }
  return { kind: opts.kind, examined, leads };
}
