import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";


/** The shape @supabase/ssr hands `setAll`. Spelled out so the callback is
    typed rather than implicitly any — 10 errors that made `tsc --noEmit`
    never clean, which is where a real one would have hidden. */
type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

export async function updateSession(request: NextRequest) {
  const supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase isn't configured, skip the auth refresh and pass through.
  // Without this guard createServerClient throws "Your project's URL and Key
  // are required", crashing the edge middleware on every route (500
  // MIDDLEWARE_INVOCATION_FAILED).
  if (!url || !anonKey) {
    return supabaseResponse;
  }

  try {
    let response = supabaseResponse;
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });

    // Refresh session so it doesn't expire while user is active
    const { data: { user } } = await supabase.auth.getUser();

    /**
     * THE GATE, AND IT IS SHUT ONLY WHEN ASKED.
     *
     * Without FUNNEL_REQUIRE_LOGIN this does nothing at all and the app is
     * exactly what it was: no login, open to anybody with the link. That is
     * deliberate — the app is being demonstrated while this is being built, and
     * a login shipped by accident is a locked door with nobody holding a key.
     *
     * With it set, no session means the login page, and everything else waits.
     * Doing it here rather than per page means a route added later is covered
     * by default; forgetting to gate a new page is otherwise the obvious way
     * this ends up leaking.
     */
    const gated = process.env.FUNNEL_REQUIRE_LOGIN === "1";
    const path = request.nextUrl.pathname;
    const open =
      path === "/login" ||
      path.startsWith("/auth/") ||
      // Machine-to-machine, authenticated by INTEGRATION_SHARED_KEY rather than
      // by a session. AcqOS has no cookie and must not be redirected to a form.
      path.startsWith("/api/integration/");

    if (gated && !user && !open) {
      const to = request.nextUrl.clone();
      to.pathname = "/login";
      to.search = "";
      return NextResponse.redirect(to);
    }

    // Signed in and staring at the login page: send them where they meant to go.
    if (gated && user && path === "/login") {
      const to = request.nextUrl.clone();
      to.pathname = "/";
      to.search = "";
      return NextResponse.redirect(to);
    }

    return response;
  } catch {
    // Never let an auth hiccup crash the entire edge middleware
    return supabaseResponse;
  }
}
