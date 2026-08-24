import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { coverageEnds, lastImported, type ImportStatusRow } from "@/lib/integration/coverage";
import { isIsoDay, JOURNEY_METRIC_KEYS, type SourceType } from "@/lib/integration/schema";
import type { Metrics } from "@/lib/funnel/spine";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type JourneyRow = {
  stage_order: number;
  stage_slug: string;
  stage_metric: keyof typeof JOURNEY_METRIC_KEYS;
  source_type: SourceType | null;
};

/**
 * Parked rows carry no date of their own, so they are placed by the coverage of
 * the batch they arrived in. `undated` is the rows no window can place at all —
 * named rather than dropped, so they cannot vanish from both the count and the
 * caller's attention.
 */
type ParkedCut = {
  count: number;
  allTime: number;
  undated: number;
  reasons: Record<string, number>;
};

/** Ground Up pulls the same filtered totals the Funnel OS UI reads. */
export async function GET(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") return NextResponse.json({ error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  if (key !== "ok") return new NextResponse(null, { status: 401 });

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const product = url.searchParams.get("product") || null;
  const channel = url.searchParams.get("channel") || null;
  if (!clientId || !isIsoDay(from) || !isIsoDay(to) || from > to) {
    return NextResponse.json({ error: "clientId, from and to (YYYY-MM-DD, from <= to) are required" }, { status: 400 });
  }
  // fo_cut only honours p_offer on v_metrics_by_offer. Accepting it here and
  // passing it to v_metrics_total returned the unsplit totals under a filtered
  // heading — refuse it instead, and say where the split actually lives.
  if (url.searchParams.get("offer")) {
    return NextResponse.json({
      error: "offer is not a filter on this endpoint: these are whole-funnel totals, and only the purchase stages differ by offer. Read the preview_purchases and middle_purchases stages instead.",
    }, { status: 400 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  // Overlap, not containment — a round that started before the window and ran
  // into it is part of that window's story (0023).
  //
  // Narrowed by product and NOT by channel, deliberately, because that is what
  // the filter itself does: fo_filter_people_ok takes a product and no channel.
  // Nothing in the leads export says whether a person came from Meta or Google,
  // so a channel filter narrows spend and delivery and never narrows people. A
  // round with no spend in the chosen channel still produced its leads,
  // attendance and sales, and they are still in these totals — dropping it from
  // this list would describe a narrowing the numbers did not make.
  let rounds = db.from("rounds").select("round_id").eq("client_id", clientId).lte("start_date", to).gte("end_date", from).order("start_date");
  if (product) rounds = rounds.eq("product_id", product);

  const [stagesResult, totalResult, statusResult, roundsResult, parkedResult] = await Promise.all([
    db.from("client_journey_config")
      .select("stage_order, stage_slug, stage_metric, source_type")
      .eq("client_id", clientId).order("stage_order"),
    db.rpc("fo_cut", { p_view: "v_metrics_total", p_client: clientId, p_product: product, p_channel: channel, p_from: from, p_to: to, p_offer: null }),
    db.from("v_import_status")
      .select("source, imported_at, coverage_start, coverage_end, is_stale, days_behind")
      .eq("client_id", clientId).order("source"),
    rounds,
    // Counted in SQL against the same window as the stage values, so the caveat
    // and the numbers it qualifies describe one period.
    db.rpc("fo_unmatched_cut", { p_client: clientId, p_from: from, p_to: to }),
  ]);

  const firstError = [stagesResult, totalResult, statusResult, roundsResult, parkedResult]
    .map((result) => result.error).find(Boolean);
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 500 });
  if (!stagesResult.data?.length) return NextResponse.json({ error: "unknown clientId" }, { status: 404 });

  const total = (totalResult.data?.[0] ?? null) as { m?: Metrics } | null;
  const metrics = total?.m ?? {};
  const sources = (statusResult.data ?? []) as ImportStatusRow[];
  const parked = (parkedResult.data ?? null) as ParkedCut | null;

  return NextResponse.json({
    clientId,
    from,
    to,
    filters: { product, channel },
    coverage: {
      lastImportedAt: lastImported(sources),
      lastObservationDate: coverageEnds(sources),
      anySourceStale: sources.some((source) => source.is_stale),
      // Per source, because one number cannot say which file is the short one.
      sources: sources.map((source) => ({
        source: source.source,
        importedAt: source.imported_at,
        coverageStart: source.coverage_start,
        coverageEnd: source.coverage_end,
        isStale: source.is_stale,
        daysBehind: source.days_behind,
      })),
      roundsInWindow: (roundsResult.data ?? []).map((round) => round.round_id),
    },
    stages: ((stagesResult.data ?? []) as JourneyRow[]).map((stage) => ({
      order: stage.stage_order,
      slug: stage.stage_slug,
      metric: stage.stage_metric,
      value: metrics[JOURNEY_METRIC_KEYS[stage.stage_metric]] ?? null,
      sourceType: stage.source_type,
    })),
    parked: {
      count: parked?.count ?? 0,
      reasons: parked?.reasons ?? {},
      allTime: parked?.allTime ?? 0,
      undated: parked?.undated ?? 0,
    },
  });
}
