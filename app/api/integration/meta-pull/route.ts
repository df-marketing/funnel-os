import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { isIsoDay } from "@/lib/integration/schema";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { MISSING_TOKEN_MESSAGE } from "@/lib/meta/graph";
import { runPull } from "@/lib/meta/pull";
import type { ClickKind } from "@/lib/meta/insights";

export const runtime = "nodejs";

/**
 * "PULL NOW" for a machine — AcqOS, a cron, a terminal.
 *
 * The work is in lib/meta/pull.ts; the button in the Import tab runs exactly the
 * same function through a different door, so the two cannot drift.
 *
 * It does not write unless asked twice: `commit: true` is required, and without
 * it the pull runs end to end and reports what it WOULD write. The Import tab
 * has worked that way since the beginning and a call that reaches a live ad
 * account has less business being the exception, not more.
 */

const MAX_DAYS = 92;

const defaultWindow = () => {
  const now = new Date();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const back = new Date(now);
  back.setUTCDate(back.getUTCDate() - 1);
  return { since: day(back), until: day(now) };
};

export async function POST(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") {
    return NextResponse.json({ ok: false, error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  }
  if (key !== "ok") {
    /*
     * A body, where the other integration routes answer 401 with nothing. Those
     * are called by AcqOS, which knows what it sent. This one gets typed into a
     * terminal, and an empty 401 through a JSON parser reports "Expecting value:
     * line 1 column 1" — naming neither the status nor the header, and reading
     * like the request never arrived. Naming the header gives nothing away:
     * whether it is required was never the secret, its value is.
     */
    return NextResponse.json(
      { ok: false, error: "unauthorized",
        note: "Send the shared secret in the x-integration-key header." },
      { status: 401 },
    );
  }

  let body: { clientId?: string; since?: string; until?: string; commit?: boolean; clicks?: ClickKind };
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const clientId = body.clientId?.trim();
  if (!clientId) return NextResponse.json({ ok: false, error: "clientId is required" }, { status: 400 });

  const win = body.since || body.until
    ? { since: body.since ?? "", until: body.until ?? "" }
    : defaultWindow();
  if (!isIsoDay(win.since) || !isIsoDay(win.until) || win.since > win.until) {
    return NextResponse.json({ ok: false, error: "since and until must be YYYY-MM-DD with since <= until" }, { status: 400 });
  }
  if (Math.round((Date.parse(win.until) - Date.parse(win.since)) / 86_400_000) > MAX_DAYS) {
    return NextResponse.json({ ok: false, error: `a pull covers at most ${MAX_DAYS} days; this is not a backfill` }, { status: 400 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  const out = await runPull(db, { clientId, ...win, commit: body.commit, clicks: body.clicks });
  if (!out.ok) {
    const note = out.error === "no_meta_token" ? MISSING_TOKEN_MESSAGE : out.note;
    return NextResponse.json({ ok: false, error: out.error, note }, { status: out.status });
  }
  return NextResponse.json(
    out.committed ? out : { ...out, note: "Nothing was written. Send commit: true to apply exactly this." },
  );
}
