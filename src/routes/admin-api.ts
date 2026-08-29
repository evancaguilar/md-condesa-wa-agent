// /admin/api/* — JSON API for the dashboard (login/logout/me, overview, bot +
// training-wheels toggles, conversations, approvals, KB overlay CRUD + chat,
// campaigns, edits, sandbox). All signed-cookie authed except login + UI.
//
// Spec: docs/dashboard-plan.md §5. Zero runtime deps, Web APIs only. It receives
// the Ports bundle so the sandbox route can build a per-request brain that reuses
// the same overlay loader + real usage accrual as production.

import type {
  BookTrialInput,
  BrainResult,
  ConvoContext,
  Env,
  KbSection,
  Ports,
  StoredMessage,
} from "../types.js";
import {
  authenticateLogin,
  buildSetCookie,
  decideLoginRateLimit,
  hashPassword,
  isValidUsername,
  newSaltHex,
  recordFailedLogin,
  signAdminCookieV2,
  timingSafeEqual,
  verifyAdminCookieV2,
  type AdminUserRow,
} from "./admin-auth.js";
import {
  isBotEnabled,
  cancelFollowups,
  cancelPendingApprovals,
  kvGet,
  kvSet,
  getContact,
  recentMessages,
  getPendingApprovals,
  newestInboundWamid,
  scheduleFollowup,
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
  editsAfter,
  statsOverview,
  getTrainingWheels,
  clearHumanOverride,
  resetConversation,
  getActiveCampaigns,
  listAirtableRules,
  getAirtableRule,
  updateAirtableRule,
  deleteAirtableRule,
  getAdminUserSoft,
  listAdminUsersSoft,
  createAdminUser,
  updateAdminUser,
  setAssignedToSoft,
  setReadAtSoft,
  listStaffLater,
  cancelStaffLater,
  listApprovalHistory,
  namesForPhones,
} from "../db/queries-admin.js";
import { parseApprovalHistoryParams } from "../db/approvals-history.js";
import {
  sendStaffMedia,
  sendStaffText,
  parseStaffLaterNote,
  staffLaterNote,
  STAFF_LATER_MAX_HORIZON_SECONDS,
  STAFF_LATER_TOKEN_RE,
  STAFF_TEXT_MAX,
} from "../services/staff-send.js";
import { shiftOutOfQuiet } from "../cron/quiet.js";
import {
  blastComponents,
  loadBlastAudience,
  queueBlast,
  type BlastCandidate,
  type BlastPayload,
} from "../services/blast.js";
import type { Program } from "../cron/nudge-copy.js";
import { sendTemplate } from "../services/send.js";
import {
  markRead,
  sendMedia,
  sendText,
  uploadMedia,
  WindowClosedError,
  type OutboundMediaKind,
} from "../services/send.js";
import { channelOf } from "../services/channel.js";
import { fetchMediaResponse } from "../services/media.js";
import { flagOptOutInAirtable } from "../services/lead-sync.js";
import { parseRule, ruleSummaryEs } from "../services/airtable-rules.js";
import { assembleOverlay, estimateTokens } from "../brain/overlay.js";
import {
  adTextForMatch,
  firstReplyFor,
  matchCampaignTiered,
  normalizeText,
} from "../pipeline/campaigns.js";
import {
  approveAndSend,
  editAndSend,
  discardApproval,
  type ApprovalResult,
  surenessKey,
  guardedApprovalKey,
} from "../services/approvals.js";
import { runKbChat, applyProposal, accrueChatUsage } from "../services/kb-editor.js";
import { auditHumanSend, parseBookingFromText } from "../services/booking-guard.js";
import { registerBooking } from "../services/booking-core.js";
import { callAnthropic, unescapeNewlines } from "../brain/claude.js";
import { buildSystem } from "../brain/prompt.js";
import { runEditAnalysis } from "../services/edit-tuner.js";
import { createBrainWithKb, makeOverlayLoader } from "../brain/index.js";
import { updateControlPanel } from "../services/slack.js";
import {
  AUTO_SEND_DAILY_CAP,
  getAutoSendCount,
  isAutoSendEnabled,
  setAutoSendEnabled,
} from "../services/auto-send.js";
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
  const cookieSession = await verifyAdminCookieV2(
    env.ADMIN_PASSWORD,
    req.headers.get("cookie"),
    nowSec(),
  );
  if (!cookieSession) return json({ error: "unauthorized" }, 401);

  // Per-request user lookup: makes "disable user" effective immediately.
  // Pre-migration (table absent) only evan's break-glass session exists.
  const userRow = await getAdminUserSoft(env.DB, cookieSession.user);
  let session: Session;
  if (userRow) {
    if (userRow.disabled) return json({ error: "unauthorized" }, 401);
    session = {
      user: userRow.username,
      role: userRow.role === "owner" ? "owner" : "staff",
      displayName: userRow.display_name,
    };
  } else if (cookieSession.user === "evan") {
    session = { user: "evan", role: "owner", displayName: "Evan" };
  } else {
    return json({ error: "unauthorized" }, 401); // deleted/unknown user
  }

  // ---- session ----
  if (path === "/admin/api/logout" && method === "POST") {
    return jsonWithCookie({ ok: true }, buildSetCookie("", 0));
  }
  if (path === "/admin/api/me" && method === "GET") {
    return json({
      ok: true,
      user: session.user,
      displayName: session.displayName,
      role: session.role,
    });
  }

  // ---- template blasts (owner-only; see services/blast.ts) ----
  if (path === "/admin/api/blast/preview" && method === "POST") {
    if (session.role !== "owner") return json({ error: "forbidden" }, 403);
    return handleBlastPreview(req, env);
  }
  if (path === "/admin/api/blast/test" && method === "POST") {
    if (session.role !== "owner") return json({ error: "forbidden" }, 403);
    return handleBlastTest(req, env);
  }
  if (path === "/admin/api/blast/queue" && method === "POST") {
    if (session.role !== "owner") return json({ error: "forbidden" }, 403);
    const res = await handleBlastQueue(req, env);
    if (res.note) {
      ctx.waitUntil(ports.slack.postNote(res.note).catch(() => {}));
    }
    return res.response;
  }

  // ---- staff users (owner-only) ----
  if (path === "/admin/api/users" && method === "GET") {
    if (session.role !== "owner") return json({ error: "forbidden" }, 403);
    return handleUsersList(env);
  }
  if (path === "/admin/api/users" && method === "POST") {
    if (session.role !== "owner") return json({ error: "forbidden" }, 403);
    return handleUserCreate(req, env);
  }
  const userMatch = path.match(/^\/admin\/api\/users\/([a-z0-9_-]+)$/);
  if (userMatch && method === "PUT") {
    if (session.role !== "owner") return json({ error: "forbidden" }, 403);
    return handleUserUpdate(req, env, userMatch[1]!, session);
  }
  // Assignment picker needs the roster; any session, names only (no role/hash).
  if (path === "/admin/api/staff" && method === "GET") {
    return handleStaffList(env, session);
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
  // Gated auto-send lane (services/auto-send.ts). GET reads the switch + today's
  // usage; POST flips it (kv absent ⇒ disabled, so the lane ships inert).
  if (path === "/admin/api/autosend" && method === "GET") {
    return handleAutoSendState(env);
  }
  if (path === "/admin/api/autosend" && method === "POST") {
    const body = await readJson<{ enabled?: boolean }>(req);
    await setAutoSendEnabled(env.DB, body.enabled === true);
    // Best-effort: keep the pinned Slack control panel in sync.
    ctx.waitUntil(updateControlPanel(env).catch(() => {}));
    return handleAutoSendState(env);
  }

  // ---- conversations ----
  if (path === "/admin/api/conversations" && method === "GET") {
    return handleConversationsList(env, url);
  }
  // ---- media proxy (auth-gated; resolves Graph media ids to bytes) ----
  const mediaMatch = path.match(/^\/admin\/api\/media\/(\d+)$/);
  if (mediaMatch && method === "GET") {
    const got = await fetchMediaResponse(env, mediaMatch[1]!);
    if (!got) return json({ error: "media_unavailable" }, 404);
    const headers = new Headers();
    headers.set(
      "content-type",
      got.mimeType ?? got.res.headers.get("content-type") ?? "application/octet-stream",
    );
    const len = got.res.headers.get("content-length");
    if (len) headers.set("content-length", len);
    headers.set("cache-control", "private, max-age=3600");
    return new Response(got.res.body, { status: 200, headers });
  }

  const convoMatch = path.match(
    /^\/admin\/api\/conversations\/([^/]+)(\/(pause|resume|status|reset|send|assign|read|unread|send-media|send-later|booking\/parse|booking))?$/,
  );
  if (convoMatch) {
    const phone = decodeURIComponent(convoMatch[1]!);
    const sub = convoMatch[3];
    if (!sub && method === "GET") return handleConversationDetail(env, phone, url);
    if (sub === "pause" && method === "POST") return handlePause(req, env, phone);
    if (sub === "resume" && method === "POST") return handleResume(env, phone);
    if (sub === "status" && method === "POST") {
      return handleStatus(req, env, phone, ports, session);
    }
    if (sub === "send" && method === "POST") {
      return handleStaffSend(req, env, ports, phone, session);
    }
    if (sub === "send-media" && method === "POST") {
      return handleStaffSendMedia(req, env, ports, phone, session);
    }
    if (sub === "send-later" && method === "POST") {
      return handleSendLater(req, env, phone, session);
    }
    if (sub === "booking/parse" && method === "POST") {
      return handleBookingParse(env, phone);
    }
    if (sub === "booking" && method === "POST") {
      return handleBookingRegister(req, env, ports, phone, session);
    }
    if (sub === "assign" && method === "POST") {
      return handleAssign(req, env, phone);
    }
    if (sub === "read" && method === "POST") {
      // Blue ticks to the lead: mark their newest inbound as read. Best-effort.
      const wamid = await newestInboundWamid(env.DB, phone);
      if (wamid) ctx.waitUntil(markRead(env, wamid, phone));
      // Shared (team-wide) read marker; no-op pre-migration.
      await setReadAtSoft(env.DB, phone, nowSec());
      return json({ ok: true });
    }
    if (sub === "unread" && method === "POST") {
      // 0 (not NULL) so the marker beats any per-browser localStorage read map.
      await setReadAtSoft(env.DB, phone, 0);
      return json({ ok: true });
    }
    if (sub === "reset" && method === "POST") {
      // Testing tool: wipe history + claims so the phone acts like a new lead.
      await resetConversation(env.DB, phone);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  // ---- scheduled staff sends ----
  const schedMatch = path.match(/^\/admin\/api\/scheduled\/(\d+)\/cancel$/);
  if (schedMatch && method === "POST") {
    return json({ ok: await cancelStaffLater(env.DB, Number(schedMatch[1])) });
  }

  // ---- approvals ----
  if (path === "/admin/api/approvals" && method === "GET") {
    return handleApprovalsList(env);
  }
  if (path === "/admin/api/approvals/history" && method === "GET") {
    return handleApprovalsHistory(env, url);
  }
  const apprMatch = path.match(/^\/admin\/api\/approvals\/(\d+)\/(approve|edit|discard)$/);
  if (apprMatch && method === "POST") {
    const id = Number(apprMatch[1]);
    const action = apprMatch[2]!;
    let result: ApprovalResult;
    if (action === "approve") result = await approveAndSend(env, id);
    else if (action === "edit") {
      const body = await readJson<{ text?: string }>(req);
      result = await editAndSend(env, id, body.text ?? "");
    } else result = await discardApproval(env, id);
    if (result.ok) {
      // Attribution: who resolved it from the panel (Slack card stays generic).
      const verb =
        action === "approve" ? "aprobada" : action === "edit" ? "editada" : "descartada";
      ctx.waitUntil(
        ports.slack
          .postNote(`✅ Aprobación #${id} ${verb} por ${session.user} desde el panel`)
          .catch(() => {}),
      );
    }
    return approvalJson(result);
  }

  const rewriteMatch = path.match(/^\/admin\/api\/approvals\/(\d+)\/rewrite$/);
  if (rewriteMatch && method === "POST") {
    const body = await readJson<{ guidance?: string }>(req);
    return handleApprovalRewrite(env, Number(rewriteMatch[1]), body.guidance ?? "");
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
  // On-demand edit-pattern analysis (Editor tab "🧠 Analizar ediciones").
  // Read-only wrt the tuner: does NOT touch the cron watermark.
  if (path === "/admin/api/kb/analyze-edits" && method === "POST") {
    const edits = await editsAfter(env.DB, 0, 30);
    if (edits.length === 0) {
      return json({ reply: "No hay ediciones registradas todavía.", proposals: [] });
    }
    const r = await runEditAnalysis(env, edits);
    return json({ reply: r.summary, proposals: r.proposals });
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

// ---- session shape (derived per request from the v2 cookie + admin_users) ----

interface Session {
  user: string;
  role: "owner" | "staff";
  displayName: string;
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

  const body = await readJson<{ username?: string; password?: string }>(req);
  const provided = body.password ?? "";
  const usernameRaw = (body.username ?? "").trim().toLowerCase();
  // Invalid charset is treated as unknown-user (still constant-shaped flow).
  const username = isValidUsername(usernameRaw) ? usernameRaw : usernameRaw === "" ? "" : "\u0000";

  // Master-password compare (break-glass; SHA-256 both sides + timing-safe).
  const providedHash = await sha256Hex(provided);
  const expectedHash = await sha256Hex(env.ADMIN_PASSWORD);
  const masterMatches = timingSafeEqual(
    hexToBytes(providedHash),
    hexToBytes(expectedHash),
  );

  const dbRow = username && username !== "\u0000"
    ? await getAdminUserSoft(env.DB, username)
    : null;
  const userRow: AdminUserRow | null = dbRow
    ? {
        username: dbRow.username,
        display_name: dbRow.display_name,
        pass_salt: dbRow.pass_salt,
        pass_hash: dbRow.pass_hash,
        role: dbRow.role,
        disabled: dbRow.disabled,
      }
    : null;

  const decision2 = await authenticateLogin({
    username: username === "\u0000" ? "invalid" : username,
    password: provided,
    userRow,
    masterMatches,
  });

  if (!decision2.ok) {
    await kvSet(env.DB, rlKey, recordFailedLogin(state, now));
    return json({ ok: false, error: "invalid" }, 401);
  }

  const cookieValue = await signAdminCookieV2(
    env.ADMIN_PASSWORD,
    decision2.user,
    now + THIRTY_DAYS,
  );
  return jsonWithCookie(
    { ok: true, user: decision2.user, role: decision2.role },
    buildSetCookie(cookieValue, THIRTY_DAYS),
  );
}

// ---- staff users (owner-only handlers) ----

async function handleUsersList(env: Env): Promise<Response> {
  const rows = await listAdminUsersSoft(env.DB);
  return json({
    items: rows.map((r) => ({
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      disabled: !!r.disabled,
      createdAt: r.created_at,
    })),
  });
}

async function handleStaffList(env: Env, session: Session): Promise<Response> {
  let items: { user: string; displayName: string }[] = [];
  try {
    const rows = await listAdminUsersSoft(env.DB);
    items = rows
      .filter((r) => !r.disabled)
      .map((r) => ({ user: r.username, displayName: r.display_name }));
  } catch {
    items = [];
  }
  // Pre-migration (admin_users absent) the picker still needs one option.
  if (!items.length) items = [{ user: session.user, displayName: session.displayName }];
  return json({ items });
}

async function handleUserCreate(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    username?: string;
    displayName?: string;
    password?: string;
    role?: string;
  }>(req);
  const username = (body.username ?? "").trim().toLowerCase();
  const displayName = (body.displayName ?? "").trim() || username;
  const password = body.password ?? "";
  const role = body.role === "owner" ? "owner" : "staff";
  if (!isValidUsername(username)) return json({ error: "invalid_username" }, 400);
  if (password.length < 8) return json({ error: "password_too_short" }, 400);
  const salt = newSaltHex();
  const hash = await hashPassword(password, salt);
  try {
    await createAdminUser(env.DB, {
      username,
      displayName,
      passSalt: salt,
      passHash: hash,
      role,
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("users_table_missing")) {
      return json({ error: "users_table_missing" }, 409);
    }
    if (/unique|constraint/i.test(msg)) return json({ error: "duplicate_user" }, 409);
    throw err;
  }
  return json({ ok: true });
}

async function handleUserUpdate(
  req: Request,
  env: Env,
  username: string,
  session: Session,
): Promise<Response> {
  const body = await readJson<{
    displayName?: string;
    password?: string;
    disabled?: boolean;
  }>(req);
  if (body.disabled === true && username === session.user) {
    return json({ error: "cannot_disable_self" }, 400);
  }
  const patch: Parameters<typeof updateAdminUser>[2] = {};
  if (typeof body.displayName === "string" && body.displayName.trim()) {
    patch.displayName = body.displayName.trim();
  }
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 8) return json({ error: "password_too_short" }, 400);
    patch.passSalt = newSaltHex();
    patch.passHash = await hashPassword(body.password, patch.passSalt);
  }
  if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
  const found = await updateAdminUser(env.DB, username, patch);
  if (!found) return json({ error: "not_found" }, 404);
  return json({ ok: true });
}

// ---- staff send (dashboard inbox composer) ----

async function handleStaffSend(
  req: Request,
  env: Env,
  ports: Ports,
  phone: string,
  session: Session,
): Promise<Response> {
  const body = await readJson<{ text?: string; token?: string }>(req);
  const token = (body.token ?? "").trim();
  // 'later:' is the scheduled-send claim namespace — an immediate send using it
  // would burn a scheduled row's at-most-once key into a fake 'sent'.
  if (!token || token.length > 128 || token.startsWith("later:"))
    return json({ error: "token_required" }, 400);
  const result = await sendStaffText(
    env,
    phone,
    body.text ?? "",
    session.user,
    token,
    {
      sendText: (e, p, b, opts) => sendText(e, p, b, opts),
      isWindowClosed: (err) => err instanceof WindowClosedError,
      postNote: (_e, text) => ports.slack.postNote(text),
      auditSend: (e, p, t, by) => auditHumanSend(e, p, t, "staff", by),
    },
  );
  if (!result.ok && (result.reason === "empty" || result.reason === "too_long")) {
    return json({ error: result.reason }, 400);
  }
  // Everything else uses the approvalJson convention: HTTP 200 union.
  return json(result);
}

// ---- scheduled staff send ("send later") ----

/**
 * Queues a staff-composed reply as a followups row (kind='staff_later'). The due
 * time is clamped out of quiet hours here; the 24h window is deliberately NOT
 * checked now — it is re-checked at fire time, where a closed window becomes a
 * loud Slack note instead of a silently swapped template.
 */
async function handleSendLater(
  req: Request,
  env: Env,
  phone: string,
  session: Session,
): Promise<Response> {
  const body = await readJson<{ text?: string; dueAt?: number; token?: string }>(req);
  const text = (body.text ?? "").trim();
  if (!text) return json({ error: "empty" }, 400);
  if (text.length > STAFF_TEXT_MAX) return json({ error: "too_long" }, 400);
  const token = (body.token ?? "").trim();
  if (!STAFF_LATER_TOKEN_RE.test(token)) return json({ error: "token_required" }, 400);
  const now = nowSec();
  const dueAt = Math.floor(Number(body.dueAt));
  if (
    !Number.isFinite(dueAt) ||
    dueAt <= now ||
    dueAt > now + STAFF_LATER_MAX_HORIZON_SECONDS
  ) {
    return json({ error: "bad_due_at" }, 400);
  }
  const contact = await getContact(env.DB, phone);
  if (!contact) return json({ error: "no_contact" }, 404);
  // Mirror the immediate-send rule: a queued message to a baja'd lead would
  // only be silently swallowed at fire time — reject it while a human is here.
  if (contact.status === "opted_out") return json({ error: "opted_out" }, 409);
  const clamped = shiftOutOfQuiet(dueAt);
  // INSERT OR IGNORE on UNIQUE(phone, kind, airtable_record_id): a double submit
  // carrying the same client token is a no-op, never a second queued message.
  await scheduleFollowup(env.DB, {
    phone,
    kind: "staff_later",
    dueAt: clamped,
    airtableRecordId: `later:${token}`,
    note: staffLaterNote(text, session.user),
  });
  // A reused token after a lost response may carry NEW text/time while the OLD
  // row is what fires — confirm what is actually queued, or refuse the mismatch.
  const row = await env.DB.prepare(
    `SELECT due_at AS dueAt, note FROM followups
     WHERE phone = ?1 AND kind = 'staff_later' AND airtable_record_id = ?2`,
  )
    .bind(phone, `later:${token}`)
    .first<{ dueAt: number; note: string | null }>();
  const queued = row ? parseStaffLaterNote(row.note) : null;
  if (row && queued && queued.text !== text) {
    return json({ error: "token_reused" }, 409);
  }
  return json({ ok: true, dueAt: row?.dueAt ?? clamped });
}

// ---- staff media send (multipart: file + token + caption?) ----

const MEDIA_MAX_BYTES = 16 * 1024 * 1024; // WA image limit; videos/docs also capped here (v1)
const MEDIA_KIND_BY_MIME: { re: RegExp; kind: OutboundMediaKind }[] = [
  { re: /^image\/(jpeg|png|webp)$/i, kind: "image" },
  { re: /^video\/(mp4|3gpp)$/i, kind: "video" },
  { re: /^application\/pdf$/i, kind: "document" },
];

async function handleStaffSendMedia(
  req: Request,
  env: Env,
  ports: Ports,
  phone: string,
  session: Session,
): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "multipart_required" }, 400);
  }
  const token = String(form.get("token") ?? "").trim();
  if (!token || token.length > 128) return json({ error: "token_required" }, 400);
  const caption = String(form.get("caption") ?? "");
  // Duck-typed file check (workers-types' FormDataEntryValue lacks File).
  const entry = form.get("file") as unknown;
  const file = entry as Blob & { name?: string; type: string; size: number };
  const isFileLike =
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as Blob).arrayBuffer === "function";
  if (!isFileLike) return json({ error: "file_required" }, 400);
  if (file.size > MEDIA_MAX_BYTES) return json({ error: "file_too_large" }, 400);
  const match = MEDIA_KIND_BY_MIME.find((m) => m.re.test(file.type));
  if (!match) return json({ error: "unsupported_type" }, 400);
  // IG/FB contacts: media attachments are WA-only in v1 — reject before the
  // (WA-specific) Graph media upload burns a request.
  if (channelOf(phone) !== "wa") {
    return json({ error: "channel_unsupported" }, 400);
  }

  const fname = file.name || "archivo";
  let mediaId: string;
  try {
    mediaId = await uploadMedia(env, file, fname);
  } catch (err) {
    console.error("staff media upload failed", err);
    return json({ error: "upload_failed" }, 502);
  }

  const result = await sendStaffMedia(
    env,
    phone,
    {
      kind: match.kind,
      mediaId,
      caption,
      filename: match.kind === "document" ? fname : undefined,
    },
    session.user,
    token,
    {
      sendMedia: (e, p, k, id, opts) => sendMedia(e, p, k, id, opts),
      isWindowClosed: (err) => err instanceof WindowClosedError,
      postNote: (_e, text) => ports.slack.postNote(text),
    },
  );
  if (!result.ok && result.reason === "too_long") {
    return json({ error: "too_long" }, 400);
  }
  return json(result);
}

