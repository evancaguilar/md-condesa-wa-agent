// D1 side of the engagement-driven drip (pure policy: src/cron/nudge-policy.ts).
// ONE batched statement per ≤60 phones, every subquery walking
// idx_messages_phone_ts (phone, ts) in ts order for exactly one phone:
//   first_in  → the phone's oldest inbound (stops at the first match)
//   engaged   → first outbound (~1–2 rows in), then the first REAL inbound
//               after it (stops at the first match; a silent lead costs the
//               rows written after our first message — its own bot/nudge rows)
// INDEXED BY pins the index: without stats the planner may pick
// idx_messages_direction_ts for direction = 'in' (= every inbound ever; the
// rows-read outages of 2026-09). No new index needed — idx_messages_phone_ts is
// worker-applied (src/db/indexes.ts, migr_idx_2026_09_17).

import { OPT_OUT_BUTTON_LABELS } from "../pipeline/promo-button.js";
import type { LeadEngagement } from "../cron/nudge-policy.js";

/** Phones per statement (D1 caps bound parameters at 100). */
export const ENGAGEMENT_CHUNK = 60;

/**
 * Lower-cased bodies that are NOT a reply: the one-tap opt-out quick reply in
 * every spelling a template may carry (the stored body is the raw label, so
 * the accented "más" variant is listed next to the normalized one).
 */
export const OPT_OUT_TAP_BODIES: readonly string[] = [
  ...new Set([...OPT_OUT_BUTTON_LABELS, "no recibir más mensajes"]),
];

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * SQL predicate over inbound alias `i`: a message that counts as an answer.
 * Reactions are stored as "[reaccionó ❤️]" / "[quitó su reacción]"
 * (routes/webhook-parse.ts); an opt-out tap stores its button label.
 */
export const REAL_INBOUND_SQL = (a: string): string =>
  `COALESCE(${a}.body, '') NOT LIKE '[reaccionó%' AND COALESCE(${a}.body, '') <> '[quitó su reacción]' ` +
  `AND lower(trim(COALESCE(${a}.body, ''))) NOT IN (${OPT_OUT_TAP_BODIES.map(lit).join(", ")})`;

/** EXISTS(real inbound strictly after our first outbound) for `phoneExpr`. */
export const ENGAGED_EXISTS_SQL = (phoneExpr: string): string =>
  `EXISTS (
     SELECT 1 FROM messages i INDEXED BY idx_messages_phone_ts
      WHERE i.phone = ${phoneExpr} AND i.direction = 'in'
        AND i.ts > (SELECT o.ts FROM messages o INDEXED BY idx_messages_phone_ts
                     WHERE o.phone = ${phoneExpr} AND o.direction <> 'in'
                     ORDER BY o.ts LIMIT 1)
        AND ${REAL_INBOUND_SQL("i")})`;

function ph(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(", ");
}

/** The batched lookup for `n` phones (binds: the phones). Contacts by PK. */
export const ENGAGEMENT_SQL = (n: number): string =>
  `SELECT c.phone AS phone, c.created_at AS created_at,
          (SELECT f.ts FROM messages f INDEXED BY idx_messages_phone_ts
            WHERE f.phone = c.phone AND f.direction = 'in'
            ORDER BY f.ts LIMIT 1) AS first_in,
          ${ENGAGED_EXISTS_SQL("c.phone")} AS engaged
     FROM contacts c WHERE c.phone IN (${ph(n)})`;

interface EngagementRow {
  phone: string;
  created_at: number | null;
  first_in: number | null;
  engaged: number | null;
}

/**
 * Engagement of each phone. Phones without a contact row are absent (callers
 * treat absent as SILENT). THROWS on a D1 error — every caller catches and
 * falls back to SILENT (the conservative class).
 */
export async function engagementByPhone(
  db: D1Database,
  phones: readonly string[],
): Promise<Map<string, LeadEngagement>> {
  const out = new Map<string, LeadEngagement>();
  const uniq = [...new Set(phones)];
  for (let i = 0; i < uniq.length; i += ENGAGEMENT_CHUNK) {
    const chunk = uniq.slice(i, i + ENGAGEMENT_CHUNK);
    const { results } = await db.prepare(ENGAGEMENT_SQL(chunk.length)).bind(...chunk).all<EngagementRow>();
    for (const r of results ?? []) {
      const first = r.first_in ?? r.created_at ?? null;
      out.set(r.phone, {
        engaged: Number(r.engaged) === 1,
        firstMessageAt: typeof first === "number" && first > 0 ? first : null,
      });
    }
  }
  return out;
}
