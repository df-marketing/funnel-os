/**
 * WHETHER A ROUND MAY BE CREATED.
 *
 * Step 0 of the import had no screen, so rounds were made by SQL insert. The
 * screen is only safe if it refuses everything the hand-written SQL refused —
 * and the reason those refusals exist is that getting a round wrong does not
 * fail anything.
 *
 * A day of spend is filed to a round BY DATE. A wrong window does not throw; it
 * files the money under the neighbouring round, leaves the account total
 * correct, and moves every per-round figure. Nothing on screen says so. That is
 * what these assertions are protecting.
 */
import { checkRound, checkRoundEdit, suggestNextCode, type ExistingRound } from "../lib/funnel/rounds";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

/** Shely's real rounds, read from production 25 September 2026. */
const SHELY: ExistingRound[] = [
  { round_id: "0826-03", code: "0826-03", start_date: "2026-08-21", end_date: "2026-08-27", market: "SG", product_id: "shely-webinar" },
  { round_id: "0926-01", code: "0926-01", start_date: "2026-08-28", end_date: "2026-09-03", market: "SG", product_id: "shely-webinar" },
  { round_id: "0926-02", code: "0926-02", start_date: "2026-09-08", end_date: "2026-09-14", market: "SG", product_id: "shely-webinar" },
  { round_id: "0926-03", code: "0926-03", start_date: "2026-09-15", end_date: "2026-09-21", market: "SG", product_id: "shely-webinar" },
  { round_id: "0926-04", code: "0926-04", start_date: "2026-09-24", end_date: "2026-09-30", market: "SG", product_id: "shely-webinar" },
];

const round = (over: Partial<Parameters<typeof checkRound>[0]> = {}) => ({
  code: "0926-05", startDate: "2026-10-01", endDate: "2026-10-07",
  sessionDate: "2026-10-07", sessionLabel: "Class 7 Oct 2026",
  productId: "shely-webinar", market: "SG", ...over,
});

console.log("\nthe good case");
eq("a clean round after the last one", checkRound(round(), SHELY).kind, "ok");
eq("no session date is fine — not every product has a class",
  checkRound(round({ sessionDate: "", sessionLabel: "" }), SHELY).kind, "ok");

console.log("\nrequired fields, all reported at once");
{
  const v = checkRound(round({ code: "", startDate: "", productId: "", market: "" }), SHELY);
  eq("invalid", v.kind, "invalid");
  eq("names every missing field in one pass",
    v.kind === "invalid" ? v.errors.map((e) => e.field).sort() : null,
    ["code", "market", "productId", "startDate"]);
}

console.log("\nshapes");
for (const bad of ["926-05", "0926-5", "0926_05", "Q4-05", "0926-05 "]) {
  const v = checkRound(round({ code: bad.trim() === "" ? "" : bad }), SHELY);
  eq(`'${bad}' is refused as a code`, v.kind, "invalid");
}
eq("a date that does not exist is refused",
  checkRound(round({ startDate: "2026-02-30" }), SHELY).kind, "invalid");
eq("2028 is a leap year, so 29 Feb is real",
  checkRound(round({ code: "0228-01", startDate: "2028-02-29", endDate: "2028-03-05", sessionDate: "2028-03-05" }), SHELY).kind,
  "ok");

console.log("\ndates that relate wrongly");
eq("ends before it starts",
  checkRound(round({ startDate: "2026-10-07", endDate: "2026-10-01" }), SHELY).kind, "invalid");
eq("the class is outside the round",
  checkRound(round({ sessionDate: "2026-10-20" }), SHELY).kind, "invalid");
{
  /* A mistyped year is the one that would do real damage: a round spanning
     months swallows every neighbouring round's spend, by date, in silence. */
  const v = checkRound(round({ endDate: "2027-10-07" }), SHELY);
  eq("a year-long round is refused", v.kind, "invalid");
  eq("and says to check the year",
    v.kind === "invalid" ? v.errors[0].message.includes("check the year") : false, true);
}

console.log("\nthe same code again");
{
  const again = round({ code: "0926-04", startDate: "2026-09-24", endDate: "2026-09-30", sessionDate: "2026-09-30" });
  eq("identical is a no-op, not a conflict", checkRound(again, SHELY).kind, "identical");

  const moved = round({ code: "0926-04", startDate: "2026-09-25", endDate: "2026-10-01", sessionDate: "2026-09-30" });
  const v = checkRound(moved, SHELY);
  eq("moving its dates is refused", [v.kind, v.kind === "conflict" ? v.code : null], ["conflict", "code_moved"]);
  /* It used to claim moving a round "re-files every row already imported".
     That was asserted, never checked, and wrong — round_id is a stored foreign
     key, so rows keep their round. The message now points at edit, which does
     the check that actually matters: which rows end up outside the window. */
  eq("and points at edit rather than at SQL",
    v.kind === "conflict" ? v.error.includes("Use edit") : false, true);
  eq("and no longer claims rows are re-filed",
    v.kind === "conflict" ? v.error.includes("re-files") : true, false);
}