// ---- booking gap closure (Slice 4) ----

/**
 * Read-only: what class does the LAST outbound message promise? Runs the same
 * deterministic parse (+ the one cheap model fallback) booking-guard uses on
 * live sends, and returns the schedule verdict. Writes nothing.
 */
async function handleBookingParse(env: Env, phone: string): Promise<Response> {
  const messages = await recentMessages(env.DB, phone, 20);
  const lastOut = [...messages]
    .reverse()
    .find((m) => m.direction !== "in" && (m.body ?? "").trim() !== "");
  if (!lastOut) return json({ error: "no_outbound" }, 404);
  const parsed = await parseBookingFromText(
    env,
    phone,
    lastOut.body,
    nowSec(),
  );
  return json({
    ok: true,
    sentText: lastOut.body.slice(0, 500),
    hints: parsed.hints,
    verdict: parsed.verdict,
  });
}

/**
 * Register a trial a human already promised. Same core as the Slack capture
 * card's "Registrar" button: validateSlot (unless `force`) → Airtable →
 * anti-no-show sequence → booking video.
 */
async function handleBookingRegister(
  req: Request,
  env: Env,
  ports: Ports,
  phone: string,
  session: Session,
): Promise<Response> {
  const body = await readJson<{
    name?: string;
    childName?: string;
    discipline?: string;
    audience?: string;
    trialDate?: string;
    trialTime?: string;
    force?: boolean;
  }>(req);
  const discipline = (body.discipline ?? "").trim();
  const trialDate = (body.trialDate ?? "").trim();
  const trialTime = (body.trialTime ?? "").trim();
  if (!discipline) return json({ error: "discipline_required" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trialDate)) return json({ error: "bad_trial_date" }, 400);
  if (!/^\d{1,2}:\d{2}$/.test(trialTime)) return json({ error: "bad_trial_time" }, 400);
  const contact = await getContact(env.DB, phone);
  if (!contact) return json({ error: "no_contact" }, 404);

  const input: BookTrialInput = {
    name: (body.name ?? contact.name ?? "").trim(),
    discipline,
    audience: body.audience === "kid" ? "kid" : "adult",
    trialDate,
    trialTime: trialTime.padStart(5, "0"),
    phone,
  };
  const childName = (body.childName ?? "").trim();
  if (childName) input.childName = childName;

  const result = await registerBooking(env, ports.slack, input, {
    force: body.force === true,
    by: session.user,
  });
  return json(result);
}

