import assert from "node:assert/strict";
import { coverageEnds, lastImported, type ImportStatusRow } from "../lib/integration/coverage";
import { validateFunnelSchema } from "../lib/integration/schema";
import { chosenSnapshot, insightWithSnapshot, isClosedDay, isClosedMonth, todayLocal, versionsOf } from "../lib/integration/freeze";
import { localDay } from "../lib/import/csv";

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
    { ...valid.stages[1], order: 1, metric: "Sign Ups!", sourceType: "stripe" },
  ],
});
assert.equal(rejected.ok, false, "bad schemas must be rejected as a whole");
if (!rejected.ok) {
  assert.ok(rejected.errors.some((e) => e.field === "metric"), "reports malformed metric names");
  assert.ok(rejected.errors.some((e) => e.field === "sourceType"), "reports unsupported source types");
  assert.ok(rejected.errors.some((e) => e.field === "order"), "reports duplicate orders");
}

/**
 * A metric this module has never heard of is no longer this module's to refuse.
 *
 * Before 0048 the list of metrics was six values in TypeScript, so a client
 * measuring anything else could not be described at all. The vocabulary is a
 * table now: 'signups' is a well-formed name, the validator passes it, and
 * fo_unknown_metrics in the route says whether anyone declared it. This asserts
 * the split, because collapsing it back would silently re-close the vocabulary.
 */
const undeclared = validateFunnelSchema({
  ...valid,
  stages: [valid.stages[0], { ...valid.stages[1], metric: "signups" }],
});
assert.equal(undeclared.ok, true, "a well-formed metric name is the database's call, not the validator's");

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

// Frozen insights — history is versioned, and the calendar guard never treats
// today's partial period as a finished one.
const frozenRows = [
  { version: 1, is_current: false, payload: { leads: 172 }, frozen_at: "2026-05-20T00:00:00Z", frozen_by: "acqos", note: null },
  { version: 2, is_current: true, payload: { leads: 173 }, frozen_at: "2026-05-21T00:00:00Z", frozen_by: "manual", note: "corrected export" },
];
assert.deepEqual(versionsOf(frozenRows), [1, 2], "all frozen versions remain readable");
assert.equal(chosenSnapshot(frozenRows, "prefer", null)?.version, 2, "prefer reads the current frozen version");
assert.equal(chosenSnapshot(frozenRows, "never", null), null, "never leaves the live calculation alone");
assert.equal(chosenSnapshot(frozenRows, "only", 1)?.payload.leads, 172, "a named prior version does not move");
assert.equal(chosenSnapshot(frozenRows, "only", 3), null, "an unknown version is absent, not zero");
assert.equal(isClosedDay("2026-05-19", "2026-05-20"), true, "a finished round can freeze");
assert.equal(isClosedDay("2026-05-20", "2026-05-20"), false, "a round ending today is still open");
assert.equal(isClosedMonth("2026-05-01", "2026-05-31", "2026-05-20"), false, "the current month refuses without force");
assert.equal(isClosedMonth("2026-05-01", "2026-05-31", "2026-06-01"), true, "a past month can freeze");
// The guard reads the CLIENT's calendar, not the server's. This was UTC, and
// the eight-hour gap fell exactly on the hour a monthly freeze would run: at
// 00:30 on 1 September in Singapore a UTC clock still says 31 August, so
// freezing August came back 422 "the month contains today".
const firstOfSeptSgt = "2026-08-31T16:30:00.000Z";          // = 2026-09-01 00:30 +08
assert.equal(localDay(firstOfSeptSgt), "2026-09-01", "the local day has already turned over");
assert.equal(
  isClosedMonth("2026-08-01", "2026-08-31", localDay(firstOfSeptSgt)), true,
  "August is freezable the moment September starts locally, not eight hours later",
);
assert.equal(
  isClosedDay("2026-08-31", localDay(firstOfSeptSgt)), true,
  "a round that ended yesterday is freezable at half past midnight",
);
assert.equal(todayLocal(), localDay(new Date().toISOString()), "the guard and the importer agree on what day it is");

// A live response still reports which frozen versions exist. Reading
// frozen=never and being told there are none would be a claim, not a blank.
const liveWithHistory = insightWithSnapshot({ leads: 174 }, null, [1, 2]) as {
  snapshot: { frozen: boolean; versionsAvailable: number[] };
};
assert.equal(liveWithHistory.snapshot.frozen, false, "a live read says it is live");
assert.deepEqual(liveWithHistory.snapshot.versionsAvailable, [1, 2], "and still lists the stored versions");

