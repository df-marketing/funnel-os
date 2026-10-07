import { NextResponse } from "next/server";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { planImport, ImportError, type Plan } from "@/lib/import/pipeline";
import { SOURCES, type ImportSourceKey } from "@/lib/import/sources";
import { detectSource } from "@/lib/import/detect";
import { parseCsv } from "@/lib/import/csv";
import { requireStaff } from "@/lib/auth/access";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/import/preview
 * multipart: file, source, client
 *
 * Parses, matches, attributes and diffs — and writes NOTHING to the reporting
 * tables. The plan is staged on a batch row so the diff shown is exactly the
 * diff that /commit will apply.
 */
export async function POST(request: Request) {
  /* Writing, or staff-only. The middleware proves there is a session;
     only this proves the session may do it. */
  const denied = await requireStaff();
  if (denied) return denied;

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    const form = await request.formData();
    const file = form.get("file");
    const source = String(form.get("source") ?? "");
    const clientId = String(form.get("client") ?? "");

    if (!(file instanceof File)) return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
    if (!clientId) return NextResponse.json({ error: "No client selected." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) {
      return NextResponse.json({ error: "That file is over 15MB. Split it and import in parts." }, { status: 413 });
    }

    const text = await file.text();

    /* `auto` is what the single drop zone sends: the file's own columns say
       which source it is, so the operator is not asked a question the file
       already answers.

       Detected HERE rather than in the browser, because the server is already
       parsing this text — detecting anywhere else means a second parse and a
       second chance for detection and import to disagree about what the
       columns were. */
    let resolved = source as ImportSourceKey;
    if (source === "auto" || !source) {
      const { headers, rows } = parseCsv(text);
      /* Clarity's scroll-depth label sits in the FIRST COLUMN partway down the
         file, not in the header row — so the first column is read too. */
      const first = headers[0];
      const firstColumn = first ? rows.map((r) => String(r[first] ?? "")) : [];
      const found = detectSource(headers, firstColumn);

      if (found.kind === "unknown") {
        return NextResponse.json({ error: found.why, headers: headers.slice(0, 24) }, { status: 400 });
      }
      if (found.kind === "unsure") {
        /* It could be more than one thing and guessing is the expensive
           outcome — a sales file read as leads files revenue as opt-ins and
           the totals still add up. So it asks, and names what it saw. */
        return NextResponse.json({
          error: `This could be ${found.candidates.map((c) => SOURCES[c.source].label).join(" or ")}. Choose which it is.`,
          ambiguous: found.candidates,
          headers: headers.slice(0, 24),
        }, { status: 409 });
      }
      resolved = found.source as ImportSourceKey;
    }

    const plan = await planImport(db, { source: resolved, clientId, fileName: file.name, text });

    // Park any previously staged batch for this source — one pending diff at a time,
    // otherwise two half-approved imports can interleave.
    await db.from("import_batches")
      .update({ status: "discarded", staged_payload: null })
      .eq("client_id", clientId).eq("source", resolved).eq("status", "staged");

    const { data: batch, error } = await db.from("import_batches").insert({
      // `resolved`, never `source` — the latter may still read "auto",
      // which import_batches has a check constraint against for good reason.
      source: resolved, client_id: clientId, status: "staged",
      file_name: plan.fileName, row_count: plan.rowCount,
      coverage_start: plan.coverage.start, coverage_end: plan.coverage.end,
      column_map: plan.columnMap,
      staged_payload: plan as unknown as Record<string, unknown>,
      diff_summary: {
        counts: plan.counts, attribution: plan.attribution,
        diff: plan.diff, warnings: plan.warnings, prerequisite: plan.prerequisite,
      },
      expected_cadence: "1 day",
    }).select("batch_id").single();

    if (error) return NextResponse.json({ error: `Could not stage the import: ${error.message}` }, { status: 500 });

    return NextResponse.json({ batchId: batch.batch_id, plan: summarise(plan) });
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message, detail: err.detail ?? [] }, { status: 422 });
    }
    console.error("[import/preview]", err);
    return NextResponse.json({ error: "Could not read that file." }, { status: 500 });
  }
}

/** The plan minus the row payload — the UI only needs the numbers. */
function summarise(p: Plan) {
  return {
    source: p.source, fileName: p.fileName, rowCount: p.rowCount,
    coverage: p.coverage, columnMap: p.columnMap, unusedColumns: p.unusedColumns,
    counts: p.counts, attribution: p.attribution, diff: p.diff, warnings: p.warnings,
    prerequisite: p.prerequisite,
    willWrite: {
      contacts: p.ops.contacts.length,
      events: p.ops.events.length,
      ads: p.ops.ads.length,
      unmatched: p.ops.unmatched.length,
      refunds: p.ops.refundUpdates.length,
      answers: p.ops.answerUpdates.length,
    },
    /**
     * A scroll import writes no events and no ads, so every count above it is
     * zero and the diff would read "nothing new" for a file that is about to
     * write a twenty-point curve. What it IS doing has to be said in its own
     * terms: which round, how many sessions, and whether it replaces one.
     */
    scroll: p.ops.scroll
      ? {
          round: String(p.ops.scroll.run.round_id),
          device: String(p.ops.scroll.run.device),
          sessions: Number(p.ops.scroll.run.sessions),
          pageViews: (p.ops.scroll.run.page_views ?? null) as number | null,
          points: p.ops.scroll.points.length,
          replaces: Boolean(p.ops.scroll.replaces),
        }
      : null,
  };
}