// ---- assignment ----

async function handleAssign(req: Request, env: Env, phone: string): Promise<Response> {
  const body = await readJson<{ user?: string | null }>(req);
  const raw = typeof body.user === "string" ? body.user.trim().toLowerCase() : null;
  const user = raw && isValidUsername(raw) ? raw : null;
  await setAssignedToSoft(env.DB, phone, user);
  return json({ ok: true, assignedTo: user });
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

// ---- gated auto-send ----

async function handleAutoSendState(env: Env): Promise<Response> {
  const [enabled, todayCount] = await Promise.all([
    isAutoSendEnabled(env.DB),
    getAutoSendCount(env.DB),
  ]);
  return json({ ok: true, enabled, todayCount, cap: AUTO_SEND_DAILY_CAP });
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

/** How long a cancelled staff_later row stays visible in the chat detail. */
const SCHEDULED_CANCELLED_TTL = 48 * 3600;

function clampLimit(raw: string | null, dflt: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), 200);
}

async function handleConversationsList(env: Env, url: URL): Promise<Response> {
  const limit = clampLimit(url.searchParams.get("limit"), 50);
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80) || null;
  const rows = await listConversations(env.DB, limit, offset, q);
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
    hiConfCount: r.hiConfCount ?? 0,
    approvedAsIsCount: r.approvedAsIsCount ?? 0,
    inboundCount: r.inboundCount ?? 0,
    campaignName: r.campaignName,
    assignedTo: r.assignedTo ?? null,
    readAt: r.readAt ?? null,
    matchBody: r.matchBody ?? null,
  }));
  return json({ items, now });
}

