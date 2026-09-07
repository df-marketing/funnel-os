import { scrub, type MetaAdRow, type MetaCampaignRow } from "./insights";

/**
 * THE GRAPH CALLS.
 *
 * Two of them, deliberately — see insights.ts and §4 of the brief. Ad level for
 * spend, impressions and clicks; campaign level for reach, which counts distinct
 * people and cannot be summed out of the ad rows.
 *
 * Server-only. The token is read here, never passed in from a request, never
 * returned, and never allowed into an error — every string that leaves this
 * module goes through `scrub` first, because `paging.next` carries the token in
 * its query string and AcqOS leaked a live one exactly that way.
 */

const VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

/** Pages are capped so a mis-set date range cannot loop the Graph API forever. */
const MAX_PAGES = 50;

export class MetaError extends Error {
  constructor(message: string, readonly code: string) {
    super(scrub(message));
    this.name = "MetaError";
  }
}

const AD_FIELDS = [
  "campaign_name", "adset_name", "ad_name",
  "spend", "impressions", "clicks", "inline_link_clicks",
  "actions", "account_currency",
].join(",");

const CAMPAIGN_FIELDS = ["campaign_name", "reach"].join(",");

type Page<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string; code?: number } };

/**
 * One insights query, followed to the end of its pagination.
 *
 * `time_increment=1` is not optional. Without it a multi-day range returns
 * hour-of-day buckets aggregated across the WHOLE range, every row stamped with
 * the range's start date. It cost AcqOS two live incidents: a five-day round all
 * landed on 9 July, and a backfill put every snapshot on 8 June. Both looked
 * present and were worthless.
 *
 * `since` and `until` are both INCLUSIVE. Meta's range is not a half-open REST
 * interval, so callers should overlap deliberately — the dedupe key makes an
 * overlapping pull free.
 */
async function insights<T>(
  account: string, token: string, level: "ad" | "campaign",
  since: string, until: string, fields: string,
): Promise<T[]> {
  const act = account.startsWith("act_") ? account : `act_${account}`;
  const params = new URLSearchParams({
    level,
    fields,
    time_increment: "1", // mandatory — see above
    time_range: JSON.stringify({ since, until }),
    limit: "200",
    access_token: token,
  });

  let url: string | null = `${BASE}/${act}/insights?${params}`;
  const out: T[] = [];

  for (let page = 0; url && page < MAX_PAGES; page++) {
    let body: Page<T>;
    try {
      const res: Response = await fetch(url, { cache: "no-store" });
      body = (await res.json()) as Page<T>;
      if (!res.ok) {
        // Meta's own message can name the field it disliked, which is useful —
        // but it is echoed through scrub() by MetaError before going anywhere.
        throw new MetaError(body.error?.message ?? `Graph returned ${res.status}`, "graph_error");
      }
    } catch (e) {
      if (e instanceof MetaError) throw e;
      throw new MetaError(scrub(e instanceof Error ? e.message : String(e)), "graph_unreachable");
    }
    out.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }
  return out;
}

export const fetchAdRows = (account: string, token: string, since: string, until: string) =>
  insights<MetaAdRow>(account, token, "ad", since, until, AD_FIELDS);

export const fetchReachRows = (account: string, token: string, since: string, until: string) =>
  insights<MetaCampaignRow>(account, token, "campaign", since, until, CAMPAIGN_FIELDS);

/**
 * The token, from the environment only.
 *
 * Absent is a different fault from wrong — one is a deployment that was never
 * finished, the other a credential that expired — and they need different people
 * to go and fix them, so they answer differently.
 */
export const metaToken = (): string | null => process.env.META_ACCESS_TOKEN || null;

export const MISSING_TOKEN_MESSAGE =
  "META_ACCESS_TOKEN isn't set on this deployment. Create a long-lived token with the " +
  "ads_read scope, run `vercel env add META_ACCESS_TOKEN` for Production, and redeploy. " +
  "Everything else in the app works without it; the Meta pull cannot.";
