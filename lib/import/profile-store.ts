import type { SupabaseClient } from "@supabase/supabase-js";
import { mappingProfileNameKey, matchMappingProfile, validateMappingProfile, type MappingProfile } from "./mapping-profile";
import { ImportReviewError, type BoundScope } from "./review-scope";
import type { SourceSpec } from "./sources";

const TABLE = "import_mapping_profiles";
const COLS = "id,name,config,revision";
type Stored = { id: string; name: string; config: unknown; revision: number };
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// These exact scope columns must be used on every read and update.
const scopeFilters = (scope: BoundScope) => ({
  client_id: scope.clientId, source: scope.source,
  stage_key: scope.stageSlug ?? "", stage_binding: scope.binding,
});

export function profileRevision(id: unknown, revision: unknown): asserts id is string {
  if (typeof id !== "string" || !ID.test(id) ||
      typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || revision > 2147483646) {
    throw new ImportReviewError("Choose a valid current mapping profile.");
  }
}

const unavailable = () => new ImportReviewError(
  "Saved mapping profiles are not available. A workspace owner must configure profile storage before you can save or load profiles.", 503,
);

function storedProfile(row: Stored, scope: BoundScope) {
  if (!row.config || typeof row.config !== "object" || Array.isArray(row.config)) return null;
  const cfg = row.config as { headers?: unknown; mapping?: unknown; rules?: unknown };
  return { clientId: scope.clientId, source: scope.source, stageSlug: scope.stageSlug,
    name: row.name, headers: cfg.headers, mapping: cfg.mapping, rules: cfg.rules };
}

export async function listMappingProfiles(
  db: SupabaseClient, scope: BoundScope, spec: SourceSpec, headers: readonly string[],
) {
  const { data, error } = await db.from(TABLE).select(COLS).match(scopeFilters(scope))
    .order("updated_at", { ascending: false }).limit(100);
  if (error) throw unavailable();
  return ((data ?? []) as Stored[]).flatMap((row) => {
    try {
      const raw = storedProfile(row, scope);
      const saved = validateMappingProfile(raw, scope, spec);
      const match = matchMappingProfile(raw, scope, spec, headers);
      return [{ id: row.id, revision: row.revision, profile: match ?? saved, matches: match !== null }];
    } catch { return []; }
  });
}

export async function loadMappingProfile(
  db: SupabaseClient, scope: BoundScope, spec: SourceSpec, headers: readonly string[], id: string, revision: number,
) {
  profileRevision(id, revision);
  const { data, error } = await db.from(TABLE).select(COLS).match(scopeFilters(scope))
    .eq("id", id).eq("revision", revision).maybeSingle();
  if (error) throw unavailable();
  if (!data) throw new ImportReviewError("This profile is no longer current in the selected import. Load profiles again.", 409);
  return validateMappingProfile(storedProfile(data as Stored, scope), scope, spec, headers);
}

export async function writeMappingProfile(
  db: SupabaseClient, scope: BoundScope, profile: MappingProfile, update?: { id: string; revision: number },
) {
  const config = { headers: profile.headers, mapping: profile.mapping, rules: profile.rules };
  if (Buffer.byteLength(JSON.stringify(config), "utf8") > 60000) {
    throw new ImportReviewError("This mapping profile is too large to save.");
  }
  const values = { name: profile.name, name_key: mappingProfileNameKey(profile.name), config };
  let result;
  if (update) {
    profileRevision(update.id, update.revision);
    result = await db.from(TABLE).update({
      ...values, revision: update.revision + 1, updated_at: new Date().toISOString(),
    }).match(scopeFilters(scope)).eq("id", update.id).eq("revision", update.revision).select("id,revision").maybeSingle();
  } else {
    result = await db.from(TABLE).insert({
      ...values, client_id: scope.clientId, source: scope.source, stage_key: scope.stageSlug ?? "",
      stage_binding: scope.binding,
    }).select("id,revision").single();
  }
  if (result.error?.code === "23505") throw new ImportReviewError("A profile with this name already exists here. Choose another name or explicitly update it.", 409);
  if (result.error) throw unavailable();
  if (!result.data) throw new ImportReviewError("The profile changed since you opened it. Load profiles again before updating.", 409);
  return { id: result.data.id as string, revision: result.data.revision as number };
}
