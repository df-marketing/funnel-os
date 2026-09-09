import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/scroll/heatmap   multipart: runId, file
 * DELETE /api/scroll/heatmap { runId }
 *
 * THE ONE PART OF CLARITY THAT IS NOT AN EXPORT.
 *
 * Clarity gives the scroll curve as a file and gives the heatmap as a picture
 * on a screen — there is no export for the image, and the share links it does
 * offer expire. So the heatmap has to be a screenshot somebody takes, and this
 * is where it lands. The column, the bucket and the link on the round were all
 * built for it; nothing could put a file in the middle, so `heatmap_path` was
 * null on every run and the feature existed only as a schema.
 *
 * The image is stored under the run, not under the round: a round can run two
 * landing pages on two devices, and four heatmaps that all say "0726-01" are
 * four pictures nobody can tell apart. The run already carries the page, the
 * device and the window, so `<client>/<round>/<run>.<ext>` is unambiguous and
 * stays that way when the curve is re-exported — replacing a curve mints a new
 * run id, which is exactly when the old picture stops describing it.
 *
 * Nothing here can move a number. `heatmap_path` is read by one component and
 * by no view, no metric and no total.
 */

/** What Clarity's own screenshot button and every OS screenshot tool produce. */
const ALLOWED = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

/**
 * A full-page heatmap of a long landing page is a tall image, and Clarity's own
 * download is routinely 3–6 MB. Ten leaves room for a retina capture of a very
 * long page without becoming a way to put arbitrary payloads in a public
 * bucket.
 */
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  const form = await request.formData();
  const runId = String(form.get("runId") ?? "");
  const file = form.get("file");

  if (!runId) return NextResponse.json({ error: "No scroll run was named." }, { status: 400 });
  if (!(file instanceof File) || !file.size) {
    return NextResponse.json({ error: "No image was attached." }, { status: 400 });
  }

  const ext = ALLOWED.get(file.type);
  if (!ext) {
    return NextResponse.json({
      error: `A heatmap has to be a PNG, JPEG or WebP image. That file is ${file.type || "of no stated type"}.`,
    }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      error: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB and the limit is ${MAX_BYTES / 1024 / 1024} MB.`,
    }, { status: 413 });
  }

  /* The run has to exist before its picture does, and the round and client come
     off the run rather than off the request — a path assembled from whatever
     the caller sent is a path the caller chooses. */
  const { data: run, error: findErr } = await db
    .from("scroll_runs")
    .select("run_id, client_id, round_id, heatmap_path")
    .eq("run_id", runId)
    .maybeSingle();

  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!run) {
    return NextResponse.json({
      error: "That scroll run is not on record. Import the Clarity scroll export first — the curve is what the heatmap is attached to.",
    }, { status: 404 });
  }

  const path = `${run.client_id}/${run.round_id}/${run.run_id}.${ext}`;

  const { error: upErr } = await db.storage
    .from("clarity-heatmaps")
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: true });
  if (upErr) {
    return NextResponse.json({ error: `Storing the heatmap failed: ${upErr.message}` }, { status: 500 });
  }

  /* Stored before it is pointed at. A row naming an object that failed to
     upload shows the round a broken link; an object with no row pointing at it
     is invisible and costs a few megabytes. */
  const { error: setErr } = await db
    .from("scroll_runs").update({ heatmap_path: path }).eq("run_id", run.run_id);
  if (setErr) {
    return NextResponse.json({ error: `Recording the heatmap failed: ${setErr.message}` }, { status: 500 });
  }

  revalidateTag(FUNNEL_TAG);
  revalidatePath("/");
  return NextResponse.json({ ok: true, path });
}

export async function DELETE(request: Request) {
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  const { runId } = await request.json();
  if (!runId) return NextResponse.json({ error: "No scroll run was named." }, { status: 400 });

  const { data: run } = await db
    .from("scroll_runs").select("run_id, heatmap_path").eq("run_id", runId).maybeSingle();
  if (!run?.heatmap_path) return NextResponse.json({ ok: true });

  /* The row first this time, for the same reason in reverse: the link on screen
     goes the moment the row does, and an orphaned object is cheaper than a
     round pointing at something that no longer exists. */
  const { error } = await db
    .from("scroll_runs").update({ heatmap_path: null }).eq("run_id", run.run_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await db.storage.from("clarity-heatmaps").remove([run.heatmap_path]);

  revalidateTag(FUNNEL_TAG);
  revalidatePath("/");
  return NextResponse.json({ ok: true });
}
