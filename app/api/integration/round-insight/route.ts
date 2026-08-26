import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import {
  coverageOf, cut, journeyOf, moveJson, stepJson, targetsOf, type Cut, type Scope,
} from "@/lib/integration/insight";
import { candidatesFrom, diffAssets, missedTargetIn, movesFor, rankedIssues, tooThinIn, type Asset } from "@/lib/funnel/analysis";
import { brokenSteps, diagnose, verdictOf } from "@/lib/funnel/diagnose";
import { DEFAULT_OPTS, isObjective, OBJECTIVES } from "@/lib/funnel/chart";
import { chosenSnapshot, freezeMode, insightWithSnapshot, isClosedDay, snapshotsFor, todayLocal, versionsOf } from "@/lib/integration/freeze";

export const runtime = "nodejs";

/**
 * One finished round, analysed — the input to AcqOS's experiment loop.
 *
 * This is steps 1–5 and 7 of the CRO process for a single round, plus step 3's
 * walk down the funnel. It is the same arithmetic the "This round" tab runs, on
 * the same rows, through the same pure modules — so the deck AcqOS generates and
 * the screen a person is looking at cannot disagree.
 *
 * What it deliberately does NOT do is write the hypothesis or pick the next
 * test. Step 6 is a claim about cause and step 7 is a decision about money;
 * neither is this app's to make. What crosses the wire is an ordered list of
 * what broke, where to look, and what is worth testing — labelled as candidates.
 * A generator that receives a verdict will print a verdict.
 */
// endDate is not here: only POST needs it, and reading it inside the shared
// calculation put a table GET has no use for on the read path — a missing
// rounds row would 500 a request that never asked when the round ended.
type LiveRound = { payload: Record<string, unknown>; periodKey: string };

