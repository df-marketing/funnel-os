import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { isIsoDay } from "@/lib/integration/schema";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { MISSING_TOKEN_MESSAGE } from "@/lib/meta/graph";
import { runPull } from "@/lib/meta/pull";

export const runtime = "nodejs";

/**
 * "PULL NOW" for the person looking at the Import tab.
 *
 * The same runPull as the integration route, through a different door. This one
 * has no shared key, for the same reason /api/import/commit has none: the app
 * deliberately has no login, and a button a browser can press cannot hold a
 * secret. Adding one here would only move it into the page source.
 *
 * So this is as reachable as the rest of the app — which is the standing design,
 * not an oversight. What is different is that this endpoint SPENDS a Meta token,
 * and an open endpoint that spends someone else's rate limit is worth slowing
 * down even when reading the data behind it is already public.
 *
 * Hence the cooldown. It is per warm instance rather than global — serverless
 * gives no shared memory without another service — so it stops a person leaning
 * on the button, which is the realistic case, and would not stop a determined
 * flood. Said plainly rather than dressed up as protection it is not.
 */

const COOLDOWN_MS = 20_000;
const lastPull = new Map<string, number>();

export async function POST(request: Request) {
  let body: { clientId?: string; since?: string; until?: string; commit?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const clientId = body.clientId?.trim();
  if (!clientId) return NextResponse.json({ ok: false, error: "clientId is required" }, { status: 400 });

  // Only a commit is rate-limited. A dry run writes nothing and is the thing we
  // want people pressing freely before they commit.
  if (body.commit) {
    const since = Date.now() - (lastPull.get(clientId) ?? 0);
    if (since < COOLDOWN_MS) {
      return NextResponse.json(
        { ok: false, error: "cooldown",
          note: `Just pulled. Try again in ${Math.ceil((COOLDOWN_MS - since) / 1000)}s.` },
        { status: 429 },
      );
    }
  }

  const since = body.since ?? null;
  const until = body.until ?? null;
  if (!isIsoDay(since) || !isIsoDay(until) || since > until) {
    return NextResponse.json({ ok: false, error: "since and until must be YYYY-MM-DD with since <= until" }, { status: 400 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  const out = await runPull(db, {
    clientId, since, until, commit: body.commit,
  });

  if (!out.ok) {
    const note = out.error === "no_meta_token" ? MISSING_TOKEN_MESSAGE : out.note;
    return NextResponse.json({ ok: false, error: out.error, note }, { status: out.status });
  }

  if (out.committed && (out.written ?? 0) > 0) {
    lastPull.set(clientId, Date.now());
    // The figures on every other tab were just restated. Without this the page
    // shows the old ones and the pull looks as if it did nothing.
    revalidateTag(FUNNEL_TAG);
  }
  return NextResponse.json(out);
}
