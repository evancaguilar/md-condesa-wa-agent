// "¿Cómo nos encontraste?" — the I/O half (pure rules: ./origin-question-core.ts).
//
//  - armOriginQuestion  : called from afterBookingConfirmed, i.e. only once a
//                         booking confirmation has REACHED the lead. Eligible
//                         lead (no ad / Google click / campaign) → once-ever
//                         kv claim + an `origin_ask` followup a few minutes out.
//  - sendOriginQuestion : the followup at send time (cron/followups.ts). Re-checks
//                         eligibility and the Leads row, never talks over a live
//                         exchange (defers), sends the question in-window only.
//  - captureOriginAnswer: inbound pipeline, before the gates (not a gate): the
//                         first messages after the question are classified; an
//                         answer is written to Leads.Canal (+ raw text) and the
//                         brain gets an <origen> hint to just say thanks.
//
// Everything is best-effort: a failure here never touches the booking, the
// confirmation, the reminders or the reply.

import type { Env, Followup } from "../types.js";
import { CLIENT } from "../client.gen.js";
import {
  getContact,
  getPendingApprovals,
  kvGet,
  kvSet,
  kvSetIfAbsent,
  markFollowup,
  recentMessages,
  scheduleFollowup,
} from "../db/queries.js";
import { AirtableWriteError, extractUnknownFieldName, findLeadByPhone, leadsMap, updateRecord } from "./airtable.js";
import { googleClickKey } from "./google-click.js";
import { sendText, WindowClosedError } from "./send.js";
import { isQuietHour, next8am } from "../cron/quiet.js";
import {
  ORIGIN_ASK_DELAY_SEC,
  ORIGIN_DEFER_SEC,
  ORIGIN_MAX_DEFERS,
  canalWritable,
  classifyOriginAnswer,
  leadAlreadyAttributed,
  originArmedKey,
  originAwaitingAnswer,
  originQuestionCopy,
  originSendGate,
  originStateKey,
  parseOriginState,
  readDefers,
  shouldAskOrigin,
  type OriginCanal,
  type OriginState,
} from "./origin-question-core.js";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function eligible(env: Env, phone: string): Promise<boolean> {
  const contact = await getContact(env.DB, phone);
  const gclick = await kvGet(env.DB, googleClickKey(phone));
  return shouldAskOrigin({ contact, hasGoogleClick: !!gclick });
}

/**
 * Arm the question right after a booking confirmation reached the lead. Once
 * per phone, ever (kv claim). Never throws.
 */
export async function armOriginQuestion(env: Env, phone: string): Promise<void> {
  try {
    if (!originQuestionCopy("es", CLIENT.copy)) return; // client has no copy → off
    if (!(await eligible(env, phone))) return;
    const now = nowSec();
    if (!(await kvSetIfAbsent(env.DB, originArmedKey(phone), String(now)))) return;
    await scheduleFollowup(env.DB, {
      phone,
      kind: "origin_ask",
      dueAt: now + ORIGIN_ASK_DELAY_SEC,
      airtableRecordId: null,
      note: null,
    });
  } catch (err) {
    console.warn(`[origin] arm failed for ${phone}`, err);
  }
}

async function deferRow(env: Env, f: Followup, dueAt: number): Promise<void> {
  const n = readDefers(f.note) + 1;
  await env.DB.prepare(
    `UPDATE followups SET due_at = ?2, note = ?3, status = 'scheduled'
     WHERE id = ?1 AND status = 'scheduled'`,
  )
    .bind(f.id, dueAt, `defers:${n}`)
    .run();
}

/**
 * The `origin_ask` followup at send time. Marks the row itself
 * (sent / cancelled) or pushes it back; throws only on an unexpected send
 * error, which the tick's generic retry handles.
 */
