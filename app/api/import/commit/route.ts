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
    if (!batch.staged_payload) {
      return NextResponse.json({ error: "That batch has no staged rows — re-upload the file." }, { status: 409 });
    }

    await commitPlan(db, batchId, batch.staged_payload as unknown as Plan);
    revalidatePath("/");
    revalidateTag(FUNNEL_TAG);
    return NextResponse.json({ ok: true });
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
