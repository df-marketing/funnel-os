import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client for writes.
 *
 * The dashboard reads with the anon key under RLS. Imports write, and the app
 * has no login yet — so writes go through server routes holding the service-role
 * key, never the browser. This module must never be imported from a client
 * component: the key would end up in the bundle.
 *
 * Returns null when the key isn't configured, so routes can say so plainly
 * instead of failing with an RLS error nobody can act on.
 */
export function createAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Supabase's newer key system calls this a "secret key" (sb_secret_…) rather
  // than service_role, so both names are accepted — naming it after what the
  // dashboard shows you shouldn't produce a 503 with no explanation.
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;

  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const MISSING_KEY_MESSAGE =
  "SUPABASE_SERVICE_ROLE_KEY isn't set. Copy the secret key from Supabase → Settings → API " +
  "(Secret keys → sb_secret_…, or the legacy service_role key), then run " +
  "`vercel env add SUPABASE_SERVICE_ROLE_KEY` and redeploy. Reads work without it; imports don't.";

/**
 * PostgREST caps a response at 1000 rows. The matching index needs every contact
 * and every event, so paging is not optional — a silent truncation here would
 * make known people look unmatched and park real revenue.
 */
export async function fetchAll<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  apply?: (q: any) => any,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    let q = client.from(table).select(columns).range(from, from + pageSize - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < pageSize) return out;
  }
}
