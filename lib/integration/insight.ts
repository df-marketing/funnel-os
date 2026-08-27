/**
 * What the two insight endpoints have in common.
 *
 * Both answer the same question at different zoom levels — "what happened, and
 * which step of the funnel is the problem" — so both need the journey, the
 * targets, the coverage caveat, and the same JSON shape for a compared metric.
 * Keeping that in one place is what stops the round endpoint and the month
 * endpoint quietly disagreeing about what a `move` is.
 *
 * Nothing here decides anything. The arithmetic lives in lib/funnel/analysis.ts
 * and lib/funnel/diagnose.ts, both of which are pure and testable; this module
 * loads rows and shapes JSON.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Metrics } from "@/lib/funnel/spine";
import type { Move } from "@/lib/funnel/analysis";
import type { Diagnosis, StageRef } from "@/lib/funnel/diagnose";
import { explainStep } from "@/lib/funnel/diagnose";
import { coverageEnds, lastImported, type ImportStatusRow } from "./coverage";
import { isTransientMessage, retryRead } from "@/lib/supabase/transient";

/** One column out of fo_cut. Same shape the dashboard reads. */
export type Cut = {
  cut_key: string;
  cut_label: string;
  cut_sub: string | null;
  m: Metrics | null;
  /**
   * Set only by cross-tab cuts, where adjacent columns sharing a group_key sit
   * under one spanning header — rounds across the top, sources underneath.
   * Absent on every one-dimensional cut, which is how a caller knows there is
   * no second header row to draw.
   */
  group_key?: string | null;
  group_label?: string | null;
  group_sub?: string | null;
};

export type Scope = {
  p_client: string;
  p_product: string | null;
  p_channel: string | null;
  p_from: string | null;
  p_to: string | null;
};

/**
 * fo_cut. `offer` is null for every insight cut and is only ever set by the
 * series endpoint asking for v_metrics_by_offer, which is the one view fo_cut
 * honours it on.
 */
export async function cut(db: SupabaseClient, view: string, scope: Scope, offer: string | null = null): Promise<Cut[]> {
  /**
   * Retried, because this is where the cold-start blip surfaced.
   *
   * AcqOS saw `v_metrics_by_month: JWT issued at future` three times in five
   * minutes and shrugged it off, having built retries; this route turned the
   * same blip into a 500 and cost a report. fo_cut is declared stable and reads
   * nothing but views, so asking twice is free and cannot write anything.
   */
  const { data, error } = await retryRead(
    // Awaited inside the thunk: the rpc builder is a thenable, not a Promise,
    // and handing it back raw leaves the result type unresolvable.
    async () => await db.rpc("fo_cut", { p_view: view, ...scope, p_offer: offer }),
    (r) => ({ transient: !!r.error && isTransientMessage(r.error.message ?? "") }),
  );
  if (error) throw new Error(`${view}: ${error.message}`);
  return (data ?? []) as Cut[];
}

/** YYYY-MM-DD, without asserting the date exists. Cheap enough to run on input. */
export const isIsoDayLoose = (v: string | null): v is string =>
  !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Why a month's reach is not the platform's answer for that month.
 *
 * Reach counts distinct people, so it is the one figure in ads_performance that
 * cannot be added — 0526-02's six ad sets sum to 20,665 against a campaign row
 * of 11,380, an 82% overstatement. 0016 handles that by taking the COARSEST row
 * available rather than summing: a line naming no ad set is already deduplicated
 * across everything under it.
 *
 * That fixes a round. It does not fix a month, because no export carries a
 * month-level row. Shely's May reads 22,803, which is exactly 12,672 + 10,131 —
 * her two rounds' campaign lines added — so anyone reached in both rounds is
 * counted twice, and Frequency, which divides impressions by it, is understated
 * by the same error.
 *
 * The number is still returned. It is the best available and it is roughly
 * right; what it is not is the platform's own figure for the period, and a
 * report that prints it beside a platform export will not reconcile.
 */
export const REACH_NOTE =
  "Reach and Frequency are per-round figures rolled up, not the ad platform's own figure for this period. " +
  "Reach counts distinct people and cannot be added: any column spanning more than one round double-counts " +
  "anyone reached in two of them, and Frequency (impressions / reach) is understated by the same amount. " +
  "A round column is trustworthy where the export carried a campaign-level line; a month or week column is " +
  "an over-count. Reconcile against the platform before publishing either.";

/**
 * The client's journey, as diagnose.ts wants it.
 *
 * Ordered by stage_order and nothing else. A journey with a missing metric is
 * returned as-is rather than repaired: diagnose() reports an unknown pair as a
 * step with no rate, which is the honest answer, and silently dropping the
 * stage would renumber the funnel underneath the reader.
 */
