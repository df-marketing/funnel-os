import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth/access";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { isTarget, proposeFromCampaigns, proposeFromSources, type Proposal } from "@/lib/funnel/rules";

export const runtime = "nodejs";

/**
 * WHAT THE DATA ALREADY SAYS, OFFERED AS A CHOICE.
 *
 * Opening a rules screen to an empty form asks somebody to know the campaign
 * naming convention by heart. This reads what is already there and proposes the
 * split — accepting is one click, and typing a rule stays available for the
 * cases a scan cannot see.
 *
 * COVERAGE IS ASKED OF fo_resolve, THOUGH A MIRROR EXISTS. lib/funnel/rules.ts
 * carries `resolve`, a deliberate TypeScript copy of the matcher, so a rule can
 * be checked without a database. It is not used here, and the reason is not
 * distrust of it: coverage depends on the dimension_values rows in production
 * RIGHT NOW, so answering from the mirror would mean fetching those rows and
 * re-deciding what the database is about to decide anyway. Asking the database
 * is both shorter and the thing being asked about.
 *
 * The cost is one round trip per distinct value, which is why the scan is
 * capped and says so when it bites.
 */

const MAX_DISTINCT = 200;

export async function GET(request: Request) {
  const denied = await requireStaff();
  if (denied) return denied;

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  const url = new URL(request.url);
  const clientId = (url.searchParams.get("client") ?? "").trim();
  const target = url.searchParams.get("target") ?? "source";
  if (!clientId) return NextResponse.json({ ok: false, error: "client is required" }, { status: 400 });
  if (!isTarget(target)) {
    return NextResponse.json({ ok: false, error: `'${target}' is not a dimension this app resolves` }, { status: 400 });
  }

  /* Campaign names from both sides of the join. An ads export names campaigns
     that never produced a lead, and a lead can carry a utm_campaign for a
     campaign whose spend has not been imported yet; a rule has to cover both or
     it will look right on one tab and wrong on the next. */
  const [adRows, leadRows, srcRows] = await Promise.all([
    db.from("v_ads").select("campaign").eq("client_id", clientId).limit(1000),
    db.from("events").select("utm_campaign").eq("client_id", clientId).not("utm_campaign", "is", null).limit(1000),
    db.from("events").select("source").eq("client_id", clientId).not("source", "is", null).limit(1000),
  ]);

  const campaigns = [...new Set([
    ...((adRows.data ?? []) as Array<{ campaign: string | null }>).map((r) => r.campaign ?? ""),
    ...((leadRows.data ?? []) as Array<{ utm_campaign: string | null }>).map((r) => r.utm_campaign ?? ""),
  ].map((c) => c.trim()).filter(Boolean))];

  const sources = ((srcRows.data ?? []) as Array<{ source: string | null }>)
    .map((r) => (r.source ?? "").trim()).filter(Boolean);
  const distinctSources = [...new Set(sources)];

  const truncated =
    campaigns.length > MAX_DISTINCT || distinctSources.length > MAX_DISTINCT ||
    (adRows.data ?? []).length === 1000 || (leadRows.data ?? []).length === 1000;

  /* Ask the engine what it already answers for. Bounded, and reported when it
     bites — a silently truncated scan would propose rules for a subset and read
     as if it had seen everything. */
  const resolve = async (campaign: string | null, source: string | null) => {
    const { data } = await db.rpc("fo_resolve", {
      p_client: clientId, p_target: target,
      p_campaign: campaign, p_ad_set: null, p_ad: null, p_source: source,
    });
    return (data ?? null) as string | null;
  };

  const scanCampaigns = campaigns.slice(0, MAX_DISTINCT);
  const scanSources = distinctSources.slice(0, MAX_DISTINCT);

  const [campaignHits, sourceHits] = await Promise.all([
    Promise.all(scanCampaigns.map(async (c) => [c, await resolve(c, null)] as const)),
    Promise.all(scanSources.map(async (s) => [s, await resolve(null, s)] as const)),
  ]);

  const coveredCampaigns = new Set(campaignHits.filter(([, k]) => k !== null).map(([c]) => c));
  const coveredSources = new Set(sourceHits.filter(([, k]) => k !== null).map(([s]) => s));

  /* Source is the only target proposed from the lead-source column, and it is
     the point of the requirement: a new source arrives with no tracking
     parameter of its own, so the export's own column is the only honest signal.
     Every other target reads the campaign name. */
  const proposals: Proposal[] = target === "source"
    ? [
        ...proposeFromSources(sources.filter((s) => scanSources.includes(s)), coveredSources),
        ...proposeFromCampaigns(scanCampaigns, coveredCampaigns),
      ]
    : proposeFromCampaigns(scanCampaigns, coveredCampaigns);

  return NextResponse.json({
    ok: true,
    target,
    scanned: { campaigns: scanCampaigns.length, sources: scanSources.length },
    covered: { campaigns: coveredCampaigns.size, sources: coveredSources.size },
    truncated,
    proposals,
  });
}
