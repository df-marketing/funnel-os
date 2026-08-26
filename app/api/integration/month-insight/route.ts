import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import {
  CHANNEL_SHARED, CHANNEL_SHARED_NOTE, coverageOf, cut, isMonth, journeyOf,
  monthWindow, moveJson, stepJson, targetsOf, type Cut, type Scope,
} from "@/lib/integration/insight";
import { missedTargetIn, movesFor, rankedIssues, tooThinIn, type Asset } from "@/lib/funnel/analysis";
import { brokenSteps, diagnose, verdictOf } from "@/lib/funnel/diagnose";
import { DEFAULT_OPTS, isObjective, OBJECTIVES } from "@/lib/funnel/chart";

export const runtime = "nodejs";

/**
 * One month, analysed top-down — the input to AcqOS's monthly report.
 *
 * The shape follows the order the reports are actually written in, because that
 * order IS the analysis:
 *
 *   combined month → per product → per channel → round by round → step drilldown
 *
 * Each level is the same arithmetic at a wider or narrower zoom, and each is
 * returned whole so the generator never has to re-derive one level from another.
 *
 * Rounds come back as a summary with their own key, not fully diagnosed. The
 * detail for any one of them is a call to /api/integration/round-insight with
 * that id — the two endpoints compose rather than duplicating, so a round can
 * never read one way inside the monthly report and another way on its own.
 */
