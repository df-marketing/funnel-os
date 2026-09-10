import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { decideClaim } from "@/lib/integration/claim";

export const runtime = "nodejs";

/**
 * POST /api/integration/client-handle
 *   { clientId, sourceClientId, clientName? }
 *
 * RESERVE A HANDLE. DO NOT CREATE A CLIENT.
 *
 * AcqOS creates a client at signup, self-serve, and cannot push the funnel then
 * — the Growth Journey has no volumes yet. So onboarding is two moments, and
 * between them the slug sits unclaimed. A second signup deriving the same slug
 * from a similar company name would take it, and GT could not tell that from a
 * retry, because until now the slug was the only identity it held.
 *
 * This closes that window. It writes a row nobody can see: v_clients is built
 * FROM client_journey_config and LEFT JOINs client_flags, so a flags row with no
 * journey has no switcher entry and no tabs. The namespace is taken and nothing
 * else has happened, which is what a reservation should look like.
 *
 *   201  claimed
 *   200  already yours — idempotent, safe to retry
 *   409  that handle belongs to a different AcqOS client, or you already hold
 *        a different handle
 *
 * The 409 is the one that matters. AcqOS handles it by re-minting the slug and
 * calling again, silently — a name collision with a client they cannot see must
 * never surface at signup as an error about a system the user has never heard
 * of.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: create a client. A client in GT is its
 * journey stages — v_clients is built from them — so a client with no stages is
 * not a placeholder, it is a non-entity. Creating one here would put a nameless
 * row in the switcher that no import would ever fill.
 */

/**
 * BRANCH ON `code`, NOT ON THE STATUS.
 *
 * Both refusals below are 409 and they want opposite responses. `handle_taken`
 * means somebody else has the name — mint another and try again.
 * `source_holds_other` means this AcqOS client already has a handle, and
 * re-minting there produces a SECOND handle for a client that already has one,
 * which is the drift the unique index exists to stop. A caller switching on the
 * status alone cannot tell them apart, and the failure is a mint loop.
 *
 * AcqOS inferred the re-mint contract correctly and said they had invented it.
 * They had; this is it written down, so the next caller does not have to guess
 * or match on English.
 */

/** Same shape GT enforces everywhere else a client id is accepted. */
const CLIENT_ID = /^[a-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") {
    return NextResponse.json({ ok: false, error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  }
  if (key !== "ok") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  let body: { clientId?: unknown; sourceClientId?: unknown; clientName?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const sourceClientId = typeof body.sourceClientId === "string" ? body.sourceClientId.trim() : "";

  if (!CLIENT_ID.test(clientId)) {
    return NextResponse.json({
      ok: false,
      error: "clientId must be lowercase letters, numbers, underscores or hyphens",
    }, { status: 400 });
  }
  if (!UUID.test(sourceClientId)) {
    // Required, not optional. A claim without it is the thing this exists to
    // prevent — a handle held by nobody in particular.
    return NextResponse.json({
      ok: false,
      error: "sourceClientId is required and must be the AcqOS clients.id uuid",
    }, { status: 400 });
  }

  /* Two questions, and they fail differently: is this handle taken by someone
     else, and does this AcqOS client already hold a different handle? The
     second matters because the index enforces it and a bare constraint error
     would tell AcqOS to re-mint, which would not help — re-minting produces
     another handle for a client that already has one. */
  const { data: rows, error: readError } = await db
    .from("client_flags")
    .select("client_id, source_client_id")
    .or(`client_id.eq.${clientId},source_client_id.eq.${sourceClientId}`);
  if (readError) {
    return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });
  }

  const decision = decideClaim(rows ?? [], clientId, sourceClientId);

  if (decision.kind === "handle-taken") {
    return NextResponse.json({
      ok: false,
      code: "handle_taken",
      error: `handle '${clientId}' is already claimed by a different AcqOS client`,
      retry: "mint a different handle and claim again",
    }, { status: 409 });
  }

  if (decision.kind === "source-holds-other") {
    return NextResponse.json({
      ok: false,
      code: "source_holds_other",
      error: `this AcqOS client already holds the handle '${decision.heldHandle}'`,
      heldHandle: decision.heldHandle,
      retry: "none — use the handle you already hold",
    }, { status: 409 });
  }

  if (decision.kind === "already-yours") {
    return NextResponse.json({ ok: true, clientId, claimed: false, alreadyYours: true });
  }

  /* Either no row, or a row that predates the wire and has no owner. Both are
     claimable: a handle set by hand — shely's, for instance — is exactly the
     case AcqOS wants to adopt rather than duplicate. Only the currency and name
     are left alone, because a claim is not a schema push. */
  const { error: writeError } = await db.from("client_flags").upsert({
    client_id: clientId,
    source_client_id: sourceClientId,
    claimed_at: new Date().toISOString(),
  }, { onConflict: "client_id" });

  if (writeError) {
    return NextResponse.json({ ok: false, error: writeError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    clientId,
    claimed: true,
    adopted: decision.adopted,
    note: "handle reserved. The client is not visible until a funnel is pushed.",
  }, { status: 201 });
}
