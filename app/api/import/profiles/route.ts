import { getAccess, mayRead } from "@/lib/auth/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { MappingProfileError, validateMappingProfile } from "@/lib/import/mapping-profile";
import { listMappingProfiles, profileRevision, writeMappingProfile } from "@/lib/import/profile-store";
import { bindReviewScope, bodyString, ImportReviewError, readReviewContext } from "@/lib/import/review-scope";

export const runtime = "nodejs";

const MAX_JSON_BYTES = 128 * 1024;

export async function POST(request: Request) {
  const access = await getAccess();
  // Do not inherit requireStaff()'s unauthenticated demonstration mode.
  if (!access.enforced || !access.userId || !access.staff) {
    return Response.json({ error: "Saved profiles require a signed-in staff account on a login-enabled workspace." }, { status: 403 });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site" ||
      !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Send a valid profile request from this workspace." }, { status: 415 });
  }

  try {
    if (Number(request.headers.get("content-length")) > MAX_JSON_BYTES) {
      throw new ImportReviewError("This mapping profile is too large.", 413);
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new ImportReviewError("This mapping profile is too large.", 413);
    let input;
    try { input = JSON.parse(text); } catch { throw new ImportReviewError("The mapping profile request is invalid."); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ImportReviewError("The mapping profile request is invalid.");
    const clientId = bodyString(input.clientId);
    const source = bodyString(input.source);
    if (!clientId || !mayRead(access, clientId)) throw new ImportReviewError("Choose an available client.", 404);

    const db = createAdminClient();
    if (!db) throw new ImportReviewError("The workspace’s import connection is unavailable.", 503);
    const ctx = await readReviewContext(db, clientId, source);
    const scope = bindReviewScope(ctx, clientId, source, input.stageSlug, input.binding);
    if (scope.stageSlug === null) throw new ImportReviewError("Named profiles require a configured journey stage.", 422);

    if (input.action === "list") {
      const headers = input.headers;
      if (!Array.isArray(headers) || headers.length > 256 ||
          !headers.every((h) => typeof h === "string" && h.length <= 200)) {
        throw new ImportReviewError("Valid file headers are required to suggest profiles.");
      }
      return Response.json({ profiles: await listMappingProfiles(db, scope, ctx.spec, headers) });
    }
    if (input.action !== "create" && input.action !== "update") throw new ImportReviewError("Choose a valid profile action.");
    const profile = validateMappingProfile(input.profile, scope, ctx.spec);
    if (input.action === "update") {
      profileRevision(input.id, input.revision);
      return Response.json(await writeMappingProfile(db, scope, profile, { id: input.id, revision: input.revision }));
    }
    return Response.json(await writeMappingProfile(db, scope, profile), { status: 201 });
  } catch (error) {
    if (error instanceof ImportReviewError || error instanceof MappingProfileError) {
      return Response.json({ error: error.message }, { status: error instanceof ImportReviewError ? error.status : 422 });
    }
    console.error("[import/profiles]", error);
    return Response.json({ error: "Could not use saved mapping profiles." }, { status: 500 });
  }
}