/** The one live calculation used by both GET and POST. */
async function liveRound(request: Request): Promise<LiveRound | NextResponse> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const roundId = url.searchParams.get("roundId");
  const product = url.searchParams.get("product") || null;
  const channel = url.searchParams.get("channel") || null;
  const objectiveParam = url.searchParams.get("objective");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  if (objectiveParam && !isObjective(objectiveParam)) {
    return NextResponse.json({
      error: `unknown objective '${objectiveParam}'. One of: ${Object.keys(OBJECTIVES).join(", ")}`,
    }, { status: 400 });
  }
  const objective = isObjective(objectiveParam) ? objectiveParam : DEFAULT_OPTS.objective;

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    // Unwindowed: the round list is what decides the window, not the other way
    // round. A from/to here would be a second filter on a selection the round id
    // has already made, and could only ever remove the round being asked about.
    const scope: Scope = { p_client: clientId, p_product: product, p_channel: channel, p_from: null, p_to: null };

    const [stages, rounds, baseline, targets, coverage] = await Promise.all([
      journeyOf(db, clientId),
      cut(db, "v_metrics_by_round", scope),
      cut(db, "v_metrics_baseline", scope),
      targetsOf(db, clientId),
      coverageOf(db, clientId),
    ]);

    if (!stages.length) return NextResponse.json({ error: `unknown clientId '${clientId}'` }, { status: 404 });
    if (!rounds.length) {
      return NextResponse.json({
        error: "this client has no rounds" + (product ? ` for product '${product}'` : ""),
      }, { status: 404 });
    }

    // Default to the most recent round, which is the one that just finished and
    // the only one the loop ever asks for unposed. Named ids stay available so a
    // report can be rebuilt for any round, months later.
    const index = roundId ? rounds.findIndex((r) => r.cut_key === roundId) : rounds.length - 1;
    if (index < 0) {
      return NextResponse.json({
        error: `unknown roundId '${roundId}' for this client`,
        rounds: rounds.map((r) => r.cut_key),
      }, { status: 404 });
    }
    const now = rounds[index];
    // The round before it in the SAME filtered list — so a product filter
    // compares against that product's previous round, not the client's.
    const prev = index > 0 ? rounds[index - 1] : null;
    const base = baseline[0] ?? null;

    const ids = [now.cut_key, prev?.cut_key].filter(Boolean) as string[];
    const [assetRows, scrollRows] = await Promise.all([
      db.from("v_round_assets")
        .select("round_id, kind, name, spend, leads, spend_share, att, prev_buys, rev")
        .eq("client_id", clientId).in("round_id", ids),
      db.from("v_scroll_runs").select("run_id").eq("client_id", clientId).eq("round_id", now.cut_key),
    ]);
    if (assetRows.error) throw new Error(`v_round_assets: ${assetRows.error.message}`);
    if (scrollRows.error) throw new Error(`v_scroll_runs: ${scrollRows.error.message}`);

    const assets = (assetRows.data ?? []) as Asset[];
    const assetsNow = assets.filter((a) => a.round_id === now.cut_key);
    const assetsPrev = prev ? assets.filter((a) => a.round_id === prev.cut_key) : [];

    const moves = movesFor(now.m ?? null, prev?.m ?? null, base?.m ?? null, targets);
    const steps = diagnose({
      stages,
      now: now.m ?? null,
      prev: prev?.m ?? null,
      base: base?.m ?? null,
      targets,
      assetsNow,
      assetsPrev,
      scrollRuns: (scrollRows.data ?? []).length,
    });
    const candidates = candidatesFrom(assetsNow, now.cut_label, objective);

    return {
      periodKey: now.cut_key,
      payload: {
      clientId,
      filters: { product, channel },
      objective,
      round: {
        id: now.cut_key,
        label: now.cut_label,
        dates: now.cut_sub,
        // Null when this is the client's first round: there is nothing behind
        // it, and every percentage on the page says so rather than reading the
        // absence as a zero to divide by.
        previousId: prev?.cut_key ?? null,
        previousLabel: prev?.cut_label ?? null,
        baselineId: base?.cut_key ?? null,
        isFirst: prev === null,
      },
      metrics: now.m ?? {},
      previousMetrics: prev?.m ?? null,
      // Step 1–2: every metric, compared. The caller picks what to print.
      moves: moves.map(moveJson),
      // Step 5: what got worse, ordered by the objective — never filtered by it.
      issues: rankedIssues(moves, objective).map((m) => ({ ...moveJson(m), onObjective: m.onObjective })),
      // Worse, but on a denominator too small to rank. Reported, not ranked.
      tooThin: tooThinIn(moves).map(moveJson),
      missedTarget: missedTargetIn(moves).map(moveJson),
      // The one sentence that goes at the top: did the funnel break, or
      // did the numbers move for a reason that is not the funnel's?
      verdict: verdictOf(steps, moves),
      // Step 3: which step of the funnel broke, and where to look first.
      steps: steps.map(stepJson),
      brokenSteps: brokenSteps(steps).map((d) => stepJson(d)),
      // Step 3's raw material — what was swapped between the two rounds.
      assetChanges: diffAssets(assetsNow, assetsPrev).map((c) => ({
        kind: c.kind, name: c.name, change: c.change, shareShiftPts: c.shareShift,
      })),
      // Step 7: things worth TESTING next round. Never a verdict — see the
      // module comment in lib/funnel/analysis.ts for why the wording matters.
      candidates: {
        judgedOn: candidates.noun,
        shown: candidates.shown,
        droppedForSpace: candidates.dropped,
        tooThin: candidates.tooThin,
        roundProducedNone: candidates.roundHasNone,
        producedButUntracked: candidates.untracked,
        notMeasured: candidates.unavailable,
      },
      coverage,
      generatedAt: new Date().toISOString(),
      },
    };
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

function guarded(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") return NextResponse.json({ error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  return key === "ok" ? null : new NextResponse(null, { status: 401 });
}

function versionParam(url: URL) {
  const raw = url.searchParams.get("version");
  if (raw === null) return null;
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined;
}

/**
 * The stored copy is consulted BEFORE anything is calculated.
 *
 * A frozen insight exists to survive changes underneath it, and some of those
 * changes stop the live path producing that round at all — the round moved to
 * another product, the journey config was edited, the row was deleted. Reading
 * the table second meant those were exactly the cases where the frozen copy
 * became unreachable: the request died on the recalculation it was trying not
 * to depend on.
 */
