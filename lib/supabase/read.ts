import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { isTransient, retryRead } from "./transient";

/**
 * A cookie-free read client.
 *
 * Every table carries an anon `select using (true)` policy, so these reads never
 * depend on a session — and reading cookies would opt the whole call out of
 * unstable_cache. This client can therefore live inside a cached function; the
 * cookie-bound one in ./server.ts cannot.
 */
/**
 * Node's fetch reports every network failure as the same three words —
 * `TypeError: fetch failed` — and hides what actually happened in `.cause`,
 * which supabase-js drops on the floor. The screen then read "fetch failed"
 * next to a suggestion to run the migrations, which is the one explanation it
 * cannot be: the app was already talking to that schema an hour earlier.
 *
 * This walks the cause chain and puts the real reason in the message, so the
 * difference between "the hostname doesn't resolve", "the connection was
 * refused" and "the request timed out" survives to the screen. Three different
 * problems with three different fixes, and none of them is the SQL editor.
 */
function describe(e: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let cur: unknown = e;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { message?: string; code?: string; errno?: number; syscall?: string; cause?: unknown };
    const bit = [o.code, o.syscall, o.message].filter(Boolean).join(" ");
    if (bit && !parts.includes(bit)) parts.push(bit);
    cur = o.cause;
  }
  return parts.join(" — ") || String(e);
}

/** Where reads are pointed, said once so the error can name it. */
const host = () => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  } catch {
    return process.env.NEXT_PUBLIC_SUPABASE_URL ? "an unparseable URL" : "no URL configured";
  }
};

export function createReadClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        /**
         * Every request through this client is a read — anon key, select-only
         * policies — so retrying one cannot write anything twice. That is what
         * makes a blanket retry safe here and not on the admin client.
         */
        fetch: async (input, init) => {
          const attempt = async () => {
            try {
              const res = await fetch(input as RequestInfo, init);
              // Cloned because a body may only be read once and the caller still
              // needs it. Only 5xx pays for the clone.
              if (res.status >= 500) {
                const body = await res.clone().text().catch(() => "");
                return { res, transient: isTransient(res.status, body) };
              }
              return { res, transient: false };
            } catch (e) {
              throw new TypeError(`Could not reach ${host()} — ${describe(e)}`);
            }
          };
          const out = await retryRead(attempt, (o) => ({ transient: o.transient }));
          return out.res;
        },
      },
    },
  );
}

/** One tag for the whole dashboard: an import commit changes every cut at once. */
export const FUNNEL_TAG = "funnel";
