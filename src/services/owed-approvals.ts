// "Sin responder" — expired approvals the lead is still owed an answer for.
//
// Until 2026-11-11 an approval nobody touched for 12 h was flipped to `expired`
// by the timeout cron (services/slack-timeouts.decideTimeout) and silently left
// the Aprobaciones tab: GET /admin/api/approvals only lists `pending`. The lead
// was never answered and nothing in the panel said so (Evan: "¿perdemos el
// rastro de esa conversación?" — yes).
//
// The cron behavior stays (expiry still stops holding lines / best-bet on a
// stale draft); this module decides which expired rows the panel keeps showing
// in a second "⏱ Sin responder" section until someone deals with them:
//   - window still open (< 24 h since the lead's last message) → the panel can
//     still send the draft (Aprobar / Editar work on an expired row there);
//   - window closed → answer from the OTHER WhatsApp (wa.me link with the draft
//     prefilled) and tap «Ya lo atendí».
//
// A row drops off the list by itself when it no longer represents an open debt:
//   - someone tapped «Ya lo atendí» (kv owedDoneKey) or sent the human_followup
//     template from the Slack card (same marker);
//   - a staff member answered in the panel / WA Business app after the draft
//     was queued (out_human / out_human_echo after created_at);
//   - the lead wrote again and a NEWER approval exists for that phone (the
//     newer row — pending or resolved — carries the conversation now);
//   - the contact opted out;
//   - it is older than OWED_MAX_AGE_SEC (a week-old unanswered lead is a
//     re-engagement job, not an approval).
//
// Pure: the admin route gathers the facts (point reads, see admin-api.ts) and
// this only filters/sorts, so every rule above has a unit test.

/** How long an expired approval stays in "Sin responder". */
export const OWED_MAX_AGE_SEC = 7 * 86400;
/** Hard cap on rows the panel scans per poll (rows-read budget, d1-rows-read). */
export const OWED_SCAN_LIMIT = 60;
/** WhatsApp customer-service window. */
const WINDOW_SEC = 24 * 3600;

/** kv marker: someone handled this expired approval outside the panel. */
export function owedDoneKey(id: number): string {
  return `owed_done:${id}`;
}

export interface OwedCandidate {
  id: number;
  phone: string;
  createdAt: number;
  /** When the cron expired it (resolved_at), if known. */
  expiredAt: number | null;
}

export interface OwedFacts {
  /** Highest approval id for this phone (any status). */
  latestIdForPhone: number | null;
  /** A human message went to the lead after the draft was queued. */
  humanReplyAfter: boolean;
  /** owedDoneKey is set. */
  handled: boolean;
  optedOut: boolean;
  lastInboundAt: number | null;
}

export interface OwedItem extends OwedCandidate {
  windowOpen: boolean;
  /** Hours of WhatsApp window left (ceil), 0 when closed. */
  windowHoursLeft: number;
}

/** Pure. Is this expired row still an open debt? */
export function isOwed(c: OwedCandidate, f: OwedFacts, now: number): boolean {
  if (now - c.createdAt > OWED_MAX_AGE_SEC) return false;
  if (f.handled || f.optedOut || f.humanReplyAfter) return false;
  if (f.latestIdForPhone !== null && f.latestIdForPhone > c.id) return false;
  return true;
}

/** Pure. Window state for an owed row. */
export function owedWindow(
  lastInboundAt: number | null,
  now: number,
): { windowOpen: boolean; windowHoursLeft: number } {
  if (lastInboundAt === null) return { windowOpen: false, windowHoursLeft: 0 };
  const left = WINDOW_SEC - (now - lastInboundAt);
  if (left <= 0) return { windowOpen: false, windowHoursLeft: 0 };
  return { windowOpen: true, windowHoursLeft: Math.ceil(left / 3600) };
}

/**
 * Pure. Keeps one candidate per phone (the newest — an older expired row for
 * the same phone is always superseded by a newer one anyway), newest first.
 * Callers fetch facts only for what this returns.
 */
export function dedupeCandidates<T extends OwedCandidate>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const cur = best.get(r.phone);
    if (!cur || r.id > cur.id) best.set(r.phone, r);
  }
  return [...best.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

/** Pure. Final list: owed rows with their window state, newest first. */
export function selectOwed<T extends OwedCandidate>(
  rows: Array<{ row: T; facts: OwedFacts }>,
  now: number,
): Array<T & { windowOpen: boolean; windowHoursLeft: number }> {
  return rows
    .filter(({ row, facts }) => isOwed(row, facts, now))
    .map(({ row, facts }) => ({ ...row, ...owedWindow(facts.lastInboundAt, now) }))
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

/**
 * wa.me deep link for answering from the other WhatsApp, draft prefilled.
 * Digits only (wa.me rejects "+"/spaces); null for IG/FB ids or empty phones.
 * The text is capped so a long draft can't build an absurd URL.
 */
export function waMeLink(phone: string, text: string | null): string | null {
  if (!/^\d{8,15}$/.test(phone)) return null;
  const base = `https://wa.me/${phone}`;
  const t = (text ?? "").trim().slice(0, 1500);
  return t ? `${base}?text=${encodeURIComponent(t)}` : base;
}
