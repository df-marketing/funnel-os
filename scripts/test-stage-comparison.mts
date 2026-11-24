import assert from "node:assert/strict";
import { comparisonStage, stageComparisonView, stageComparison } from "../lib/funnel/stage-comparison";
import type { Stage } from "../lib/funnel/data";
import { projectRoundJourney, roundPlotCuts } from "../lib/funnel/round-journey.mjs";

const sample: Stage = {
  client_id: "synthetic", stage_order: 2, stage_name: "Approved application",
  stage_slug: "arbitrary-stage", stage_metric: "approval-count",
  compare_dimension: "ads_performance.ad", stage_rate_label: null,
};

const safeFallback = stageComparison(sample, "stray-asset");
assert.equal(safeFallback.cut, "round");
assert.equal(safeFallback.fallback, "ads_performance.ad");
assert.equal(safeFallback.assetCut, undefined);
assert.equal(stageComparison(sample, null, "week").cut, "week");
assert.equal(stageComparison({ ...sample, compare_dimension: "rounds.round_id" }, null, "week").cut, "round");
assert.equal(stageComparison({ ...sample, compare_dimension: "unrelated.fake_breakdown" }, null).cut, "round");

const realDimension = { ...sample, stage_slug: "whatever-another-client-named-it", stage_metric: "clicks" };
assert.equal(stageComparison(realDimension, null).cut, "ad");
assert.equal(stageComparison(realDimension, "synthetic creative").cut, "adround");
assert.equal(stageComparison(realDimension, null).legacy, null);
const legacy = { ...realDimension, stage_slug: "ads" };
assert.equal(stageComparison(legacy, null).legacy, "ads");
assert.equal(stageComparison({ ...legacy, stage_metric: sample.stage_metric }, null).legacy, null);
assert.equal(stageComparison({ ...legacy, compare_dimension: "rounds.round_id" }, null).legacy, null);
assert.equal(stageComparison({ ...sample, stage_metric: "leads", compare_dimension: "events.utm_campaign → landing page" }, null).cut, "landing");
assert.equal(stageComparison({ ...sample, stage_metric: "attendance", compare_dimension: "events.variant → reminder sequence" }, null).cut, "variant");
const genericClass = stageComparison({ ...sample, stage_slug: "class", stage_metric: "attendance", compare_dimension: "events.variant" }, null);
assert.equal(genericClass.by, "variant");
assert.equal(genericClass.legacy, null);
assert.equal(stageComparison({ ...sample, stage_metric: "leads", compare_dimension: "events.utm_campaign" }, null).cut, "round");

for (const stage_slug of ["import", "round", "analysis"]) {
  const reserved = { ...sample, stage_slug };
  const stages = [reserved];
  assert.equal(comparisonStage(stages, stage_slug), null);
  assert.equal(comparisonStage(stages, stageComparisonView(stage_slug)), reserved);
  assert.equal(comparisonStage([], stageComparisonView(stage_slug)), null);
}
assert.equal(comparisonStage([sample, sample], sample.stage_slug), null);
assert.equal(stageComparisonView(sample.stage_slug), sample.stage_slug);

const cuts = [
  { cut_key: "zero", cut_label: "R0", cut_sub: "", m: { verifiedApproval: 0, leads: 90 } },
  { cut_key: "absent", cut_label: "R1", cut_sub: "", m: { leads: 70 } },
  { cut_key: "measured", cut_label: "R2", cut_sub: "", m: { verifiedApproval: 12, leads: 200 } },
];
const projection = projectRoundJourney({
  stages: [sample],
  vocabulary: [{ metric: "approval-count", metric_key: "verifiedApproval", client_id: "synthetic",
    event_type: "approval", source: "events", is_core: false }],
  clientId: "synthetic", sourceKeepsSpend: true, baseline: null, total: null, cuts,
});
const key = projection.choices[0].key;
assert.deepEqual(projection.cuts.map((column) => column.m[key]), [0, null, 12]);
assert.deepEqual(roundPlotCuts(projection, key).map((column) => column.m.leads), [0, null, 12]);
// The gated report never treats a legacy URL name as a measurement selector.
const configuredCompare = (stage: Stage, asset = null as string | null) => stageComparison(stage, asset, "round", true);
const click = configuredCompare(legacy);
const renamed = configuredCompare({ ...legacy, stage_name: "Engaged audience", stage_slug: "interaction", stage_order: 5 });
assert.equal(click.cut, "ad");
assert.equal(renamed.cut, click.cut);
assert.equal(renamed.by, click.by);
assert.equal(renamed.legacy, null);
assert.equal(click.legacy, null);
assert.equal(configuredCompare(legacy, "sample-asset").cut, "adround");
const remapped = configuredCompare({ ...legacy, stage_metric: "approval-count" });
assert.equal(remapped.cut, "round");
assert.equal(remapped.fallback, "ads_performance.ad");
const legacyPurchase = { ...sample, stage_slug: "preview", stage_metric: "preview_purchases", compare_dimension: "events.round_id" };
assert.equal(stageComparison(legacyPurchase, null).cut, "preview");
assert.equal(configuredCompare(legacyPurchase).cut, "round");
assert.equal(configuredCompare({ ...legacyPurchase, stage_slug: "completely-different" }).cut, "round");
assert.equal(configuredCompare({ ...sample, stage_metric: "leads", compare_dimension: "events.utm_campaign" }).cut, "round");
assert.equal(configuredCompare({ ...sample, stage_metric: "attendance", compare_dimension: "events.variant" }).cut, "variant");
console.log("Dynamic stage comparison routing, scoped projection and figure parity passed.");
