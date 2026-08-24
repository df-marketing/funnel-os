import { NextResponse } from "next/server";
import { hasIntegrationKey } from "@/lib/integration/auth";
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

type ReasonRow = { reason: string | null; rows_waiting: number | string };

/** Ground Up pulls the same filtered totals the Funnel OS UI reads. */
export async function GET(request: Request) {
  if (!hasIntegrationKey(request)) return new NextResponse(null, { status: 401 });

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

  let rounds = db.from("rounds").select("round_id").eq("client_id", clientId).lte("start_date", to).gte("end_date", from).order("start_date");
  if (product) rounds = rounds.eq("product_id", product);

  const [stagesResult, totalResult, statusResult, roundsResult, summaryResult, reasonsResult] = await Promise.all([
    db.from("client_journey_config")
      .select("stage_order, stage_slug, stage_metric, source_type")
      .eq("client_id", clientId).order("stage_order"),
    db.rpc("fo_cut", { p_view: "v_metrics_total", p_client: clientId, p_product: product, p_channel: channel, p_from: from, p_to: to, p_offer: null }),
    db.from("v_import_status")
      .select("source, imported_at, coverage_start, coverage_end, is_stale, days_behind")
      .eq("client_id", clientId).order("source"),
    rounds,
    db.from("v_unmatched_summary").select("waiting").eq("client_id", clientId).maybeSingle(),
    db.from("v_unmatched_by_reason").select("reason, rows_waiting").eq("client_id", clientId),
  ]);

  const firstError = [stagesResult, totalResult, statusResult, roundsResult, summaryResult, reasonsResult]
    .map((result) => result.error).find(Boolean);
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 500 });
  if (!stagesResult.data?.length) return NextResponse.json({ error: "unknown clientId" }, { status: 404 });

  const total = (totalResult.data?.[0] ?? null) as { m?: Metrics } | null;
  const metrics = total?.m ?? {};
  const reasons = Object.fromEntries(
    ((reasonsResult.data ?? []) as ReasonRow[]).map((row) => [row.reason ?? "unknown", Number(row.rows_waiting)]),
  );
  const sources = (statusResult.data ?? []) as ImportStatusRow[];

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
    parked: { count: Number(summaryResult.data?.waiting ?? 0), reasons },
  });
}
