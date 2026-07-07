// /admin/api/* — JSON API for the dashboard (login/logout/me, overview, bot +
// training-wheels toggles, conversations, approvals, KB overlay CRUD + chat,
// campaigns, edits, sandbox). All signed-cookie authed except login + UI.
//
// Spec: docs/dashboard-plan.md §5. Zero runtime deps, Web APIs only. It receives
// the Ports bundle so the sandbox route can build a per-request brain that reuses
// the same overlay loader + real usage accrual as production.

import type {
  BrainResult,
  ConvoContext,
  Env,
  KbSection,
  Ports,
  StoredMessage,
} from "../types.js";
import {
  buildSetCookie,
  decideLoginRateLimit,
  recordFailedLogin,
  signAdminCookie,
  timingSafeEqual,
  verifyAdminCookie,
} from "./admin-auth.js";
import {
  isBotEnabled,
  kvGet,
  kvSet,
  getContact,
  recentMessages,
  getPendingApprovals,
  setContactStatus,
  setHumanOverride,
  accrueUsage,
} from "../db/queries.js";
import {
  listKbSections,
  getKbSection,
  createKbSection,
  updateKbSection,
  deleteKbSection,
  insertKbRevision,
  listKbRevisions,
  getKbRevision,
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaign,
  listConversations,
  listEdits,
  statsOverview,
  getTrainingWheels,
  clearHumanOverride,
  getActiveCampaigns,
  listAirtableRules,
  getAirtableRule,
  updateAirtableRule,
  deleteAirtableRule,
} from "../db/queries-admin.js";
import { parseRule, ruleSummaryEs } from "../services/airtable-rules.js";
import { assembleOverlay, estimateTokens } from "../brain/overlay.js";
import { normalizeText, matchCampaign } from "../pipeline/campaigns.js";
import {
  approveAndSend,
  editAndSend,
  discardApproval,
  type ApprovalResult,
} from "../services/approvals.js";
import { runKbChat, applyProposal } from "../services/kb-editor.js";
import { createBrainWithKb, makeOverlayLoader } from "../brain/index.js";
import { updateControlPanel } from "../services/slack.js";
import { KB } from "../kb.js";

// Overlay hard cap (estimated tokens). A resulting overlay above this is rejected
// so the second cached system block stays small.
const OVERLAY_TOKEN_CAP = 2000;

// ---- response helpers ----

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function jsonWithCookie(body: unknown, setCookie: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": setCookie,
    },
  });
}

async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const THIRTY_DAYS = 30 * 24 * 3600;

// ---- SHA-256 hex (login password compare) ----

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ---- KB base version (parsed from the compiled KB header comment) ----

/** Extracts `version: <x>` from the compiled KB header comment in src/kb.ts's KB. */
function kbBaseVersion(): string {
  const m = KB.match(/version:\s*([^\s]+)/);
  return m ? m[1]! : "unknown";
}

// ---- overlay token accounting ----

async function overlayTokens(env: Env): Promise<number> {
  const sections = await listKbSections(env.DB);
  return estimateTokens(assembleOverlay(sections));
}

/**
 * Estimated overlay token count if `next` replaced (or was added to) the current
 * sections. `next` overrides the section with a matching id; a null-id entry is
 * treated as a brand-new section. Used to enforce the cap before we commit a write.
 */
function overlayTokensWith(sections: KbSection[], next: KbSection): number {
  const merged = sections.filter((s) => s.id !== next.id);
  merged.push(next);
  return estimateTokens(assembleOverlay(merged));
}

// ---- approval result → JSON ----

function approvalJson(r: ApprovalResult): Response {
  if (r.ok) return json({ ok: true });
  return json({ ok: false, reason: r.reason });
}

// ---- dispatcher ----

