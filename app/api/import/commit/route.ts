import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { commitPlan, ImportError, type Plan } from "@/lib/import/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/import/commit  { batchId }
 *
 * Applies the staged plan. Committing locks the batch: a later import can add
 * rows or flag a restate, but it can never silently change a number this one
 * already reported.
 */
export async function POST(request: Request) {
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    const { batchId } = await request.json();
    if (!batchId) return NextResponse.json({ error: "No batch id." }, { status: 400 });

    const { data: batch, error } = await db
      .from("import_batches")
      .select("batch_id, status, staged_payload")
      .eq("batch_id", batchId)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!batch) return NextResponse.json({ error: "That batch no longer exists." }, { status: 404 });
    if (batch.status === "committed") {
      return NextResponse.json({ error: "That batch is already committed. Committed batches are locked." }, { status: 409 });
    }
    if (batch.status === "discarded") {
      return NextResponse.json({
        error:
          "This file was planned before another import committed, so its diff is out of date — " +
          "drop it again to see what it really does now.",
      }, { status: 409 });
    }
    if (!batch.staged_payload) {
      return NextResponse.json({ error: "That batch has no staged rows — re-upload the file." }, { status: 409 });
    }

    const plan = batch.staged_payload as unknown as Plan;
    await commitPlan(db, batchId, plan);

    /**
     * Any OTHER file still staged was planned against the data as it stood
     * before this commit — so its matches, its attribution and its diff are all
     * out of date now.
     *
     * This is not hypothetical. Drop all four files, then commit them in order,
     * and attendance was matched against a contacts table that was still empty:
     * every attendee parks as an unknown person, the commit reports 0 rows
     * written, and nothing anywhere says why. The order the Import tab insists
     * on is the order of COMMITS, and the plan is deliberately frozen at preview
     * so the diff you approved is the diff that gets applied — which means the
     * only honest thing to do with a stale plan is throw it away and ask for the
     * file again.
     */
    const { data: stale } = await db
      .from("import_batches")
      .update({ status: "discarded", staged_payload: null })
      .eq("client_id", plan.clientId)
      .eq("status", "staged")
      .select("source");

    revalidatePath("/");
    revalidateTag(FUNNEL_TAG);
    return NextResponse.json({ ok: true, invalidated: (stale ?? []).map((s) => s.source) });
  } catch (err) {
    if (err instanceof ImportError) return NextResponse.json({ error: err.message }, { status: 422 });
    console.error("[import/commit]", err);
    return NextResponse.json({ error: "The commit failed." }, { status: 500 });
  }
}

/** DELETE — discard a staged batch without applying it. */
export async function DELETE(request: Request) {
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  const { batchId } = await request.json();
  const { error } = await db.from("import_batches")
    .update({ status: "discarded", staged_payload: null })
    .eq("batch_id", batchId).eq("status", "staged");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  revalidatePath("/");
  revalidateTag(FUNNEL_TAG);
  return NextResponse.json({ ok: true });
}
