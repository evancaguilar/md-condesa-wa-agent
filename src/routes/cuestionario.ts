// /api/cuestionario — the pre-trial questionnaire's backend (docs/cuestionario.md).
//
//   GET    /api/cuestionario?t=<token>  → greeting data + current answers
//   PATCH  /api/cuestionario?t=<token>  → save answers (whitelisted), `__complete`
//   OPTIONS                              → CORS preflight
//   POST   /api/cuestionario/send        → send the link (Bearer CUESTIONARIO_SEND_KEY)
//
// Public by design: the page on mdcondesa.com calls it from the lead's phone.
// Defences: an HMAC token bound to ONE Leads record + version + 14-day expiry,
// a per-version column whitelist (the browser can never touch `Cuestionario
// enviado/versión` or any CRM column outside the questionnaire), 120
// requests/token/hour, and a response shape that never carries the phone.

import type { Env } from "../types.js";
import { kvIncrementIfBelow } from "../db/queries.js";
import { leadsMap, AirtableWriteError } from "../services/airtable.js";
import { greetingName } from "../cron/display-name.js";
import { postNote, postTaskNote } from "../services/slack.js";
import { timingSafeEqual } from "./admin-auth.js";
import {
  isCuestionarioVersion,
  verifyToken,
  type CuestionarioVersion,
} from "../services/cuestionario-token.js";
import {
  F_DONE,
  answersFromFields,
  cdmxDia,
  cdmxHora,
  cellFilled,
  cellText,
  completionFields,
  completionSummary,
  corsHeaders,
  isoToEpoch,
  sanitizeAnswers,
} from "../services/cuestionario-core.js";
import {
  RATE_LIMIT_PER_HOUR,
  getLeadRecord,
  patchLeadAnswers,
  rateKey,
  sendCuestionario,
} from "../services/cuestionario.js";

const MAX_BODY_BYTES = 64 * 1024;

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) },
  });
}

export async function handleCuestionario(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get("Origin");

  if (url.pathname === "/api/cuestionario/send") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, null);
    return handleSend(req, env);
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "GET" && req.method !== "PATCH") {
    return json({ error: "method_not_allowed" }, 405, origin);
  }
  if (!env.CUESTIONARIO_SECRET) return json({ error: "not_configured" }, 503, origin);

  const nowSec = Math.floor(Date.now() / 1000);
  const token = url.searchParams.get("t") ?? "";
  const claims = await verifyToken(env.CUESTIONARIO_SECRET, token, nowSec);
  if ("error" in claims) return json({ error: claims.error }, claims.error === "expired" ? 410 : 401, origin);

  try {
    if (!(await kvIncrementIfBelow(env.DB, rateKey(token, nowSec), RATE_LIMIT_PER_HOUR))) {
      return json({ error: "rate_limited" }, 429, origin);
    }
  } catch (err) {
    console.warn("[cuestionario] rate-limit counter failed (allowing)", err);
  }

  try {
    if (req.method === "GET") return await handleGet(env, claims.recordId, claims.version, origin);
    return await handlePatch(req, env, ctx, claims.recordId, claims.version, origin, nowSec);
  } catch (err) {
    console.error("[cuestionario] airtable failure", err);
    return json({ error: "upstream" }, 502, origin);
  }
}

async function handleGet(
  env: Env,
  recordId: string,
  version: CuestionarioVersion,
  origin: string | null,
): Promise<Response> {
  const rec = await getLeadRecord(env, recordId);
  if (!rec) return json({ error: "not_found" }, 404, origin);
  const m = leadsMap();
  const f = rec.fields;
  const trialIso = cellText(f[m.trialDateTime]);
  const epoch = isoToEpoch(trialIso);
  return json(
    {
      version,
      nombre: greetingName(cellText(f[m.name])),
      hijo: cellText(f[m.childName]),
      dia: epoch === null ? null : cdmxDia(epoch, "es"),
      hora: epoch === null ? null : cdmxHora(epoch),
      trialIso: epoch === null ? null : trialIso,
      answers: answersFromFields(version, f),
    },
    200,
    origin,
  );
}

async function handlePatch(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  recordId: string,
  version: CuestionarioVersion,
  origin: string | null,
  nowSec: number,
): Promise<Response> {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413, origin);
  let body: unknown = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: "bad_json" }, 400, origin);
  }
  const { fields, complete } = sanitizeAnswers(version, body);
  if (!complete && Object.keys(fields).length === 0) return json({ ok: true }, 200, origin);

  // Completion: read first so the Slack summary fires only on the FIRST
  // completion (the page may resend `__complete`; last write still wins).
  let wasDone = false;
  if (complete) {
    const before = await getLeadRecord(env, recordId);
    if (!before) return json({ error: "not_found" }, 404, origin);
    wasDone = cellFilled(before.fields[F_DONE]);
  }

  let saved;
  try {
    saved = await patchLeadAnswers(env, recordId, complete ? { ...fields, ...completionFields(nowSec) } : fields);
  } catch (err) {
    if (err instanceof AirtableWriteError && err.status === 404) return json({ error: "not_found" }, 404, origin);
    throw err;
  }
  if (saved.dropped.length) console.warn(`[cuestionario] ${recordId}: missing Airtable columns ${saved.dropped.join(", ")}`);

  if (complete && !wasDone) {
    const m = leadsMap();
    const f = saved.record.fields;
    const text = completionSummary({
      name: cellText(f[m.name]),
      kid: version === "adultos" ? null : cellText(f[m.childName]),
      version,
      program: cellText(f[m.audience]),
      trialEpoch: isoToEpoch(cellText(f[m.trialDateTime])),
      phone: cellText(f[m.phone]),
      fields: f,
    });
    ctx.waitUntil(postTaskNote(env, text).catch((e) => console.error("[cuestionario] slack summary failed", e)));
  }
  return json({ ok: true }, 200, origin);
}

/** POST /api/cuestionario/send — for the Airtable automation (Bearer key). */
async function handleSend(req: Request, env: Env): Promise<Response> {
  const key = env.CUESTIONARIO_SEND_KEY ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const enc = new TextEncoder();
  if (!key || !got || !timingSafeEqual(enc.encode(got), enc.encode(key))) {
    return json({ error: "unauthorized" }, 401, null);
  }
  const body = (await req.json().catch(() => null)) as
    | { recordId?: unknown; version?: unknown; resend?: unknown }
    | null;
  const recordId = typeof body?.recordId === "string" ? body.recordId.trim() : "";
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) return json({ error: "recordId inválido" }, 400, null);
  if (body?.version !== undefined && !isCuestionarioVersion(body.version)) {
    return json({ error: "version inválida (adultos|kids|bfc)" }, 400, null);
  }
  const result = await sendCuestionario(
    env,
    { postNote: (t) => postNote(env, t) },
    {
      recordId,
      ...(isCuestionarioVersion(body?.version) ? { version: body.version } : {}),
      resend: body?.resend === true,
    },
  );
  return json(result, 200, null);
}
