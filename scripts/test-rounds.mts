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
import { checkRound, checkRoundEdit, suggestNextCode, roundIdFor, type ExistingRound } from "../lib/funnel/rounds";

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
  productId: "shely-webinar", market: "SG", campaigns: [] as string[], ...over,
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
/* A class outside the ads window is NORMAL, not an error. See the block below
   for why this rule had to go. */
eq("a class after the ads stop is fine",
  checkRound(round({ sessionDate: "2026-10-20" }), SHELY).kind, "ok");
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
    sessionDate: "2026-09-22", sessionLabel: "Class 22 Sep 2026",
    campaigns: [] as string[], ...over,
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
  eq("a class outside the new ads window is fine",
    checkRoundEdit(edit({ sessionDate: "2026-09-30" }), SHELY).kind, "ok");
  eq("a mistyped year is still refused",
    checkRoundEdit(edit({ endDate: "2027-09-22", sessionDate: "2026-09-22" }), SHELY).kind, "invalid");
  eq("dropping the class date is allowed",
    checkRoundEdit(edit({ sessionDate: "", sessionLabel: "" }), SHELY).kind, "ok");
}

console.log("\nads and classes run on their own schedules — Henry's two cases");
{
  /* CASE 1, reported 9 Oct. Ads 14-16 September, class on the 17th. The class
     was refused for being "outside the round", which is not a thing a round
     has an opinion about: the ads window is when money was spent, the class is
     when people turned up. */
  eq("ads 14-16 Sep with a class on the 17th",
    checkRound(round({ code: "0926-09", startDate: "2026-09-14", endDate: "2026-09-16",
                       sessionDate: "2026-09-17" }), []).kind, "ok");

  /* CASE 2, the same bug wearing a different hat. To record that class an
     operator had to stretch the ads window to the 17th — and the next round's
     ads starting on the 17th were then refused as an overlap, by a date that
     was only there to satisfy the rule above. Fixing the first fixes this. */
  const prior = [{ round_id: "0926-02", code: "0926-02", start_date: "2026-09-14",
                   end_date: "2026-09-16", market: "SG", product_id: "shely-webinar" }];
  eq("the next round's ads may start the day of the previous class",
    checkRound(round({ code: "0926-03", startDate: "2026-09-17", endDate: "2026-09-23",
                       sessionDate: "2026-09-24" }), prior).kind, "ok");

  /* And the thing that genuinely must still be refused: two rounds whose ADS
     cover the same day. That is the ambiguity the rule exists for. */
  eq("ads that really do overlap are still refused",
    checkRound(round({ code: "0926-03", startDate: "2026-09-16", endDate: "2026-09-22",
                       sessionDate: "2026-09-23" }), prior).kind, "conflict");

  /* A class shared between two rounds is not an overlap. Nothing is filed to a
     class date, so two rounds inviting people to the same session is a fact
     about the business, not a collision. */
  eq("two rounds may share a class date",
    checkRound(round({ code: "0926-03", startDate: "2026-09-17", endDate: "2026-09-23",
                       sessionDate: "2026-09-16" }), prior).kind, "ok");

  /* The guard that is left is for typos only. */
  eq("a class a year out is still caught",
    checkRound(round({ sessionDate: "2027-10-07" }), SHELY).kind, "invalid");
  eq("and says to check the year",
    (() => { const v = checkRound(round({ sessionDate: "2027-10-07" }), SHELY);
             return v.kind === "invalid" && v.errors[0].message.includes("check the year"); })(), true);
}

console.log("\nhow long a window may be, and what that guard is for");
{
  /* The guard was 92 days — Shely's quarter — and it refused FWD i-Care's
     first round, which is a genuine 98-day experiment. Measured before it was
     moved: 92 never caught a mistyped MONTH anyway (a weekly round ending
     2026-10-21 instead of 2026-09-21 spans 37 days and always passed), so the
     only error it has ever caught is the year, and that is 372 days. */
  const span = (start: string, end: string) =>
    checkRound(round({ code: "1026-01", startDate: start, endDate: end, sessionDate: "" }), []).kind;

  eq("i-Care's 98-day window is a window, not a typo", span("2026-07-01", "2026-10-06"), "ok");
  eq("186 days is the limit", span("2026-01-01", "2026-07-05"), "ok");
  eq("187 is not", span("2026-01-01", "2026-07-06"), "invalid");
  eq("a mistyped year is still caught", span("2026-09-15", "2027-09-21"), "invalid");
  eq("and still says to check the year",
    (() => { const v = checkRound(round({ startDate: "2026-09-15", endDate: "2027-09-21", sessionDate: "" }), []);
             return v.kind === "invalid" && v.errors.some((e) => e.message.includes("check the year")); })(), true);
  /* The class-drift guard is a DISTANCE from the window, not a span, and keeps
     its own number — three months. Unchanged by the above. */
  eq("a class three months out is still a class",
    checkRound(round({ sessionDate: "2026-12-20" }), []).kind, "ok");
  eq("a class a year out is still a typo",
    checkRound(round({ sessionDate: "2027-10-07" }), []).kind, "invalid");
}

