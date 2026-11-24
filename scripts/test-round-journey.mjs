import assert from "node:assert/strict";
import { projectRoundJourney, roundPlotCuts, roundNumber } from "../lib/funnel/round-journey.mjs";

// Synthetic SECOM-shaped fixture, not live SECOM figures or metric identifiers.
const names = ["Impressions", "Clicks", "Leads", "Book Physical Appointment",
  "Scope Home Security Setup & Quotation Sent", "Sale Closed"];
const metrics = ["impressions", "clicks", "leads", "fixture_book", "fixture_quote", "fixture_sale"];
const stages = names.map((stage_name, i) => ({
  client_id: "fixture", stage_order: i + 1, stage_name, stage_slug: `s${i}`,
  stage_metric: metrics[i], stage_rate_label: null, compare_dimension: null,
}));
const vocabulary = [
  { metric: "fixture_book", metric_key: "book", source: "events", event_type: "appointment" },
  { metric: "fixture_quote", metric_key: "quote", source: "events", event_type: "quotation" },
  { metric: "fixture_sale", metric_key: "closed", source: "events", event_type: "sale" },
].map((v) => ({ ...v, client_id: "fixture", is_core: false }));
const cut = { cut_key: "r1", cut_label: "Round 1", cut_sub: null,
  m: { spend: 100, impr: "1000", clicks: 0, leads: "0", book: 3, quote: null, closed: 2 } };
const input = { stages: [...stages].reverse(), vocabulary, clientId: "fixture",
  sourceKeepsSpend: true, baseline: cut, total: cut, cuts: [cut] };
const before = JSON.stringify(input);
const p = projectRoundJourney(input);
assert.deepEqual(p.choices.map((x) => x.label), names);
assert.equal(p.rows[0].key, "spend");
assert.equal(p.cuts[0].m[p.choices[1].key], 0);
assert.equal(p.cuts[0].m[p.choices[2].key], 0);
assert.equal(p.cuts[0].m[p.choices[3].key], 3);
assert.equal(p.cuts[0].m[p.choices[4].key], null);
assert.equal(p.cuts[0].m[p.choices[5].key], null);
assert.match(p.unavailable.join(" "), /attribution/);
assert.equal(p.baseline.m[p.choices[3].key], 3);
assert.equal(p.total.m[p.choices[3].key], 3);
for (const choice of p.choices)
  assert.equal(roundPlotCuts(p, choice.key)[0].m.leads, p.cuts[0].m[choice.key]);
assert.equal(JSON.stringify(input), before);
for (const value of [null, undefined, "", " ", false, true, "bad", Infinity, {}])
  assert.equal(roundNumber(value), null);
assert.equal(roundNumber("0"), 0);
assert.equal(roundNumber(0), 0);
assert.equal(roundNumber("0.5"), 0.5);
const adsVocabulary = vocabulary.map((v) => v.metric === "fixture_book"
  ? { ...v, source: "ads", event_type: null } : v);
const organic = projectRoundJourney({ ...input, vocabulary: adsVocabulary, sourceKeepsSpend: false });
assert.equal(organic.cuts[0].m[p.choices[3].key], null);
assert.equal(organic.cuts[0].m[p.choices[5].key], null);
assert.match(organic.unavailable.join(" "), /source filter/);
const foreign = { ...vocabulary[0], client_id: "another-client" };
assert.equal(projectRoundJourney({ ...input, vocabulary: [...vocabulary, foreign] }).unavailable.length, 1);
const duplicate = { ...vocabulary[0], client_id: null };
assert.equal(projectRoundJourney({ ...input, vocabulary: [...vocabulary, duplicate] })
  .cuts[0].m[p.choices[3].key], null);
const collision = { ...vocabulary[0], metric: "other-metric" };
assert.equal(projectRoundJourney({ ...input, vocabulary: [...vocabulary, collision] })
  .cuts[0].m[p.choices[3].key], null);
const missing = projectRoundJourney({ ...input, vocabulary: [] });
assert.equal(missing.cuts[0].m[p.choices[3].key], null);
assert.equal(missing.cuts[0].m[p.choices[0].key], 1000);
assert.equal(projectRoundJourney({ ...input, cuts: [] }).cuts.length, 0);
assert.equal(projectRoundJourney({ ...input, stages: [] }).choices.length, 0);
const decoy = { ...stages[0], stage_metric: "constructor" };
const unknown = projectRoundJourney({ ...input, stages: [decoy] });
assert.equal(unknown.cuts[0].m[unknown.choices[0].key], null);
const noEvent = vocabulary.map((v) => v.metric === "fixture_book" ? { ...v, event_type: null } : v);
assert.equal(projectRoundJourney({ ...input, vocabulary: noEvent }).cuts[0].m[p.choices[3].key], null);
console.log("round-journey fixtures passed");