export async function handleAdminApi(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  ports: Ports,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname; // e.g. /admin/api/overview
  const method = req.method;

  // ---- login (unauthed, rate-limited) ----
  if (path === "/admin/api/login" && method === "POST") {
    return handleLogin(req, env);
  }

  // ---- auth gate (everything else) ----
  const authed = await verifyAdminCookie(
    env.ADMIN_PASSWORD,
    req.headers.get("cookie"),
    nowSec(),
  );
  if (!authed) return json({ error: "unauthorized" }, 401);

  // ---- session ----
  if (path === "/admin/api/logout" && method === "POST") {
    return jsonWithCookie({ ok: true }, buildSetCookie("", 0));
  }
  if (path === "/admin/api/me" && method === "GET") {
    return json({ ok: true });
  }

  // ---- overview ----
  if (path === "/admin/api/overview" && method === "GET") {
    return handleOverview(env);
  }

  // ---- toggles ----
  if (path === "/admin/api/bot" && method === "POST") {
    return handleBotToggle(req, env, ctx);
  }
  if (path === "/admin/api/training-wheels" && method === "POST") {
    const body = await readJson<{ enabled?: boolean }>(req);
    await kvSet(env.DB, "training_wheels", body.enabled ? "1" : "0");
    return json({ ok: true });
  }

  // ---- conversations ----
  if (path === "/admin/api/conversations" && method === "GET") {
    return handleConversationsList(env, url);
  }
  const convoMatch = path.match(/^\/admin\/api\/conversations\/([^/]+)(\/(pause|resume|status))?$/);
  if (convoMatch) {
    const phone = decodeURIComponent(convoMatch[1]!);
    const sub = convoMatch[3];
    if (!sub && method === "GET") return handleConversationDetail(env, phone);
    if (sub === "pause" && method === "POST") return handlePause(req, env, phone);
    if (sub === "resume" && method === "POST") return handleResume(env, phone);
    if (sub === "status" && method === "POST") return handleStatus(req, env, phone);
    return json({ error: "not_found" }, 404);
  }

  // ---- approvals ----
  if (path === "/admin/api/approvals" && method === "GET") {
    return handleApprovalsList(env);
  }
  const apprMatch = path.match(/^\/admin\/api\/approvals\/(\d+)\/(approve|edit|discard)$/);
  if (apprMatch && method === "POST") {
    const id = Number(apprMatch[1]);
    const action = apprMatch[2]!;
    if (action === "approve") return approvalJson(await approveAndSend(env, id));
    if (action === "edit") {
      const body = await readJson<{ text?: string }>(req);
      return approvalJson(await editAndSend(env, id, body.text ?? ""));
    }
    return approvalJson(await discardApproval(env, id));
  }

  // ---- KB ----
  if (path === "/admin/api/kb" && method === "GET") {
    return handleKbGet(env);
  }
  if (path === "/admin/api/kb/sections" && method === "POST") {
    return handleKbCreate(req, env);
  }
  const kbSecMatch = path.match(/^\/admin\/api\/kb\/sections\/(\d+)$/);
  if (kbSecMatch) {
    const id = Number(kbSecMatch[1]);
    if (method === "PUT") return handleKbUpdate(req, env, id);
    if (method === "DELETE") return handleKbDelete(env, id);
  }
  if (path === "/admin/api/kb/revisions" && method === "GET") {
    const limit = clampLimit(url.searchParams.get("limit"), 50);
    return json({ items: await listKbRevisions(env.DB, limit) });
  }
  const revertMatch = path.match(/^\/admin\/api\/kb\/revisions\/(\d+)\/revert$/);
  if (revertMatch && method === "POST") {
    return handleKbRevert(env, Number(revertMatch[1]));
  }
  if (path === "/admin/api/kb/chat" && method === "POST") {
    return handleKbChat(req, env);
  }
  if (path === "/admin/api/kb/confirm" && method === "POST") {
    return handleKbConfirm(req, env);
  }

  // ---- campaigns ----
  if (path === "/admin/api/campaigns" && method === "GET") {
    return json({ items: await listCampaigns(env.DB) });
  }
  if (path === "/admin/api/campaigns" && method === "POST") {
    return handleCampaignCreate(req, env);
  }
  const campMatch = path.match(/^\/admin\/api\/campaigns\/(\d+)$/);
  if (campMatch && method === "PUT") {
    return handleCampaignUpdate(req, env, Number(campMatch[1]));
  }

  // ---- airtable rules ----
  if (path === "/admin/api/rules" && method === "GET") {
    return handleRulesList(env);
  }
  const ruleMatch = path.match(/^\/admin\/api\/rules\/(\d+)$/);
  if (ruleMatch) {
    const id = Number(ruleMatch[1]);
    if (method === "PUT") return handleRuleUpdate(req, env, id);
    if (method === "DELETE") return handleRuleDelete(env, id);
  }

  // ---- edits ----
  if (path === "/admin/api/edits" && method === "GET") {
    const limit = clampLimit(url.searchParams.get("limit"), 50);
    return json({ items: await listEdits(env.DB, limit) });
  }

  // ---- sandbox ----
  if (path === "/admin/api/sandbox" && method === "POST") {
    return handleSandbox(req, env);
  }

  return json({ error: "not_found" }, 404);
}