/**
 * Guided rewrite: the reviewer tells the model HOW to change a pending draft
 * and gets a new draft back. Deliberately a bare callAnthropic with NO tools —
 * not brain.respond — so book_trial can never fire from a rewrite. Never sends
 * and never resolves the approval: the client drops the text into the edit box
 * and the normal edit path (editAndSend → insertEdit) both sends and logs the
 * draft→final pair, so every guided rewrite feeds the edit tuner.
 */
async function handleApprovalRewrite(
  env: Env,
  id: number,
  guidance: string,
): Promise<Response> {
  const g = guidance.trim();
  if (!g || g.length > 500) return json({ error: "bad_guidance" }, 400);
  const pending = await getPendingApprovals(env.DB);
  const a = pending.find((x) => x.id === id);
  if (!a) return json({ error: "not_pending" }, 404);

  const [contact, history] = await Promise.all([
    getContact(env.DB, a.phone),
    recentMessages(env.DB, a.phone, 15),
  ]);
  const overlay = await makeOverlayLoader(env.DB)();
  // Same emoji speaker prefixes the approval context uses — the model has seen
  // this transcript format in every draft it produced.
  const convo = history
    .map((m) => {
      const who =
        m.direction === "in"
          ? "👤"
          : m.direction === "out_human" || m.direction === "out_human_echo"
            ? "🧑"
            : "🤖";
      return `${who} ${m.body}`;
    })
    .join("\n");
  const user = [
    `<conversation>\n${convo}\n</conversation>`,
    `<current_draft>\n${a.draft}\n</current_draft>`,
    `<staff_guidance>\n${g}\n</staff_guidance>`,
    contact?.name ? `Lead: ${contact.name}` : "",
    "Reescribe el borrador siguiendo la indicación del staff. Mantén la voz del bot (cálida, breve, emojis ligeros) y el idioma del lead. Responde ÚNICAMENTE con el texto final del mensaje de WhatsApp — sin comillas, sin explicación.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const resp = await callAnthropic(
    fetch,
    env.ANTHROPIC_API_KEY,
    buildSystem(KB, overlay),
    [{ role: "user", content: user }],
    [],
    600,
  );
  await accrueChatUsage(env, resp.usage);
  const text = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) return json({ error: "empty" }, 502);
  return json({ ok: true, text: unescapeNewlines(text) });
}

