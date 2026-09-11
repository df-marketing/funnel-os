import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth/access";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { revalidateTag } from "next/cache";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { cleanKey, isTarget, whyInvalid, nextOrd, type DimensionRow } from "@/lib/funnel/rules";

export const runtime = "nodejs";

/**
 * The rules, as rows a person can write.
 *
 * REQUIREMENT 3. The engine has been able to do this since 0073 — five targets,
 * ten operators, four fields — and the only way to reach it was to write SQL by
 * hand. That is fine for the one client we have and stops being fine at the
 * second, which is the whole point of the requirement.
 *
 * STAFF ONLY, and it is not a preference. A rule decides which source a lead is
 * credited to, so a client able to edit their own rules could move their own
 * revenue between columns. It sits behind requireStaff for the same reason
 * Import does.
 *
 * CHANGING A RULE RESTATES HISTORY. Nothing is re-imported: the raw campaign
 * name and source are stored, the label is derived at read, so every past round
 * answers to the new rule the moment it is saved. That is the design — and it
 * is also why the cache is dropped here rather than left to expire, because a
 * rule that takes thirty minutes to appear reads as a rule that did not save.
 */

type Body = Partial<DimensionRow> & { id?: string };

async function client() {
  const denied = await requireStaff();
  if (denied) return { denied };
  const db = createAdminClient();
  if (!db) {
    return { denied: NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 }) };
  }
  return { db };
}

export async function GET(request: Request) {
  const g = await client();
  if (g.denied) return g.denied;

  const url = new URL(request.url);
  const clientId = (url.searchParams.get("client") ?? "").trim();
  const target = url.searchParams.get("target");
  if (!clientId) return NextResponse.json({ ok: false, error: "client is required" }, { status: 400 });
  if (target && !isTarget(target)) {
    return NextResponse.json({ ok: false, error: `'${target}' is not a dimension this app resolves` }, { status: 400 });
  }

  let q = g.db.from("dimension_values").select("*").eq("client_id", clientId);
  if (target) q = q.eq("target", target);
  const { data, error } = await q.order("target").order("ord").order("key");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, values: data ?? [] });
}

export async function POST(request: Request) {
  const g = await client();
  if (g.denied) return g.denied;

  let body: Body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const clientId = String(body.client_id ?? "").trim();
  if (!clientId) return NextResponse.json({ ok: false, error: "client_id is required" }, { status: 400 });

  const value: Partial<DimensionRow> = {
    client_id: clientId,
    target: body.target,
    key: cleanKey(String(body.key ?? "")),
    label: body.label ? String(body.label).slice(0, 80) : null,
    note: body.note ? String(body.note).slice(0, 400) : null,
    flags: body.flags && typeof body.flags === "object" ? body.flags : {},
    rules: Array.isArray(body.rules) ? body.rules : [],
  };

  /* Refused with the reason, not a 400 and a shrug. Somebody is mid-edit and
     the message is the only thing that tells them which clause is wrong. */
  const bad = whyInvalid(value);
  if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

  /* Order is only computed for a NEW value. Recomputing it on every save would
     silently re-sort rules somebody has deliberately arranged. */
  if (typeof body.ord === "number") {
    value.ord = body.ord;
  } else if (!body.id) {
    const { data: siblings } = await g.db.from("dimension_values")
      .select("ord, flags").eq("client_id", clientId).eq("target", value.target!);
    value.ord = nextOrd((siblings ?? []) as Array<{ ord: number; flags: Record<string, unknown> }>);
  }

  const row = body.id ? { ...value, id: body.id } : value;
  const { data, error } = await g.db.from("dimension_values")
    .upsert(row, { onConflict: "id" }).select().single();

  if (error) {
    /* The unique key is (client, target, key). Saying so beats "duplicate key
       value violates constraint dimension_values_client_target_key_key". */
    const clash = /duplicate key|unique/i.test(error.message);
    return NextResponse.json({
      ok: false,
      error: clash ? `'${value.key}' already exists for ${value.target} — edit that one instead` : error.message,
    }, { status: clash ? 409 : 500 });
  }

  revalidateTag(FUNNEL_TAG);
  return NextResponse.json({ ok: true, value: data }, { status: body.id ? 200 : 201 });
}

export async function DELETE(request: Request) {
  const g = await client();
  if (g.denied) return g.denied;

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });

  /* Read it first so the response can say what went, and so deleting the last
     catch-all can be refused: without one, everything it used to absorb
     resolves to null and appears as an unnamed column rather than an error. */
  const { data: doomed } = await g.db.from("dimension_values").select("*").eq("id", id).maybeSingle();
  if (!doomed) return NextResponse.json({ ok: true, deleted: false, reason: "no such value" });

  if ((doomed.flags as Record<string, unknown>)?.catch_all) {
    const { count } = await g.db.from("dimension_values")
      .select("id", { count: "exact", head: true })
      .eq("client_id", doomed.client_id).eq("target", doomed.target);
    if ((count ?? 0) > 1) {
      return NextResponse.json({
        ok: false,
        error: `'${doomed.key}' is the catch-all for ${doomed.target}. Delete the others first, or make another value the catch-all — without one, anything unmatched becomes an unnamed column.`,
      }, { status: 409 });
    }
  }

  const { error } = await g.db.from("dimension_values").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  revalidateTag(FUNNEL_TAG);
  return NextResponse.json({ ok: true, deleted: true, key: doomed.key, target: doomed.target });
}
