import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /auth/signout
 *
 * Ends the session and returns to the login page.
 *
 * POST rather than GET, because a GET sign-out is a link anybody can put in an
 * image tag or a chat message and log somebody out by having them look at it.
 */
export async function POST(request: Request) {
  const db = await createClient();
  await db.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