console.log("\noverlap, which is per market");
{
  const v = checkRound(round({ code: "0926-06", startDate: "2026-09-20", endDate: "2026-09-26", sessionDate: "2026-09-26" }), SHELY);
  eq("an SG round overlapping SG rounds is refused",
    [v.kind, v.kind === "conflict" ? v.code : null], ["conflict", "overlaps"]);
  eq("and names the round it collides with",
    v.kind === "conflict" ? v.error.includes("0926-03") || v.error.includes("0926-04") : false, true);

  /* MY and SG run their own schedules and overlap constantly. The ads importer
     resolves the market first precisely so that is allowed. */
  eq("the same window in another market is fine",
    checkRound(round({ code: "0926-06", startDate: "2026-09-20", endDate: "2026-09-26", sessionDate: "2026-09-26", market: "MY" }), SHELY).kind,
    "ok");

  eq("touching the day before is not an overlap",
    checkRound(round({ code: "0926-06", startDate: "2026-09-22", endDate: "2026-09-23", sessionDate: "2026-09-23" }), SHELY).kind, "ok");
  eq("sharing a single day IS an overlap",
    checkRound(round({ code: "0926-06", startDate: "2026-09-21", endDate: "2026-09-23", sessionDate: "2026-09-23" }), SHELY).kind, "conflict");
}

console.log("\nthe suggested next code");
eq("counts within the month", suggestNextCode(SHELY, "2026-09-28"), "0926-05");
eq("a month with no rounds starts at 01", suggestNextCode(SHELY, "2026-11-02"), "1126-01");
eq("August continues from 03", suggestNextCode(SHELY, "2026-08-29"), "0826-04");
eq("nothing to count from gives nothing", suggestNextCode(SHELY, "not-a-date"), null);

console.log("\nediting a round's dates");
{
  const edit = (over: Partial<Parameters<typeof checkRoundEdit>[0]> = {}) => ({
    code: "0926-03", startDate: "2026-09-16", endDate: "2026-09-22",
    sessionDate: "2026-09-22", sessionLabel: "Class 22 Sep 2026", ...over,
  });

  eq("a corrected window is allowed", checkRoundEdit(edit(), SHELY).kind, "ok");
  eq("re-submitting the same dates is ok and says so",
    (() => { const v = checkRoundEdit(edit({ startDate: "2026-09-15", endDate: "2026-09-21", sessionDate: "2026-09-21" }), SHELY);
             return [v.kind, v.kind === "ok" ? v.unchanged : null]; })(),
    ["ok", true]);

  eq("a round that is not there", 
    (() => { const v = checkRoundEdit(edit({ code: "0926-99" }), SHELY);
             return [v.kind, v.kind === "conflict" ? v.code : null]; })(),
    ["conflict", "not_found"]);

  /* Itself must be excluded from the overlap test, or every round would
     collide with where it already is. */
  eq("a round does not overlap itself",
    checkRoundEdit(edit({ startDate: "2026-09-15", endDate: "2026-09-21", sessionDate: "2026-09-21" }), SHELY).kind, "ok");
  eq("but it does overlap its neighbour",
    (() => { const v = checkRoundEdit(edit({ startDate: "2026-09-13", endDate: "2026-09-19", sessionDate: "2026-09-19" }), SHELY);
             return [v.kind, v.kind === "conflict" ? v.code : null]; })(),
    ["conflict", "overlaps"]);

  eq("backwards dates", checkRoundEdit(edit({ startDate: "2026-09-22", endDate: "2026-09-16" }), SHELY).kind, "invalid");
  eq("a class outside the new window",
    checkRoundEdit(edit({ sessionDate: "2026-09-30" }), SHELY).kind, "invalid");
  eq("a mistyped year is still refused",
    checkRoundEdit(edit({ endDate: "2027-09-22", sessionDate: "2026-09-22" }), SHELY).kind, "invalid");
  eq("dropping the class date is allowed",
    checkRoundEdit(edit({ sessionDate: "", sessionLabel: "" }), SHELY).kind, "ok");
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
