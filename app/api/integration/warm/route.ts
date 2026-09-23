import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { getDashboard, NO_FILTER } from "@/lib/funnel/data";

export const runtime = "nodejs";
// Never prerendered, never cached. This route's whole job is to fill somebody
// else's cache; caching its own response would mean it stopped doing anything.
export const dynamic = "force-dynamic";

/**
 * POST /api/integration/warm
 *
 * FILL THE CACHE BEFORE SOMEBODY WAITS ON IT.
 *
 * A cold filter change is 3.4s and a warm one is 0.06s — measured 21 Sep 2026
 * against production. The difference is entirely whether `unstable_cache` has
 * seen that exact combination before, and every round a person clicks is a
 * combination nothing has seen. So the operator's experience is: every click
 * is the slow one, because the fast path only exists for a click you already
 * made.
 *
 * This walks the common combinations and asks for them, so the cache is warm
 * before anyone clicks. It does not make anything faster — it moves the slow
 * read to a time when nobody is watching.
 *
 * ── WHY IT CALLS getDashboard AND NOT THE QUERIES ─────────────────────────
 *
 * getDashboard is exactly what the page calls. Warming through it means the
 * cache entries filled here are the SAME entries the page reads, by
 * construction — there is no second list of keys to drift out of step. A warmer
 * that fetched "the same data" a different way would warm nothing and report
 * success, which is the one failure mode that would be invisible.
 *
 * ── DO NOT RUN THIS DURING THE WORKING DAY ────────────────────────────────
 *
 * Measured 23 Sep 2026: while a sweep was running, a live page took 27.5s. The
 * same page cold, with nothing else happening, is 3.4s. The warmer made the app
 * EIGHT TIMES WORSE than the problem it exists to solve.
 *
 * Being serial and polite is not enough. On a shared-CPU instance there is one
 * core, and a warmer holding it for five seconds at a time is a competitor
 * whatever gap it leaves. So the schedule is a single overnight run and the
 * cache window is eighteen hours to outlast the day that follows it.
 *
 * A manual call is fine for one client or a handful of rounds — that is why the
 * defaults are small. A full sweep at 11am is an outage.
 *
 * ── HOW IT IS KEPT FROM BREAKING THE THING IT IS HELPING ──────────────────
 *
 * The database is a shared-CPU nano instance where three concurrent reads have
 * already produced a statement timeout once. A warmer that fired everything at
 * once would be indistinguishable from an outage. So:
 *
 *   SERIAL.      One combination at a time. Never Promise.all. The warmer is
 *                always the lowest-priority caller and must behave like it.
 *   PAUSED.      A gap between reads, so live requests get a slice.
 *   BUDGETED.    Stops at budgetMs whatever is left undone, and says what it
 *                skipped. It can never run long or run away.
 *   ONE AT A TIME. A second call while one is running is refused, not queued.
 *   STOPS ON ERROR. If a read fails, it stops. A struggling database does not
 *                need a warmer retrying against it.
 *   READ ONLY.   getDashboard reads. There is no write path reachable here.
 *
 * ── ONE CALL DOES NOT FINISH, AND THAT IS THE DESIGN ─────────────────────
 *
 * A complete sweep is 179 combinations — 4 clients, their own tabs, every round
 * — at roughly 2.8s each. Ten minutes, which no single function invocation
 * should hold open.
 *
 * So the budget running out is the NORMAL outcome, not a failure, and the
 * response carries `nextOffset`. A caller loops until it stops coming back, and
 * the sweep is spread over as many short invocations as it needs. Order is
 * fixed — clients, tabs, rounds newest-first — so an offset means the same
 * thing on the next call.
 *
 * `nextOffset` is deliberately absent after an error. A caller looping on it
 * cannot turn one failure into a retry storm against a database that has just
 * said it is struggling.
 */

/** Never Promise.all in here. See the header. */
const GAP_MS = 250;
const DEFAULT_BUDGET_MS = 50_000;
const MAX_BUDGET_MS = 120_000;

/** Refuses a second concurrent warm rather than queueing it. Per-instance. */
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Done = { client: string; view: string; round: string | null; ms: number };