export async function journeyOf(db: SupabaseClient, clientId: string): Promise<StageRef[]> {
  const { data, error } = await db
    .from("client_journey_config")
    .select("stage_order, stage_slug, stage_name, stage_metric")
    .eq("client_id", clientId)
    .order("stage_order");
  if (error) throw new Error(`client_journey_config: ${error.message}`);
  return ((data ?? []) as Array<{
    stage_order: number; stage_slug: string; stage_name: string; stage_metric: string;
  }>).map((r) => ({
    order: r.stage_order,
    slug: r.stage_slug,
    name: r.stage_name,
    metric: r.stage_metric as StageRef["metric"],
  }));
}

/** Agreed numbers, by spine metric key. Empty until someone sets one. */
export async function targetsOf(db: SupabaseClient, clientId: string): Promise<Record<string, number>> {
  const { data, error } = await db.from("v_client_targets").select("metric, target").eq("client_id", clientId);
  if (error) throw new Error(`v_client_targets: ${error.message}`);
  return Object.fromEntries(
    ((data ?? []) as Array<{ metric: string; target: string | number }>).map((r) => [r.metric, Number(r.target)]),
  );
}

/**
 * How far the data actually reaches, carried on every insight.
 *
 * An insight is a claim about a period, and a claim about a period whose files
 * stop halfway through it is worth exactly as much as the reader's knowledge
 * that they do. AcqOS is going to put these numbers in front of a client, so
 * the caveat travels with them rather than being available on request.
 */
export async function coverageOf(db: SupabaseClient, clientId: string) {
  const { data, error } = await db
    .from("v_import_status")
    .select("source, imported_at, coverage_start, coverage_end, is_stale, days_behind")
    .eq("client_id", clientId)
    .order("source");
  if (error) throw new Error(`v_import_status: ${error.message}`);
  const sources = (data ?? []) as ImportStatusRow[];
  return {
    lastImportedAt: lastImported(sources),
    lastObservationDate: coverageEnds(sources),
    anySourceStale: sources.some((s) => s.is_stale),
    sources: sources.map((s) => ({
      source: s.source,
      importedAt: s.imported_at,
      coverageStart: s.coverage_start,
      coverageEnd: s.coverage_end,
      isStale: s.is_stale,
      daysBehind: s.days_behind,
    })),
  };
}

/**
 * One compared metric, as JSON.
 *
 * `thin` and `sample` are carried out to the caller rather than used to filter
 * here, because a rate on a thin denominator is reported and never ranked — and
 * the reporting is AcqOS's job. Dropping it would hide the fact that it was
 * measured at all.
 */
export const moveJson = (m: Move) => ({
  key: m.key,
  label: m.label,
  format: m.fmt,
  direction: m.direction,
  now: m.now,
  previous: m.prev,
  baseline: m.base,
  target: m.target,
  deltaPct: m.deltaPct,
  vsTargetPct: m.vsTargetPct,
  verdict: m.verdict,
  sample: m.sample,
  sampleOf: m.sampleOf,
  thin: m.thin,
});

/** One diagnosed step of the funnel, as JSON, with its one-line reading. */
export const stepJson = (d: Diagnosis) => ({
  from: { slug: d.step.from.slug, name: d.step.from.name, metric: d.step.from.metric },
  to: { slug: d.step.to.slug, name: d.step.to.name, metric: d.step.to.metric },
  rate: d.step.rate,
  rateLabel: d.step.rateLabel,
  move: d.move ? moveJson(d.move) : null,
  pointsAt: d.pointsAt,
  nothingChanged: d.nothingChanged,
  blind: d.blind,
  reading: explainStep(d),
  look: d.look.map((l) => ({
    where: l.where,
    because: l.because,
    measured: l.measured,
    changed: l.changed.map((c) => ({
      kind: c.kind,
      name: c.name,
      change: c.change,
      shareShiftPts: c.shareShift,
      spendNow: c.now?.spend ?? null,
      spendPrev: c.prev?.spend ?? null,
    })),
  })),
});

