import type { Stage } from "./data";
import type { Cut2 } from "./cuts";

export type LegacyComparison = "targeting" | "ads" | "lp" | "class" | "preview" | "middle";

const PREFIX = "compare:";
const FIXED = new Set([
  "import", "unmatched", "acqos", "rules", "forms",
  "month", "week", "round", "source", "roundsource", "analysis",
]);
export const isFixedReportingView = (view: string) => FIXED.has(view);

/** Preserve existing stage bookmarks. A configured slug colliding with a
 * built-in URL gets a namespaced link instead of opening an unrelated view. */
export function stageComparisonView(slug: string): string {
  return FIXED.has(slug) || slug.startsWith(PREFIX) ? PREFIX + slug : slug;
}

export function comparisonStage(stages: readonly Stage[], view: string): Stage | null {
  if (FIXED.has(view)) return null;
  const slug = view.startsWith(PREFIX) ? view.slice(PREFIX.length) : view;
  const matches = stages.filter((stage) => stage.stage_slug === slug);
  return matches.length === 1 ? matches[0] : null;
}
export const isComparisonAddress = (view: string) => view.startsWith(PREFIX);

type AssetCut = "ad" | "adset" | "landing" | "variant";
type Dimension = { cut: Cut2; label: string; by: string; assetCut?: AssetCut; fallback?: string };
export type StageComparison = Dimension & { stage: Stage; legacy: LegacyComparison | null };

const forDimension = (metric: string, dimension: string | null, defaultCut: "round" | "week"): Dimension => {
  const fallback = { cut: defaultCut, label: defaultCut === "week" ? "Weeks" : "Rounds", by: defaultCut === "week" ? "week" : "round" };
  const deliveryOrLead = ["impressions", "clicks", "leads"].includes(metric);
  if (dimension === "ads_performance.ad_set" && deliveryOrLead)
    return { cut: "adset", label: "Audiences", by: "audience", assetCut: "adset" };
  if (dimension === "ads_performance.ad" && deliveryOrLead)
    return { cut: "ad", label: "Ads", by: "ad", assetCut: "ad" };
  if (dimension === "events.utm_campaign → landing page" && metric === "leads")
    return { cut: "landing", label: "Landing pages", by: "landing page", assetCut: "landing" };
  if (dimension === "events.variant → reminder sequence" && metric === "attendance")
    return { cut: "variant", label: "Reminder sequences", by: "reminder sequence", assetCut: "variant" };
  if (dimension === "events.variant" && metric === "attendance")
    return { cut: "variant", label: "Variants", by: "variant", assetCut: "variant" };
  if (dimension === "rounds.session_label" && metric === "attendance")
    return { cut: "session", label: "Sessions", by: "session" };
  // Existing custom counts are aggregated by round/month/week, not by an
  // arbitrary configured table.column. Never interpolate the configuration.
  if (dimension === null) return fallback;
  if (["rounds.round_id", "events.round_id"].includes(dimension))
    return { cut: "round", label: "Rounds", by: "round" };
  return { ...fallback, fallback: dimension };
};

const DRILLED: Record<AssetCut, Cut2> = {
  ad: "adround", adset: "adsetround", landing: "landinground", variant: "variantround",
};

export function stageComparison(
  stage: Stage,
  asset: string | null,
  defaultCut: "round" | "week" = "round",
  reportingPreview = false,
): StageComparison {
  const dimension = stage.compare_dimension?.trim().toLowerCase() || null;
  const metric = stage.stage_metric ?? "";
  const selection = forDimension(metric, dimension, defaultCut);
  const slug = stage.stage_slug;
  let cut = selection.cut;
  let legacy: LegacyComparison | null = null;
  // The opted-in path needs only the configured metric and breakdown. The
  // same contract applies to a renamed, reordered, added, or reserved stage.
  // Legacy panes and any preset offer cuts remain untouched outside preview.
  if (reportingPreview) {
    if (selection.assetCut && asset) cut = DRILLED[selection.assetCut];
    return { ...selection, cut, stage, legacy };
  }
  if (slug === "targeting" && metric === "impressions" && cut === "adset") legacy = slug;
  if (slug === "ads" && metric === "clicks" && cut === "ad") legacy = slug;
  if (slug === "lp" && metric === "leads" && cut === "landing") legacy = slug;
  if (slug === "class" && metric === "attendance" && dimension === "events.variant → reminder sequence") legacy = slug;
  if (dimension === "events.round_id" &&
      ((slug === "preview" && metric === "preview_purchases") ||
       (slug === "middle" && metric === "middle_purchases"))) {
    legacy = slug;
    cut = slug;
  }
  if (selection.assetCut && asset) cut = DRILLED[selection.assetCut];
  return { ...selection, cut, stage, legacy };
}
