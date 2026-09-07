import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/supabase/admin";
import { fetchAdRows, fetchReachRows, metaToken, MetaError } from "./graph";
import {
  toAdRows, toReachRows, adKey, newRows, splitReach, coarseKey,
  type AdRow, type ClickKind, type Skipped,
} from "./insights";

/**
 * ONE PULL, TWO DOORS.
 *
 * The button in the Import tab and the shared-key route both land here, so they
 * cannot drift into disagreeing about what a pull does. The doors differ only in
 * who is allowed through them.
 */

export type PullResult = {
  ok: true;
  committed: boolean;
  window: { since: string; until: string };
  account: string;
  clicks: ClickKind;
  fetched: { ad: number; reach: number };
  wouldWrite: number;
  alreadyHad: number;
  written?: number;
  batch?: string;
  rounds: string[];
  skipped: Skipped[];
  reachWithheld: number;
  skippedSpend: number;
  anyFailed: boolean;
  failures: string[];
};

export type PullFailure = { ok: false; error: string; note?: string; status: number };

export async function runPull(
  db: SupabaseClient,
  opts: { clientId: string; since: string; until: string; commit?: boolean; clicks?: ClickKind },
): Promise<PullResult | PullFailure> {
  const token = metaToken();
  if (!token) return { ok: false, error: "no_meta_token", status: 503 };

  const flags = await db
    .from("client_flags").select("meta_ad_account_id")
    .eq("client_id", opts.clientId).maybeSingle();
  if (flags.error) return { ok: false, error: "client_lookup_failed", status: 502 };

  const account = (flags.data as { meta_ad_account_id?: string | null } | null)?.meta_ad_account_id;
  if (!account) {
    return {
      ok: false, error: "no_meta_ad_account", status: 400,
      note: `No Meta ad account is recorded for ${opts.clientId}. Set client_flags.meta_ad_account_id.`,
    };
  }

  // The round comes from the spend date first — see insights.ts roundOf.
  const rounds = await fetchAll<{ round_id: string; start_date: string; end_date: string }>(
    db, "rounds", "round_id, start_date, end_date", (q) => q.eq("client_id", opts.clientId));

  const clicks: ClickKind = opts.clicks ?? "link";
  const skipped: Skipped[] = [];
  let ads: AdRow[] = [];
  let reach: AdRow[] = [];
  const failures: string[] = [];
  // What Meta actually returned, before anything of ours refused any of it.
  // Counting the survivors here reported "Meta returned nothing" for a window
  // where it returned 27 rows and we declined all 27 — which reads as an empty
  // ad account rather than as a refusal, and sends the reader to the wrong place.
  const raw = { ad: 0, reach: 0 };

  // Isolated: reach failing must not lose the spend, and the other way round.
  try {
    const got = await fetchAdRows(account, token, opts.since, opts.until);
    raw.ad = got.length;
    const t = toAdRows(got, rounds, clicks);
    ads = t.rows; skipped.push(...t.skipped);
  } catch (e) {
    failures.push(e instanceof MetaError ? e.code : "ad_fetch_failed");
  }
  try {
    const got = await fetchReachRows(account, token, opts.since, opts.until);
    raw.reach = got.length;
    const t = toReachRows(got, rounds);
    reach = t.rows; skipped.push(...t.skipped);
  } catch (e) {
    failures.push(e instanceof MetaError ? e.code : "reach_fetch_failed");
  }
  if (failures.length === 2) return { ok: false, error: "all_pulls_failed", status: 502 };

  const roundIds = [...new Set([...ads, ...reach].map((r) => r.round_id))];
  const fresh: AdRow[] = [];
  let reachWithheld: Skipped[] = [];
  if (roundIds.length) {
    const existing = await fetchAll<{
      round_id: string; date: string; campaign: string | null;
      ad_set: string | null; ad: string | null; reach: number | null;
    }>(db, "ads_performance", "round_id, date, campaign, ad_set, ad, reach",
       (q) => q.in("round_id", roundIds));

    // 0016 sums every ad_set-null row in a ROUND, so one coarse row is the most
    // a round may have. A second would be added to a figure already covering it.
    const measured = existing
      .filter((r) => !r.ad_set && r.reach !== null)
      .map((r) => coarseKey(r.round_id));
    const split = splitReach(reach, measured);
    reachWithheld = split.withheld;
    fresh.push(...newRows([...ads, ...split.write], existing.map(adKey)));
  }

  const base: PullResult = {
    ok: true,
    committed: false,
    window: { since: opts.since, until: opts.until },
    account, clicks,
    fetched: raw,
    wouldWrite: fresh.length,
    alreadyHad: ads.length + reach.length - fresh.length,
    rounds: [...new Set(fresh.map((r) => r.round_id))].sort(),
    skipped,
    reachWithheld: reachWithheld.length,
    // The money behind the refusals, so "27 rows refused" can be weighed.
    skippedSpend: Math.round(
      skipped.reduce((t, x) => t + (x.spend ?? 0), 0) * 100) / 100,
    anyFailed: failures.length > 0,
    failures,
  };

  if (!opts.commit) return base;
  if (!fresh.length) return { ...base, committed: true, written: 0 };

  const batch = crypto.randomUUID();
  const { error } = await db.from("ads_performance")
    .insert(fresh.map((r) => ({ ...r, import_batch_id: batch })));
  if (error) return { ok: false, error: "write_failed", status: 502 };

  return { ...base, committed: true, written: fresh.length, batch };
}
