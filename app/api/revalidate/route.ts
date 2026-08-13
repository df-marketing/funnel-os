import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { FUNNEL_TAG } from "@/lib/supabase/read";

export const runtime = "nodejs";

/**
 * POST /api/revalidate
 *
 * Drops every cached read and re-fetches from Supabase.
 *
 * Committing an import clears the cache on its own. This route exists for the
 * other case: rows changed in the SQL editor, which the app cannot observe. The
 * page would then serve a stale figure for up to an hour with no sign anything
 * was wrong — indistinguishable from the SQL having silently failed.
 *
 * Reads nothing and writes nothing, so there is no key or auth to get wrong.
 */
export async function POST() {
  revalidateTag(FUNNEL_TAG);
  revalidatePath("/");
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}
