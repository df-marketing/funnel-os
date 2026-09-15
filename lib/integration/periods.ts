/**
 * Whether a period is finished. Pure, so it can be pinned by a test.
 *
 * The route loads rows and shapes JSON; this decides. See the route for why
 * there is no `finalised` column and why there should not be one.
 */

export type RoundPeriodRow = {
  period: string;      // YYYY-MM, from fo_round_anchor — the NAMED month
  start_date: string;
  end_date: string;
  code: string;
};

export type PeriodStatus = "final" | "incomplete" | "open";

export type Period = {
  period: string;
  start: string;
  end: string;
  status: PeriodStatus;
  reason: string | null;
  rounds: number;
  roundCodes: string[];
  completeThrough: string;
};

/** Last calendar day of a YYYY-MM. Day 0 of the next month is the last of this one. */
export function monthEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * @param rounds every round belonging to the client, already carrying the month
 *               the anchor put it in.
 * @param reach  where imported data runs out — the EARLIEST coverage_end across
 *               sources, or null if any source cannot say.
 * @param today  the comparison date, passed in rather than read, so a test can
 *               pin a day and so "still running" cannot depend on when the
 *               process happens to run.
 */
export function classifyPeriods(
  rounds: RoundPeriodRow[],
  reach: string | null,
  today: string,
): Period[] {
  const byPeriod = new Map<string, RoundPeriodRow[]>();
  for (const round of rounds) {
    const list = byPeriod.get(round.period);
    if (list) list.push(round); else byPeriod.set(round.period, [round]);
  }

  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, list]) => {
      const ends = monthEnd(period);
      /* The last thing that has to have happened before this month is finished.
         Usually the month end — but a round anchored here can run past it, and
         the month is not done until that round is. Seeding the reduce with the
         month end rather than with the first round is what makes that true in
         both directions. */
      const lastEnding = list.reduce(
        (latest, r) => (r.end_date > latest ? r.end_date : latest),
        ends,
      );
      const stillRunning = lastEnding >= today;

      const status: PeriodStatus =
        stillRunning ? "open"
          : reach === null ? "incomplete"
            : reach >= lastEnding ? "final"
              : "incomplete";

      return {
        period,
        start: `${period}-01`,
        end: ends,
        status,
        /* Said out loud, because `incomplete` has two causes and they want
           different things from the caller: one waits, one imports.
           `open` has two causes as well, and only one of them is about a round —
           blaming a round for a date no round ends on is how a caller goes
           looking for a round that is not there. */
        reason:
          status === "final" ? null
            : stillRunning
              ? lastEnding > ends
                ? `a round here runs to ${lastEnding}, past the end of the month`
                : `the month has not ended yet — it runs to ${ends}`
              : reach === null ? "no source reports a coverage end"
                : `imported data stops ${reach}, before this period ends ${lastEnding}`,
        rounds: list.length,
        roundCodes: list.map((r) => r.code),
        completeThrough: lastEnding,
      };
    });
}