export async function GET(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") return NextResponse.json({ error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  if (key !== "ok") return new NextResponse(null, { status: 401 });

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const month = url.searchParams.get("month");
  const product = url.searchParams.get("product") || null;
  const objectiveParam = url.searchParams.get("objective");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  if (month !== null && !isMonth(month)) {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }
  if (objectiveParam && !isObjective(objectiveParam)) {
    return NextResponse.json({
      error: `unknown objective '${objectiveParam}'. One of: ${Object.keys(OBJECTIVES).join(", ")}`,
    }, { status: 400 });
  }
  const objective = isObjective(objectiveParam) ? objectiveParam : DEFAULT_OPTS.objective;

  // A channel filter is refused rather than ignored. This endpoint's whole job
  // is to report every channel side by side; narrowing to one would leave the
  // byChannel block describing a single column and the combined block silently
  // describing something else. Ask for the channel you want out of byChannel.
  if (url.searchParams.get("channel")) {
    return NextResponse.json({
      error: "channel is not a filter on this endpoint — it reports every channel side by side. Read the byChannel block instead.",
    }, { status: 400 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    const wide: Scope = { p_client: clientId, p_product: product, p_channel: null, p_from: null, p_to: null };
    const [stages, months, baseline, targets, coverage] = await Promise.all([
      journeyOf(db, clientId),
      cut(db, "v_metrics_by_month", wide),
      cut(db, "v_metrics_baseline", wide),
      targetsOf(db, clientId),
      coverageOf(db, clientId),
    ]);

    if (!stages.length) return NextResponse.json({ error: `unknown clientId '${clientId}'` }, { status: 404 });
    if (!months.length) return NextResponse.json({ error: "this client has no months of data" }, { status: 404 });

    // Default to the most recent month with data — which on the 1st is last
    // month, and is the only one the reporting loop asks for unposed.
    const index = month ? months.findIndex((m) => m.cut_key === month) : months.length - 1;
    if (index < 0) {
      return NextResponse.json({
        error: `no data for month '${month}'`,
        months: months.map((m) => m.cut_key),
      }, { status: 404 });
    }
    const now = months[index];
    const prev = index > 0 ? months[index - 1] : null;
    const base = baseline[0] ?? null;
    const window = monthWindow(now.cut_key);
    const inMonth: Scope = { p_client: clientId, p_product: product, p_channel: null, p_from: window.from, p_to: window.to };

    const [products, channels, rounds, sources] = await Promise.all([
      db.from("v_products").select("product_id, product_name, cadence").eq("client_id", clientId).order("product_name"),
      db.from("v_client_channels").select("channel, ad_rows, spend").eq("client_id", clientId).order("channel"),
      cut(db, "v_metrics_by_round", inMonth),
      cut(db, "v_metrics_by_source", inMonth),
    ]);
    if (products.error) throw new Error(`v_products: ${products.error.message}`);
    if (channels.error) throw new Error(`v_client_channels: ${channels.error.message}`);

    const productRows = (products.data ?? []) as Array<{ product_id: string; product_name: string; cadence: string }>;
    const channelRows = (channels.data ?? []) as Array<{ channel: string; ad_rows: number; spend: number | null }>;

    /**
     * Per product and per channel, each read through fo_cut with its own filter
     * rather than by splitting the combined row. Only fo_cut knows which ratios
     * survive which filter, and arithmetic done out here would reconstruct the
     * ones it deliberately blanked.
     */
    const [perProduct, perChannel] = await Promise.all([
      Promise.all(productRows.map(async (p) => ({
        productId: p.product_id,
        name: p.product_name,
        cadence: p.cadence,
        metrics: (await cut(db, "v_metrics_total", { ...inMonth, p_product: p.product_id }))[0]?.m ?? {},
      }))),
      Promise.all(channelRows.map(async (c) => ({
        channel: c.channel,
        metrics: (await cut(db, "v_metrics_total", { ...inMonth, p_channel: c.channel }))[0]?.m ?? {},
      }))),
    ]);

    /**
     * Month-level step 3 compares the assets that carried money across the whole
     * month against the whole month before — which audience or creative was
     * added, dropped or reweighted between one month and the next. Read for the
     * rounds in each window rather than through fo_cut, for the same reason the
     * round endpoint does: the window has already chosen them.
     */
    const prevWindow = prev ? monthWindow(prev.cut_key) : null;
    const roundsPrev: Cut[] = prevWindow
      ? await cut(db, "v_metrics_by_round", { ...inMonth, p_from: prevWindow.from, p_to: prevWindow.to })
      : [];
    const nowIds = rounds.map((r) => r.cut_key);
    const prevIds = roundsPrev.map((r) => r.cut_key);
    const allIds = [...nowIds, ...prevIds];
    const assets = allIds.length
      ? await db.from("v_round_assets")
          .select("round_id, kind, name, spend, leads, spend_share, att, prev_buys, rev")
          .eq("client_id", clientId).in("round_id", allIds)
      : { data: [] as Asset[], error: null };
    if (assets.error) throw new Error(`v_round_assets: ${assets.error.message}`);
    const assetAll = (assets.data ?? []) as Asset[];

    const moves = movesFor(now.m ?? null, prev?.m ?? null, base?.m ?? null, targets);
    const steps = diagnose({
      stages,
      now: now.m ?? null,
      prev: prev?.m ?? null,
      base: base?.m ?? null,
      targets,
      assetsNow: assetAll.filter((a) => nowIds.includes(a.round_id)),
      assetsPrev: assetAll.filter((a) => prevIds.includes(a.round_id)),
      // A month's scroll evidence is per round; the round endpoint is where it
      // can be read against one page. Zero here means "not looked at this zoom".
      scrollRuns: 0,
    });

    return NextResponse.json({
      clientId,
      filters: { product },
      objective,
      month: {
        key: now.cut_key,
        label: now.cut_label,
        sub: now.cut_sub,
        from: window.from,
        to: window.to,
        previousKey: prev?.cut_key ?? null,
        previousLabel: prev?.cut_label ?? null,
        isFirst: prev === null,
      },
      // Level 1 — the combined month.
      combined: {
        metrics: now.m ?? {},
        previousMetrics: prev?.m ?? null,
        moves: moves.map(moveJson),
        issues: rankedIssues(moves, objective).map((m) => ({ ...moveJson(m), onObjective: m.onObjective })),
        tooThin: tooThinIn(moves).map(moveJson),
        missedTarget: missedTargetIn(moves).map(moveJson),
      },
      // Level 2 — each product's month. Only meaningful when there is more than
      // one; a single-product client gets one row identical to combined, which
      // the generator can drop on sight rather than being told it is special.
      byProduct: perProduct,
      // Level 3 — each channel's month, with the attribution caveat attached.
      byChannel: {
        channels: perChannel,
        notChannelAttributable: [...CHANNEL_SHARED],
        note: CHANNEL_SHARED_NOTE,
      },
      // Where the LEADS came from, which is a different question from which
      // platform the money was spent on. Both belong in the report and they are
      // not two views of one thing.
      bySource: sources.map((s) => ({ key: s.cut_key, label: s.cut_label, sub: s.cut_sub, metrics: s.m ?? {} })),
      // Level 4 — round by round. Summary only; the detail is round-insight.
      byRound: rounds.map((r) => ({
        id: r.cut_key,
        label: r.cut_label,
        dates: r.cut_sub,
        metrics: r.m ?? {},
        insightUrl: `/api/integration/round-insight?clientId=${encodeURIComponent(clientId)}&roundId=${encodeURIComponent(r.cut_key)}`,
      })),
      // The one sentence that goes at the top: did the funnel break, or
      // did the numbers move for a reason that is not the funnel's?
      verdict: verdictOf(steps, moves),
      // Level 5 — which step of the funnel broke, month over month.
      steps: steps.map(stepJson),
      brokenSteps: brokenSteps(steps).map(stepJson),
      coverage,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
