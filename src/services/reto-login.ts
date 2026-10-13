// Calls the site for a Reto course login (see src/pipeline/reto-login.ts for the
// contract). Never throws: any failure becomes RETO_LOGIN_FALLBACK so the member
// always gets an answer.

import {
  parseRetoLoginResponse,
  RETO_LOGIN_FALLBACK,
  type RetoLoginResult,
} from "../pipeline/reto-login.js";

export interface RetoLoginEnv {
  RETO_LOGIN_URL?: string;
  RETO_BOT_SECRET?: string;
}

type Outcome = RetoLoginResult & { error?: string };

const TIMED_OUT = Symbol("timeout");

export async function requestRetoLogin(
  env: RetoLoginEnv,
  phone: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<Outcome> {
  // Never rejects (errors become a fallback Outcome), so losing the race below
  // leaves no unhandled rejection behind.
  const call = async (): Promise<Outcome> => {
    try {
      const r = await fetchFn(env.RETO_LOGIN_URL!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RETO_BOT_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ phone }),
      });
      let body: unknown = null;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      const res = parseRetoLoginResponse(body);
      // The site sends a usable reply even on 502 (Airtable down): relay it, but
      // still report the status so ops sees it.
      return r.ok ? res : { ...res, error: `HTTP ${r.status}` };
    } catch (err) {
      return { reply: RETO_LOGIN_FALLBACK, member: null, ok: false, error: String(err) };
    }
  };
  const timer = new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs));
  const out = await Promise.race([call(), timer]);
  if (out === TIMED_OUT) {
    return { reply: RETO_LOGIN_FALLBACK, member: null, ok: false, error: `timeout ${timeoutMs} ms` };
  }
  return out;
}