export async function POST(request: Request) {
  // The WRITE key, not the read-only one. Warming is an operator action that
  // generates real database load, and the read-only key exists to be handed to
  // an agent — nothing holding it should be able to make the database busy.
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") return NextResponse.json({ ok: false, error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  if (key !== "ok") return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { clientId?: unknown; budgetMs?: unknown; rounds?: unknown; offset?: unknown } = {};
  try { body = await request.json(); } catch { /* every field is optional */ }

  const onlyClient = typeof body.clientId === "string" ? body.clientId : null;
  /* Where to resume. A full sweep is 179 combinations at roughly 2.8s each —
     about ten minutes, which no single function invocation should hold open.
     So the caller pages: it gets `nextOffset` back whenever the budget ran out
     with work left, and calls again with it until it stops coming.

     The work list is built in a fixed order — clients, then their tabs, then
     their rounds newest first — so an offset means the same thing on the next
     call. It is a cursor into a deterministic list, not a promise that nothing
     changed underneath; a round imported mid-sweep shifts later items by one,
     which costs a repeat or a miss of ONE combination and nothing worse. */
  const offset = typeof body.offset === "number" && body.offset > 0 ? Math.floor(body.offset) : 0;
  const budgetMs = Math.min(
    typeof body.budgetMs === "number" && body.budgetMs > 0 ? body.budgetMs : DEFAULT_BUDGET_MS,
    MAX_BUDGET_MS,
  );
  const roundLimit = typeof body.rounds === "number" && body.rounds > 0 ? Math.min(body.rounds, 20) : 4;

  if (running) {
    // Refused, not queued. Two warmers at once is the concurrency this exists
    // to avoid, and a queue would just delay the same collision.
    return NextResponse.json({ ok: false, error: "a warm is already running on this instance" }, { status: 409 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  running = true;
  const startedAt = Date.now();
  const left = () => budgetMs - (Date.now() - startedAt);
  const done: Done[] = [];
  let stoppedBy: "budget" | "error" | "complete" = "complete";
  let failure: string | null = null;

  try {
    /* The clients and their tabs, read once. A client IS its journey stages, so
       this is also the list of tabs worth warming — warming a tab a client does
       not have would populate a key no page will ever ask for. */
    let stagesQuery = db.from("client_journey_config")
      .select("client_id, stage_slug, stage_order").order("client_id").order("stage_order");
    if (onlyClient) stagesQuery = stagesQuery.eq("client_id", onlyClient);
    const { data: stageRows, error: stageError } = await stagesQuery;
    if (stageError) throw new Error(`client_journey_config: ${stageError.message}`);

    const tabsByClient = new Map<string, string[]>();
    for (const row of (stageRows ?? []) as Array<{ client_id: string; stage_slug: string | null }>) {
      if (!row.stage_slug) continue;
      const list = tabsByClient.get(row.client_id);
      if (list) list.push(row.stage_slug); else tabsByClient.set(row.client_id, [row.stage_slug]);
    }
    if (!tabsByClient.size) {
      return NextResponse.json({ ok: false, error: onlyClient ? `unknown clientId '${onlyClient}'` : "no clients" }, { status: 404 });
    }

    /* Newest rounds first, because that is what somebody opens on a Monday. A
       round from May is a combination nobody is waiting on. */
    let roundsQuery = db.from("rounds")
      .select("client_id, start_date, end_date").order("start_date", { ascending: false });
    if (onlyClient) roundsQuery = roundsQuery.eq("client_id", onlyClient);
    const { data: roundRows, error: roundError } = await roundsQuery;
    if (roundError) throw new Error(`rounds: ${roundError.message}`);

    const roundsByClient = new Map<string, string[]>();
    for (const r of (roundRows ?? []) as Array<{ client_id: string; start_date: string; end_date: string }>) {
      const list = roundsByClient.get(r.client_id) ?? [];
      if (list.length < roundLimit) list.push(`${r.start_date}..${r.end_date}`);
      roundsByClient.set(r.client_id, list);
    }

    /* The work list, in the order it matters. Unfiltered first for every
       client — that is what a fresh login lands on and the only page somebody
       is guaranteed to open — then the newest rounds. */
    const work: Array<{ client: string; view: string; periods: string | null }> = [];
    for (const [client, tabs] of tabsByClient) {
      for (const view of tabs) work.push({ client, view, periods: null });
    }
    for (const [client, tabs] of tabsByClient) {
      for (const periods of roundsByClient.get(client) ?? []) {
        for (const view of tabs) work.push({ client, view, periods });
      }
    }

    /* Everything before the offset was done by an earlier call in this sweep.
       Sliced rather than skipped inside the loop so `plannedTotal` and
       `nextOffset` both count from the same list. */
    const remaining = work.slice(offset);

    for (const item of remaining) {
      // Checked BEFORE the read, not after, so the budget bounds when this
      // returns rather than merely when it stops adding work.
      if (left() < 4_000) { stoppedBy = "budget"; break; }
      const t = Date.now();
      /* getDashboard catches its own errors and returns a Dashboard carrying an
         `error` string, so a bad combination does not throw. Read it, because a
         warmer that reports success while warming nothing is worse than one
         that fails. */
      const result = await getDashboard(item.client, item.view, { ...NO_FILTER, periods: item.periods });
      if (result.error) { stoppedBy = "error"; failure = `${item.client}/${item.view}: ${result.error}`; break; }
      done.push({ client: item.client, view: item.view, round: item.periods, ms: Date.now() - t });
      await sleep(GAP_MS);
    }

    const reached = offset + done.length;
    return NextResponse.json({
      ok: stoppedBy !== "error",
      stoppedBy,
      failure,
      warmed: done.length,
      offset,
      /* Present only when there is more to do, it is safe to continue, AND this
         call actually got somewhere.
         
         `done.length > 0` is the one that matters and it was missing: a budget
         too small to finish a single combination warms nothing, leaves `reached`
         equal to `offset`, and hands the caller back the offset it just sent.
         The loop then repeats the same call forever — bounded only by the page
         cap, so the symptom is twelve identical no-op pages rather than an
         obvious hang. Caught by the verify run, which uses a 1s budget and so
         hits this every time.

         Absent on error too, so a caller looping on it cannot turn one failure
         into a retry storm against a database that just said it is struggling. */
      nextOffset: stoppedBy === "budget" && done.length > 0 && reached < work.length ? reached : undefined,
      // Named, not just counted — "skipped 40" is a number, and which 40 is the
      // question somebody will actually have.
      remaining: work.length - reached,
      plannedTotal: work.length,
      elapsedMs: Date.now() - startedAt,
      slowest: [...done].sort((a, b) => b.ms - a.ms).slice(0, 5),
      combinations: done,
    }, { status: stoppedBy === "error" ? 500 : 200 });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      warmed: done.length,
      elapsedMs: Date.now() - startedAt,
    }, { status: 500 });
  } finally {
    // In `finally` so a throw cannot leave the flag set and lock the route out
    // until the instance recycles.
    running = false;
  }
}