// ---- login ----

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rlKey = `admin_rl:${ip}`;
  const now = nowSec();

  const state = await kvGet(env.DB, rlKey);
  const decision = decideLoginRateLimit(state, now);
  if (decision.blocked) {
    // Persist the pruned state so the window can eventually clear.
    await kvSet(env.DB, rlKey, decision.stateJson);
    return json({ ok: false, error: "rate_limited" }, 429);
  }

  const body = await readJson<{ password?: string }>(req);
  const provided = body.password ?? "";

  const providedHash = await sha256Hex(provided);
  const expectedHash = await sha256Hex(env.ADMIN_PASSWORD);
  const ok = timingSafeEqual(hexToBytes(providedHash), hexToBytes(expectedHash));

  if (!ok) {
    await kvSet(env.DB, rlKey, recordFailedLogin(state, now));
    return json({ ok: false, error: "invalid" }, 401);
  }

  const cookieValue = await signAdminCookie(env.ADMIN_PASSWORD, now + THIRTY_DAYS);
  return jsonWithCookie({ ok: true }, buildSetCookie(cookieValue, THIRTY_DAYS));
}

// ---- overview ----

async function handleOverview(env: Env): Promise<Response> {
  const [stats, botEnabled, trainingWheels, tokens] = await Promise.all([
    statsOverview(env.DB),
    isBotEnabled(env.DB),
    getTrainingWheels(env),
    overlayTokens(env),
  ]);
  return json({
    botEnabled,
    trainingWheels,
    pendingCount: stats.pendingCount,
    convosToday: stats.convosToday,
    convosWeek: stats.convosWeek,
    month: stats.month,
    overlayTokens: tokens,
  });
}

// ---- bot toggle ----

async function handleBotToggle(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readJson<{ enabled?: boolean }>(req);
  await kvSet(env.DB, "bot_enabled", body.enabled ? "true" : "false");
  // Best-effort: reflect the change in the pinned Slack control panel.
  ctx.waitUntil(updateControlPanel(env).catch(() => {}));
  return json({ ok: true });
}

// ---- conversations ----

function clampLimit(raw: string | null, dflt: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), 200);
}

async function handleConversationsList(env: Env, url: URL): Promise<Response> {
  const limit = clampLimit(url.searchParams.get("limit"), 50);
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  const rows = await listConversations(env.DB, limit, offset);
  const now = nowSec();
  const items = rows.map((r) => ({
    phone: r.phone,
    name: r.name,
    status: r.status,
    lastBody: r.lastBody,
    lastTs: r.lastTs,
    lastDirection: r.lastDirection,
    paused: (r.humanOverrideUntil ?? 0) > now,
    pendingCount: r.pendingCount,
    campaignName: r.campaignName,
  }));
  return json({ items });
}

async function handleConversationDetail(env: Env, phone: string): Promise<Response> {
  const [contact, messages, pending] = await Promise.all([
    getContact(env.DB, phone),
    recentMessages(env.DB, phone, 100),
    getPendingApprovals(env.DB, phone),
  ]);
  if (!contact) return json({ error: "not_found" }, 404);
  return json({ contact, messages, pending });
}

