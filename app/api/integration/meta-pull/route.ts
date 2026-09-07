import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { isIsoDay } from "@/lib/integration/schema";
import { createAdminClient, fetchAll, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { fetchAdRows, fetchReachRows, metaToken, MetaError, MISSING_TOKEN_MESSAGE } from "@/lib/meta/graph";
import {
  toAdRows, toReachRows, adKey, newRows, splitReach, coarseKey,
  type AdRow, type ClickKind, type Skipped,
} from "@/lib/meta/insights";

export const runtime = "nodejs";

/**
 * "PULL NOW" — the latest Meta numbers, on demand.
 *
 * Fetches a client's ad figures and writes them into `ads_performance` the same
 * way a dropped CSV would, so the Import tab's freshness and coverage reporting
 * keeps working and a pull is not a second, invisible way for numbers to arrive.
 *
 * ── IT WRITES FOUR COLUMNS ────────────────────────────────────────────────
 * spend, impressions and clicks at ad level, reach at campaign level. Nothing
 * else. Not leads — those are CRM events with identity resolution and their own
 * dedupe key, and Meta's lead count is a different number reached a different
 * way. Not conversions — purchases come from the payments file, and ROAS here
 * means what the advertising produced against real sales. Not budgets, not
 * anything below the ad.
 *
 * ── IT DOES NOT WRITE BY DEFAULT ──────────────────────────────────────────
 * `commit: true` is required. Without it the pull runs end to end and reports
 * exactly what it WOULD write, changing nothing. The Import tab has worked this
 * way since the beginning — drop a file, read the diff, then commit — and a
 * button that reaches a live ad account has less business being an exception,
 * not more.
 *
 * ── A CAMPAIGN WITH NO ROUND IS REFUSED ───────────────────────────────────
 * `ads_performance.round_id` is a foreign key and Meta has never heard of a
 * round. Rows whose campaign maps to no round are not written, and every one is
 * named in `skipped`. That is also the provenance rule: a campaign nobody mapped
 * is a campaign nobody asked this to manage. Silence about a skipped campaign is
 * the failure that matters, because it reads as success.
 */

type Body = {
  clientId?: string;
  since?: string;
  until?: string;
  commit?: boolean;
  clicks?: ClickKind;
};

/** A pull cannot reach further back than this in one go. Backfill is out of scope. */
const MAX_DAYS = 92;

/** Yesterday and today, in the account's terms. Overlap is free — see adKey. */
const defaultWindow = (): { since: string; until: string } => {
  const now = new Date();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const back = new Date(now);
  back.setUTCDate(back.getUTCDate() - 1);
  return { since: day(back), until: day(now) };
};

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export async function POST(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") {
    return NextResponse.json({ ok: false, error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  }
  if (key !== "ok") {
    /*
     * A body, where the other integration routes answer 401 with nothing at all.
     * Those are called by AcqOS, which knows what it sent. This one gets typed
     * into a terminal by a person, and an empty 401 piped through a JSON parser
     * reports "Expecting value: line 1 column 1" — which names neither the
     * status nor the header, and reads like the request never arrived.
     *
     * Naming the header gives away nothing: whether it is required is not the
     * secret, its value is.
     */
    return NextResponse.json(
      { ok: false, error: "unauthorized",
        note: "Send the shared secret in the x-integration-key header. It is stored " +
              "as INTEGRATION_SHARED_KEY on this deployment and on the AcqOS side." },
      { status: 401 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 });
  }

  const clientId = body.clientId?.trim();
  if (!clientId) {
    return NextResponse.json({ ok: false, error: "clientId is required" }, { status: 400 });
  }

  const win = body.since || body.until
    ? { since: body.since ?? "", until: body.until ?? "" }
    : defaultWindow();
  if (!isIsoDay(win.since) || !isIsoDay(win.until) || win.since > win.until) {
    return NextResponse.json(
      { ok: false, error: "since and until must be YYYY-MM-DD with since <= until" },
      { status: 400 },
    );
  }
  if (daysBetween(win.since, win.until) > MAX_DAYS) {
    return NextResponse.json(
      { ok: false, error: `a pull covers at most ${MAX_DAYS} days; this is not a backfill` },
      { status: 400 },
    );
  }

  const token = metaToken();
  if (!token) return NextResponse.json({ ok: false, error: MISSING_TOKEN_MESSAGE }, { status: 503 });

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  // ── Which account, and does this client exist at all ──────────────────────
  const flags = await db
    .from("client_flags")
    .select("meta_ad_account_id")
    .eq("client_id", clientId)
    .maybeSingle();
  if (flags.error) {
    return NextResponse.json({ ok: false, error: "client_lookup_failed" }, { status: 502 });
  }
  const account = (flags.data as { meta_ad_account_id?: string | null } | null)?.meta_ad_account_id;
  if (!account) {
    return NextResponse.json(
      { ok: false, error: "no_meta_ad_account",
        note: `No Meta ad account is recorded for ${clientId}. Set client_flags.meta_ad_account_id.` },
      { status: 400 },
    );
  }

  // Rounds are still created by hand. A campaign whose round does not exist is
  // refused below rather than guessed into one.
  const rounds = await fetchAll<{ round_id: string }>(
    db, "rounds", "round_id", (q) => q.eq("client_id", clientId));

  const clicks: ClickKind = body.clicks ?? "link";
  const skipped: Skipped[] = [];
  let ads: AdRow[] = [];
  let reach: AdRow[] = [];
  const failures: string[] = [];

  // Each call is isolated: reach failing must not lose the spend, and vice versa.
  try {
    const raw = await fetchAdRows(account, token, win.since, win.until);
    const t = toAdRows(raw, rounds, clicks);
    ads = t.rows; skipped.push(...t.skipped);
  } catch (e) {
    failures.push(e instanceof MetaError ? e.code : "ad_fetch_failed");
  }
  try {
    const raw = await fetchReachRows(account, token, win.since, win.until);
    const t = toReachRows(raw, rounds);
    reach = t.rows; skipped.push(...t.skipped);
  } catch (e) {
    failures.push(e instanceof MetaError ? e.code : "reach_fetch_failed");
  }

  if (failures.length === 2) {
    return NextResponse.json({ ok: false, error: "all_pulls_failed", failures }, { status: 502 });
  }

  // ── What is already there ────────────────────────────────────────────────
  // The pipeline's own dedupe key, so pulling the same day twice is a no-op and
  // the deliberately overlapping window costs nothing.
  const roundIds = [...new Set([...ads, ...reach].map((r) => r.round_id))];
  const fresh: AdRow[] = [];
  let reachWithheld: Skipped[] = [];
  if (roundIds.length) {
    const existing = await fetchAll<{
      round_id: string; date: string; campaign: string | null; ad_set: string | null; ad: string | null;
      reach: number | null;
    }>(db, "ads_performance", "round_id, date, campaign, ad_set, ad, reach",
       (q) => q.in("round_id", roundIds));

    // Round-days that already carry a coarse reach — the CSV's ALL CAMPAIGNS
    // rows. 0016 SUMS every ad_set-null row, so adding a second one there would
    // double the reach and halve the frequency, beside a spend still correct.
    const measured = existing
      .filter((r) => !r.ad_set && r.reach !== null)
      .map((r) => coarseKey(r.round_id, r.date));
    const split = splitReach(reach, measured);
    reachWithheld = split.withheld;

    fresh.push(...newRows([...ads, ...split.write], existing.map(adKey)));
  }

  const summary = {
    ok: true,
    committed: false,
    window: win,
    account,
    clicks,
    fetched: { ad: ads.length, reach: reach.length },
    wouldWrite: fresh.length,
    alreadyHad: ads.length + reach.length - fresh.length,
    rounds: [...new Set(fresh.map((r) => r.round_id))].sort(),
    skipped,
    reachWithheld: reachWithheld.length,
    anyFailed: failures.length > 0,
    failures,
  };

  if (!body.commit) {
    return NextResponse.json({
      ...summary,
      note: "Nothing was written. Send commit: true to apply exactly this.",
    });
  }

  if (!fresh.length) {
    return NextResponse.json({ ...summary, committed: true, written: 0, note: "Nothing new to write." });
  }

  const batch = crypto.randomUUID();
  const { error } = await db.from("ads_performance").insert(
    fresh.map((r) => ({ ...r, import_batch_id: batch })),
  );
  if (error) {
    // Never the database's own text — it can carry row contents.
    return NextResponse.json({ ...summary, ok: false, error: "write_failed" }, { status: 502 });
  }

  return NextResponse.json({ ...summary, committed: true, written: fresh.length, batch });
}
