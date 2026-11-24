import { getAccess, mayRead } from "@/lib/auth/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCsv } from "@/lib/import/csv";
import { detectSource } from "@/lib/import/detect";
import { inspectLeadOptInDate, inspectLeadRoundTags, type LeadRoundMatches } from "@/lib/import/lead-round-evidence";
import { isBuiltIn, readReviewContext, bodyString, ImportReviewError } from "@/lib/import/review-scope";
import { mapColumns, SOURCES } from "@/lib/import/sources";
import { WorkbookImportError } from "@/lib/import/worksheets";
import { boundedFormData, ImportInputError, inspectUpload, requireWorkbookAccess, validateUpload } from "@/lib/import/upload-file";

export const runtime = "nodejs";

// This route never stages an import or saves a profile.
export async function POST(request: Request) {
  const access = await getAccess();
  if (!access.staff) return Response.json({ error: "This account cannot review imports." }, { status: 403 });
  try {
    const form = await boundedFormData(request);
    const clientId = bodyString(form.get("client"));
    if (!clientId || !mayRead(access, clientId)) return Response.json({ error: "Choose an available client." }, { status: 404 });
    const source = bodyString(form.get("source")) || "auto";
    const file = validateUpload(form.get("file"));
    requireWorkbookAccess(file, access.enforced);
    const input = await inspectUpload(file, bodyString(form.get("sheet")));
    if (input.kind === "worksheets") return Response.json(input);

    const { headers, rows } = parseCsv(input.text);
    let resolved = source;
    const roundTagEvidence = source === "auto" || source === "leads" ? inspectLeadRoundTags(headers, rows) : null;
    if (source === "auto") {
      const first = headers[0];
      const found = detectSource(headers, first ? rows.map((r) => String(r[first] ?? "")) : []);
      if (found.kind === "unsure") {
        const candidates = found.candidates.map((c) => ({ ...c, label: SOURCES[c.source].label }));
        if (roundTagEvidence?.withRoundCode && !candidates.some((c) => c.source === "leads")) {
          // A Lead export without a date is not a valid auto-detection result.
          // It is nevertheless useful to inspect its columns without staging.
          candidates.push({ source: "leads", label: SOURCES.leads.label, why: "Review lead columns and opt-in dates" });
        }
        return Response.json({ kind: "source", message: "Choose which dataset this file contains.", roundTagEvidence, candidates });
      }
      if (found.kind === "unknown") {
        return Response.json({ kind: "source", message: found.why, detail: found.detail ?? [],
          roundTagEvidence, candidates: (["ads", "leads", "attendance", "sales", "scroll"] as const).map((key) => ({
            source: key, label: SOURCES[key].label,
          })) });
      }
      resolved = found.source;
    }

    if (resolved === "scroll") return Response.json({ kind: "legacy", source: resolved, profileReason: "Clarity uses its own export format and does not use column mapping profiles." });
    if (!rows.length) throw new ImportReviewError("That file has no data rows.", 422);
    const db = createAdminClient();
    if (!db) throw new ImportReviewError("The client’s import configuration is unavailable.", 503);

    let ctx;
    try { ctx = await readReviewContext(db, clientId, resolved); }
    catch (error) {
      // An older hosted schema must not remove the existing built-in CSV path.
      if (error instanceof ImportReviewError && isBuiltIn(resolved)) {
        if (error.status === 424) return Response.json({ kind: "legacy", source: resolved, profileReason: error.message });
        if (error.status === 503) {
          const known = await db.from("v_clients").select("client_id").eq("client_id", clientId).maybeSingle();
          if (!known.error && known.data) return Response.json({ kind: "legacy", source: resolved, profileReason: error.message });
        }
      }
      throw error;
    }
    const { data: remembered } = await db.from("v_column_map").select("column_map")
      .eq("client_id", clientId).eq("source", resolved).maybeSingle();
    const { map, missing, broken } = mapColumns(ctx.spec, headers, remembered?.column_map ?? null);
    let roundMatches: LeadRoundMatches = { status: "unchecked" };
    if (resolved === "leads" && roundTagEvidence?.dominant) {
      const code = roundTagEvidence.dominant.code;
      // The only interpolated query clause is a validated MMYY-NN from the
      // evidence helper; client scope is enforced separately in both queries.
      // Never read another client's matching codes.
      const maxRounds = 25;
      const matching = await db.from("rounds").select("round_id,code,market")
        .eq("client_id", clientId).or(`code.eq.${code},round_id.eq.${code}`)
        .order("round_id").limit(maxRounds + 1);
      roundMatches = matching.error ? { status: "unavailable" } : {
        status: "verified", truncated: (matching.data?.length ?? 0) > maxRounds,
        rounds: (matching.data ?? []).slice(0, maxRounds).map((round) => ({
          roundId: String(round.round_id), code: round.code ?? null, market: round.market ?? null,
        })),
      };
    }
    return Response.json({
      kind: "mapping", source: ctx.spec.key, label: ctx.spec.label, headers,
      fields: ctx.spec.fields.map((f) => ({ field: f.field, required: f.required })),
      automatic: map, missing, broken, stages: ctx.stages.map(({ slug, label, binding }) => ({ slug, label, binding })),
      fallbackBinding: ctx.fallbackBinding,
      ...(resolved === "leads" ? { roundTagEvidence, roundMatches, leadDate: inspectLeadOptInDate(rows, map.event_date) } : {}),
      profileEnabled: access.enforced && !!access.userId && access.staff,
    });
  } catch (error) {
    if (error instanceof ImportInputError || error instanceof ImportReviewError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof WorkbookImportError) return Response.json({ error: error.message }, { status: 422 });
    console.error("[import/inspect]", error);
    return Response.json({ error: "Could not inspect that file." }, { status: 500 });
  }
}