async function handlePause(req: Request, env: Env, phone: string): Promise<Response> {
  const body = await readJson<{ hours?: number }>(req);
  const envHours = Number(env.HUMAN_SNOOZE_HOURS) || 8;
  const hours =
    typeof body.hours === "number" && Number.isFinite(body.hours) && body.hours > 0
      ? body.hours
      : envHours;
  const until = await setHumanOverride(env.DB, phone, hours);
  return json({ ok: true, until });
}

async function handleResume(env: Env, phone: string): Promise<Response> {
  await clearHumanOverride(env.DB, phone);
  return json({ ok: true });
}

async function handleStatus(req: Request, env: Env, phone: string): Promise<Response> {
  const body = await readJson<{ status?: string }>(req);
  const status = body.status === "student" ? "student" : "lead";
  await setContactStatus(env.DB, phone, status);
  return json({ ok: true });
}

// ---- approvals ----

async function handleApprovalsList(env: Env): Promise<Response> {
  const pending = await getPendingApprovals(env.DB);
  // Enrich each with the contact name (getPendingApprovals returns raw rows).
  const items = await Promise.all(
    pending.map(async (a) => {
      const contact = await getContact(env.DB, a.phone);
      return {
        id: a.id,
        phone: a.phone,
        name: contact?.name ?? null,
        draft: a.draft,
        context: a.context,
        createdAt: a.created_at,
      };
    }),
  );
  return json({ items });
}

// ---- KB ----

async function handleKbGet(env: Env): Promise<Response> {
  const sections = await listKbSections(env.DB);
  return json({
    base: { version: kbBaseVersion(), text: KB },
    sections,
    overlayTokens: estimateTokens(assembleOverlay(sections)),
  });
}

async function handleKbCreate(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ title?: string; content?: string; sort?: number }>(req);
  const title = (body.title ?? "").trim();
  const content = body.content ?? "";
  if (!title) return json({ error: "title_required" }, 400);

  const sections = await listKbSections(env.DB);
  // Cap check against a synthetic new section (id -1 never collides).
  const candidate: KbSection = {
    id: -1,
    title,
    content,
    sort: body.sort ?? 100,
    enabled: 1,
    created_at: 0,
    updated_at: 0,
  };
  if (overlayTokensWith(sections, candidate) > OVERLAY_TOKEN_CAP) {
    return json({ error: "overlay_too_large" }, 400);
  }

  const section = await createKbSection(env.DB, {
    title,
    content,
    sort: body.sort,
  });
  await insertKbRevision(env.DB, {
    sectionId: section.id,
    action: "create",
    title: section.title,
    content: section.content,
    prevContent: null,
    source: "manual",
  });
  const after = await listKbSections(env.DB);
  return json({ section, overlayTokens: estimateTokens(assembleOverlay(after)) });
}

async function handleKbUpdate(req: Request, env: Env, id: number): Promise<Response> {
  const prev = await getKbSection(env.DB, id);
  if (!prev) return json({ error: "not_found" }, 404);

  const body = await readJson<{
    title?: string;
    content?: string;
    sort?: number;
    enabled?: number | boolean;
  }>(req);

  const enabled =
    body.enabled === undefined
      ? undefined
      : body.enabled === true || body.enabled === 1
        ? 1
        : 0;

  // Cap check against the projected post-update section.
  const sections = await listKbSections(env.DB);
  const candidate: KbSection = {
    ...prev,
    title: body.title ?? prev.title,
    content: body.content ?? prev.content,
    sort: body.sort ?? prev.sort,
    enabled: enabled ?? prev.enabled,
  };
  if (overlayTokensWith(sections, candidate) > OVERLAY_TOKEN_CAP) {
    return json({ error: "overlay_too_large" }, 400);
  }

  const section = await updateKbSection(env.DB, id, {
    title: body.title,
    content: body.content,
    sort: body.sort,
    enabled,
  });
  if (!section) return json({ error: "not_found" }, 404);

  await insertKbRevision(env.DB, {
    sectionId: id,
    action: "update",
    title: section.title,
    content: section.content,
    prevContent: prev.content,
    source: "manual",
  });
  const after = await listKbSections(env.DB);
  return json({ section, overlayTokens: estimateTokens(assembleOverlay(after)) });
}

