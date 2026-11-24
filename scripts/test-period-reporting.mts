import assert from "node:assert/strict";
import { allowReportingPreview, isReportingPreviewView } from "../lib/funnel/reporting-preview";
import { periodReporting } from "../lib/funnel/period-reporting";
import { previewCell } from "../lib/funnel/chart";
import type { Cut, Stage } from "../lib/funnel/data";
import type { JourneyVocabulary } from "../lib/funnel/journey-strip";

const gate = { mode: "development", host: "127.0.0.1:3000", client: "brand_new_client", reporting: "preview",
  configured: "brand_new_client, second-client" };
assert.equal(allowReportingPreview(gate), true);
assert.equal(allowReportingPreview({ ...gate, client: "second-client", host: "[::1]:3320" }), true);
for (const client of [undefined, "shely", "secom_smart_test", "fwd_meta_import_test", "brand_new", "brand_new_client ", "brand_new_client_2"]) {
  assert.equal(allowReportingPreview({ ...gate, client }), false);
}
for (const reporting of [undefined, "Preview", ["preview", "preview"], "preview,preview"]) {
  assert.equal(allowReportingPreview({ ...gate, reporting }), false);
}
for (const host of [undefined, "dev.example.invalid", "127.0.0.1.example.invalid"]) {
  assert.equal(allowReportingPreview({ ...gate, host }), false);
}
assert.equal(allowReportingPreview({ ...gate, mode: "production" }), false);
for (const view of ["import", "rules", "unmatched", "acqos"]) assert.equal(isReportingPreviewView(view), false);
assert.equal(isReportingPreviewView("compare:import"), true);
for (const configured of ["", "*", "brand_new_client,*", "brand_new_client,", "brand_new_client, bad entry", " BRAND_NEW_CLIENT "]) {
  assert.equal(allowReportingPreview({ ...gate, configured }), false);
}
const prior = process.env.GT_REPORTING_PREVIEW_CLIENTS;
delete process.env.GT_REPORTING_PREVIEW_CLIENTS;
try {
  assert.equal(allowReportingPreview({ ...gate, configured: undefined }), false);
} finally {
  if (prior !== undefined) process.env.GT_REPORTING_PREVIEW_CLIENTS = prior;
}

const clientId = "brand_new_client";
const stage = (metric: string, slug: string, name: string, order: number): Stage => ({
  client_id: clientId, stage_order: order, stage_name: name, stage_slug: slug,
  stage_metric: metric, compare_dimension: null, stage_rate_label: null,
});
const stages = [stage("demo-lead", "incoming", "Lead captured", 1), stage("fwd-action", "ad-action", "Ad application", 2),
  stage("preview_purchases", "closed", "Closed", 3)];
const vocabulary: JourneyVocabulary = [
  { metric: "demo-lead", metric_key: "customLeads", client_id: clientId, source: "events", event_type: "lead_custom", is_core: false },
  { metric: "fwd-action", metric_key: "applied", client_id: clientId, source: "ads", event_type: null, is_core: false },
];
const cut = (id: string, m: Record<string, number | null>): Cut => ({ cut_key: id, cut_label: id, cut_sub: null, m });
const input = {
  stages, clientId, vocabulary, sourceKeepsSpend: true, view: "month" as const,
  columns: [cut("2026-09", { customLeads: 820, applied: 266, prevBuy: 0.5, spend: 100, rev: -5, roas: -0.05, reach: 99 })],
  baseline: null, total: null,
};
const month = periodReporting(input);
assert.deepEqual(month.rows.map((row) => row.key), ["spend", "stage:incoming", "stage:ad-action", "stage:closed", "rev", "roas"]);
assert.equal(previewCell(0.5, month.rows.find((row) => row.key === "stage:closed")!.fmt), "0.5");
assert.equal(previewCell(0.004, month.rows.find((row) => row.key === "stage:closed")!.fmt), "0.004");
assert.equal(month.columns[0].m["stage:incoming"], 820);
assert.equal(month.columns[0].m["stage:ad-action"], 266);
assert.equal(month.columns[0].m["stage:closed"], 0.5);
assert.equal(month.columns[0].m.rev, -5);
assert.equal(month.columns[0].m.roas, -0.05);
assert.equal(month.columns[0].m.reach, undefined);

const weekly = periodReporting({ ...input, view: "week" });
assert.equal(weekly.columns[0].m["stage:ad-action"], null);
assert.equal(weekly.columns[0].m["stage:incoming"], 820);
assert.equal(weekly.weeklyAdsUnavailable, true);
assert.equal(periodReporting({ ...input, sourceKeepsSpend: false }).columns[0].m["stage:ad-action"], null);
assert.equal(periodReporting({ ...input, vocabulary: null }).columns[0].m.rev, null);

const withheld = periodReporting({ ...input, vocabulary: [...vocabulary, { ...vocabulary[0], metric: "other", metric_key: "rev" }] });
assert.equal(withheld.columns[0].m.rev, null);
const zero = periodReporting({ ...input, columns: [cut("2026-09", { customLeads: 0, applied: 0, spend: 0 })] });
assert.equal(zero.columns[0].m["stage:incoming"], 0);
assert.equal(zero.columns[0].m["stage:closed"], null);
const sourceInputs = {
  ...input, total: input.columns[0], baseline: input.columns[0],
  columns: [{ ...input.columns[0], group_key: "round-a", group_label: "Round A" }],
};
for (const view of ["source", "roundsource"] as const) {
  const result = periodReporting({ ...sourceInputs, view });
  assert.deepEqual(result.rows.map((row) => row.key), month.rows.map((row) => row.key));
  assert.equal(result.sourceCustomUnavailable, true);
  assert.equal(result.columns[0].group_key, "round-a");
  assert.equal(result.columns[0].m["stage:incoming"], null);
  assert.equal(result.columns[0].m["stage:ad-action"], null);
  assert.equal(result.baseline?.m["stage:incoming"], null);
  assert.equal(result.total?.m["stage:incoming"], null);
  assert.equal(result.columns[0].m["stage:closed"], 0.5);
  assert.equal(result.columns[0].m.rev, -5);
  assert.equal(result.columns[0].m.reach, undefined);
}
const reconfigured = periodReporting({ ...input, stages: [
  stage("preview_purchases", "closed", "Renamed purchase", 1),
  stage("demo-lead", "incoming", "New lead label", 2),
] });
assert.deepEqual(reconfigured.rows.map((row) => row.label), [
  "Ad spend", "Renamed purchase", "New lead label", "Recorded sales revenue", "Paid ROAS (×)",
]);
assert.equal(reconfigured.columns[0].m["stage:closed"], 0.5);
assert.equal(reconfigured.columns[0].m["stage:ad-action"], undefined);
console.log("Reporting gate, dynamically ordered projections, source grains, finance, and null/zero assertions passed.");
