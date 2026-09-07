import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createAdminClient, fetchAll, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { validateRound, type ExistingRound, type RoundInput } from "@/lib/rounds/validate";

export const runtime = "nodejs";

/**
 * CREATING A ROUND.
 *
 * The last step in the chain that was still a hand-written SQL insert. Nothing
 * can be imported for a round that does not exist — an ads file, a leads export
 * and the Meta pull all refuse outright — and "now" is exactly when a round is
 * newest, so the gap bit hardest at the only moment the feature mattered.
 *
 * Unauthenticated, like the rest of the app's mutations, because there is no
 * login by design. What it can do is bounded instead: it writes one row to
 * `rounds` for a client that already exists, and it will not delete one that
 * has anything attached.
 */

const isoDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function POST(request: Request) {
  let body: Partial<RoundInput>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const clientId = body.client_id?.trim();
  const roundId = body.round_id?.trim();
  if (!clientId || !roundId) {
    return NextResponse.json({ ok: false, error: "client_id and round_id are required" }, { status: 400 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  // A round belongs to a client that exists. Inventing one here would make a
  // typo look like a new client on the switcher.
  const known = await db.from("v_clients").select("client_id").eq("client_id", clientId).maybeSingle();
  if (known.error) return NextResponse.json({ ok: false, error: "client_lookup_failed" }, { status: 502 });
  if (!known.data) return NextResponse.json({ ok: false, error: "unknown_client" }, { status: 400 });

  const all = await fetchAll<ExistingRound & { round_id: string }>(
    db, "rounds", "round_id, start_date, end_date, product_id", (q) => q.eq("client_id", clientId));

  const input: RoundInput = {
    round_id: roundId,
    client_id: clientId,
    product_id: body.product_id?.trim() || null,
    start_date: isoDay(body.start_date) ? body.start_date : "",
    end_date: isoDay(body.end_date) ? body.end_date : "",
    session_date: isoDay(body.session_date) ? body.session_date : null,
    session_label: body.session_label?.trim() || null,
  };

  // Editing a round must not find itself overlapping itself.
  const others = all.filter((r) => r.round_id !== roundId);
  const problems = validateRound(input, others);
  if (problems.length) return NextResponse.json({ ok: false, problems }, { status: 400 });

  const { error } = await db.from("rounds").upsert({
    round_id: input.round_id,
    client_id: input.client_id,
    product_id: input.product_id,
    start_date: input.start_date,
    end_date: input.end_date,
    session_date: input.session_date,
    session_label: input.session_label,
  }, { onConflict: "round_id" });
  if (error) return NextResponse.json({ ok: false, error: "write_failed" }, { status: 502 });

  // Period lists, month buckets and every cut are built from rounds.
  revalidateTag(FUNNEL_TAG);
  return NextResponse.json({
    ok: true,
    round: input,
    existed: all.some((r) => r.round_id === roundId),
  });
}

/**
 * Deleting is only for a round created by mistake — one nothing has been
 * imported into. A round with spend or people attached is not a mistake, it is
 * a record, and the way to be rid of it is not a button.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const roundId = url.searchParams.get("round_id");
  if (!roundId) return NextResponse.json({ ok: false, error: "round_id is required" }, { status: 400 });

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  const [ads, events] = await Promise.all([
    db.from("ads_performance").select("id", { count: "exact", head: true }).eq("round_id", roundId),
    db.from("events").select("event_id", { count: "exact", head: true }).eq("round_id", roundId),
  ]);
  const attached = (ads.count ?? 0) + (events.count ?? 0);
  if (attached > 0) {
    return NextResponse.json(
      { ok: false, error: "round_has_data",
        note: `${roundId} has ${ads.count ?? 0} ad rows and ${events.count ?? 0} people attached. ` +
              "Delete those first if you really mean to remove it." },
      { status: 409 },
    );
  }

  const { error } = await db.from("rounds").delete().eq("round_id", roundId);
  if (error) return NextResponse.json({ ok: false, error: "delete_failed" }, { status: 502 });
  revalidateTag(FUNNEL_TAG);
  return NextResponse.json({ ok: true, deleted: roundId });
}
