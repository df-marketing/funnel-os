/**
 * The one fault worth trying again.
 *
 * A cold Supabase connection sometimes rejects a perfectly good request with
 * `JWT issued at future` — the token was signed a fraction of a second ahead of
 * the clock that validates it. It clears on the very next call, and both clocks
 * are otherwise correct; nothing about the request is wrong.
 *
 * AcqOS hit it three times in five minutes of probing and survives because it
 * retries. This app did not retry, so the same blip reached a person as a 500
 * page or a route as a hard error. That asymmetry is the whole reason this
 * exists: the fault is identical, only the handling differed.
 *
 * Deliberately narrow. Only 5xx and only the transient message — a 400, a 404
 * or a genuine SQL error is an answer, and asking three times does not improve
 * it. And only ever wrapped around READS: a retried write is a second write.
 */

/** Roughly 0.6s of patience, spent in two goes. Longer helps nothing here. */
const BACKOFF_MS = [120, 480];

const TRANSIENT = /issued at future|jwt|connection|timeout|temporarily unavailable/i;

/**
 * supabase-js hands back a PostgrestError with no HTTP status, so the message is
 * all there is to go on. Kept separate from the status check for that reason.
 */
export const isTransientMessage = (body: string) => TRANSIENT.test(body);

export const isTransient = (status: number, body: string) =>
  status >= 500 && isTransientMessage(body);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a read while it keeps failing transiently.
 *
 * `run` must be idempotent. The last outcome is returned whatever it is — a
 * retry that never succeeds must surface the real error, not a message about
 * having tried, or the next person to read the logs learns nothing.
 */
export async function retryRead<T>(
  run: () => Promise<T>,
  failure: (result: T) => { transient: boolean },
): Promise<T> {
  let out = await run();
  for (const ms of BACKOFF_MS) {
    if (!failure(out).transient) return out;
    await wait(ms);
    out = await run();
  }
  return out;
}