async function handleKbDelete(env: Env, id: number): Promise<Response> {
  const prev = await getKbSection(env.DB, id);
  if (!prev) return json({ error: "not_found" }, 404);
  await deleteKbSection(env.DB, id);
  await insertKbRevision(env.DB, {
    sectionId: id,
    action: "delete",
    title: prev.title,
    content: null,
    prevContent: prev.content,
    source: "manual",
  });
  return json({ ok: true });
}

async function handleKbRevert(env: Env, revisionId: number): Promise<Response> {
  const rev = await getKbRevision(env.DB, revisionId);
  if (!rev) return json({ error: "not_found" }, 404);

  // Restore the section's prior content. If the section still exists, update it;
  // if it was deleted, re-create it. prev_content is the "before" snapshot.
  const restoredContent = rev.prev_content ?? "";
  const sectionId = rev.section_id;

  let section: KbSection | null = null;
  if (sectionId !== null) {
    const existing = await getKbSection(env.DB, sectionId);
    if (existing) {
      section = await updateKbSection(env.DB, sectionId, {
        title: rev.title,
        content: restoredContent,
      });
      await insertKbRevision(env.DB, {
        sectionId,
        action: "revert",
        title: rev.title,
        content: restoredContent,
        prevContent: existing.content,
        source: "manual",
      });
    }
  }

  if (!section) {
    // Section is gone (deleted) — re-create it from the revision snapshot.
    section = await createKbSection(env.DB, {
      title: rev.title,
      content: restoredContent,
    });
    await insertKbRevision(env.DB, {
      sectionId: section.id,
      action: "revert",
      title: rev.title,
      content: restoredContent,
      prevContent: null,
      source: "manual",
    });
  }

  return json({ ok: true, section });
}

async function handleKbChat(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ messages?: { role: string; content: string }[] }>(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const result = await runKbChat(env, messages);
  return json({ reply: result.reply, proposals: result.proposals });
}

// applyProposal validation reasons → HTTP status. duplicate_trigger is a 409
// (the UI keys off status===409); the rest are 4xx client errors keyed off
// `error` in the body (e.g. handleOverlayError reads error==="overlay_too_large").
const APPLY_FAIL_STATUS: Record<string, number> = {
  duplicate_trigger: 409,
  overlay_too_large: 400,
  section_not_found: 404,
  unknown_proposal: 400,
};

async function handleKbConfirm(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ proposal?: unknown }>(req);
  if (!body.proposal) return json({ error: "proposal_required" }, 400);
  try {
    const result = await applyProposal(env, body.proposal as never);
    // applyProposal returns a discriminated union; a failed validation is
    // {ok:false, reason} (NOT a thrown error). Map it to the right HTTP status
    // with an {error:<reason>} body so the SPA's api() helper (which only reacts
    // to non-2xx) surfaces it instead of rendering a false "✅ Aplicado".
    if (!result.ok) {
      return json({ error: result.reason }, APPLY_FAIL_STATUS[result.reason] ?? 400);
    }
    return json(result);
  } catch (err) {
    // Backstop: a DB-level unique-constraint violation still maps to 409.
    const msg = err instanceof Error ? err.message : String(err);
    const status = /duplicate|trigger|unique|conflict|exists/i.test(msg) ? 409 : 400;
    return json({ error: msg }, status);
  }
}

// ---- campaigns ----

