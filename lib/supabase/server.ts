import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";


/** The shape @supabase/ssr hands `setAll`. Spelled out so the callback is
    typed rather than implicitly any — 10 errors that made `tsc --noEmit`
    never clean, which is where a real one would have hidden. */
type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components can't set cookies; middleware handles session refresh
          }
        },
      },
    },
  );
}
