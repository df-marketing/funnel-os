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

// Two stages cannot share a slug: the database would take it (the key is
// client_id + stage_order) and both would inherit the same preserved price.
const sameSlug = validateFunnelSchema({
  ...valid,
  stages: [valid.stages[0], { ...valid.stages[1], slug: "targeting" }],
});
assert.equal(sameSlug.ok, false, "duplicate slugs must be rejected");
if (!sameSlug.ok) {
  assert.ok(sameSlug.errors.some((e) => e.field === "slug" && e.message.includes("targeting")), "names the repeated slug");
}

// createClient and clientNote are optional, and default to not-onboarding.
const plain = validateFunnelSchema(valid);
assert.ok(plain.ok && plain.value.createClient === false, "an absent createClient is not an onboarding");
assert.ok(plain.ok && plain.value.clientNote === null, "an absent clientNote stays null so the stored one survives");

const opening = validateFunnelSchema({ ...valid, createClient: true, clientNote: "Webinar → offer" });
assert.ok(opening.ok && opening.value.createClient === true, "createClient: true is carried through");
assert.ok(opening.ok && opening.value.clientNote === "Webinar → offer", "clientNote is carried through");

const badFlag = validateFunnelSchema({ ...valid, createClient: "yes" });
assert.equal(badFlag.ok, false, "createClient must be a boolean, not a truthy string");

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

// Auth — a server with no key and a caller with the wrong one are different
// faults, and used to give the same answer.
const { checkIntegrationKey } = await import("../lib/integration/auth");
const withKey = (value?: string) =>
  new Request("https://x/api/integration/actuals", { headers: value === undefined ? {} : { "x-integration-key": value } });

delete process.env.INTEGRATION_SHARED_KEY;
assert.equal(checkIntegrationKey(withKey("anything")), "unconfigured", "no key on the server is not the caller's fault");

process.env.INTEGRATION_SHARED_KEY = "s3cret-value";
assert.equal(checkIntegrationKey(withKey("s3cret-value")), "ok", "the right key passes");
assert.equal(checkIntegrationKey(withKey("wrong-value!")), "unauthorized", "a same-length wrong key fails");
assert.equal(checkIntegrationKey(withKey("short")), "unauthorized", "a shorter key fails without throwing");
assert.equal(checkIntegrationKey(withKey("s3cret-value-and-then-some")), "unauthorized", "a longer key fails");
assert.equal(checkIntegrationKey(withKey()), "unauthorized", "no header at all fails");

console.log("integration schema validation: ok");
console.log("integration coverage rule: ok");
console.log("integration auth states: ok");
