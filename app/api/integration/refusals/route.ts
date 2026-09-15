import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { REFUSALS } from "@/lib/integration/codes";

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
    note:
      "Branch on `code`, or on `recover`. Never on the HTTP status: handle_taken and " +
      "source_holds_other are both 409 and want opposite responses, and a caller that " +
      "cannot tell them apart mints handles in a loop.",
    refusals: REFUSALS,
  });
}
