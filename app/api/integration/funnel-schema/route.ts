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
  if (!count) return NextResponse.json({ ok: false, error: "unknown clientId" }, { status: 404 });

  const { data, error } = await db.rpc("replace_client_journey_schema", {
    p_client_id: schema.clientId,
    p_client_name: schema.clientName,
    p_stages: schema.stages,
  });
  if (error) return NextResponse.json({ error: `Could not replace funnel schema: ${error.message}` }, { status: 500 });

  revalidatePath("/");
  revalidateTag(FUNNEL_TAG);
  // A price the payload did not carry was kept from the old rows rather than
  // erased. Say so: the caller is entitled to know the stored funnel is not
  // exactly what it sent.
  const kept = (data as { pricesPreserved?: string[] } | null)?.pricesPreserved ?? [];
  return NextResponse.json({
    ok: true,
    clientId: schema.clientId,
    stagesWritten: schema.stages.length,
    pricesPreserved: kept,
    syncedAt: new Date().toISOString(),
  });
}
