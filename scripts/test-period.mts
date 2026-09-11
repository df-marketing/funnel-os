/**
 * WHICH PERIOD A ROUND BELONGS TO.
 *
 * A round is atomic. Filtering by overlap gave it to every window it touched, so
 * 0926-01 (28 Aug – 3 Sep) was counted whole in August AND whole in September:
 * an August window read 8,933.95 where By month read 4,997.27, and adding two
 * consecutive months double-counted the round in between. No set of classes
 * anyone ran corresponds to 8,933.95.
 *
 * The fix is an anchor — one day per round — and containment instead of overlap.
 * The property that makes it correct is not "August looks right"; it is that
 * DISJOINT WINDOWS PARTITION THE ROUNDS. That is what the last block asserts,
 * and it is the only assertion here that would catch a rule which happens to fix
 * Shely's two straddling rounds while breaking some other shape.
 *
 * fo_round_anchor in 20260911100000 is the SQL twin of anchorOf. If either moves
 * without the other, the UI filters on one rule and the database on another, and
 * nothing throws — the totals just quietly stop adding up.
 */
import { monthOf, anchorOf, monthWindow } from "../lib/funnel/cuts";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
};

type R = { round_id: string; code?: string | null; start_date: string; end_date: string };
const r = (code: string, start_date: string, end_date: string): R =>
  ({ round_id: code, code, start_date, end_date });

/* Shely's real shapes: the two that straddle, and one that does not. */
const AUG01 = r("0826-01", "2026-07-31", "2026-08-06");  // opens in July, called August
const SEP01 = r("0926-01", "2026-08-28", "2026-09-03");  // opens in August, called September
const MAY02 = r("0526-02", "2026-05-13", "2026-05-19");  // entirely within its month

console.log("\nAnchor — the day a round is filed under");
{
  eq("a round opening the month before anchors on the 1st of its named month",
     anchorOf(AUG01), "2026-08-01");

  eq("the September round anchors in September, not the August it opened in",
     anchorOf(SEP01), "2026-09-01");

  /* Eleven of Shely's thirteen rounds are this shape, so this is the case that
     proves the change is narrow rather than sweeping. */
  eq("a round inside its own month anchors on its start date",
     anchorOf(MAY02), "2026-05-13");
}

console.log("\nAnchor — the two properties everything else rests on");
{
  const all = [AUG01, SEP01, MAY02,
    r("0526-01", "2026-05-06", "2026-05-12"),
    r("0726-01", "2026-06-30", "2026-07-07"),
    r("1226-01", "2026-12-28", "2027-01-04"),   // crosses a YEAR boundary
    r("NS-W1",   "2026-08-10", "2026-08-16"),   // Northsea: code in no known shape
  ];

  /* If the anchor fell outside the round, it would be a date on which nothing
     happened, and a window containing it would report a round that did not run. */
  eq("every anchor falls inside its own round",
     all.filter((x) => anchorOf(x) < x.start_date || anchorOf(x) > x.end_date), []);

  /* This is what makes a plain calendar month select exactly By month's rounds.
     Without it the windowed read and By month would disagree again, differently. */
  eq("every anchor falls inside the month the round is named for",
     all.filter((x) => anchorOf(x).slice(0, 7) !== monthOf(x)), []);
}

console.log("\nAnchor — the shapes that are not MMYY-NN");
{
  /* Falls back to the start month, so it anchors on start_date — the behaviour
     these rounds already had, unchanged. */
  eq("an unparseable code anchors on its start date",
     anchorOf(r("NS-W1", "2026-08-10", "2026-08-16")), "2026-08-10");

  eq("a nonsense month in the code does not invent a date",
     anchorOf(r("9926-01", "2026-08-10", "2026-08-16")), "2026-08-10");

  /* Named for a month the round never ran in: monthOf refuses the name, so the
     anchor cannot land outside the round. */
  eq("a name that does not overlap the real dates is ignored",
     anchorOf(r("0126-01", "2026-08-10", "2026-08-16")), "2026-08-10");
}

console.log("\nWindow — a month is a calendar month");
{
  eq("August", monthWindow("2026-08"), { from: "2026-08-01", to: "2026-08-31" });
  eq("September", monthWindow("2026-09"), { from: "2026-09-01", to: "2026-09-30" });
  eq("February, not a leap year", monthWindow("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  eq("February, a leap year", monthWindow("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
  eq("December does not roll into January", monthWindow("2026-12"), { from: "2026-12-01", to: "2026-12-31" });
}

console.log("\nSelection — the bug, and the property that rules it out");
{
  /* The predicate, exactly as fo_filter_ok now applies it: containment of one
     day, not overlap of a span. */
  const picks = (rounds: R[], w: { from: string; to: string }) =>
    rounds.filter((x) => anchorOf(x) >= w.from && anchorOf(x) <= w.to).map((x) => x.code);

  const shely = [
    r("0826-01", "2026-07-31", "2026-08-06"),
    r("0826-02", "2026-08-10", "2026-08-16"),
    r("0826-03", "2026-08-24", "2026-08-30"),
    SEP01,
  ];

  eq("August gets its three rounds and not September's",
     picks(shely, monthWindow("2026-08")), ["0826-01", "0826-02", "0826-03"]);

  eq("September gets the round named for it, though it opened in August",
     picks(shely, monthWindow("2026-09")), ["0926-01"]);

  /* THE INVARIANT. Overlap could not satisfy this for any straddling round, and
     it is the reason adjacent months now add up instead of overstating. Asserted
     across every month pair, not just the two that were reported broken. */
  const monthsOf = (rounds: R[]) => [...new Set(rounds.map(monthOf))].sort();
  const placed = monthsOf(shely).flatMap((m) => picks(shely, monthWindow(m)));
  eq("no round appears in two months", placed.length, new Set(placed).size);
  eq("and none is dropped either", new Set(placed).size, shely.length);

  /* A round selects on its anchor twice over — a span would admit any other
     round anchored inside it, which is the same leak one round wide. */
  const justOne = { from: anchorOf(AUG01), to: anchorOf(AUG01) };
  eq("a single round's window selects only that round",
     picks(shely, justOne), ["0826-01"]);

  /* The old month window: min(start)..max(end) of the rounds named for August.
     Kept as a regression guard — under overlap this admitted 0926-01, and if
     anyone rebuilds the picker that way the anchor rule still refuses it. */
  const oldAugWindow = { from: "2026-07-31", to: "2026-08-30" };
  eq("even the old sloppy window can no longer reach September's round",
     picks(shely, oldAugWindow), ["0826-01", "0826-02", "0826-03"]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
