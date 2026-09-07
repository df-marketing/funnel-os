/**
 * META INSIGHTS → ads_performance ROWS.
 *
 * The whole of the "Pull now" translation, as pure functions. No fetch, no
 * database, no environment — a Graph response goes in and rows come out, so the
 * traps below are testable without a token and without touching a live account.
 *
 * Everything this module refuses to do is as important as what it does. It
 * writes spend, impressions and clicks at ad level and reach at campaign level.
 * It never writes a lead, a conversion, a budget, or anything below the ad —
 * those belong to the CRM and the payments file, and Meta's versions of them are
 * different numbers arrived at a different way.
 *
 * See BRIEF-meta-pull-now-funnel-os.md. The section that matters most is 4a: the
 * campaign string is not a label, it is three facts. The round comes from it,
 * the country comes from its DF_XX_ prefix, and the landing page comes from its
 * LP token — none of them stored, all re-derived on every read. So a campaign
 * name written even slightly differently from the CSV does not merely land in
 * the wrong round; it lands in the wrong country and the wrong landing-page arm
 * at the same time, and the totals stay right while it happens.
 */

/** One row of `level=ad` insights, as Meta sends it. Everything is a string. */
export type MetaAdRow = {
  date_start?: string;
  date_stop?: string;
  campaign_name?: string;
  adset_name?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  account_currency?: string;
};

/** One row of `level=campaign` insights. Reach only — see below. */
export type MetaCampaignRow = {
  date_start?: string;
  campaign_name?: string;
  reach?: string;
};

/** What the pipeline stores. `null` is not `0` and the difference survives. */
export type AdRow = {
  round_id: string;
  date: string;
  campaign: string | null;
  ad_set: string | null;
  ad: string | null;
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  channel: string;
};

export type Skipped = { campaign: string | null; date: string | null; reason: string };

/**
 * A NUMBER META DID NOT SEND IS NOT A ZERO.
 *
 * Trap 5.6, and the app's standing rule. Meta omits null fields entirely, so an
 * absent key and a "0" are different facts and only one of them was measured.
 * `ads_performance` columns default to 0, which would quietly turn the first
 * into the second, so every field is resolved here and written explicitly.
 */
export const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * WHICH CLICK.
 *
 * Three click metrics, none interchangeable (trap 5.7). Funnel OS's loaded
 * history uses Meta's LINK clicks throughout — deliberately, because a CTR is
 * only comparable between a June audience and an August one if it is the same
 * measurement both times. AcqOS's pushed schema declares `outbound_click` for
 * the same stage, and the two differ by a lot on engagement-heavy creative.
 *
 * Default is `link`, matching the reconciled data. Changing it restates every
 * CTR and CPC already reported, so it is a decision and not a default — hence
 * an argument rather than a constant.
 */
export type ClickKind = "link" | "outbound" | "all";

export const clicksFrom = (r: MetaAdRow, kind: ClickKind): number | null => {
  if (kind === "all") return num(r.clicks);
  if (kind === "link") return num(r.inline_link_clicks);
  // outbound_clicks is NOT a top-level field — it lives inside `actions`
  const hit = (r.actions ?? []).find((a) => a.action_type === "outbound_click");
  return num(hit?.value);
};

/**
 * A day, as the ad account reckons it.
 *
 * `date_start` on a `time_increment=1` row is already the account's local day,
 * which is what the pipeline buckets by. It is NOT a UTC instant and must never
 * be parsed as one — appending Z to it shifts a Singapore account by eight
 * hours and moves rows across day boundaries.
 */
export const dayOf = (r: { date_start?: string }): string | null =>
  /^\d{4}-\d{2}-\d{2}$/.test(r.date_start ?? "") ? r.date_start! : null;

/** Trim to null. A blank ad set is not the same as an absent one downstream. */
const text = (v: string | null | undefined): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

export type Round = { round_id: string };

/**
 * The round a campaign names, by the same rule the CSV import uses — one
 * function, so a pulled row and a dropped file can never disagree about which
 * round a campaign belongs to.
 */
export const roundOf = (campaign: string | null, rounds: Round[]): string | null => {
  if (!campaign) return null;
  const hay = campaign.toLowerCase().replace(/_/g, "-");
  return (
    [...rounds]
      .sort((a, b) => b.round_id.length - a.round_id.length)
      .find((r) => hay.includes(r.round_id.toLowerCase().replace(/_/g, "-")))?.round_id ?? null
  );
};

export type Translation = { rows: AdRow[]; skipped: Skipped[] };

/**
 * AD-LEVEL ROWS.
 *
 * `reach` is deliberately left null on every one of these. Reach counts distinct
 * people and does not sum (0016) — six ad sets of one campaign summed to 20,665
 * against the campaign's own 11,380, an 82% overstatement that drags Frequency
 * with it. A per-ad reach is a number that must never be added up, so it is not
 * written at all, and the campaign-level pass supplies the one figure that may be
 * read.
 *
 * A campaign matching no round is REFUSED and named. It is not guessed into a
 * round and not silently dropped: "3 campaigns had no round" is the most useful
 * thing this feature can say, and silence about it reads as success. It doubles
 * as the provenance rule — a campaign nobody mapped is a campaign nobody asked
 * this to manage.
 */
