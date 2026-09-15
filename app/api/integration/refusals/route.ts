import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { CONTRACT_VERSION, REFUSALS } from "@/lib/integration/codes";

export const runtime = "nodejs";

/**
 * GET /api/integration/refusals
 *
 * The refusal contract, served rather than described.
 *
 * The four codes existed in three places — two route files and a handover
 * document — and nothing made them agree. Serving them from the same constant
 * the routes throw means AcqOS can assert against the contract instead of
 * copying it, and a copy that drifts fails a test rather than a client.
 *
 * Static. No database, no client, nothing to filter — which is why it takes the
 * read key and nothing else.
 */
export async function GET(request: Request) {
  const key = checkIntegrationKey(request, "read");
  if (key === "unconfigured") return NextResponse.json({ error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  if (key !== "ok") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({
    /* Assert on this. It changes ONLY for a breaking change — a rename, a
       removal, or a moved status/recover. New codes appear without bumping it,
       because a caller that has never heard of a new code still handles every
       code it already knew, which is what additive means. */
    contractVersion: CONTRACT_VERSION,
    stability: "additive-only",
    note:
      "Branch on `code`, or on `recover`. Never on the HTTP status: handle_taken and " +
      "source_holds_other are both 409 and want opposite responses, and a caller that " +
      "cannot tell them apart mints handles in a loop.",
    guarantee:
      "Every code, status and recover value below is pinned by a frozen literal copy in " +
      "scripts/test-refusals.mts. A rename or a changed status fails that test before it " +
      "can reach you. Codes may be ADDED at contractVersion 1 without notice.",
    refusals: REFUSALS,
  });
}
