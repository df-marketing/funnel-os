/**
 * WHICH MONTHS MAY BE REPORTED ON.
 *
 * GroundTruth has no `finalised` column, so /api/integration/periods derives the
 * answer from two facts that cannot be set by hand: when the rounds ended, and
 * how far the imports reach. The thing worth pinning is not that Shely's August
 * reads `final` — it is the three-way split, because the two failure states mean
 * opposite things to the caller and collapsing them is the bug this prevents:
 *
 *   open        still happening. Wait.
 *   incomplete  over, and the files stop short. Import something.
 *
 * A caller that sees one status for both either publishes a month with a hole in
 * it, or waits forever for a month that will never fill itself.
 *
 * The rounds below are Shely's real ones, read from production on 15 September
 * 2026. 0826-01 and 0926-01 are the two that straddle a month boundary and are
 * the reason the anchor exists at all.
 */
import { classifyPeriods, monthEnd, type RoundPeriodRow } from "../lib/integration/periods";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
};

const r = (code: string, start: string, end: string, period: string): RoundPeriodRow =>
  ({ code, start_date: start, end_date: end, period });

/* Shely, production, 15 September 2026. Note 0826-01 STARTS in July and 0926-01
   STARTS in August — the period column is the anchor's answer, not the start
   date's, which is the whole point. */
const SHELY: RoundPeriodRow[] = [
  r("0526-02", "2026-05-13", "2026-05-19", "2026-05"),
  r("0526-03", "2026-05-23", "2026-05-28", "2026-05"),
  r("0626-01", "2026-06-05", "2026-06-09", "2026-06"),
  r("0626-02", "2026-06-19", "2026-06-23", "2026-06"),
  r("0726-01", "2026-07-01", "2026-07-07", "2026-07"),
  r("0726-02", "2026-07-09", "2026-07-14", "2026-07"),
  r("0726-03", "2026-07-15", "2026-07-21", "2026-07"),
  r("0726-04", "2026-07-22", "2026-07-30", "2026-07"),
  r("0826-01", "2026-07-31", "2026-08-06", "2026-08"),
  r("0826-02", "2026-08-07", "2026-08-20", "2026-08"),
  r("0826-03", "2026-08-21", "2026-08-27", "2026-08"),
  r("0926-01", "2026-08-28", "2026-09-03", "2026-09"),
  r("0926-02", "2026-09-08", "2026-09-14", "2026-09"),
];

console.log("\nmonth ends");
eq("31-day month", monthEnd("2026-05"), "2026-05-31");
eq("30-day month", monthEnd("2026-06"), "2026-06-30");
eq("February, non-leap", monthEnd("2026-02"), "2026-02-28");
eq("February, leap", monthEnd("2028-02"), "2028-02-29");
eq("December does not roll the year", monthEnd("2026-12"), "2026-12-31");

console.log("\nshely as she actually stands — reach 2026-09-02, today 2026-09-15");
{
  // Earliest coverage_end across her four sources: leads stops on 09-02.
  const got = classifyPeriods(SHELY, "2026-09-02", "2026-09-15");
  eq("five periods, in order", got.map((p) => p.period),
    ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  eq("May through August are final", got.map((p) => p.status),
    ["final", "final", "final", "final", "open"]);
  /* September is open on the 15th because SEPTEMBER has not ended — not because
     a round is running. Both of her September rounds finished on the 14th. A
     month is never final before its own last day, however complete the imports
     look, because a round can still be added to it. */
  eq("September is open until the month itself ends",
    got[4].reason, "the month has not ended yet — it runs to 2026-09-30");
  eq("a final period gives no reason", got[0].reason, null);
  eq("August holds three rounds", got[3].roundCodes, ["0826-01", "0826-02", "0826-03"]);
  eq("0826-01 is August's despite starting 31 July", got[2].roundCodes.includes("0826-01"), false);
}

console.log("\nthe distinction that matters");
{
  /* Same data, eight days earlier: 0926-02 has not run yet, so September is not
     waiting on an import — it is waiting on the month. Same status would be a
     lie about whose move it is. */
  const mid = classifyPeriods(SHELY, "2026-09-02", "2026-09-10");
  eq("September is open mid-month too", mid[4].status, "open");
  eq("and blames the month, not a round that is not there",
    mid[4].reason, "the month has not ended yet — it runs to 2026-09-30");

  /* October, where a round genuinely overruns. THIS is when a round is the
     reason, and the message has to say which date and why. */
  const spill = classifyPeriods([r("1026-01", "2026-10-28", "2026-11-04", "2026-10")], "2026-09-02", "2026-11-01");
  eq("an overrunning round is named as the reason", spill[0].reason,
    "a round here runs to 2026-11-04, past the end of the month");

  /* A month that is over, whose files stopped inside it. This is the one that
     never fixes itself. */
  const short = classifyPeriods(SHELY, "2026-08-10", "2026-09-15");
  eq("August goes incomplete when coverage stops inside it", short[3].status, "incomplete");
  eq("July is still final — coverage cleared it", short[2].status, "final");
  eq("and the reason names both dates", short[3].reason,
    "imported data stops 2026-08-10, before this period ends 2026-08-31");
}

console.log("\na round that overruns its own month");
{
  /* Anchored to August, ends 4 September. August is not finished until that
     round is, so coverage to 31 August is NOT enough — the seed of the reduce is
     what makes this true, and dropping it is a silent wrong answer. */
  const over = [r("0826-99", "2026-08-25", "2026-09-04", "2026-08")];
  eq("completeThrough follows the round past the month end",
    classifyPeriods(over, "2026-09-10", "2026-09-15")[0].completeThrough, "2026-09-04");
  eq("coverage to the month end is not enough",
    classifyPeriods(over, "2026-08-31", "2026-09-15")[0].status, "incomplete");
  eq("coverage past the round is",
    classifyPeriods(over, "2026-09-04", "2026-09-15")[0].status, "final");
  eq("the month end alone still bounds a round that ended early",
    classifyPeriods([r("0826-98", "2026-08-01", "2026-08-03", "2026-08")], "2026-08-31", "2026-09-15")[0].completeThrough,
    "2026-08-31");
}

console.log("\nnothing is final on an unknown reach");
{
  /* A source with no coverage_end makes coverageEnds() return null. Blank is not
     zero and it is not "reaches forever" — it is not knowing, and not knowing
     cannot finalise a month. */
  const unknown = classifyPeriods(SHELY, null, "2026-09-15");
  eq("no period is final", unknown.filter((p) => p.status === "final").length, 0);
  eq("the ended ones are incomplete", unknown[0].status, "incomplete");
  eq("and say why", unknown[0].reason, "no source reports a coverage end");
}

console.log("\nedges");
eq("no rounds, no periods", classifyPeriods([], "2026-09-02", "2026-09-15"), []);
eq("reach exactly on the last ending is final",
  classifyPeriods([r("x", "2026-05-01", "2026-05-20", "2026-05")], "2026-05-31", "2026-09-15")[0].status,
  "final");
eq("today exactly on the last ending is still open",
  classifyPeriods([r("x", "2026-09-01", "2026-09-15", "2026-09")], "2026-09-30", "2026-09-15")[0].status,
  "open");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
