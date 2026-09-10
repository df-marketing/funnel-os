import { NextResponse } from "next/server";
import { createReadClient } from "@/lib/supabase/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * IT USED TO REPORT THE CLOCK AND CALL THAT HEALTH.
 *
 *   export function GET() {
 *     return NextResponse.json({ status: "ok", timestamp: … });
 *   }
 *
 * Nothing behind it. AcqOS found the consequence: fo-main — a duplicate
 * deployment with no Supabase and no integration key, which cannot render a
 * single page — answered this endpoint with `{"status":"ok"}`. Two deployments,
 * both claiming health, one of them unable to do anything at all.
 *
 * That is worse than the bug it replaced. Until an hour ago the login gate was
 * catching this route and returning a redirect to /login, which tells a monitor
 * nothing. A hardcoded ok tells a monitor something false, and false beats
 * silent for how long it survives.
 *
 * So it now asserts the things it depends on, and says which one failed:
 *
 *   supabase   configured, and actually answering
 *   integration key   configured — without it AcqOS gets 503 on every call
 *
 * 200 only when both hold. 503 with a reason otherwise.
 *
 * ── IT ALSO SAYS WHICH DEPLOYMENT IT IS ────────────────────────────────────
 *
 * The question that started this was "which of these two URLs is the real
 * GroundTruth", and it took a 401-versus-503 comparison on a different endpoint
 * to answer it. The commit is not a secret and it settles that in one call.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * No key, no URL, no row content. A health endpoint is unauthenticated by
 * necessity — it is checked by things that cannot sign in — so it may report
 * WHETHER a dependency is configured and never WHAT it is set to.
 *
 * The database read is the cheapest one available: a HEAD count against a
 * four-row table. It is a real round trip on an instance that throttles, and
 * that is the point — "configured" is not "working", and the difference is
 * exactly what a monitor is for.
 */
export async function GET() {
  const checks: Record<string, string> = {};
  let ok = true;

  const hasUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const hasAnon = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!hasUrl || !hasAnon) {
    // fo-main's case exactly: the deployment exists and can serve nothing.
    checks.supabase = "not configured";
    ok = false;
  } else {
    try {
      const { error } = await createReadClient()
        .from("client_flags")
        .select("client_id", { count: "exact", head: true });
      if (error) { checks.supabase = `unreachable: ${error.message}`; ok = false; }
      else checks.supabase = "reachable";
    } catch (e) {
      checks.supabase = `unreachable: ${e instanceof Error ? e.message : String(e)}`;
      ok = false;
    }
  }

  /* Not fatal on its own — the dashboard works without it — but AcqOS gets a
     503 on every integration call, and that is worth saying here rather than
     leaving somebody to discover it from the other side. */
  checks.integrationKey = process.env.INTEGRATION_SHARED_KEY ? "configured" : "not configured";
  if (!process.env.INTEGRATION_SHARED_KEY) ok = false;

  return NextResponse.json({
    status: ok ? "ok" : "degraded",
    checks,
    // Which deployment answered. Not a secret, and it is the question that
    // sent two people comparing status codes across two URLs.
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    loginRequired: process.env.FUNNEL_REQUIRE_LOGIN === "1",
    timestamp: new Date().toISOString(),
  }, { status: ok ? 200 : 503 });
}
