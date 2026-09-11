// One-time phone-number migration to a fresh WABA (docs/waba-migration-runbook.md).
//
// Why: WABA 1582515279931864 carries ManyChat's shared credit line, which
// blocks adding our own payment method; from 2026-10-01 Meta stops delivering
// service messages on a WABA with no payment method. Moving the SAME number to
// a WABA we created ourselves sidesteps the credit line; leads notice nothing.
//
// Why here and not the Graph API Explorer: the worker already holds the
// system-user token as a Cloudflare secret, so Evan runs each step from the
// /admin console (owner-only) and the token never leaves Cloudflare. Every
// step is one explicit call; nothing runs on its own. The UI-only parts
// (create the WABA, add the card, disable two-step verification) stay with
// Evan in WhatsApp Manager — there is no API for them.
//
// Steps, in order:
//   check        → old number + new WABA readiness (read-only)
//   migrate      → POST /{newWaba}/phone_numbers {migrate_phone_number:true}
//   request_code → SMS/VOICE code to the number (the SIM must be reachable)
//   verify_code  → POST /{newId}/verify_code
//   register     → POST /{newId}/register {pin}  (new two-step PIN)
//   subscribe    → POST /{newWaba}/subscribed_apps (webhooks for the new WABA)
//   post_check   → the migrated number as Meta sees it now
// then Evan sets WA_PHONE_NUMBER_ID = the new id in the Cloudflare dashboard.

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

const GRAPH = "https://graph.facebook.com/v21.0";

export const KV_NEW_PHONE_ID = "wa_migration:new_phone_id";
export const KV_LAST = "wa_migration:last";

export const MIGRATION_STEPS = [
  "check",
  "migrate",
  "request_code",
  "verify_code",
  "register",
  "subscribe",
  "post_check",
] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

/** Typed exactly so the confirm phrase can't be satisfied by accident. */
export const MIGRATE_CONFIRM = "MIGRAR 2274";

export interface MigrationInput {
  step: MigrationStep;
  /** Destination WABA (required for check/migrate/subscribe). */
  newWabaId?: string;
  /** Source WABA — optional, lets `check` list its numbers too. */
  oldWabaId?: string;
  /** Overrides the kv-remembered id returned by `migrate`. */
  newPhoneNumberId?: string;
  codeMethod?: "SMS" | "VOICE";
  code?: string;
  pin?: string;
  confirm?: string;
}

export interface GraphError {
  message: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  fbtrace_id?: string;
}

export interface MigrationResult {
  ok: boolean;
  step: MigrationStep;
  /** Step-specific payload (Graph responses, derived numbers, readiness). */
  data?: Record<string, unknown>;
  error?: string;
  graphError?: GraphError;
}

