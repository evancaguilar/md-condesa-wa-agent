// Campaign matching for inbound leads. When a lead's first message repeats the
// trigger phrase from an ad (e.g. "Vi su anuncio de defensa personal"), we tag
// the contact with that campaign so the brain can respond with campaign-specific
// knowledge. Pure module (no I/O) — unit-tested.

import type { Campaign } from "../types.js";

/**
 * Normalize free text for trigger matching:
 *   - NFD decompose + strip combining diacritics ("Ánuncio" → "anuncio")
 *   - lowercase
 *   - strip punctuation (anything not a letter, number, or space)
 *   - collapse runs of whitespace to a single space, trim
 *
 * The same normalization is applied to stored `trigger_norm` (in the KB editor /
 * campaign create path) so equality/prefix comparisons line up.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First active campaign whose normalized trigger matches the normalized inbound
 * body: either the whole body equals the trigger, or the body starts with the
 * trigger (so "curso de defensa ... me interesa" still matches trigger "curso de
 * defensa"). Returns the campaign id, or null when nothing matches.
 *
 * `bodyNorm` is expected already normalized via `normalizeText`.
 */
export function matchCampaign(
  bodyNorm: string,
  campaigns: Campaign[],
): number | null {
  for (const c of campaigns) {
    const trigger = c.trigger_norm;
    if (!trigger) continue;
    if (bodyNorm === trigger || bodyNorm.startsWith(trigger)) {
      return c.id;
    }
  }
  return null;
}

/**
 * First campaign whose `ad_id` contains the referral `source_id` (the Meta ad
 * id). `ad_id` may hold SEVERAL ids separated by commas/whitespace — one
 * campaign concept usually runs as multiple live ads (creatives) in Meta.
 * This takes precedence over trigger-phrase matching: a click-to-WhatsApp lead is
 * attributed by the ad it came from, not by whatever prefilled text it sent.
 * Returns the campaign id, or null when `sourceId` is empty or nothing matches.
 */
export function matchCampaignByAdId(
  sourceId: string | null | undefined,
  campaigns: Campaign[],
): number | null {
  if (!sourceId) return null;
  for (const c of campaigns) {
    if (!c.ad_id) continue;
    if (c.ad_id.split(/[\s,]+/).includes(sourceId)) return c.id;
  }
  return null;
}

/**
 * The instant canned welcome for a brand-new ad lead, or null when none applies:
 * no campaign, the lead already has an outbound message (mid-conversation trigger
 * typing, or human already replied), or the campaign's first_reply is unset/blank.
 * `?? ""` covers the pre-migration shape where the property is absent entirely.
 */
export function firstReplyFor(
  campaign: Campaign | null | undefined,
  hasPriorOutbound: boolean,
): string | null {
  if (!campaign || hasPriorOutbound) return null;
  const text = (campaign.first_reply ?? "").trim();
  return text === "" ? null : text;
}

/** kv key for the at-most-once claim on a phone's first-reply send. */
export function firstReplyKey(phone: string): string {
  return `first_reply_sent:${phone}`;
}
