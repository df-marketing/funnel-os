import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Temporary diagnostic: measures Supabase latency from inside the function.
 *
 * A view that takes 40ms from a laptop can take 400ms from the function if the
 * function and the database are on different continents, and that difference is
 * invisible from outside. This route makes it visible. Delete once the region
 * question is settled.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const h = { apikey: key, authorization: `Bearer ${key}` };

  const time = async (label: string, path: string) => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await fetch(`${url}/rest/v1/${path}`, { headers: h, cache: "no-store" }).then((r) => r.text());
      runs.push(Math.round(performance.now() - t));
    }
    return { label, runs };
  };

  // Cold: a brand-new TLS handshake. Warm: connection reused.
  const cold = await time("first-hit (incl. TLS)", "v_clients?select=client_id");
  const results = await Promise.all([
    time("v_clients", "v_clients?select=client_id,client_name,client_note,stage_count"),
    time("rounds (full scan)", "rounds?select=client_id"),
    time("v_metrics_by_round", "v_metrics_by_round?select=cut_key,m&client_id=eq.shely"),
    time("v_metrics_by_adset", "v_metrics_by_adset?select=cut_key,m&client_id=eq.shely"),
    time("v_journey_strip", "v_journey_strip?select=*&client_id=eq.shely"),
  ]);

  return NextResponse.json({
    functionRegion: process.env.VERCEL_REGION ?? "unknown",
    supabaseHost: url.replace("https://", ""),
    cold,
    results,
  });
}
