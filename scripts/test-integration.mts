import assert from "node:assert/strict";
import { validateFunnelSchema } from "../lib/integration/schema";

const valid = {
  clientId: "shely",
  clientName: "Shely",
  source: "acqos",
  schemaVersion: 1,
  generatedAt: "2026-08-24T09:00:00+08:00",
  stages: [
    {
      order: 1, slug: "targeting", name: "Targeted views", metric: "impressions",
      sourceType: "meta", sourceRef: "impressions", compareDimension: "ads_performance.ad_set",
      rateLabel: null, unitPrice: null,
    },
    {
      order: 2, slug: "preview", name: "Bought preview", metric: "preview_purchases",
      sourceType: "csv", sourceRef: "sales", compareDimension: "events.round_id",
      rateLabel: "Close rate", unitPrice: 0,
    },
  ],
};

const accepted = validateFunnelSchema(valid);
assert.equal(accepted.ok, true, "valid AcqOS schema should be accepted");
if (accepted.ok) assert.equal(accepted.value.stages[1].unitPrice, 0, "zero price must not turn into null");

const rejected = validateFunnelSchema({
  ...valid,
  stages: [
    valid.stages[0],
    { ...valid.stages[1], order: 1, metric: "signups", sourceType: "stripe" },
  ],
});
assert.equal(rejected.ok, false, "bad schemas must be rejected as a whole");
if (!rejected.ok) {
  assert.ok(rejected.errors.some((e) => e.field === "metric"), "reports unsupported metrics");
  assert.ok(rejected.errors.some((e) => e.field === "sourceType"), "reports unsupported source types");
  assert.ok(rejected.errors.some((e) => e.field === "order"), "reports duplicate orders");
}

console.log("integration schema validation: ok");
