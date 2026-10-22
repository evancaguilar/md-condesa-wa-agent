// POST /hooks/airtable/enrolled — push trigger for the "Se inscribió" welcome +
// student kit (docs/airtable-enrolled-hook.md).
//
// The cron already does all of this (syncBookings → processResult arms the
// student_kit row → a later tick runs it), but only on its */5 schedule — two
// polls, so up to ~10 min. The Airtable "Se inscribió" automation (which also
// creates the Alumno) calls this as its LAST action, so the welcome AND the QR
// go out within seconds. The cron stays the fallback, untouched in behaviour.
//
// Trust model: the body is only a record id. The hook re-reads the Leads
// record from Airtable, maps it with the cron's own mapper, and acts only when
// Airtable itself says "Se inscribió" — a forged call can at worst make the bot
// do early what the cron would do anyway. X-Hook-Key (AIRTABLE_HOOK_KEY) is
// anti-spam, plus 60 calls/min.
//
// Idempotence is the cron's: processResult's kv marker + enrolment claim (no
// double welcome) and runStudentKitNow's compare-and-set claim on the kit row
// (no double kit) — see src/cron/followups.ts.

import type { Env } from "../types.js";
import { timingSafeEqual } from "./admin-auth.js";
import {
  classifyResult,
  getBookingRecord,
  normalizeMxPhone,
  type BookingRecord,
} from "../services/airtable.js";
import {
  processResult,
  runStudentKitNow,
  type KitNowOutcome,
  type ResultOutcome,
} from "../cron/followups.js";
import type { CronDeps } from "../cron/deps.js";
import { kvIncrementIfBelow } from "../db/queries.js";

export const HOOK_PATH = "/hooks/airtable/enrolled";
export const HOOK_RATE_PER_MIN = 60;
/** Reply before Airtable's 30 s script budget; the work continues via waitUntil. */
export const HOOK_REPLY_BUDGET_MS = 15_000;

export type WelcomeStatus =
  | ResultOutcome
  | "not_enrolled"
  | "not_found"
  | "no_phone"
  | "error"
  | "pending";
export type KitStatus = KitNowOutcome | "skipped" | "error" | "pending";

export interface HookResult {
  ok: boolean;
  welcome: WelcomeStatus;
  kit: KitStatus;
  ms: number;
  error?: string;
}

/** Everything the handler touches, injected (tests use fakes). */
export interface EnrolledHookDeps {
  hookKey: string | undefined;
  nowMs(): number;
  /** true = allowed. Throwing = allowed (fail open, logged). */
  rateLimit(nowMs: number): Promise<boolean>;
  getRecord(recordId: string): Promise<BookingRecord | null>;
  processResult(rec: BookingRecord, phone: string): Promise<ResultOutcome>;
  runKit(phone: string, recordId: string): Promise<KitNowOutcome>;
  /** ops_log note — only on failure (the cron retries). */
  postNote(text: string): Promise<void>;
  /** Keeps the work alive past the reply (ctx.waitUntil). */
  waitUntil(p: Promise<unknown>): void;
  /** Reply budget (ms); default HOOK_REPLY_BUDGET_MS. */
  budgetMs?: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Pure. Constant-time X-Hook-Key check; an unset secret refuses everything. */
export function hookKeyOk(expected: string | undefined, got: string | null): boolean {
  if (!expected || !got) return false;
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(got), enc.encode(expected));
}

export function hookRateKey(nowMs: number): string {
  return `ahk_rl:${Math.floor(nowMs / 60_000)}`;
}

