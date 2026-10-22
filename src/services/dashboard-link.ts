// Deep link into the admin dashboard's chat view: /admin#chats/<digits>.
// The SPA resolves the digits (any MX phone shape) to the real contact.
import type { Env } from "../types.js";

const DEFAULT_BASE = "https://md-condesa-wa-agent.evancaguilar.workers.dev";

/** null for IG/FB ids (not phone-addressable) or when no digits remain. */
export function dashboardChatUrl(env: Env, phone: string): string | null {
  const raw = String(phone ?? "").trim();
  if (!raw || /^(ig|fb):/i.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const base = ((env as unknown as Record<string, string | undefined>).DASHBOARD_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  return `${base}/admin#chats/${digits}`;
}

/** Any dashboard deep link: dashboardUrl(env, "logs/audit") → …/admin#logs/audit. */
export function dashboardUrl(env: Env, hash: string): string {
  const base = ((env as unknown as Record<string, string | undefined>).DASHBOARD_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  return `${base}/admin#${hash.replace(/^#/, "")}`;
}