export async function sendOriginQuestion(
  env: Env,
  f: Followup,
  opts: { isQuiet?: (epoch: number) => boolean } = {},
): Promise<void> {
  const now = nowSec();
  const contact = await getContact(env.DB, f.phone);
  const text = originQuestionCopy(contact?.lang ?? "es", CLIENT.copy);
  if (!text || !(await eligible(env, f.phone))) {
    await markFollowup(env.DB, f.id, "cancelled");
    return;
  }
  if (readDefers(f.note) >= ORIGIN_MAX_DEFERS) {
    await markFollowup(env.DB, f.id, "cancelled");
    return;
  }
  if ((opts.isQuiet ?? isQuietHour)(now)) {
    // The send-time window check below drops it if the 24h window closed overnight.
    await deferRow(env, f, next8am(now) + 15 * 60);
    return;
  }
  const pending = await getPendingApprovals(env.DB, f.phone).catch(() => []);
  const msgs = await recentMessages(env.DB, f.phone, 6);
  if (pending.length > 0 || originSendGate(msgs, now) === "defer") {
    await deferRow(env, f, now + ORIGIN_DEFER_SEC);
    return;
  }
  // Staff may already have tagged the lead (Adquisición, Canal, Vio anuncio).
  try {
    const rec = await findLeadByPhone(env, f.phone);
    if (rec && leadAlreadyAttributed(rec.fields, leadsMap().source)) {
      await markFollowup(env.DB, f.id, "cancelled");
      return;
    }
  } catch (err) {
    console.warn(`[origin] Airtable read failed for ${f.phone}; asking anyway`, err);
  }
  try {
    await sendText(env, f.phone, text);
  } catch (err) {
    if (err instanceof WindowClosedError) {
      await markFollowup(env.DB, f.id, "cancelled");
      return;
    }
    throw err;
  }
  const state: OriginState = { askedAt: now };
  await kvSet(env.DB, originStateKey(f.phone), JSON.stringify(state));
  await markFollowup(env.DB, f.id, "sent");
}

/**
 * Write a classified answer to the lead's row: Canal (only over an empty /
 * bot-written value) and the raw text in the free-text column (fill-if-empty).
 * A missing free-text column is dropped and the write retried once.
 */
async function writeAnswer(env: Env, phone: string, canal: OriginCanal | null, raw: string): Promise<void> {
  const rec = await findLeadByPhone(env, phone);
  if (!rec) return;
  const map = leadsMap();
  const fields: Record<string, unknown> = {};
  if (canal && canalWritable(rec.fields[map.source])) fields[map.source] = canal;
  const howFound = map.howFound;
  if (howFound) {
    const cur = rec.fields[howFound];
    if (cur === undefined || cur === null || (typeof cur === "string" && cur.trim() === "")) {
      fields[howFound] = raw.slice(0, 500);
    }
  }
  if (Object.keys(fields).length === 0) return;
  try {
    await updateRecord(env, env.AIRTABLE_TRIALS_TABLE, rec.id, fields);
  } catch (err) {
    if (
      err instanceof AirtableWriteError &&
      err.unknownField &&
      howFound &&
      extractUnknownFieldName(err.message) === howFound &&
      fields[map.source]
    ) {
      await updateRecord(env, env.AIRTABLE_TRIALS_TABLE, rec.id, { [map.source]: fields[map.source] });
      return;
    }
    throw err;
  }
}

/**
 * Inbound hook: when the question is open, read this message as a possible
 * answer. Returns the captured answer ({canal}, canal null = answered but not
 * placeable), or null when this message is not an answer. Never throws.
 */
export async function captureOriginAnswer(
  env: Env,
  phone: string,
  body: string,
  now: number,
): Promise<{ canal: OriginCanal | null } | null> {
  try {
    const state = parseOriginState(await kvGet(env.DB, originStateKey(phone)));
    if (!state || !originAwaitingAnswer(state, now)) return null;
    const ans = classifyOriginAnswer(body);
    if (!ans) {
      const next: OriginState = { ...state, misses: (state.misses ?? 0) + 1 };
      await kvSet(env.DB, originStateKey(phone), JSON.stringify(next));
      return null;
    }
    const done: OriginState = { ...state, answeredAt: now, canal: ans.canal };
    await kvSet(env.DB, originStateKey(phone), JSON.stringify(done));
    try {
      await writeAnswer(env, phone, ans.canal, body);
    } catch (err) {
      console.warn(`[origin] Airtable write failed for ${phone}`, err);
    }
    return { canal: ans.canal };
  } catch (err) {
    console.warn(`[origin] capture failed for ${phone}`, err);
    return null;
  }
}

/** kv read for the brain hint after the burst debounce (fail-soft). */
export async function readOriginState(env: Env, phone: string): Promise<OriginState | null> {
  try {
    return parseOriginState(await kvGet(env.DB, originStateKey(phone)));
  } catch {
    return null;
  }
}
