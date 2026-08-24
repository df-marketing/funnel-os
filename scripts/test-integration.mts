import assert from "node:assert/strict";
import { coverageEnds, lastImported, type ImportStatusRow } from "../lib/integration/coverage";
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

// Coverage — shely's real v_import_status on 2026-08-24. Ads reach the 31st;
// attendance and sales stop on the 28th and leads on the 27th.
const row = (source: string, importedAt: string, end: string | null): ImportStatusRow =>
  ({ source, imported_at: importedAt, coverage_start: "2026-05-01", coverage_end: end, is_stale: true, days_behind: null });

const shely = [
  row("ads", "2026-08-19T06:08:56Z", "2026-05-31"),
  row("attendance", "2026-08-19T06:09:19Z", "2026-05-28"),
  row("leads", "2026-08-19T06:09:16Z", "2026-05-27"),
  row("sales", "2026-08-19T06:09:22Z", "2026-05-28"),
  row("scroll", "2026-08-21T01:41:44Z", "2026-05-27"),
];

assert.equal(coverageEnds(shely), "2026-05-27", "coverage runs out at the earliest source, not the latest");
assert.equal(lastImported(shely), "2026-08-21T01:41:44Z", "last import is the most recent of any source");
assert.equal(coverageEnds([]), null, "a client with no committed batch has no coverage");
assert.equal(
  coverageEnds([row("ads", "2026-08-19T06:08:56Z", "2026-05-31"), row("attendance", "2026-08-19T06:09:19Z", null)]),
  null,
  "a source with no coverage_end makes the whole answer unknown, not the other source's date",
);

console.log("integration schema validation: ok");
console.log("integration coverage rule: ok");
