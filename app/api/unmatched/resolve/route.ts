import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { normEmail, normPhone } from "@/lib/import/identity";
import { writeCsv, type Row } from "@/lib/import/csv";
import { planImport, ImportError } from "@/lib/import/pipeline";
import type { SourceKey } from "@/lib/import/sources";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/unmatched/resolve  { rowId, action: "accept" | "assign" | "dismiss", identity? }
 *
 * A parked row is a row the importer could not tie to a person. Resolving it
 * supplies the one thing that was missing — who it is — and then runs the row
 * through the REAL import pipeline.
 *
 * That last part is the whole design. This used to stamp resolved_at and
 * resolved_contact_id and stop, which meant an accepted row left the queue,
 * dropped out of "revenue held" (the summary filters resolved_at is null) and
 * was still counted nowhere. 297 of real money stopped being tracked without
 * ever arriving in revenue, silently breaking the promise printed at the top of
 * that screen: every figure understated by exactly this queue, and never
 * overstated.
 *
 * Replaying through planImport instead means a resolved row produces exactly
 * the event an ordinary import would have — same round attribution, same
 * closing credit, same dedupe, same restatement check — so the queue can never
 * drift away from the importer.
 *
 *   accept   use the row's own best guess (only some rows have one)
 *   assign   use an email or phone the human typed
 *   dismiss  close it without counting it — the only lossy option, by design
 *
 * The parked row is never deleted. resolved_at, resolved_by and
 * resolved_contact_id are stamped on it, so the queue stays auditable.
 */
export async function POST(request: Request) {
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    const { rowId, action, identity } = await request.json();
    if (!rowId || !["accept", "assign", "dismiss"].includes(action)) {
      return NextResponse.json(
        { error: "Need a rowId and action of accept, assign or dismiss." },
        { status: 400 },
      );
    }

    const { data: row, error } = await db
      .from("unmatched_rows")
      .select("row_id, client_id, source, raw_data, best_guess, confidence, resolved_at, import_batch_id")
      .eq("row_id", rowId)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "That row no longer exists." }, { status: 404 });
    if (row.resolved_at) return NextResponse.json({ error: "That row is already resolved." }, { status: 409 });

    if (action === "dismiss") {
      const { error: e } = await db.from("unmatched_rows")
        .update({ resolved_at: new Date().toISOString(), resolved_by: "dismissed" })
        .eq("row_id", rowId);
      if (e) return NextResponse.json({ error: e.message }, { status: 500 });
      revalidatePath("/");
      revalidateTag(FUNNEL_TAG);
      return NextResponse.json({ ok: true, outcome: "dismissed" });
    }

    // ── who is this? ────────────────────────────────────────────────────────
    const claim = String(action === "assign" ? identity ?? "" : row.best_guess ?? "").trim();
    if (!claim) {
      return NextResponse.json(
        action === "assign"
          ? { error: "Type the email address or phone number of the person this row belongs to." }
          : { error: "There's no best guess to accept on that row — nothing confident enough was found." },
        { status: 422 },
      );
    }

    // Resolve against real contacts. A contact is never invented here: the point
    // of the queue is that a wrong identity silently credits someone else's
    // attendance, and then someone else's sale.
    const email = normEmail(claim);
    const phone = normPhone(claim);
    let contactId: string | null = null;

    if (email) {
      const { data } = await db.from("contacts")
        .select("contact_id").eq("client_id", row.client_id).eq("email", email).maybeSingle();
      contactId = data?.contact_id ?? null;
    }
    if (!contactId && phone) {
      const { data } = await db.from("contacts")
        .select("contact_id").eq("client_id", row.client_id).eq("phone", phone).maybeSingle();
      contactId = data?.contact_id ?? null;
    }
    if (!contactId) {
      return NextResponse.json(
        { error: `"${claim}" doesn't match a known contact. Import their lead first, or fix it at source — this screen won't invent a person.` },
        { status: 422 },
      );
    }

    // ── replay the row as a one-row import, with the identity supplied ──────
    const raw = (row.raw_data ?? {}) as Row;
    const headers = Object.keys(raw);
    if (!headers.length) {
      return NextResponse.json({ error: "That row has no original data to replay." }, { status: 422 });
    }

    const plan = await planImport(db, {
      source: row.source as SourceKey,
      clientId: row.client_id,
      fileName: `resolve:${rowId}`,
      text: writeCsv(headers, [raw]),
      asContactId: contactId,
    });

    // Naming the person doesn't fix a row that was ALSO missing something else —
    // no date, no amount, no round. Say which, and leave the row parked, because
    // resolving it would drop it out of the queue without counting it.
    if (!plan.ops.events.length) {
      if (plan.counts.duplicates > 0) {
        // already imported under another identity; the data is in, so close the row
        const { error: e } = await db.from("unmatched_rows").update({
          resolved_at: new Date().toISOString(),
          resolved_contact_id: contactId,
          resolved_by: action === "assign" ? "assigned" : "accepted",
        }).eq("row_id", rowId);
        if (e) return NextResponse.json({ error: e.message }, { status: 500 });
        revalidatePath("/");
        revalidateTag(FUNNEL_TAG);
        return NextResponse.json({ ok: true, outcome: "already counted", contactId, written: 0 });
      }
      const why = plan.ops.unmatched[0]?.guess_method ?? plan.warnings[0] ?? "the row is still unusable";
      return NextResponse.json(
        { error: `Naming the person isn't enough — ${why}. Fix it at source and re-import.` },
        { status: 422 },
      );
    }

    const events = plan.ops.events.map((e) => ({ ...e, import_batch_id: row.import_batch_id ?? null }));
    const { error: insErr } = await db.from("events").insert(events);
    if (insErr) return NextResponse.json({ error: `Writing the event failed: ${insErr.message}` }, { status: 500 });

    for (const u of plan.ops.refundUpdates) {
      await db.from("events")
        .update({ refund_amount: u.refund_amount, refund_date: u.refund_date })
        .eq("event_id", u.event_id);
    }

    const { error: e } = await db.from("unmatched_rows").update({
      resolved_at: new Date().toISOString(),
      resolved_contact_id: contactId,
      resolved_by: action === "assign" ? "assigned" : "accepted",
    }).eq("row_id", rowId);
    if (e) return NextResponse.json({ error: e.message }, { status: 500 });

    revalidatePath("/");
    revalidateTag(FUNNEL_TAG);
    return NextResponse.json({
      ok: true,
      outcome: action === "assign" ? "assigned" : "accepted",
      contactId,
      written: events.length,
      restatements: plan.diff.restatements,
    });
  } catch (err) {
    if (err instanceof ImportError) return NextResponse.json({ error: err.message }, { status: 422 });
    console.error("[unmatched/resolve]", err);
    return NextResponse.json({ error: "Could not resolve that row." }, { status: 500 });
  }
}
