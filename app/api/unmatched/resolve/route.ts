import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { normEmail, normPhone } from "@/lib/import/identity";

export const runtime = "nodejs";

/**
 * POST /api/unmatched/resolve  { rowId, action: "accept" | "dismiss" }
 *
 * "accept" ties the parked row to the contact its best guess names, and the row
 * stops being understated-by. "dismiss" closes it without counting it.
 *
 * The parked row is never deleted either way — resolved_at and resolved_contact_id
 * are stamped on it, so the queue stays auditable.
 */
export async function POST(request: Request) {
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  try {
    const { rowId, action } = await request.json();
    if (!rowId || !["accept", "dismiss"].includes(action)) {
      return NextResponse.json({ error: "Need a rowId and action of accept or dismiss." }, { status: 400 });
    }

    const { data: row, error } = await db
      .from("unmatched_rows")
      .select("row_id, client_id, best_guess, confidence, resolved_at")
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

    if (!row.best_guess) {
      return NextResponse.json(
        { error: "There's no best guess to accept on that row — nothing confident enough was found." },
        { status: 422 },
      );
    }

    // The guess names a person by email or phone. Resolve it against real contacts;
    // if it doesn't land on one, refuse rather than invent a contact.
    const email = normEmail(row.best_guess);
    const phone = normPhone(row.best_guess);
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
        { error: `"${row.best_guess}" doesn't match a known contact. Fix it at source rather than guessing here.` },
        { status: 422 },
      );
    }

    const { error: e } = await db.from("unmatched_rows").update({
      resolved_at: new Date().toISOString(),
      resolved_contact_id: contactId,
      resolved_by: "accepted",
    }).eq("row_id", rowId);
    if (e) return NextResponse.json({ error: e.message }, { status: 500 });

    revalidatePath("/");
    revalidateTag(FUNNEL_TAG);
    return NextResponse.json({ ok: true, outcome: "accepted", contactId });
  } catch (err) {
    console.error("[unmatched/resolve]", err);
    return NextResponse.json({ error: "Could not resolve that row." }, { status: 500 });
  }
}