export async function GET(request: Request) {
  const denied = guarded(request); if (denied) return denied;
  const url = new URL(request.url);
  const mode = freezeMode(url.searchParams.get("frozen"));
  const version = versionParam(url);
  if (!mode || version === undefined) return NextResponse.json({ error: "frozen must be prefer, only or never; version must be a positive integer" }, { status: 400 });

  const clientId = url.searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  const roundId = url.searchParams.get("roundId");
  const pinned = version !== null || mode === "only";

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    // Only a named round can be looked up without computing one. Without an id
    // the period is "whichever round is most recent", and answering that is the
    // calculation `only` is refusing to run — so say so rather than guess.
    if (!roundId && pinned) {
      return NextResponse.json({
        error: "frozen=only and version need an explicit roundId: without one the period is 'the most recent round', and resolving that needs the live calculation this mode refuses to run.",
      }, { status: 400 });
    }

    let rows = roundId ? await snapshotsFor(db, clientId, "round", roundId) : [];
    if (roundId && mode !== "never") {
      const chosen = chosenSnapshot(rows, mode, version);
      if (chosen) return NextResponse.json(insightWithSnapshot(chosen.payload, chosen, versionsOf(rows)));
      if (pinned) {
        return NextResponse.json({
          error: `no frozen insight for round '${roundId}'${version !== null ? ` version ${version}` : ""}`,
          versions: versionsOf(rows),
        }, { status: 404 });
      }
    }

    const live = await liveRound(request); if (live instanceof NextResponse) return live;
    if (!roundId) rows = await snapshotsFor(db, clientId, "round", live.periodKey);
    const chosen = mode === "never" ? null : chosenSnapshot(rows, mode, version);
    return NextResponse.json(chosen
      ? insightWithSnapshot(chosen.payload, chosen, versionsOf(rows))
      : insightWithSnapshot(live.payload, null, versionsOf(rows)));
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}

export async function POST(request: Request) {
  const denied = guarded(request); if (denied) return denied;
  let body: { frozenBy?: string; note?: string; replace?: boolean; force?: boolean } = {};
  try { body = await request.json(); } catch { /* every field is optional */ }
  const live = await liveRound(request); if (live instanceof NextResponse) return live;
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });
  const clientId = String(live.payload.clientId);

  try {
    // Read here rather than in the shared calculation: only the freeze needs to
    // know when the round ended, and a GET should not fail on a column it never
    // looks at.
    const roundRow = await db.from("rounds").select("end_date")
      .eq("client_id", clientId).eq("round_id", live.periodKey).maybeSingle();
    if (roundRow.error) throw new Error(`rounds: ${roundRow.error.message}`);
    const endDate = roundRow.data?.end_date as string | undefined;
    if (!endDate) {
      return NextResponse.json({
        error: `round '${live.periodKey}' has no end date on record, so there is no way to tell whether it has finished. Pass force: true to freeze it anyway.`,
      }, { status: 422 });
    }
    if (!body.force && !isClosedDay(endDate, todayLocal())) {
      return NextResponse.json({
        error: `Round ${live.periodKey} ends ${endDate} and today is ${todayLocal()}, so it is still open. Pass force: true to freeze it anyway.`,
      }, { status: 422 });
    }

    const rows = await snapshotsFor(db, clientId, "round", live.periodKey);
    const current = chosenSnapshot(rows, "prefer", null);
    if (current && !body.replace) return NextResponse.json({ ok: false, periodKey: live.periodKey, version: current.version, frozenAt: current.frozen_at }, { status: 409 });
    const note = body.force
      ? [body.note, `Forced while round was still open (ends ${endDate}, forced ${todayLocal()}).`].filter(Boolean).join(" ")
      : body.note ?? null;
    const { data, error } = await db.rpc("freeze_period_insight", {
      p_client_id: clientId, p_period_kind: "round", p_period_key: live.periodKey,
      p_payload: live.payload, p_frozen_by: body.frozenBy ?? null, p_note: note,
    });
    if (error) throw new Error(error.message);
    const frozen = data as { version: number; isFirst: boolean; supersededVersion: number | null };
    return NextResponse.json({ ok: true, periodKey: live.periodKey, ...frozen, frozenAt: new Date().toISOString() }, { status: 201 });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}