// The stored payload wins outright — a snapshot key inside it never leaks out
// and misreport which version the reader is holding.
const restored = insightWithSnapshot(
  { leads: 172, snapshot: { frozen: true, version: 99 } }, frozenRows[0], [1, 2],
) as { snapshot: { version: number } };
assert.equal(restored.snapshot.version, 1, "the snapshot block describes the row it came from");

console.log("integration freeze rules: ok");
console.log("freeze calendar is local: ok");

// ── The funnel walk (lib/funnel/diagnose.ts) ───────────────────────────────
// The two endpoints AcqOS reads are thin: they load rows and call these. Every
// judgement they make is here, so this is where it can be checked without a
// database, a network or a round of real data behind it.

const { stepsOf, diagnose, brokenSteps, verdictOf, explainStep } = await import("../lib/funnel/diagnose");
const { movesFor } = await import("../lib/funnel/analysis");
type TestAsset = Parameters<typeof diagnose>[0]["assetsNow"][number];

const journey = [
  { order: 1, slug: "targeting", name: "Ad Impressions", metric: "impressions" as const },
  { order: 2, slug: "ads", name: "Landing Page Clicks", metric: "clicks" as const },
  { order: 3, slug: "lp", name: "Leads", metric: "leads" as const },
  { order: 4, slug: "class", name: "Attendance", metric: "attendance" as const },
  { order: 5, slug: "preview", name: "Preview", metric: "preview_purchases" as const },
  { order: 6, slug: "middle", name: "Middle", metric: "middle_purchases" as const },
];

const steps = stepsOf(journey);
assert.equal(steps.length, 5, "six stages make five steps");
assert.deepEqual(steps.map((s) => s.rate), ["ctr", "leadgen", "attPct", "prevPct", "midPct"],
  "each consecutive pair resolves to the rate that sits between it");

// Stage order, not array order, decides the walk — AcqOS may send them shuffled.
assert.deepEqual(stepsOf([...journey].reverse()).map((s) => s.rate), steps.map((s) => s.rate),
  "stepsOf sorts by stage_order rather than trusting the array");

const asset = (kind: "audience" | "creative", name: string, spend: number, leads = 20): TestAsset =>
  ({ round_id: "r", kind, name, spend, leads, spend_share: 50, att: 12, prev_buys: 3, rev: 900 });

// CTR fell and the creatives are untouched → rule 3 sends you past them, up to
// the targeting. This is the whole point of the module.
const sameAds = diagnose({
  stages: journey,
  now: { impr: 10000, clicks: 100, ctr: 1.0, leads: 40 },
  prev: { impr: 10000, clicks: 200, ctr: 2.0, leads: 80 },
  base: null,
  assetsNow: [asset("creative", "Ad A", 500), asset("audience", "Cold", 500)],
  assetsPrev: [asset("creative", "Ad A", 500), asset("audience", "Cold", 500)],
});
const ctrStep = sameAds.find((d) => d.step.rate === "ctr")!;
assert.equal(ctrStep.nothingChanged, true, "no asset moved between the periods");
assert.equal(ctrStep.pointsAt, "audience", "ads unchanged and CTR down points at the targeting, not the ads");
assert.match(explainStep(ctrStep), /the ads are the same/, "and says why in the reading");

// Same fall, but a creative was swapped → start where the change was.
const swapped = diagnose({
  stages: journey,
  now: { impr: 10000, clicks: 100, ctr: 1.0 },
  prev: { impr: 10000, clicks: 200, ctr: 2.0 },
  base: null,
  assetsNow: [asset("creative", "Ad B", 500)],
  assetsPrev: [asset("creative", "Ad A", 500)],
});
assert.equal(swapped.find((d) => d.step.rate === "ctr")!.pointsAt, "creative",
  "a creative that changed is where to start");

// The step nothing in this app can break down must say so rather than clear it.
const mid = sameAds.find((d) => d.step.rate === "midPct")!;
assert.equal(mid.blind, true, "no per-asset middle purchases exist, so the step is blind");
assert.equal(mid.nothingChanged, false, "blind is not the same as 'nothing changed'");
assert.match(explainStep(mid), /no evidence here either way/, "and never reads as innocence");

// A step with one side missing is not a win. compare() calls it "unknown"; the
// reading used to fall through to "worth keeping".
const absent = diagnose({
  stages: journey,
  now: { leads: 80, att: null },
  prev: { leads: 100, att: 20, attPct: 20 },
  base: null,
  assetsNow: [asset("audience", "Cold", 500)],
  assetsPrev: [asset("audience", "Warm", 500)],
});
const attStep = absent.find((d) => d.step.rate === "attPct")!;
assert.equal(attStep.move?.verdict, "unknown", "absent is not zero and not a move");
assert.doesNotMatch(explainStep(attStep), /worth keeping|improved|rose/, "an absent reading never reads as good news");
assert.match(explainStep(attStep), /no reading/, "it says the number is missing");