/**
 * The metrics a channel filter cannot narrow, and why that matters here.
 *
 * fo_filter_people_ok takes a product and NO channel, deliberately: nothing in
 * a leads export says whether a person came from Meta or Google. So a channel
 * filter narrows spend and delivery and never narrows people, and every channel
 * comes back carrying the client's WHOLE lead, attendance and purchase count.
 *
 * fo_channel_blind already nulls the ratios that mix the two — cpl, leadgen,
 * roas and the rest — but it cannot null the raw counts, because 313 leads is a
 * true fact about the window whichever channel you asked about. A report that
 * prints those counts in a per-channel column is stating something false about
 * attribution, and would total to 313 × the number of channels.
 *
 * So the list travels with the per-channel block. A generator that reads it can
 * refuse to put these in a channel column; one that ignores it was told.
 */
export const CHANNEL_SHARED = [
  "leads", "att", "prevBuy", "midBuy", "prevRev", "midRev", "rev",
  "attPct", "prevPct", "midPct",
] as const;

export const CHANNEL_SHARED_NOTE =
  "These metrics are NOT channel-attributable: no leads export says which platform a person came " +
  "from, so every channel carries the client's whole count. They are the same number under each " +
  "channel and must not be shown in a per-channel column or summed across channels. Spend, reach, " +
  "impressions, clicks and their own ratios (CPM, CPC, CTR) are genuinely per-channel. Ratios that " +
  "mix the two are already blank.";

/**
 * Why CPA and ROAS do not divide the counts printed beside them.
 *
 * 0020: these four count only what advertising PRODUCED. 0526-03 sold six
 * preview places and its ads acquired none of the buyers — two AOAI members and
 * four from the AI Community, people already in the room who cost nothing to
 * reach — so its ROAS is not 3.62 and its CPA is not 192.20. Both are '—', and
 * that is the true answer.
 *
 * The cost is that spend / prevBuy no longer reproduces cpa, which reads as an
 * arithmetic fault to anyone who does not know the rule. The denominators now
 * travel in the metrics as paidPrevBuy, paidPrevRev and paidMidRev, so the four
 * can be checked rather than trusted.
 */
export const PAID_RETURNS_NOTE =
  "cpa, roas, prevRoas and midRoas count only what advertising produced, not every sale in the " +
  "window — a customer who was already in the community did not cost ad spend to acquire. So " +
  "spend / prevBuy will NOT reproduce cpa. Divide by paidPrevBuy instead, which is carried in the " +
  "same metrics object: cpa = spend / paidPrevBuy, roas = (paidPrevRev + paidMidRev) / spend. " +
  "A cut whose ad-produced count is zero returns null for all four, which is the honest answer and " +
  "not a missing value.";

/**
 * Why the audience and creative columns do not sum to the period.
 *
 * These cuts are built from the ad set that ACQUIRED each person, so a buyer
 * who was never acquired by an ad has no column to sit in — that is 0020's rule
 * again, applied by omission rather than by blanking. Shely's nine preview
 * purchases are three from Paid Ads and six from AOAI and the AI Community; the
 * three appear, the six are absent by design, and the columns reconcile to 33%.
 *
 * The zeroes on the named audiences are NOT that shortfall and must not be
 * turned into nulls. Cold_Broad acquired 44 people and we followed every one of
 * them to a purchase or not; none bought. That is a measurement, and 0 is what a
 * measurement of none looks like.
 */
export const AD_SLICE_NOTE =
  "Columns here are the ad set or creative that ACQUIRED each person, so they cover only people an " +
  "ad brought in. Purchases and revenue from organic, community and referral leads have no column " +
  "at all — deliberately, since no ad produced them — and these columns will therefore NOT sum to " +
  "the period total. Check them against paidPrevBuy and paidPrevRev on the period, not against " +
  "prevBuy and prevRev. A 0 on a named audience is a measurement: that audience's leads were " +
  "followed and none of them bought. Only a null means unmeasured.";

/**
 * Why a week can have leads and no spend.
 *
 * A Meta export with no day breakdown carries one row per ad set for the whole
 * reporting window, dated to the START of that window. Those rows cannot be put
 * on a week without inventing which days the money went out on, so they are
 * withheld from every week rather than placed on the wrong one.
 */
export const WEEK_ADS_NOTE =
  "Weeks are real seven-day calendar buckets: every lead, attendance and sale is placed on the week " +
  "of its own date. Ad figures are different — a Meta export with no day breakdown dates the whole " +
  "period to its first day, which cannot be split across weeks. Where that is the case, spend, " +
  "reach, impressions, clicks and every ratio built on them are null for EVERY week rather than " +
  "placed on a week the money was not spent in. They fill in on their own once a day-broken-down " +
  "export is imported. Round columns are unaffected.";

/** YYYY-MM. The key v_metrics_by_month cuts on. */
export const isMonth = (v: string | null): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** First and last day of a YYYY-MM, as the window fo_cut takes. */
export function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
