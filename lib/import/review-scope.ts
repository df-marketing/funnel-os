import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { SOURCES, stageMetricOf, stageSpec, type ImportSourceKey, type SourceSpec } from "./sources";
import { resolveProfileScope, type ProfileScope } from "./mapping-profile";

export class ImportReviewError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
type Stage = {
  stage_slug: string | null; stage_metric: string | null; stage_name: string | null;
  stage_order: number; compare_dimension: string | null; stage_rate_label: string | null;
  source_type: string | null; source_ref: string | null; unit_price: number | null;
};
type Metric = {
  metric: string; label: string; source: string; client_id: string | null;
  event_type: string | null; product: string | null; is_core: boolean; aliases: string[] | null;
};
type StageChoice = { slug: string; label: string; source: ImportSourceKey; binding: string };
export type ReviewContext = { spec: SourceSpec; stages: StageChoice[]; fallbackBinding: string; customAdMetrics: string[] };
export type BoundScope = ProfileScope & { binding: string };

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const BOUND = /^[0-9a-f]{64}$/;
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
export const adMeasureField = (metric: string) => `ad_measure:${metric}`;

export function bodyString(value: unknown): string { return typeof value === "string" ? value : ""; }

export function isBuiltIn(source: string) { return Object.hasOwn(SOURCES, source); }

function datasetFor(metric: Metric): ImportSourceKey | null {
  if (metric.source === "ads") return "ads";
  if (metric.is_core) {
    if (metric.event_type === "lead") return "leads";
    if (metric.event_type === "attendance") return "attendance";
    if (metric.event_type === "sale") return "sales";
  }
  if (metric.event_type !== null) return `stage:${metric.metric}`;
  return null;
}

export async function readReviewContext(db: SupabaseClient, clientId: string, source: string): Promise<ReviewContext> {
  if (!ID.test(clientId)) throw new ImportReviewError("Choose a client before reviewing the import.");
  const metricName = stageMetricOf(source);
  if (!isBuiltIn(source) && (!metricName || !ID.test(metricName))) throw new ImportReviewError("Choose a supported dataset.");
  const cols = "metric,label,source,client_id,event_type,product,is_core,aliases";
  const [staged, global, owned] = await Promise.all([
    db.from("client_journey_config").select("stage_slug,stage_metric,stage_name,stage_order,compare_dimension,stage_rate_label,source_type,source_ref,unit_price").eq("client_id", clientId).order("stage_order").order("stage_slug").limit(257),
    db.from("journey_metrics").select(cols).is("client_id", null).limit(257),
    db.from("journey_metrics").select(cols).eq("client_id", clientId).limit(257),
  ]);
  if (staged.error || global.error || owned.error) throw new ImportReviewError("The client’s import configuration is unavailable.", 503);
  const config = (staged.data ?? []) as Stage[];
  const metrics = [...(global.data ?? []), ...(owned.data ?? [])] as Metric[];
  if (!config.length) {
    // Verify the legacy client before preserving its built-in automatic import.
    const known = await db.from("v_clients").select("client_id").eq("client_id", clientId).maybeSingle();
    if (known.error) throw new ImportReviewError("The client’s import configuration is unavailable.", 503);
    if (!known.data) throw new ImportReviewError("Choose an available client.", 404);
    throw new ImportReviewError("The client has no explicit journey configuration to review.", 424);
  }
  if (config.length > 256 || metrics.length > 256) throw new ImportReviewError("The selected client has too many configuration entries to review.", 422);
  const unique = new Map<string, Metric | null>();
  for (const metric of metrics) {
    if (!ID.test(metric.metric)) continue;
    unique.set(metric.metric, unique.has(metric.metric) ? null : metric);
  }
  const stages = config.flatMap((s) => {
    if (!s.stage_slug || !ID.test(s.stage_slug) || !s.stage_metric) return [];
    const metric = unique.get(s.stage_metric);
    if (!metric) return [];
    const dataset = datasetFor(metric);
    if (dataset !== source) return [];
    return [{
      slug: s.stage_slug, source: dataset, label: s.stage_name || s.stage_slug,
      binding: hash([clientId, dataset, s.stage_slug, s.stage_metric, s.stage_name, s.stage_order,
        s.compare_dimension, s.stage_rate_label, s.source_type, s.source_ref, s.unit_price,
        metric.event_type, metric.product, metric.client_id, metric.is_core, metric.label, metric.aliases]),
    }];
  });
  let spec: SourceSpec;
  if (metricName) {
    const declared = unique.get(metricName);
    if (!declared?.event_type || declared.source !== "events" || declared.is_core || !stages.length) {
      throw new ImportReviewError("This metric is not an importable stage for this client.", 404);
    }
    spec = stageSpec(declared.metric, declared.label, declared.event_type);
  } else {
    spec = SOURCES[source as keyof typeof SOURCES];
  }
  const ads = source === "ads" ? [...unique.values()].flatMap((m) =>
    m && m.source === "ads" && !m.is_core ? [m] : []) : [];
  if (ads.length) spec = {
    ...spec, fields: [...spec.fields, ...ads.map((m) => ({
      field: adMeasureField(m.metric), required: false, aliases: [m.metric, ...(m.aliases ?? [])],
    }))],
  };
  return {
    spec, stages, customAdMetrics: ads.map((m) => m.metric),
    fallbackBinding: hash([clientId, source, config.map((s) => [s.stage_slug, s.stage_metric, s.stage_order, s.stage_name, s.compare_dimension, s.stage_rate_label, s.source_type, s.source_ref, s.unit_price])]),
  };
}

export function bindReviewScope(
  ctx: ReviewContext, clientId: string, source: string, stageSlug: unknown, expectedBinding: unknown,
): BoundScope {
  const scope = resolveProfileScope({ clientId, source, stageSlug }, clientId, ctx.stages);
  const binding = scope.stageSlug === null ? ctx.fallbackBinding : ctx.stages.find((s) => s.slug === scope.stageSlug)?.binding;
  if (!binding || typeof expectedBinding !== "string" || !BOUND.test(expectedBinding) || binding !== expectedBinding) {
    throw new ImportReviewError("The journey changed since this file was reviewed. Review the file again.", 409);
  }
  return { ...scope, binding };
}