console.log("\ntwo rounds may share a week, if they do not share a campaign");
{
  /* FWD i-Care handed over three files called Round 1, 2 and 3, and all three
     report the SAME window — 2026-07-01 to 2026-10-06. They are not three
     weeks; they are three experiments that ran concurrently, told apart only
     by campaign name. The real names, from the three exports. */
  const R1 = ["FWD_iCareChi_META_MOFU_Sales_2026", "FWD_iCareEng_META_MOFU_Sales_2026"];
  const R2 = ["FWD_iCareChi_META_MOFU_Sales_2026_SingleAttribution",
              "FWD_iCareEng_META_MOFU_Sales_2026_SingleAttribution",
              "FWD_iCareChi_META_MOFU_Sales_2026_SingleAttribution_PurchaseOptimised",
              "FWD_iCareEng_META_MOFU_Sales_2026_SingleAttribution_PurchaseOptimised"];
  const R3 = ["FWD_iCareChi_META_MOFU_Sales_2026_40To49", "FWD_iCareEng_META_MOFU_Sales_2026_40To49",
              "FWD_iCareChi_META_MOFU_Sales_2026_50To60", "FWD_iCareEng_META_MOFU_Sales_2026_50To60"];

  const WINDOW = { startDate: "2026-07-01", endDate: "2026-10-06", sessionDate: "", sessionLabel: "",
                   productId: "icare-insurance", market: "MY" };
  const icare = (code: string, campaigns: string[]) => ({ code, ...WINDOW, campaigns });
  const asExisting = (code: string, campaigns: string[] | null) => ({
    round_id: code, code, start_date: WINDOW.startDate, end_date: WINDOW.endDate,
    market: "MY", product_id: "icare-insurance", campaigns,
  });

  /* The whole point. Round 1 exists; Round 2 covers exactly the same days and
     is allowed, because neither one is ambiguous any more. */
  eq("a second round over the same window, both naming campaigns",
    checkRound(icare("1026-02", R2), [asExisting("1026-01", R1)]).kind, "ok");
  eq("and a third",
    checkRound(icare("1026-03", R3), [asExisting("1026-01", R1), asExisting("1026-02", R2)]).kind, "ok");

  /* Still refused when only ONE of them names anything, because the one that
     names nothing claims every campaign in its window — so the day is as
     ambiguous as it ever was. */
  {
    const v = checkRound(icare("1026-02", R2), [asExisting("1026-01", null)]);
    eq("refused when the EXISTING round names none",
      [v.kind, v.kind === "conflict" ? v.code : null], ["conflict", "overlaps"]);
    eq("and says so rather than repeating the generic reason",
      v.kind === "conflict" ? v.error.includes("names no campaigns") : false, true);
  }
  eq("refused when the NEW round names none",
    checkRound(icare("1026-02", []), [asExisting("1026-01", R1)]).kind, "conflict");

  /* And the generic refusal still names the way out. A message that says only
     "refused" is the thing the refusal-code work was about. */
  {
    const v = checkRound(icare("1026-02", []), [asExisting("1026-01", null)]);
    eq("neither names any, and the message offers the fix",
      v.kind === "conflict" ? v.error.includes("name the campaigns each one owns") : false, true);
  }

  /* A campaign belongs to one round, dates or no dates. */
  {
    const v = checkRound(icare("1026-02", [R1[0], ...R2]), [asExisting("1026-01", R1)]);
    eq("a campaign another round already owns",
      [v.kind, v.kind === "conflict" ? v.code : null], ["conflict", "campaign_taken"]);
    eq("and names which one", v.kind === "conflict" ? v.error.includes("1026-01") : false, true);
  }
  eq("case and padding are not what makes a name different",
    checkRound(icare("1026-02", ["  fwd_icarechi_meta_mofu_sales_2026  "]), [asExisting("1026-01", R1)]).kind,
    "conflict");

  /* THE PREFIX TRAP, and the reason this is exact equality.
     
     Round 1's campaign name is a PREFIX of all eight of Rounds 2 and 3's. A
     substring rule files everything to Round 1; "longest match wins" — the
     tie-break roundFromCampaign uses for 0526-03 against 0526-031 — reverses
     it, because Round 1's whole name is LONGER than the suffix that
     distinguishes Round 2. Under equality, R1 and R2 are simply disjoint. */
  eq("a name that is a prefix of another is not the same name",
    checkRound(icare("1026-02", R2), [asExisting("1026-01", R1)]).kind, "ok");

  /* Shely is untouched: naming campaigns is not required, and an overlap
     between rounds that name none is refused exactly as before. */
  eq("shely's rounds still overlap-check with no campaigns anywhere",
    checkRound(round({ code: "0926-06", startDate: "2026-09-20", endDate: "2026-09-26" }), SHELY).kind,
    "conflict");

  /* Editing is the other half: one round is already created, so the fix for an
     overlap has to be reachable from edit as well as create. */
  {
    const existing = [asExisting("1026-01", R1), asExisting("1026-02", R2)];
    eq("naming campaigns on an existing round is allowed",
      checkRoundEdit({ code: "1026-02", startDate: WINDOW.startDate, endDate: WINDOW.endDate,
                       sessionDate: "", sessionLabel: "", campaigns: R2 }, existing).kind, "ok");
    eq("taking a campaign another round owns is not",
      (() => { const v = checkRoundEdit({ code: "1026-02", startDate: WINDOW.startDate,
                 endDate: WINDOW.endDate, sessionDate: "", sessionLabel: "",
                 campaigns: [R1[0]] }, existing);
               return [v.kind, v.kind === "conflict" ? v.code : null]; })(),
      ["conflict", "campaign_taken"]);
    eq("a round does not collide with its own campaigns",
      checkRoundEdit({ code: "1026-01", startDate: WINDOW.startDate, endDate: WINDOW.endDate,
                       sessionDate: "", sessionLabel: "", campaigns: R1 }, existing).kind, "ok");
    eq("dropping its campaigns re-opens the overlap it was hiding",
      checkRoundEdit({ code: "1026-02", startDate: WINDOW.startDate, endDate: WINDOW.endDate,
                       sessionDate: "", sessionLabel: "", campaigns: [] }, existing).kind, "conflict");
    /* Naming a campaign moves no row, so there is nothing for the stray-row
       check to count — which is what `unchanged` drives in the route. */
    eq("naming campaigns leaves the window unchanged",
      (() => { const v = checkRoundEdit({ code: "1026-02", startDate: WINDOW.startDate,
                 endDate: WINDOW.endDate, sessionDate: "", sessionLabel: "", campaigns: R2 }, existing);
               return v.kind === "ok" && v.unchanged; })(), true);
  }
}

