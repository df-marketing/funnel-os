import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { FUNNEL_TAG, createReadClient } from "@/lib/supabase/read";
import { requireStaff } from "@/lib/auth/access";

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
 * SQL-editor changes are also the one case the campaign lookup cannot see. It
 * is a materialised view now — five views read it and rebuilding it per query
 * was about half the database floor — and it is refreshed on import commit,
 * which a hand-edited rule never reaches. So this button refreshes it too:
 * dropping the app's cache and leaving the database's would re-read stale rows
 * faithfully and look like the button did nothing.
 *
 * The refresh runs BEFORE the cache is dropped, so nothing can repopulate the
 * cache from a lookup that is about to change.
 */
export async function POST() {
  /* Writing, or staff-only. The middleware proves there is a session;
     only this proves the session may do it. */
  const denied = await requireStaff();
  if (denied) return denied;

  let refreshed: string | null = null;
  let refreshError: string | null = null;

  const db = createReadClient();
  const { data, error } = await db.rpc("fo_refresh_lookups");
  if (error) refreshError = error.message;
  else refreshed = (data as string | null) ?? "refreshed";

  revalidateTag(FUNNEL_TAG);
  revalidatePath("/");

  /* 200 either way. The cache WAS dropped, which is what the button promises,
     and a failed lookup refresh understates new campaigns rather than
     corrupting anything — worth reporting, not worth failing the request. */
  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    lookups: refreshError ? `not refreshed: ${refreshError}` : refreshed,
  });
}