export function toAdRows(
  rows: MetaAdRow[],
  rounds: Round[],
  clicks: ClickKind = "link",
): Translation {
  const out: AdRow[] = [];
  const skipped: Skipped[] = [];

  for (const r of rows) {
    const campaign = text(r.campaign_name);
    const date = dayOf(r);
    if (!date) {
      skipped.push({ campaign, date: null, reason: "no_date_on_row" });
      continue;
    }
    const round_id = roundOf(campaign, rounds);
    if (!round_id) {
      skipped.push({ campaign, date, reason: "no_round_for_campaign" });
      continue;
    }
    out.push({
      round_id,
      date,
      campaign,
      ad_set: text(r.adset_name),
      ad: text(r.ad_name),
      spend: num(r.spend),
      impressions: num(r.impressions),
      reach: null, // 0016 — never per ad
      clicks: clicksFrom(r, clicks),
      channel: "meta",
    });
  }
  return { rows: out, skipped };
}

/**
 * CAMPAIGN-LEVEL REACH.
 *
 * Written with `ad_set` and `ad` null, which is exactly what 0016's rule keys
 * on: `coalesce(sum(reach) filter (where ad_set is null), sum(reach))`. A row
 * naming no ad set is a coarser, already-deduplicated measurement and wins.
 *
 * Spend, impressions and clicks are null here — they are counted at ad level and
 * writing them twice would double every one of them.
 *
 * 0016 also records what this cannot fix: when two campaigns run in one round
 * their reach rows overlap and cannot be added either. 0526-03's two campaigns
 * report 7,902 and 4,863 against a true 10,131. A round with several campaigns
 * still over-counts reach, and the screen says so rather than pretending.
 */
export function toReachRows(rows: MetaCampaignRow[], rounds: Round[]): Translation {
  const out: AdRow[] = [];
  const skipped: Skipped[] = [];

  for (const r of rows) {
    const campaign = text(r.campaign_name);
    const date = dayOf(r);
    if (!date) {
      skipped.push({ campaign, date: null, reason: "no_date_on_row" });
      continue;
    }
    const round_id = roundOf(campaign, rounds);
    if (!round_id) {
      skipped.push({ campaign, date, reason: "no_round_for_campaign" });
      continue;
    }
    out.push({
      round_id, date, campaign,
      ad_set: null, ad: null,
      spend: null, impressions: null,
      reach: num(r.reach),
      clicks: null,
      channel: "meta",
    });
  }
  return { rows: out, skipped };
}

/**
 * The pipeline's ads dedupe key, character for character.
 *
 * Reusing it is what makes the deliberately overlapping window of trap 5.1 free:
 * pull the same day twice and the second write is a no-op. Pressing the button
 * five times must leave the database exactly as pressing it once did.
 */
export const adKey = (r: Pick<AdRow, "round_id" | "date" | "campaign" | "ad_set" | "ad">) =>
  [r.round_id, r.date, r.campaign ?? "", r.ad_set ?? "", r.ad ?? ""].join("|");

/** Rows this pull would add, given what the round already holds. */
export function newRows(rows: AdRow[], existing: Iterable<string>): AdRow[] {
  const seen = new Set(existing);
  const out: AdRow[] = [];
  for (const r of rows) {
    const k = adKey(r);
    if (seen.has(k)) continue;
    seen.add(k); // a pull that repeats a row within itself adds it once
    out.push(r);
  }
  return out;
}

/**
 * REACH IS THE ONE NUMBER A PULL MUST NOT MERGE.
 *
 * 0016's rule reads the coarsest measurement available:
 *
 *     coalesce(sum(reach) filter (where ad_set is null), sum(reach))
 *
 * It SUMS every ad_set-null row for the round. That is right when there is one
 * of them and wrong when there are two, because reach counts distinct people and
 * two rows covering the same people cannot be added.
 *
 * The loaded history already carries exactly one such row per round — the CSV's
 * `ALL CAMPAIGNS 0726-02`, holding 48,287. A campaign-level pull would add a
 * SECOND, under the campaign's real name, and 0726-02's reach would go from
 * 48,287 to roughly double it. Frequency, which is impressions over reach, would
 * halve at the same time. Both numbers are reported and both would be wrong,
 * with the spend beside them still perfectly correct.
 *
 * So a reach row is written only where the round-day has no coarse row yet. A
 * round the CSV has already measured keeps the measurement it has; a round
 * nobody has measured gets one. Nothing is ever added to an existing reach.
 *
 * The withheld rows are returned rather than dropped — "12 reach rows withheld,
 * already measured" is a fact about the pull, and silence about it is how a
 * pull that quietly did nothing reads as one that worked.
 */
export const coarseKey = (round_id: string, date: string) => `${round_id}|${date}`;

export function splitReach(
  rows: AdRow[],
  existingCoarse: Iterable<string>,
): { write: AdRow[]; withheld: Skipped[] } {
  const measured = new Set(existingCoarse);
  const write: AdRow[] = [];
  const withheld: Skipped[] = [];
  for (const r of rows) {
    if (measured.has(coarseKey(r.round_id, r.date))) {
      withheld.push({ campaign: r.campaign, date: r.date, reason: "reach_already_measured" });
      continue;
    }
    // A round-day gets ONE reach row even when several campaigns ran in it:
    // adding two campaigns' reach over-counts the people in both. The first is
    // taken and the rest are named, which is the same refusal 0016 documents.
    measured.add(coarseKey(r.round_id, r.date));
    write.push(r);
  }
  return { write, withheld };
}

/**
 * THE TOKEN IS IN THE PAGINATION URL.
 *
 * `paging.next` carries the access token in its query string. AcqOS leaked a
 * live one this way and was still rotating it when the brief was written.
 * Nothing derived from a Graph URL reaches a log, an error or a response body
 * without going through here first.
 */
export const scrub = (s: string): string =>
  s.replace(/access_token=[^&\s"']+/gi, "access_token=REDACTED");
