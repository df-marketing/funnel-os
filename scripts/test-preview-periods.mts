import assert from "node:assert/strict";
import { previewPeriodChoices, previewCadencesFor } from "../lib/funnel/preview-periods";
import { listOf, toggle } from "../lib/funnel/filters";

const shared = { key: "r:a", label: "A · 28 Aug–3 Sep", from: "2026-09-01", to: "2026-09-01" };
const ordinary = { key: "r:c", label: "C · 22–29 Sep", from: "2026-09-22", to: "2026-09-22" };
const choices = previewPeriodChoices([
  { key: "m:2026-09", label: "September 2026", from: "2026-09-01", to: "2026-09-30" },
  shared, ordinary, { ...shared, key: "r:b", label: "B · 1–8 Sep" }, shared, ordinary,
  { key: "r:invalid", label: "Invalid", from: null, to: null },
]);
assert.deepEqual(choices, [
  { key: "2026-09-01..2026-09-30", label: "September 2026" },
  { key: "2026-09-01..2026-09-01", label: "2026-09-01 (2 rounds share this date)" },
  { key: "2026-09-22..2026-09-22", label: ordinary.label },
]);
const [month, grouped, other] = choices;
const combined = toggle(toggle(null, grouped.key), month.key);
assert.deepEqual(listOf(combined), [grouped.key, month.key]);
assert.equal(toggle(combined, grouped.key), month.key);
assert.notEqual(other.key, grouped.key);
const products = [{ product_id: "w1", cadence: "week" }, { product_id: "w2", cadence: "week" },
  { product_id: "r1", cadence: "round" }] as const;
assert.deepEqual(previewCadencesFor(products, "w1,w2"), ["week"]);
assert.deepEqual(previewCadencesFor(products, " w2, w1,w2 "), ["week"]);
assert.deepEqual(previewCadencesFor(products, "w1,r1"), ["round", "week"]);
assert.deepEqual(previewCadencesFor(products, null), ["round", "week"]);
assert.deepEqual(previewCadencesFor(products, "missing"), ["round"]);
assert.deepEqual(previewCadencesFor([{ product_id: "old" }], "old"), ["round"]);
console.log("Preview-period grouping and cadence assertions passed.");
