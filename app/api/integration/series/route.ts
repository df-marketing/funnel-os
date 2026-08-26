import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import {
  CHANNEL_SHARED, CHANNEL_SHARED_NOTE, coverageOf, cut as fetchCut, isIsoDayLoose,
  REACH_NOTE, type Cut, type Scope,
} from "@/lib/integration/insight";

export const runtime = "nodejs";

/**
 * One cut of the same table, whichever cut you ask for.
 *
 * Every column list in this app is the same metric bundle under a different
 * grouping — "adding round 0826-02 adds a column, not a formula", as spine.ts
 * puts it. The dashboard has always had eight of them and the integration
 * exposed two shapes: one window's journey stages, and one round. So AcqOS was
 * rolling months up out of frozen rounds, which is a different arithmetic from
 * the one the screen does, and could only ever agree with it by accident.
 *
 * This is the same fo_cut the UI reads, with the same filters, returning the
 * same jsonb. Nothing here computes anything: if a number differs between the
 * report and the screen, it is because the windows differ, not the maths.
 */

/** cut → the view that answers it. The only place the mapping exists. */
const VIEWS = {
  month: "v_metrics_by_month",
  week: "v_metrics_by_week",
  round: "v_metrics_by_round",
  ad: "v_metrics_by_ad",
  adset: "v_metrics_by_adset",
  source: "v_metrics_by_source",
  offer: "v_metrics_by_offer",
  roundsource: "v_metrics_by_round_source",
} as const;

type CutKey = keyof typeof VIEWS;
const isCut = (v: string | null): v is CutKey => v !== null && v in VIEWS;

/** Only this cut is split by offer; fo_cut ignores p_offer everywhere else. */
const OFFERS = ["preview", "middle"] as const;

export async function GET(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") return NextResponse.json({ error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  if (key !== "ok") return new NextResponse(null, { status: 401 });

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const cut = url.searchParams.get("cut");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const product = url.searchParams.get("product") || null;
  const channel = url.searchParams.get("channel") || null;
  const offer = url.searchParams.get("offer") || null;

  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  if (!isCut(cut)) {
    return NextResponse.json({
      error: `cut is required and must be one of: ${Object.keys(VIEWS).join(", ")}`,
    }, { status: 400 });
  }
  // Both or neither. A half-open window reads as a typo far more often than as
  // an intention, and answering one would quietly report a different period
  // from the one asked for.
  if ((from === null) !== (to === null)) {
    return NextResponse.json({ error: "from and to must be given together, or both omitted for all time" }, { status: 400 });
  }
  if (from !== null && (!isIsoDayLoose(from) || !isIsoDayLoose(to) || from > (to as string))) {
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD with from <= to" }, { status: 400 });
  }
  // Refused rather than ignored: fo_cut honours p_offer on v_metrics_by_offer
  // and nowhere else, so passing it to any other cut would return the unsplit
  // rows under a heading that claims otherwise.
  if (offer !== null && cut !== "offer") {
    return NextResponse.json({
      error: `offer only applies to cut=offer — every other cut is unsplit by offer, and would return the same rows under a heading saying it was not`,
    }, { status: 400 });
  }
  if (offer !== null && !OFFERS.includes(offer as (typeof OFFERS)[number])) {
    return NextResponse.json({ error: `offer must be one of: ${OFFERS.join(", ")}` }, { status: 400 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    const scope: Scope = { p_client: clientId, p_product: product, p_channel: channel, p_from: from, p_to: to };
    const [columns, coverage, roundRows] = await Promise.all([
      fetchCut(db, VIEWS[cut], scope, offer),
      coverageOf(db, clientId),
      // Real dates, for the two cuts whose columns are periods with a start and
      // an end. A label is prose; a report placing columns on a calendar needs
      // the dates themselves. Weeks and months carry theirs in the key already.
      cut === "round"
        ? db.from("rounds").select("round_id, start_date, end_date").eq("client_id", clientId)
        : Promise.resolve({ data: [] as Array<{ round_id: string; start_date: string; end_date: string }>, error: null }),
    ]);
    if (roundRows.error) throw new Error(`rounds: ${roundRows.error.message}`);
    const dateOf = new Map((roundRows.data ?? []).map((r) => [r.round_id, r]));

    /**
     * An empty list is an answer, not a fault. A client with no rounds in the
     * window, or no ads on a channel, genuinely has no columns — and a 404 here
     * would make "nothing happened" indistinguishable from "you asked wrongly".
     */
    return NextResponse.json({
      clientId,
      cut,
      filters: { product, channel, offer },
      from,
      to,
      columns: (columns as Cut[]).map((c) => ({
        key: c.cut_key,
        label: c.cut_label,
        sub: c.cut_sub,
        ...(cut === "round"
          ? { startDate: dateOf.get(c.cut_key)?.start_date ?? null, endDate: dateOf.get(c.cut_key)?.end_date ?? null }
          : {}),
        // Present only on cross-tab cuts, where adjacent columns share a header.
        ...(c.group_key !== undefined
          ? { groupKey: c.group_key, groupLabel: c.group_label, groupSub: c.group_sub }
          : {}),
        metrics: c.m ?? {},
      })),
      coverage,
      /**
       * What these numbers cannot say. Carried on every response rather than
       * documented elsewhere, because the caller renders them and the caveat has
       * to travel with the figure it qualifies.
       */
      notes: {
        reach: REACH_NOTE,
        ...(channel ? { channel: CHANNEL_SHARED_NOTE, notChannelAttributable: [...CHANNEL_SHARED] } : {}),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
