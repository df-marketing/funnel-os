import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { validateFunnelSchema } from "@/lib/integration/schema";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { FUNNEL_TAG } from "@/lib/supabase/read";

export const runtime = "nodejs";

/** AcqOS owns funnel shape; Funnel OS atomically replaces one known client's stages. */
export async function POST(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") return NextResponse.json({ error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 });
  if (key !== "ok") return new NextResponse(null, { status: 401 });

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

  // The validator checks a dimension looks like table.column; only the database
  // can say whether that column is there. Asked once for the whole payload, and
  // reported per stage so the answer names the row to go and fix.
  const wanted = [...new Set(schema.stages.map((stage) => stage.compareDimension).filter((d): d is string => d !== null))];
  if (wanted.length) {
    const { data: unknown, error: dimError } = await db.rpc("fo_unknown_dimensions", { p_dimensions: wanted });
    if (dimError) return NextResponse.json({ error: dimError.message }, { status: 500 });
    const missing = new Set((unknown ?? []) as string[]);
    if (missing.size) {
      return NextResponse.json({
        ok: false,
        errors: schema.stages
          .filter((stage) => stage.compareDimension && missing.has(stage.compareDimension))
          .map((stage) => ({
            stage: stage.order,
            field: "compareDimension",
            message: `no such column '${stage.compareDimension}' in this database`,
          })),
      }, { status: 400 });
    }
  }

  /**
   * The same split, one layer down: the validator says a metric looks like a
   * metric name, and journey_metrics says whether anyone declared it.
   *
   * Until 0048 this list was six values in TypeScript, so a client who measured
   * something else could not be described at all — SECOM's Appointment row
   * rendered '—' because the vocabulary was source code. Declaring one is now
   * an INSERT, and this is the check that makes a typo still fail loudly rather
   * than storing a stage nothing can ever count.
   */
  const metrics = [...new Set(schema.stages.map((stage) => stage.metric))];
  const { data: undeclared, error: metricError } = await db.rpc("fo_unknown_metrics", { p_metrics: metrics });
  if (metricError) return NextResponse.json({ error: metricError.message }, { status: 500 });
  const unknownMetrics = new Set((undeclared ?? []) as string[]);
  if (unknownMetrics.size) {
    return NextResponse.json({
      ok: false,
      errors: schema.stages
        .filter((stage) => unknownMetrics.has(stage.metric))
        .map((stage) => ({
          stage: stage.order,
          field: "metric",
          message:
            `no metric '${stage.metric}' is declared in this database. ` +
            `Declared metrics live in journey_metrics; add a row for it before pushing a stage that uses it.`,
        })),
    }, { status: 400 });
  }

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
    dimensionsPreserved?: string[]; rateLabelsPreserved?: string[];
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
  // A price, breakdown or rate label the payload did not carry was kept from the
  // old rows rather than erased. Say so for each: the caller is entitled to know
  // the stored funnel is not exactly what it sent, and which parts of it it does
  // not own.
  // created comes back from the function, which is the only place that saw the
  // prior row count and the write in the same transaction.
  return NextResponse.json({
    ok: true,
    clientId: schema.clientId,
    created: outcome?.created === true,
    stagesWritten: schema.stages.length,
    pricesPreserved: outcome?.pricesPreserved ?? [],
    dimensionsPreserved: outcome?.dimensionsPreserved ?? [],
    rateLabelsPreserved: outcome?.rateLabelsPreserved ?? [],
    syncedAt: new Date().toISOString(),
  });
}
