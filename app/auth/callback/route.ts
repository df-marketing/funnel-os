import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /auth/callback?code=…
 *
 * Where a sign-in link lands.
 *
 * A client provisioned from AcqOS has no password — the account was created
 * without one on purpose, so there is nothing to keep in step with AcqOS's copy.
 * They arrive holding a one-time code instead, and this is the only place it can
 * be exchanged for a session.
 *
 * An expired or reused link is the ordinary case, not an exception: people find
 * the welcome email a week later, or click it twice. It sends them to the login
 * page with something they can act on rather than a stack trace.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing-code", url.origin));
  }

  const db = await createClient();
  const { error } = await db.auth.exchangeCodeForSession(code);

  if (error) {
    /* Deliberately one message for expired, reused and malformed. They differ
       to us and not to the person holding the link, and the action is the same
       in all three: ask for another. */
    return NextResponse.redirect(new URL("/login?error=link-expired", url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