interface GraphCall {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function graph(
  env: Env,
  doFetch: FetchLike,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<GraphCall> {
  const res = await doFetch(`${GRAPH}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const err = parsed.error as GraphError | undefined;
  return { ok: res.ok && !err, status: res.status, body: parsed };
}

function fail(step: MigrationStep, error: string, call?: GraphCall): MigrationResult {
  return {
    ok: false,
    step,
    error,
    graphError: call ? (call.body.error as GraphError | undefined) : undefined,
    data: call ? { status: call.status, response: call.body } : undefined,
  };
}

/**
 * "+52 1 56 4199 2274" → { cc: "52", phone: "15641992274" }. Meta wants the
 * country code separate and the national number WITHOUT the "+" or the cc.
 * Only MX (+52) is handled on purpose — this module exists for one number.
 */
export function splitMxDisplayNumber(display: string): { cc: string; phone: string } | null {
  const digits = display.replace(/\D/g, "");
  if (!digits.startsWith("52") || digits.length < 12) return null;
  return { cc: "52", phone: digits.slice(2) };
}

const PHONE_FIELDS =
  "id,display_phone_number,verified_name,name_status,code_verification_status,quality_rating,status,platform_type,messaging_limit_tier";

async function readPhone(env: Env, doFetch: FetchLike, id: string): Promise<GraphCall> {
  return graph(env, doFetch, "GET", `${id}?fields=${PHONE_FIELDS}`);
}

async function readWaba(env: Env, doFetch: FetchLike, id: string): Promise<GraphCall> {
  const full = await graph(
    env,
    doFetch,
    "GET",
    `${id}?fields=id,name,account_review_status,business_verification_status,ownership_type,primary_funding_id`,
  );
  if (full.ok) return full;
  // primary_funding_id is the one field Meta might refuse on some accounts;
  // the rest is still worth showing.
  return graph(
    env,
    doFetch,
    "GET",
    `${id}?fields=id,name,account_review_status,business_verification_status,ownership_type`,
  );
}

async function remember(env: Env, step: MigrationStep, data: unknown): Promise<void> {
  await kvSet(env.DB, KV_LAST, JSON.stringify({ step, at: Math.floor(Date.now() / 1000), data }));
}

async function resolveNewId(env: Env, input: MigrationInput): Promise<string | null> {
  const fromInput = (input.newPhoneNumberId ?? "").trim();
  if (fromInput) return fromInput;
  return kvGet(env.DB, KV_NEW_PHONE_ID);
}

export async function runMigrationStep(
  env: Env,
  input: MigrationInput,
  doFetch: FetchLike = defaultFetch,
): Promise<MigrationResult> {
  const step = input.step;
  if (!MIGRATION_STEPS.includes(step)) return fail("check", `unknown step`);
  const newWabaId = (input.newWabaId ?? "").trim();

  if (step === "check") {
    if (!newWabaId) return fail(step, "newWabaId required");
    const old = await readPhone(env, doFetch, env.WA_PHONE_NUMBER_ID);
    const waba = await readWaba(env, doFetch, newWabaId);
    const numbers = await graph(
      env,
      doFetch,
      "GET",
      `${newWabaId}/phone_numbers?fields=id,display_phone_number,status`,
    );
    const apps = await graph(env, doFetch, "GET", `${newWabaId}/subscribed_apps`);
    const oldWaba = input.oldWabaId
      ? await graph(
          env,
          doFetch,
          "GET",
          `${input.oldWabaId.trim()}/phone_numbers?fields=id,display_phone_number,status`,
        )
      : null;
    const display = String(old.body.display_phone_number ?? "");
    const split = splitMxDisplayNumber(display);
    const readiness = {
      oldNumberReadable: old.ok,
      oldNumberIsMx: split !== null,
      newWabaReadable: waba.ok,
      newWabaHasFunding: !!waba.body.primary_funding_id,
      newWabaAppSubscribed:
        Array.isArray(apps.body.data) && (apps.body.data as unknown[]).length > 0,
      // Not queryable via API: two-step verification must be OFF on the old
      // number before `migrate` (WhatsApp Manager → Phone numbers → 2274).
      twoStepOffConfirmedByEvan: null as null,
    };
    const data = {
      oldNumber: old.body,
      willSend: split,
      newWaba: waba.body,
      newWabaNumbers: numbers.body,
      newWabaSubscribedApps: apps.body,
      oldWabaNumbers: oldWaba?.body ?? null,
      rememberedNewPhoneId: await kvGet(env.DB, KV_NEW_PHONE_ID),
      readiness,
    };
    return { ok: old.ok && waba.ok, step, data };
  }

  if (step === "migrate") {
    if (!newWabaId) return fail(step, "newWabaId required");
    if (input.confirm !== MIGRATE_CONFIRM) {
      return fail(step, `confirm must be exactly "${MIGRATE_CONFIRM}"`);
    }
    const old = await readPhone(env, doFetch, env.WA_PHONE_NUMBER_ID);
    if (!old.ok) return fail(step, "could not read the current number", old);
    const split = splitMxDisplayNumber(String(old.body.display_phone_number ?? ""));
    if (!split) return fail(step, "current number is not a +52 number; refusing", old);
    const call = await graph(env, doFetch, "POST", `${newWabaId}/phone_numbers`, {
      cc: split.cc,
      phone_number: split.phone,
      migrate_phone_number: true,
    });
    if (!call.ok || typeof call.body.id !== "string") {
      return fail(step, "Meta refused the migration", call);
    }
    await kvSet(env.DB, KV_NEW_PHONE_ID, call.body.id);
    const data = { newPhoneNumberId: call.body.id, sent: split, response: call.body };
    await remember(env, step, data);
    return { ok: true, step, data };
  }

  // Every remaining step targets the NEW phone number id.
  const newId = await resolveNewId(env, input);
  if (step === "subscribe") {
    if (!newWabaId) return fail(step, "newWabaId required");
    const call = await graph(env, doFetch, "POST", `${newWabaId}/subscribed_apps`, {});
    if (!call.ok) return fail(step, "subscribed_apps failed", call);
    const apps = await graph(env, doFetch, "GET", `${newWabaId}/subscribed_apps`);
    const data = { response: call.body, subscribedApps: apps.body };
    await remember(env, step, data);
    return { ok: true, step, data };
  }
  if (!newId) return fail(step, "no new phone number id yet — run `migrate` first (or pass newPhoneNumberId)");

  if (step === "request_code") {
    const method = input.codeMethod === "VOICE" ? "VOICE" : "SMS";
    const call = await graph(env, doFetch, "POST", `${newId}/request_code`, {
      code_method: method,
      language: "es",
    });
    if (!call.ok) return fail(step, "request_code failed", call);
    const data = { newPhoneNumberId: newId, codeMethod: method, response: call.body };
    await remember(env, step, data);
    return { ok: true, step, data };
  }

  if (step === "verify_code") {
    const code = (input.code ?? "").replace(/\D/g, "");
    if (code.length !== 6) return fail(step, "code must be the 6-digit code Meta sent");
    const call = await graph(env, doFetch, "POST", `${newId}/verify_code`, { code });
    if (!call.ok) return fail(step, "verify_code failed", call);
    const data = { newPhoneNumberId: newId, response: call.body };
    await remember(env, step, data);
    return { ok: true, step, data };
  }

  if (step === "register") {
    const pin = (input.pin ?? "").trim();
    if (!/^\d{6}$/.test(pin)) return fail(step, "pin must be 6 digits (this becomes the number's new two-step PIN)");
    const call = await graph(env, doFetch, "POST", `${newId}/register`, {
      messaging_product: "whatsapp",
      pin,
    });
    if (!call.ok) return fail(step, "register failed", call);
    const data = { newPhoneNumberId: newId, response: call.body };
    await remember(env, step, data);
    return { ok: true, step, data };
  }

  // post_check
  const fresh = await readPhone(env, doFetch, newId);
  const data = {
    newPhoneNumberId: newId,
    number: fresh.body,
    workerStillPointsAt: env.WA_PHONE_NUMBER_ID,
    nextStep:
      env.WA_PHONE_NUMBER_ID === newId
        ? "WA_PHONE_NUMBER_ID already updated — send a test message"
        : `set WA_PHONE_NUMBER_ID=${newId} in Cloudflare → Workers → md-condesa-wa-agent → Settings → Variables`,
  };
  return { ok: fresh.ok, step, data };
}

/** GET view: what the migration remembers, never the token. */
export async function migrationState(env: Env): Promise<Record<string, unknown>> {
  const last = await kvGet(env.DB, KV_LAST);
  return {
    currentPhoneNumberId: env.WA_PHONE_NUMBER_ID,
    rememberedNewPhoneId: await kvGet(env.DB, KV_NEW_PHONE_ID),
    last: last ? (JSON.parse(last) as unknown) : null,
    steps: MIGRATION_STEPS,
    confirmPhrase: MIGRATE_CONFIRM,
  };
}
