// "📹 Videos": prerecorded clips (CLIENT.savedVideos, hosted on the site) that
// staff send to a lead with one tap from the Chats composer or the Agenda tab.
// Spec: docs/dashboard-plan.md §12.
//
// Deliberately a BOT send, not a staff takeover: it's outreach content, so it
// does NOT pause the bot (no setHumanOverride) and does NOT cancel pending
// approvals. Sent by link (WA `video.link`) like the booking video — no upload.
// Deps-injected like staff-send.ts so the decision logic is unit-testable.

import type { SavedVideo } from "../client-config.js";
import type { Env } from "../types.js";
import { getContact } from "../db/queries.js";

/** Caption cap (WA media caption limit is 1024 chars). */
export const SAVED_VIDEO_CAPTION_MAX = 1024;

export type SavedVideoResult =
  | { ok: true; wamid: string; id: string; label: string }
  | {
      ok: false;
      reason: "unknown_video" | "no_contact" | "opted_out" | "window_closed" | "too_long";
    };

/** Looks a clip up by id (exact match). */
export function findSavedVideo(
  list: readonly SavedVideo[] | undefined,
  id: unknown,
): SavedVideo | null {
  if (typeof id !== "string" || !id) return null;
  return (list ?? []).find((v) => v.id === id) ?? null;
}

/** What the SPA needs (via /admin/api/me): id + label only. */
export function publicSavedVideos(
  list: readonly SavedVideo[] | undefined,
): { id: string; label: string }[] {
  return (list ?? []).map((v) => ({ id: v.id, label: v.label }));
}

/** Per-send caption wins over the configured default; blank → none. */
export function resolveCaption(video: SavedVideo, override: unknown): string {
  const c = typeof override === "string" ? override.trim() : "";
  return c || (video.caption ?? "").trim();
}

/** Ops note text (Slack/ops_log). */
export function savedVideoNote(by: string, label: string, who: string): string {
  return `📹 ${by} envió el video '${label}' a ${who}`;
}

/** HTTP status for a result (unknown id → 404, too_long → 400, else 200). */
export function savedVideoStatus(r: SavedVideoResult): number {
  if (r.ok) return 200;
  if (r.reason === "unknown_video") return 404;
  if (r.reason === "too_long") return 400;
  return 200;
}

export interface SavedVideoDeps {
  videos: readonly SavedVideo[] | undefined;
  sendVideo(
    env: Env,
    phone: string,
    url: string,
    caption: string | undefined,
    metaExtra: Record<string, unknown>,
  ): Promise<string>;
  isWindowClosed(err: unknown): boolean;
  postNote(text: string): Promise<void>;
}

/**
 * Sends a saved clip. Order: lookup → contact/opt-out → send (24h window guard
 * lives in sendVideo) → best-effort ops note. Never touches takeover/approvals.
 */
export async function sendSavedVideo(
  env: Env,
  phone: string,
  input: { id: unknown; caption?: unknown },
  by: string,
  deps: SavedVideoDeps,
): Promise<SavedVideoResult> {
  const video = findSavedVideo(deps.videos, input.id);
  if (!video) return { ok: false, reason: "unknown_video" };
  const caption = resolveCaption(video, input.caption);
  if (caption.length > SAVED_VIDEO_CAPTION_MAX) return { ok: false, reason: "too_long" };

  const contact = await getContact(env.DB, phone);
  if (!contact) return { ok: false, reason: "no_contact" };
  if (contact.status === "opted_out") return { ok: false, reason: "opted_out" };

  let wamid: string;
  try {
    wamid = await deps.sendVideo(env, phone, video.url, caption || undefined, {
      savedVideo: video.id,
      by,
    });
  } catch (err) {
    if (deps.isWindowClosed(err)) return { ok: false, reason: "window_closed" };
    throw err;
  }

  try {
    const who = contact.name ? `${contact.name} (${phone})` : phone;
    await deps.postNote(savedVideoNote(by, video.label, who));
  } catch (err) {
    console.error("saved-video note failed", err);
  }
  return { ok: true, wamid, id: video.id, label: video.label };
}
