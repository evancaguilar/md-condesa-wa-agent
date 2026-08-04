// Meta ad-name lookup for campaign attribution. The click-to-WhatsApp webhook
// referral carries only the ad ID + creative text — NOT the ad's internal name
// ("mananas-999 cafe comparison") that encodes which concept it belongs to. This
// module resolves id → {name, campaignName} via the Graph API once per ad and
// caches it in kv forever (ad names rarely change; a miss retries daily).
//
// Fail-soft by design: no token, API error, or missing ads_read permission all
// degrade to null and the attribution pipeline simply skips the name tier.

import type { Env } from "../types.js";
import { kvGet, kvSet } from "../db/queries.js";

const GRAPH = "https://graph.facebook.com/v23.0";
const KV_PREFIX = "ad_meta:";
/** Retry a cached lookup failure after a day (token/permission may get fixed). */
const MISS_RETRY_SECONDS = 24 * 3600;

export interface AdMeta {
  /** Ad name from Ads Manager, e.g. "mananas-999 cafe comparison". */
  name: string | null;
  /** Meta campaign name the ad belongs to (NOT our dashboard campaigns). */
  campaignName: string | null;
}

interface CachedAdMeta extends Partial<AdMeta> {
  miss?: boolean;
  ts?: number;
}

/**
 * Resolve a Meta ad id to its ad name + Meta campaign name, kv-cached.
 * Uses ADS_ACCESS_TOKEN when set, else tries the WhatsApp token (works when the
 * system user also has ad-account access). Never throws.
 */
export async function lookupAdMeta(
  env: Env,
  adId: string | null | undefined,
): Promise<AdMeta | null> {
  if (!adId || !/^[A-Za-z0-9_-]{1,128}$/.test(adId)) return null;
  const token = env.ADS_ACCESS_TOKEN || env.WA_ACCESS_TOKEN;
  if (!token) return null;

  const key = KV_PREFIX + adId;
  try {
    const cached = await kvGet(env.DB, key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedAdMeta;
      if (!parsed.miss) {
        return { name: parsed.name ?? null, campaignName: parsed.campaignName ?? null };
      }
      const age = Math.floor(Date.now() / 1000) - (parsed.ts ?? 0);
      if (age < MISS_RETRY_SECONDS) return null;
      // stale miss marker → fall through and retry the API
    }
  } catch {
    // cache read/parse problems never block the lookup
  }

  try {
    const res = await fetch(
      `${GRAPH}/${adId}?fields=name,campaign{name}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      await kvSet(
        env.DB,
        key,
        JSON.stringify({ miss: true, ts: Math.floor(Date.now() / 1000) }),
      ).catch(() => {});
      return null;
    }
    const data = (await res.json()) as {
      name?: string;
      campaign?: { name?: string };
    };
    const meta: AdMeta = {
      name: data.name ?? null,
      campaignName: data.campaign?.name ?? null,
    };
    await kvSet(env.DB, key, JSON.stringify(meta)).catch(() => {});
    return meta;
  } catch {
    return null;
  }
}