async function handleCampaignCreate(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    name?: string;
    trigger?: string;
    info?: string;
    endsAt?: number | null;
    adId?: string | null;
  }>(req);
  const name = (body.name ?? "").trim();
  const trigger = (body.trigger ?? "").trim();
  const info = body.info ?? "";
  if (!name || !trigger) return json({ error: "name_and_trigger_required" }, 400);
  const adId = typeof body.adId === "string" ? body.adId.trim() || null : null;

  const triggerNorm = normalizeText(trigger);
  // Duplicate trigger (normalized) → 409. Check before insert; the unique index
  // is a backstop but we want a clean JSON error rather than a thrown DB error.
  const existing = await listCampaigns(env.DB);
  if (existing.some((c) => c.trigger_norm === triggerNorm)) {
    return json({ error: "duplicate_trigger" }, 409);
  }

  try {
    const campaign = await createCampaign(env.DB, {
      name,
      triggerPhrase: trigger,
      triggerNorm,
      info,
      endsAt: body.endsAt ?? null,
      adId,
    });
    return json({ campaign });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|constraint/i.test(msg)) return json({ error: "duplicate_trigger" }, 409);
    throw err;
  }
}

async function handleCampaignUpdate(req: Request, env: Env, id: number): Promise<Response> {
  const existing = await getCampaign(env.DB, id);
  if (!existing) return json({ error: "not_found" }, 404);

  const body = await readJson<{
    name?: string;
    trigger?: string;
    info?: string;
    endsAt?: number | null;
    status?: string;
    adId?: string | null;
  }>(req);

  let triggerNorm: string | undefined;
  if (body.trigger !== undefined) {
    triggerNorm = normalizeText(body.trigger);
    const all = await listCampaigns(env.DB);
    if (all.some((c) => c.id !== id && c.trigger_norm === triggerNorm)) {
      return json({ error: "duplicate_trigger" }, 409);
    }
  }

  const status =
    body.status === "active" || body.status === "paused" || body.status === "ended"
      ? body.status
      : undefined;

  const update: Parameters<typeof updateCampaign>[2] = {
    name: body.name,
    triggerPhrase: body.trigger,
    triggerNorm,
    info: body.info,
    status,
  };
  // endsAt / adId: only forward the key when the client explicitly sent it
  // (an explicit null clears the column; absent leaves it unchanged).
  if ("endsAt" in body) update.endsAt = body.endsAt ?? null;
  if ("adId" in body) {
    update.adId = typeof body.adId === "string" ? body.adId.trim() || null : null;
  }

  try {
    const campaign = await updateCampaign(env.DB, id, update);
    if (!campaign) return json({ error: "not_found" }, 404);
    return json({ campaign });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|constraint/i.test(msg)) return json({ error: "duplicate_trigger" }, 409);
    throw err;
  }
}

// ---- airtable rules ----

/**
 * List rules with parsed trigger/actions, a Spanish summary, and the resolved
 * campaign name (for campaign-triggered rules). A rule whose JSON fails to parse
 * still lists (parsed:null) so the UI can flag it rather than hiding it.
 */