async function handleConversationDetail(
  env: Env,
  phone: string,
  url: URL,
): Promise<Response> {
  // ?since=<epoch> → incremental poll (inclusive; SPA dedupes by wamid).
  const sinceRaw = Number(url.searchParams.get("since"));
  const since =
    Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : undefined;
  const [contact, messages, pending, laterRows] = await Promise.all([
    getContact(env.DB, phone),
    recentMessages(env.DB, phone, 100, since),
    getPendingApprovals(env.DB, phone),
    listStaffLater(env.DB, phone, nowSec() - SCHEDULED_CANCELLED_TTL),
  ]);
  if (!contact) return json({ error: "not_found" }, 404);
  // Unparseable notes are skipped, not surfaced — the cron cancels those rows.
  const scheduled = laterRows.flatMap((r) => {
    const note = parseStaffLaterNote(r.note);
    return note
      ? [{ id: r.id, dueAt: r.dueAt, status: r.status, text: note.text, by: note.by }]
      : [];
  });
  // Campaign name for the header attribution pill (best-effort).
  let campaignName: string | null = null;
  if (contact.campaign_id != null) {
    try {
      campaignName = (await getCampaign(env.DB, contact.campaign_id))?.name ?? null;
    } catch {
      campaignName = null;
    }
  }
  return json({ contact, messages, pending, scheduled, campaignName, now: nowSec() });
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

/**
 * Manual status change from the dashboard. Setting `opted_out` is the human
 * equivalent of the inbound baja gate (a lead who says it by phone, or a
 * phrase the exact-match gate missed) and mirrors its side effects. Clearing it
 * does NOT untag Airtable — removing the Baja tag stays a manual call.
 */
async function handleStatus(
  req: Request,
  env: Env,
  phone: string,
  ports: Ports,
  session: Session,
): Promise<Response> {
  const body = await readJson<{ status?: string }>(req);
  // Strict whitelist: a malformed value must NOT coerce to "lead" — that would
  // silently clear a baja.
  if (
    body.status !== "student" &&
    body.status !== "opted_out" &&
    body.status !== "lead"
  ) {
    return json({ error: "bad_status" }, 400);
  }
  const status = body.status;
  const before = await getContact(env.DB, phone);
  await setContactStatus(env.DB, phone, status);

  if (status === "opted_out" && before?.status !== "opted_out") {
    await cancelFollowups(env.DB, phone, "skipped_optout");
    await cancelPendingApprovals(env.DB, phone, "discarded");
    try {
      await flagOptOutInAirtable(env, phone);
    } catch (err) {
      console.error("manual opt-out airtable flag failed", err);
    }
    await kvSet(
      env.DB,
      `optout_manual:${phone}`,
      JSON.stringify({ by: session.user, ts: nowSec(), dir: "set" }),
    );
    try {
      await ports.slack.postNote(`🚫 ${phone} marcado como baja por ${session.user}`);
    } catch (err) {
      console.error("manual opt-out slack note failed", err);
    }
  } else if (status !== "opted_out" && before?.status === "opted_out") {
    await kvSet(
      env.DB,
      `optout_manual:${phone}`,
      JSON.stringify({ by: session.user, ts: nowSec(), dir: "clear" }),
    );
    try {
      await ports.slack.postNote(
        `↩️ ${phone} ya no está marcado como baja (${session.user}). La etiqueta Baja en Airtable se quita a mano.`,
      );
    } catch (err) {
      console.error("manual opt-out slack note failed", err);
    }
  }
  return json({ ok: true });
}

// ---- approvals ----

async function handleApprovalsList(env: Env): Promise<Response> {
  const pending = await getPendingApprovals(env.DB);
  // Enrich each with the contact name (getPendingApprovals returns raw rows).
  const items = await Promise.all(
    pending.map(async (a) => {
      const contact = await getContact(env.DB, a.phone);
      // kv side-channels ride along so the panel (and best-bet debugging) can
      // see what the timeout cron will see.
      const surenessRaw = await kvGet(env.DB, surenessKey(a.id));
      const surenessNum = Number(surenessRaw);
      return {
        id: a.id,
        phone: a.phone,
        name: contact?.name ?? null,
        draft: a.draft,
        context: a.context,
        createdAt: a.created_at,
        sureness:
          surenessRaw !== null && Number.isFinite(surenessNum) ? surenessNum : null,
        guarded: (await kvGet(env.DB, guardedApprovalKey(a.id))) === "1",
      };
    }),
  );
  return json({ items });
}

/**
 * Approvals archive: every approval (any status) in a created_at window,
 * newest first. Filters + paging are parsed and clamped by the pure
 * db/approvals-history.ts module (default window 15 days, default limit 100,
 * cap 200 — the same numbers as clampLimit); bad filters are a 400 rather than
 * a silently-wider query. Names come from ONE batched contacts lookup.
 */
async function handleApprovalsHistory(env: Env, url: URL): Promise<Response> {
  const now = nowSec();
  const parsed = parseApprovalHistoryParams(url.searchParams, now);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const q = parsed.query;

  const rows = await listApprovalHistory(env.DB, q);
  const names = await namesForPhones(env.DB, [...new Set(rows.map((r) => r.phone))]);
  const items = rows.map((r) => ({
    id: r.id,
    phone: r.phone,
    name: names.get(r.phone) ?? null,
    draft: r.draft,
    finalText: r.final_text,
    confidence: r.confidence,
    status: r.status,
    holdingSent: r.holding_sent === 1,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    edited: r.status === "edited",
  }));
  return json({ items, now, since: q.since, limit: q.limit, offset: q.offset });
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
  // Airtable-rule proposal validation (WS-2): all client-side 400s.
  unknown_field: 400,
  bad_trigger: 400,
  bad_action: 400,
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
    firstReply?: string | null;
    adKeywords?: string | null;
  }>(req);
  const name = (body.name ?? "").trim();
  const trigger = (body.trigger ?? "").trim();
  const info = body.info ?? "";
  if (!name || !trigger) return json({ error: "name_and_trigger_required" }, 400);
  const adId = typeof body.adId === "string" ? body.adId.trim() || null : null;
  const firstReply = typeof body.firstReply === "string" ? body.firstReply.trim() || null : null;
  const adKeywords = typeof body.adKeywords === "string" ? body.adKeywords.trim() || null : null;

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
      firstReply,
      adKeywords,
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
    firstReply?: string | null;
    adKeywords?: string | null;
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
  // endsAt / adId / firstReply: only forward the key when the client explicitly
  // sent it (an explicit null clears the column; absent leaves it unchanged).
  if ("endsAt" in body) update.endsAt = body.endsAt ?? null;
  if ("adId" in body) {
    update.adId = typeof body.adId === "string" ? body.adId.trim() || null : null;
  }
  if ("firstReply" in body) {
    update.firstReply = typeof body.firstReply === "string" ? body.firstReply.trim() || null : null;
  }
  if ("adKeywords" in body) {
    update.adKeywords = typeof body.adKeywords === "string" ? body.adKeywords.trim() || null : null;
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
// ---- template blasts -------------------------------------------------------

/** Default window start: 2026-08-01 00:00 CDMX ("no agendaron en agosto"). */
const BLAST_DEFAULT_SINCE = Math.floor(Date.parse("2026-08-01T00:00:00-06:00") / 1000);

async function handleBlastPreview(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ since?: number }>(req);
  const since = typeof body.since === "number" ? body.since : BLAST_DEFAULT_SINCE;
  const audience = await loadBlastAudience(env, since, nowSec());
  const sample = (list: BlastCandidate[]): { phone: string; name: string | null }[] =>
    list.slice(0, 8).map((c) => ({ phone: c.phone, name: c.name }));
  return json({
    since,
    counts: {
      adults: audience.adults.length,
      kids: audience.kids.length,
      baby: audience.baby.length,
      excluded: audience.excluded,
    },
    samples: {
      adults: sample(audience.adults),
      kids: sample(audience.kids),
      baby: sample(audience.baby),
    },
  });
}

/** One real template send to a named phone — smoke-tests the template name,
 *  language code, and variable count before any bulk queue. */
async function handleBlastTest(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    phone?: string;
    template?: string;
    lang?: string;
    param2?: string;
  }>(req);
  const phone = (body.phone ?? "").replace(/\D/g, "");
  if (!phone || !body.template || !body.param2) {
    return json({ error: "phone, template y param2 son obligatorios" }, 400);
  }
  try {
    const wamid = await sendTemplate(
      env,
      phone,
      body.template,
      body.lang ?? "es_MX",
      blastComponents("\u{1F44B}", body.param2),
      { force: true },
    );
    return json({ ok: true, wamid });
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
}

async function handleBlastQueue(
  req: Request,
  env: Env,
): Promise<{ response: Response; note?: string }> {
  const body = await readJson<{
    confirm?: boolean;
    runId?: string;
    since?: number;
    dailyCap?: number;
    groups?: { group?: string; template?: string; lang?: string; param2?: string }[];
  }>(req);
  if (body.confirm !== true) {
    return { response: json({ error: "confirm:true requerido" }, 400) };
  }
  const runId = (body.runId ?? "").trim();
  if (!/^[a-z0-9_-]{3,40}$/.test(runId)) {
    return { response: json({ error: "runId invalido (a-z0-9_-, 3-40)" }, 400) };
  }
  if (!Array.isArray(body.groups) || body.groups.length === 0) {
    return { response: json({ error: "groups vacio" }, 400) };
  }
  const since = typeof body.since === "number" ? body.since : BLAST_DEFAULT_SINCE;
  const now = nowSec();
  const audience = await loadBlastAudience(env, since, now);
  const byGroup: Record<Program, BlastCandidate[]> = {
    adults: audience.adults,
    kids: audience.kids,
    baby: audience.baby,
  };
  const groups: {
    group: Program;
    candidates: BlastCandidate[];
    payload: BlastPayload;
  }[] = [];
  for (const g of body.groups) {
    const key = g.group as Program;
    if (key !== "adults" && key !== "kids" && key !== "baby") {
      return { response: json({ error: `grupo desconocido: ${String(g.group)}` }, 400) };
    }
    if (!g.template || !g.param2) {
      return { response: json({ error: `template y param2 obligatorios para ${key}` }, 400) };
    }
    groups.push({
      group: key,
      candidates: byGroup[key],
      payload: { t: g.template, l: g.lang ?? "es_MX", p2: g.param2 },
    });
  }
  const queued = await queueBlast(env, {
    runId,
    groups,
    startEpoch: now,
    ...(typeof body.dailyCap === "number" ? { dailyCap: body.dailyCap } : {}),
  });
  if (queued === null) {
    return { response: json({ error: "runId ya usado (blast duplicado)" }, 409) };
  }
  const detail = groups.map((g) => `${g.group}:${g.candidates.length}`).join(", ");
  return {
    response: json({
      ok: true,
      queued,
      groups: groups.map((g) => ({ group: g.group, count: g.candidates.length })),
    }),
    note: `\u{1F4E3} Blast "${runId}" encolado: ${queued} plantillas (${detail}). Salen en tandas de 50 cada 5 min, 09:00-21:00, tope ${body.dailyCap ?? 250}/dia.`,
  };
}

async function handleSandbox(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    messages?: { role?: string; body?: string }[];
    referral?: { sourceId?: string; headline?: string; body?: string } | null;
  }>(req);
  const turns = Array.isArray(body.messages) ? body.messages : [];
  // Optional simulated ad referral ("Simular anuncio" in Probar). Cleaned to
  // nulls so empty inputs behave exactly like no referral.
  const rawRef = body.referral;
  const referral =
    rawRef && (rawRef.sourceId?.trim() || rawRef.headline?.trim() || rawRef.body?.trim())
      ? {
          sourceId: rawRef.sourceId?.trim() || null,
          headline: rawRef.headline?.trim() || null,
          body: rawRef.body?.trim() || null,
        }
      : null;

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

  // Mirror the pipeline's tiered campaign matching so campaigns are testable in
  // Probar: exact ad-id → ad-creative keywords (simulated referral) → trigger
  // phrase on any user turn. NO auto-learn from the sandbox — zero side effects.
  let campaign: ConvoContext["campaign"];
  let firstReplyCandidate: string | null = null;
  try {
    const active = await getActiveCampaigns(env.DB);
    if (active.length > 0) {
      const adTextNorm = adTextForMatch(referral);
      for (const t of turns) {
        if (t.role !== "user") continue;
        const match = matchCampaignTiered({
          sourceId: referral?.sourceId,
          adTextNorm,
          bodyNorm: normalizeText(t.body ?? ""),
          campaigns: active,
        });
        if (match !== null) {
          const c = active.find((x) => x.id === match.id);
          if (c) {
            campaign = { name: c.name, info: c.info };
            // Instant-reply gate mirrors gate 5c: only fires when this is the
            // lead's first message (a real conversation has no prior outbound).
            firstReplyCandidate = firstReplyFor(c, turns.length !== 1);
          }
          break;
        }
      }
    }
  } catch {
    // sandbox must never fail because of campaign lookup
  }

  // Campaign first-reply short-circuit (gate 5c parity): a fresh lead whose only
  // message matches a campaign with a pre-written welcome gets it instantly — no
  // brain call, mirrors "✅ Enviaría directo" in the sandbox reply card.
  if (firstReplyCandidate) {
    return json({ action: "send", message: firstReplyCandidate, language: "es", confidence: "high" });
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
    // Simulated referral also feeds <ad_info> so Probar mirrors the live prompt.
    ...(referral
      ? { adRef: { headline: referral.headline, body: referral.body, sourceId: referral.sourceId } }
      : {}),
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
        sureness: result.sureness ?? null,
      };
    case "draft":
      return {
        action: "draft",
        message: result.message,
        language: result.language,
        confidence: result.confidence,
        sureness: result.sureness ?? null,
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
