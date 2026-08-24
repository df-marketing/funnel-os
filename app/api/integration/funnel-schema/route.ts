import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { hasIntegrationKey } from "@/lib/integration/auth";
import { validateFunnelSchema } from "@/lib/integration/schema";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { FUNNEL_TAG } from "@/lib/supabase/read";

export const runtime = "nodejs";

/** AcqOS owns funnel shape; Funnel OS atomically replaces one known client's stages. */
export async function POST(request: Request) {
  if (!hasIntegrationKey(request)) return new NextResponse(null, { status: 401 });

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: MISSING_KEY_MESSAGE }, { status: 503 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, errors: [{ stage: null, field: "body", message: "invalid JSON" }] }, { status: 400 });
  }

  const validated = validateFunnelSchema(body);
  if (!validated.ok) return NextResponse.json({ ok: false, errors: validated.errors }, { status: 400 });

  const schema = validated.value;
  const { count, error: knownError } = await db
    .from("client_journey_config")
    .select("client_id", { count: "exact", head: true })
    .eq("client_id", schema.clientId);
  if (knownError) return NextResponse.json({ error: knownError.message }, { status: 500 });

  // A client that isn't here can be opened, but only on purpose. Without the
  // flag an unknown id is overwhelmingly a mistyped one, and inventing a client
  // from it would put a second, near-identical account in the switcher that
  // nobody asked for and no import would ever fill.
  //
  // createClient on a client that DOES exist is not an error: a retried push
  // whose first attempt actually landed must not come back as a failure. It
  // replaces the funnel and reports created: false.
  if (!count && !schema.createClient) {
    return NextResponse.json({
      ok: false,
      error: `unknown clientId '${schema.clientId}'. If this is a new client, send createClient: true.`,
    }, { status: 404 });
  }

  const { data, error } = await db.rpc("replace_client_journey_schema", {
    p_client_id: schema.clientId,
    p_client_name: schema.clientName,
    p_stages: schema.stages,
    p_client_note: schema.clientNote,
    p_schema_version: schema.schemaVersion,
    p_generated_at: schema.generatedAt,
  });
  if (error) return NextResponse.json({ error: `Could not replace funnel schema: ${error.message}` }, { status: 500 });

  const outcome = (data ?? null) as {
    written?: boolean; created?: boolean; pricesPreserved?: string[];
    reason?: string; storedGeneratedAt?: string; incomingGeneratedAt?: string;
  } | null;

  // Refused, not failed: a newer funnel is already stored. Nothing was written,
  // so there is nothing to revalidate and no retry that would help.
  if (outcome?.written === false) {
    return NextResponse.json({
      ok: false,
      error: "stale push: a newer funnel is already stored for this client",
      storedGeneratedAt: outcome.storedGeneratedAt ?? null,
      incomingGeneratedAt: outcome.incomingGeneratedAt ?? null,
    }, { status: 409 });
  }

  revalidatePath("/");
  revalidateTag(FUNNEL_TAG);
  // A price the payload did not carry was kept from the old rows rather than
  // erased. Say so: the caller is entitled to know the stored funnel is not
  // exactly what it sent.
  // created comes back from the function, which is the only place that saw the
  // prior row count and the write in the same transaction.
  return NextResponse.json({
    ok: true,
    clientId: schema.clientId,
    created: outcome?.created === true,
    stagesWritten: schema.stages.length,
    pricesPreserved: outcome?.pricesPreserved ?? [],
    syncedAt: new Date().toISOString(),
  });
}