export async function handleEnrolledHook(req: Request, deps: EnrolledHookDeps): Promise<Response> {
  const t0 = deps.nowMs();
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!hookKeyOk(deps.hookKey, req.headers.get("X-Hook-Key"))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  try {
    if (!(await deps.rateLimit(t0))) return json({ ok: false, error: "rate_limited" }, 429);
  } catch (err) {
    console.warn("[airtable-hook] rate-limit counter failed (allowing)", err);
  }
  let body: { recordId?: unknown } | null = null;
  try {
    body = JSON.parse(await req.text()) as { recordId?: unknown } | null;
  } catch {
    body = null;
  }
  const recordId = typeof body?.recordId === "string" ? body.recordId.trim() : "";
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    return json({ ok: false, error: "recordId inválido" }, 400);
  }

  const work = runEnrolled(deps, recordId, t0);
  deps.waitUntil(work);
  const budget = deps.budgetMs ?? HOOK_REPLY_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HookResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: true, welcome: "pending", kit: "pending", ms: deps.nowMs() - t0 }),
      budget,
    );
  });
  const result = await Promise.race([work, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return json(result, 200);
}

/** Never throws: every failure lands in the result (and one ops_log note). */
async function runEnrolled(deps: EnrolledHookDeps, recordId: string, t0: number): Promise<HookResult> {
  const done = (r: Omit<HookResult, "ms">): HookResult => ({ ...r, ms: deps.nowMs() - t0 });
  const fail = async (what: string, err: unknown) => {
    const msg = String(err);
    console.error(`[airtable-hook] ${recordId}: ${what}`, err);
    await deps
      .postNote(`⚠️ Hook "Se inscribió" (${recordId}): ${what} — ${msg}. El cron lo reintenta en ≤ 5 min; revisa si no llegó.`)
      .catch((e) => console.error("[airtable-hook] slack note failed", e));
    return msg;
  };

  let rec: BookingRecord | null;
  try {
    rec = await deps.getRecord(recordId);
  } catch (err) {
    const error = await fail("no pude leer el Lead en Airtable", err);
    return done({ ok: false, welcome: "error", kit: "skipped", error });
  }
  if (!rec) return done({ ok: true, welcome: "not_found", kit: "skipped" });
  // Only what Airtable says counts — never the caller.
  if (classifyResult(rec.result) !== "enrolled") {
    return done({ ok: true, welcome: "not_enrolled", kit: "skipped" });
  }
  if (!rec.phone) return done({ ok: true, welcome: "no_phone", kit: "skipped" });
  const phone = normalizeMxPhone(rec.phone);

  let welcome: WelcomeStatus;
  try {
    welcome = await deps.processResult(rec, phone);
  } catch (err) {
    const error = await fail("falló la bienvenida", err);
    welcome = "error";
    // The kit row is armed BEFORE the welcome send, so it may still go out.
    return done({ ok: false, welcome, kit: await runKitSafe(deps, phone, recordId, fail), error });
  }
  // "busy": the cron is processing this very enrolment right now — it owns the
  // kit row too (and a kit before its welcome would be out of order).
  if (welcome === "busy") return done({ ok: true, welcome, kit: "cron" });
  return done({ ok: true, welcome, kit: await runKitSafe(deps, phone, recordId, fail) });
}

async function runKitSafe(
  deps: EnrolledHookDeps,
  phone: string,
  recordId: string,
  fail: (what: string, err: unknown) => Promise<string>,
): Promise<KitStatus> {
  try {
    return await deps.runKit(phone, recordId);
  } catch (err) {
    await fail("falló el kit (QR/responsiva)", err);
    return "error";
  }
}

/** Real wiring: the cron's own deps, Airtable mapper and D1. */
export function makeEnrolledHookDeps(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  cron: CronDeps,
): EnrolledHookDeps {
  return {
    hookKey: env.AIRTABLE_HOOK_KEY,
    nowMs: () => Date.now(),
    async rateLimit(nowMs) {
      const key = hookRateKey(nowMs);
      const ok = await kvIncrementIfBelow(env.DB, key, HOOK_RATE_PER_MIN);
      // Self-cleaning: drop earlier minutes' counters (best-effort).
      await env.DB.prepare(`DELETE FROM kv WHERE key >= 'ahk_rl:' AND key < ?1`)
        .bind(key)
        .run()
        .catch(() => {});
      return ok;
    },
    getRecord: (id) => getBookingRecord(env, id),
    // Exactly what syncBookings passes (same Purchase-value precedence).
    processResult: (rec, phone) =>
      processResult(
        env,
        { slack: cron.slack },
        rec.id,
        phone,
        rec.result ?? "",
        rec.name ?? null,
        rec.trialDateTimeIso,
        rec.leadIncome ?? rec.initialPayment ?? null,
      ),
    runKit: (phone, recordId) => runStudentKitNow(env, cron, phone, recordId),
    postNote: (t) => cron.slack.postNote(t, { kind: "student_kit" }),
    waitUntil: (p) => ctx.waitUntil(p),
  };
}