async function handleRulesList(env: Env): Promise<Response> {
  const rules = await listAirtableRules(env.DB);
  // Resolve campaign names once (only campaign-triggered rules need them).
  const campaigns = await listCampaigns(env.DB);
  const campName = (id: number): string | null =>
    campaigns.find((c) => c.id === id)?.name ?? null;

  const items = rules.map((r) => {
    const parsed = parseRule(r.trigger_json, r.actions_json);
    const campaignName =
      parsed && parsed.trigger.type === "campaign"
        ? campName(parsed.trigger.campaignId)
        : null;
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled === 1,
      lastError: r.last_error,
      trigger: parsed?.trigger ?? null,
      actions: parsed?.actions ?? null,
      campaignName,
      summaryEs: parsed ? ruleSummaryEs(parsed.trigger, parsed.actions, campaignName ?? undefined) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
  return json({ items });
}

async function handleRuleUpdate(req: Request, env: Env, id: number): Promise<Response> {
  const existing = await getAirtableRule(env.DB, id);
  if (!existing) return json({ error: "not_found" }, 404);

  const body = await readJson<{ enabled?: boolean; name?: string }>(req);
  const enabled =
    body.enabled === undefined ? undefined : body.enabled ? 1 : 0;
  const name =
    typeof body.name === "string" && body.name.trim() !== ""
      ? body.name.trim()
      : undefined;

  const rule = await updateAirtableRule(env.DB, id, { enabled, name });
  if (!rule) return json({ error: "not_found" }, 404);
  return json({ rule });
}

async function handleRuleDelete(env: Env, id: number): Promise<Response> {
  const existing = await getAirtableRule(env.DB, id);
  if (!existing) return json({ error: "not_found" }, 404);
  await deleteAirtableRule(env.DB, id);
  return json({ ok: true });
}

// ---- sandbox ----

interface CdmxNow {
  iso: string;
  weekday: string;
}

/** CDMX now → ISO + weekday. Mirrors the private helper in pipeline/inbound.ts. */
function cdmxNow(): CdmxNow {
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  return { iso, weekday: get("weekday") };
}

/**
 * Sandbox: run the brain against a synthetic conversation with ZERO side effects.
 * No message inserts, no follow-ups, no Slack, no WhatsApp — we build a dedicated
 * brain per request that shares the real overlay loader + usage accrual, then map
 * the BrainResult straight to JSON. bookTrial is a no-op stub so a booking never
 * hits Airtable.
 */
async function handleSandbox(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ messages?: { role?: string; body?: string }[] }>(req);
  const turns = Array.isArray(body.messages) ? body.messages : [];

  // Build history oldest→newest with descending fake timestamps (newest = now).
  const base = nowSec();
  const history: StoredMessage[] = turns.map((t, i) => {
    const isUser = t.role === "user";
    return {
      wamid: `sandbox-${i}`,
      phone: "sandbox",
      direction: isUser ? "in" : "out_bot",
      body: t.body ?? "",
      ts: base - (turns.length - i), // strictly increasing, all in the past
      meta: null,
    };
  });

  const cdmx = cdmxNow();

  // Mirror the pipeline's campaign matching so campaigns are testable in Probar:
  // if ANY user turn matches an active campaign trigger, attach its info.
  let campaign: ConvoContext["campaign"];
  try {
    const active = await getActiveCampaigns(env.DB);
    if (active.length > 0) {
      for (const t of turns) {
        if (t.role !== "user") continue;
        const id = matchCampaign(normalizeText(t.body ?? ""), active);
        if (id !== null) {
          const c = active.find((x) => x.id === id);
          if (c) campaign = { name: c.name, info: c.info };
          break;
        }
      }
    }
  } catch {
    // sandbox must never fail because of campaign lookup
  }

  const convoCtx: ConvoContext = {
    phone: "sandbox",
    contact: {
      phone: "sandbox",
      name: null,
      lang: "es",
      status: "lead",
      qualification: null,
      human_override_until: null,
      last_inbound_at: base,
      campaign_id: null,
      ad_ref: null,
      airtable_lead_id: null,
      created_at: base,
      updated_at: base,
    },
    history,
    nowCdmx: cdmx.iso,
    weekday: cdmx.weekday,
    windowOpen: true,
    trainingWheels: false,
    ...(campaign ? { campaign } : {}),
  };

  const brain = createBrainWithKb({
    apiKey: env.ANTHROPIC_API_KEY,
    airtable: { bookTrial: async () => "sandbox-record" },
    accrueUsage: (day, inTok, cachedTok, outTok, cost) =>
      accrueUsage(env.DB, day, inTok, cachedTok, outTok, cost),
    loadOverlay: makeOverlayLoader(env.DB),
  });

  const result = await brain.respond(convoCtx);
  return json(brainResultJson(result));
}

/** Maps the brain's discriminated union to the sandbox response shape. */
function brainResultJson(result: BrainResult): Record<string, unknown> {
  switch (result.action) {
    case "send":
      return {
        action: "send",
        message: result.message,
        language: result.language,
        confidence: result.confidence,
      };
    case "draft":
      return {
        action: "draft",
        message: result.message,
        language: result.language,
        confidence: result.confidence,
        reason: result.reason,
      };
    case "escalate":
      return {
        action: "escalate",
        reason: result.reason,
      };
    case "book":
      return {
        action: "book",
        message: result.followupMessage,
        booking: {
          name: result.name,
          discipline: result.discipline,
          audience: result.audience,
          trialDate: result.trialDate,
          trialTime: result.trialTime,
        },
      };
  }
}
