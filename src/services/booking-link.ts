// Ad attribution on the booking links the bot sends (2026-09-11). Pure: no DB,
// no fetch. The website's js/attribution.js reads utm_source / utm_content /
// utm_campaign from the landing URL and prefills the Airtable booking form
// with `Ad = utm (<utm_content>)` + `Adquisición = Pagado`, so a form row
// created from a link we sent in WhatsApp credits the Meta ad the lead clicked
// (contacts.ad_ref.sourceId) instead of landing as "Desconocido".
//
// Rule: only decorate when the ad id is KNOWN. A bare `utm_source=whatsapp`
// without an ad id would still be treated as a paid touch by the site's
// isPaid() (numeric utm_content is the paid signal, not the source), so a lead
// with no referral gets the plain link — exactly as today.

import { CLIENT } from "../client.gen.js";

export interface LinkAttribution {
  /** Meta ad id from the click-to-WhatsApp referral (contacts.ad_ref.sourceId). */
  adId: string | null;
  /** D1 campaign name (campaigns.name) the lead was tagged with, when any. */
  campaignName: string | null;
}

/** Same shape adIdToLearn accepts: Meta ids are digits, but stay tolerant. */
const AD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The ad id inside a contacts.ad_ref JSON blob, or null (tolerant of junk). */
export function adIdFromRef(adRef: string | null | undefined): string | null {
  if (!adRef) return null;
  try {
    const r = JSON.parse(adRef) as { sourceId?: unknown };
    const id = typeof r.sourceId === "string" ? r.sourceId.trim() : "";
    return AD_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Attribution for a contact: the stored first-touch ad_ref wins; a referral on
 * the current inbound (brand-new lead whose ad_ref may not be persisted yet)
 * is the fallback.
 */
export function attributionFor(
  contact: { ad_ref: string | null } | null | undefined,
  campaignName?: string | null,
  referralSourceId?: string | null,
): LinkAttribution {
  const fromRef = adIdFromRef(contact?.ad_ref);
  const fromReferral =
    typeof referralSourceId === "string" && AD_ID_RE.test(referralSourceId.trim())
      ? referralSourceId.trim()
      : null;
  return {
    adId: fromRef ?? fromReferral,
    campaignName: campaignName?.trim() ? campaignName.trim() : null,
  };
}

/**
 * `url` + `?utm_source=whatsapp&utm_content=<adId>[&utm_campaign=<name>]`.
 * Unchanged when there is no ad id, when the url already carries utm_content,
 * or when it is not an absolute http(s) URL. Existing query/hash survive.
 */
export function withAttribution(url: string, attr: LinkAttribution | null | undefined): string;
export function withAttribution(
  url: string | undefined,
  attr: LinkAttribution | null | undefined,
): string | undefined;
export function withAttribution(
  url: string | undefined,
  attr: LinkAttribution | null | undefined,
): string | undefined {
  if (url === undefined || !attr?.adId) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.searchParams.get("utm_content") !== null) return url;
  u.searchParams.set("utm_source", "whatsapp");
  u.searchParams.set("utm_content", attr.adId);
  if (attr.campaignName) u.searchParams.set("utm_campaign", attr.campaignName);
  return u.toString();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The client's booking/schedule URLs, longest first so a prefix never shadows. */
function knownLinks(): string[] {
  const l = CLIENT.links as { booking?: string; bookingKids?: string; schedule?: string };
  return [l.booking, l.bookingKids, l.schedule]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .sort((a, b) => b.length - a.length);
}

/**
 * Rewrites every bare occurrence of a known booking/schedule URL inside free
 * text (a campaign's first_reply, an owner-edited copy string) to its
 * attributed form. An occurrence already followed by `?` or `#` is left alone.
 */
export function decorateBookingLinks(
  text: string,
  attr: LinkAttribution | null | undefined,
  links: readonly string[] = knownLinks(),
): string {
  if (!attr?.adId || !text) return text;
  let out = text;
  for (const link of links) {
    const decorated = withAttribution(link, attr);
    if (decorated === link) continue;
    const re = new RegExp(escapeRe(link) + "(?![?#\\w/])", "g");
    out = out.replace(re, decorated);
  }
  return out;
}