console.log("\nthe id is global, the code is not");
{
  /* WHAT THIS IS FOR, on 9 Oct 2026.
     
     The create route wrote `round_id: r.code`. round_id is the PRIMARY KEY of
     rounds and is global; code is unique only per (client_id, product_id,
     market, code), which is the entire point of market-scoped codes.
     
     i-Care's first three rounds were called 0726-01, 0726-02 and 0726-03, and
     so were Shely's July rounds. A hand-written insert with `on conflict
     (round_id) do update` does not collide — it overwrites. Three of Shely's
     windows moved to 2026-07-01 → 2026-10-06, SG to MY, onto i-Care's
     product. No spend moved, because round_id is a stored foreign key, but
     every July figure was wrong until it was restored. */
  const SHELY_IDS = SHELY.map((r) => r.round_id);

  eq("a free code is used as the id", roundIdFor("1126-01", "icare", SHELY_IDS), "1126-01");
  eq("a code another client already uses is qualified",
    roundIdFor("0926-01", "icare", SHELY_IDS), "icare-0926-01");
  eq("re-running for the same client qualifies too — it does not overwrite",
    roundIdFor("0926-01", "shely", SHELY_IDS), "shely-0926-01");
  eq("case is not what makes an id free",
    roundIdFor("0926-01", "icare", ["0926-01".toUpperCase()]), "icare-0926-01");
  eq("both forms taken is refused rather than invented around",
    roundIdFor("0926-01", "icare", [...SHELY_IDS, "icare-0926-01"]), null);
  eq("nothing taken at all", roundIdFor("0726-01", "icare", []), "0726-01");

  /* The real case, in the order it actually happened: Shely's July rounds
     exist, then i-Care is given the same three codes. */
  const july = ["0726-01", "0726-02", "0726-03"];
  eq("i-Care's three codes all land beside Shely's rather than on them",
    july.map((c) => roundIdFor(c, "icare", [...SHELY_IDS, ...july])),
    ["icare-0726-01", "icare-0726-02", "icare-0726-03"]);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
