/**
 * WHO MAY CLAIM A HANDLE.
 *
 * Pulled out of the route because the wrong answer here is not an error page —
 * it is a real client's funnel being replaced by somebody else's. Four
 * outcomes, two of which look identical from the outside and must not be
 * confused:
 *
 *   a retry      same handle, same AcqOS client   → fine, say so, change nothing
 *   a collision  same handle, different client    → refuse, tell them to re-mint
 *
 * The route reads rows and writes them. This decides. Keeping them apart is
 * what lets the decision be tested without a database.
 */

export type ClaimRow = { client_id: string; source_client_id: string | null };

export type ClaimDecision =
  | { kind: "claim"; adopted: boolean }
  | { kind: "already-yours" }
  | { kind: "handle-taken" }
  | { kind: "source-holds-other"; heldHandle: string };

export function decideClaim(
  rows: ClaimRow[],
  clientId: string,
  sourceClientId: string,
): ClaimDecision {
  const onHandle = rows.find((r) => r.client_id === clientId);
  const onSource = rows.find((r) => r.source_client_id === sourceClientId);

  // Somebody else's handle. Refused before anything else, because every other
  // branch below would write to it.
  if (onHandle?.source_client_id && onHandle.source_client_id !== sourceClientId) {
    return { kind: "handle-taken" };
  }

  /* This AcqOS client already holds a different handle. Distinct from the case
     above and it matters: re-minting is the fix for a taken handle and is NOT
     the fix for this — it would mint a second handle for a client that already
     has one, which is the drift the unique index exists to prevent. */
  if (onSource && onSource.client_id !== clientId) {
    return { kind: "source-holds-other", heldHandle: onSource.client_id };
  }

  // Same handle, same owner. A retry whose first attempt landed.
  if (onHandle?.source_client_id === sourceClientId) return { kind: "already-yours" };

  /* Free, or held by a row that predates the wire and has no owner — shely's
     handle was set by hand and is exactly the case AcqOS should adopt rather
     than duplicate. `adopted` distinguishes them for the reply only; both
     write the same thing. */
  return { kind: "claim", adopted: Boolean(onHandle) };
}