// verdictOf — the one sentence at the top of the deck.
const firstEver = movesFor({ leads: 100 }, null, null, {});
assert.match(verdictOf(diagnose({ stages: journey, now: { leads: 100 }, prev: null, base: null, assetsNow: [], assetsPrev: [] }), firstEver).reading,
  /first period/, "a period with nothing behind it is not a clean bill of health");

// 0526-03 exactly: every rate held or improved, and leads still fell. The deck
// must not open by sending someone to fix a funnel that worked.
const held = { impr: 22669, clicks: 377, leads: 141, att: 19, ctr: 1.66, leadgen: 37.4, attPct: 13.48, spend: 1153.22, cpm: 50.87 };
const before = { impr: 28691, clicks: 455, leads: 172, att: 21, ctr: 1.59, leadgen: 37.8, attPct: 12.21, spend: 1294.04, cpm: 45.1 };
const delivery = verdictOf(
  diagnose({ stages: journey, now: held, prev: before, base: null, assetsNow: [], assetsPrev: [] }),
  movesFor(held, before, null, {}),
);
assert.equal(delivery.anyStepBroke, false, "no conversion rate got materially worse");
assert.match(delivery.reading, /upstream of the funnel/, "so the fall is reported as a delivery change");
assert.match(delivery.reading, /Impression down 21\.0%/, "and names the number that says so");

// A genuinely broken step still leads.
const brokeMoves = movesFor({ clicks: 500, leads: 50, leadgen: 10 }, { clicks: 500, leads: 200, leadgen: 40 }, null, {});
const broke = diagnose({
  stages: journey,
  now: { clicks: 500, leads: 50, leadgen: 10 },
  prev: { clicks: 500, leads: 200, leadgen: 40 },
  base: null,
  assetsNow: [asset("audience", "Cold", 500)],
  assetsPrev: [asset("audience", "Cold", 500)],
});
assert.equal(brokenSteps(broke)[0]?.step.rate, "leadgen", "the worst broken step comes first");
assert.equal(verdictOf(broke, brokeMoves).anyStepBroke, true, "and the verdict leads with it");

console.log("funnel step walk: ok");
console.log("funnel verdict: ok");

// ── A declared metric is importable without new code ─────────────────────────
{
  const { SOURCES, STAGE_PREFIX, stageMetricOf, stageSpec, mapColumns } =
    await import("../lib/import/sources.ts");

  /**
   * Attendance stops being a special case.
   *
   * The pipeline used to branch on `source === "attendance"`. It branches on the
   * spec declaring an event type now, so attendance has to declare one — if it
   * ever stopped, the attendance import would silently fall through to no branch
   * at all and write nothing, which is the worst possible failure for an
   * importer.
   */
  assert.equal(SOURCES.attendance.eventType, "attendance", "attendance declares its event type");
  assert.ok(!SOURCES.ads.eventType, "ads is not people and declares none");
  assert.ok(!SOURCES.leads.eventType, "leads has its own branch and declares none");

  assert.equal(stageMetricOf("stage:appointments"), "appointments", "reads the metric off the key");
  assert.equal(stageMetricOf("attendance"), null, "a built-in source is not a stage");
  assert.equal(stageMetricOf(STAGE_PREFIX), null, "an empty metric is not a metric");

  const spec = stageSpec("appointments", "Appointment", "appointment");
  assert.equal(spec.eventType, "appointment", "a stage spec carries the event type it writes");
  assert.equal(spec.optional, true, "a declared stage does not nag every round");
  assert.ok(
    !spec.fields.some((f) => f.field === "minutes_watched"),
    "minutes_watched is attendance's alone and is not offered generically",
  );

  // The whole point: a CRM export maps against a spec nobody wrote by hand.
  const mapped = mapColumns(spec, ["Email", "Session ID", "Booked at"]);
  assert.deepEqual(mapped.missing, [], "a plausible CRM export maps with nothing missing");
  assert.equal(mapped.map.email, "Email", "matches email by alias");
  assert.equal(mapped.map.round_id, "Session ID", "matches the round by alias");
  assert.equal(mapped.map.event_date, "Booked at", "matches the date by alias");

  const short = mapColumns(spec, ["Email"]);
  assert.deepEqual(short.missing, ["round_id"], "still refuses a file with no round to attach to");
}
console.log("declared metric import: ok");
