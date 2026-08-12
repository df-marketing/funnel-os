import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * A cookie-free read client.
 *
 * Every table carries an anon `select using (true)` policy, so these reads never
 * depend on a session — and reading cookies would opt the whole call out of
 * unstable_cache. This client can therefore live inside a cached function; the
 * cookie-bound one in ./server.ts cannot.
 */
export function createReadClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** One tag for the whole dashboard: an import commit changes every cut at once. */
export const FUNNEL_TAG = "funnel";
