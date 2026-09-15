import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { staleness, type ImportStatusRow } from "@/lib/integration/coverage";
import { classifyPeriods, type RoundPeriodRow } from "@/lib/integration/periods";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * GET /api/integration/periods?clientId=shely
 *
 * WHICH MONTHS MAY BE REPORTED ON.
 *
 * ── THERE IS NO `finalised` FLAG, AND THERE SHOULD NOT BE ──────────────────
 *
 * AcqOS asked for "finalised periods". GroundTruth has no such column — no
 * `finalised`, no `closed_at`, no `period_status`, anywhere in the schema.
 * Rather than invent one, this derives the answer, because a hand-set flag is a
 * claim the data cannot contradict: it says August is done and goes on saying it
 * after a late export lands, and the first time those two disagree the flag wins
 * and the report is wrong.
 *
 *   final       the month has ended, every round anchored to it has ended, and
 *               every source has been imported past the last of those endings.
 *               Safe to report. It can still change if somebody re-imports —
 *               GroundTruth allows re-reading a closed period on purpose — but
 *               nothing is *missing*.
 *
 *   incomplete  the month and its rounds have ended, and the files stop short.
 *               This is the one that matters. It will not fix itself: it is
 *               waiting on an import, and a caller that treats it as `final`
 *               publishes a month with a hole in it.
 *
 *   open        the month has not ended yet, or a round belonging to it has
 *               not. Nothing is wrong; it is simply still happening.
 *
 * `incomplete` and `open` are kept apart deliberately. Both mean "do not
 * report this yet" and they mean opposite things about whose move it is.
 *
 * ── WHICH MONTH A ROUND BELONGS TO ─────────────────────────────────────────
 *
 * The anchor rule, not the start date. A round belongs to exactly one period —
 * 0826-01 runs 31 July to 6 August and is August's, all of it. That rule lives
 * in fo_round_anchor and is read here through v_round_period rather than
 * recomputed, so there is one definition of a month boundary in the system.
 */

export async function GET(request: Request) {
  // Read class. This exposes round codes, dates and coverage — no metrics, no
  // money, no people — so it belongs with the other four GETs on the read-only
  // key rather than behind the key that can also write a funnel.
  const key = checkIntegrationKey(request, "read");
  if (key === "unconfigured") return NextResponse.json({ error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  if (key !== "ok") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  const [roundsResult, statusResult, journeyResult] = await Promise.all([
    db.from("v_round_period")
      .select("period, start_date, end_date, code")
      .eq("client_id", clientId).order("start_date"),
    db.from("v_import_status")
      .select("source, imported_at, coverage_start, coverage_end, is_stale, days_behind")
      .eq("client_id", clientId).order("source"),
    // A client in GroundTruth IS its journey stages, so this is how "unknown
    // clientId" is told apart from "known client with no rounds yet".
    db.from("client_journey_config")
      .select("client_id", { count: "exact", head: true }).eq("client_id", clientId),
  ]);

  if (roundsResult.error) {
    /* The view is the one part of this that needs a migration. Until it is run,
       say so in the words of the fix rather than relaying a PostgREST 404 that
       reads like the client does not exist. */
    const missing = /v_round_period/.test(roundsResult.error.message);
    return NextResponse.json({
      error: missing
        ? "v_round_period is not present on this database. Run 20260915090000_a_period_can_say_whether_it_is_finished.sql."
        : roundsResult.error.message,
    }, { status: missing ? 503 : 500 });
  }
  if (statusResult.error) return NextResponse.json({ error: statusResult.error.message }, { status: 500 });
  if (!journeyResult.count) return NextResponse.json({ error: "unknown clientId" }, { status: 404 });

  const rounds = (roundsResult.data ?? []) as RoundPeriodRow[];
  const sources = (statusResult.data ?? []) as ImportStatusRow[];
  const top = staleness(sources);

  /* Where the data runs out, as a single date. This is the EARLIEST coverage_end
     across sources, not the latest — one short file makes the whole month short,
     and a month judged against the best-covered source would be called final on
     the strength of the one file that happens to reach furthest. */
  const reach = top.lastObservationDate;
  const today = new Date().toISOString().slice(0, 10);

  const periods = classifyPeriods(rounds, reach, today);

  return NextResponse.json({
    clientId,
    asOf: today,
    // At the top, like every other read.
    ...top,
    // The short answer, so a caller does not have to filter the array to get it.
    finalPeriods: periods.filter((p) => p.status === "final").map((p) => p.period),
    periods,
  });
}
