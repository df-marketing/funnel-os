import assert from "node:assert/strict";
import { buildJourneyStrip, type JourneyVocabulary } from "../lib/funnel/journey-strip";
import type { Cut, Stage } from "../lib/funnel/data";

const clientId = "synthetic";
const configured = (stage_metric: string, stage_order: number): Stage => ({
  client_id: clientId, stage_order, stage_metric, stage_slug: stage_metric,
  stage_name: stage_metric, compare_dimension: null, stage_rate_label: null,
});
const declaration = (
  metric: string, metric_key: string, client_id: string | null = clientId, source = "ads",
): JourneyVocabulary[number] => ({
  metric, metric_key, client_id, source, event_type: source === "events" ? "approval" : null, is_core: false,
});
const custom = ["apply", "qualify", "confirm", "verify", "checkout", "purchase"];
const stages = [configured("impressions", 1), configured("clicks", 2),
  ...custom.map((name, i) => configured(name, i + 3))];
const totals = (m: Record<string, string | number | null>): Cut => ({ cut_key: "TOTAL", cut_label: "Total", cut_sub: null, m });
const scope = custom.map((m) => declaration(m, m));
const foreign = custom.flatMap((m) => ["other-a", "other-b", "other-c"].map((id) => declaration(m, m, id)));
const total = totals({ impr: 1000, clicks: 500, ctr: 48.2, apply: 266, qualify: "151",
  confirm: 0, checkout: 10, purchase: 5 });
const input = { stages: [...stages].reverse(), clientId, total, vocabulary: [...foreign, ...scope], sourceKeepsSpend: true };
const cards = buildJourneyStrip(input);
assert.deepEqual(cards.map((card) => card.stage_slug), stages.map((stage) => stage.stage_slug));
assert.deepEqual(cards.map((card) => card.value), [1000, 500, 266, 151, 0, null, 10, 5]);
assert.equal(cards[1].rate, 48.2, "Core CTR has its own filter-aware SQL semantics.");
assert.equal(cards[3].rate?.toFixed(1), "56.8", "151 / 266, not 100% from another copy of the same stage.");
assert.equal(cards[4].rate, 0);
assert.equal(cards[5].rate, null);
assert.equal(cards[6].rate, null, "No skipping the prior unmeasured stage.");
assert.equal(cards[7].rate, 50);
assert.equal(buildJourneyStrip({ ...input, sourceKeepsSpend: false })[2].value, null);
assert.equal(buildJourneyStrip({ ...input, vocabulary: null })[0].value, null);

const narrowed = buildJourneyStrip({ ...input, stages: [...stages, { ...stages[0], client_id: "foreign" }] });
assert.equal(narrowed.length, stages.length);

const ambiguous = buildJourneyStrip({ ...input, vocabulary: [...scope, declaration("apply", "other_key", null)] });
assert.equal(ambiguous[2].value, null, "Two eligible metric names are not resolved arbitrarily.");
assert.equal(ambiguous[3].value, 151);
assert.equal(ambiguous[3].rate, null, "Unverified predecessor does not become a denominator.");

const doubled = buildJourneyStrip({ ...input, vocabulary: [...scope, declaration("another-metric", "qualify")] });
assert.equal(doubled[3].value, null, "Mixed counts sharing one output key are not trusted.");

const overwritten = buildJourneyStrip({ ...input, vocabulary: [...scope, declaration("collision", "ctr")] });
assert.equal(overwritten[1].value, 500);
assert.equal(overwritten[1].rate, null, "A custom key may overwrite the precomputed rate.");

const deriveCollision = buildJourneyStrip({
  ...input, vocabulary: [...scope.filter((m) => m.metric !== "qualify"), declaration("qualify", "cp_apply")],
  total: totals({ clicks: 500, apply: 266, cp_apply: 123 }),
});
assert.equal(deriveCollision[3].value, null, "A generated cost key is not a custom stage count.");

const customSale = buildJourneyStrip({
  ...input,
  vocabulary: [...scope.filter((m) => m.metric !== "purchase"), {
    ...declaration("purchase", "purchase", clientId, "events"), event_type: "sale",
  }],
});
assert.equal(customSale[7].value, null, "Custom sale totals must not bypass the chosen credit model.");

const brokenConfiguration = buildJourneyStrip({
  ...input, stages: [...stages, { ...stages[2], stage_order: 20 }],
});
assert.equal(brokenConfiguration.length, stages.length - 1);
assert.equal(brokenConfiguration.find((card) => card.stage_slug === "qualify")?.rate, null);
console.log("Journey strip: canonical ordering, scoped values, custom ratios, missing/zero, and ambiguous collisions passed.");
