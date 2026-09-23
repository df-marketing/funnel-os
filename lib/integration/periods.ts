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

/**
 * One round, answered the same way a period is.
 *
 * AcqOS closes ROUNDS nightly and reports on MONTHS monthly, and until now this
 * endpoint only answered the second question. Their first attempt at the first
 * one was going to be "refuse unless the round is in finalPeriods" — but
 * finalPeriods holds months, so a round code is never in it and every round in
 * the current month would be refused forever.
 *
 * That was our gap, not theirs. A round has its own end date and its own
 * answer, and deriving it on their side would be the inference they were right
 * to reject. So it is computed here.
 */
export type RoundStatus = {
  code: string;
  start: string;
  end: string;
  status: PeriodStatus;
  reason: string | null;
};

export type Period = {
  period: string;
  start: string;
  end: string;
  status: PeriodStatus;
  reason: string | null;
  rounds: number;
  /** Kept for callers that already read it. `roundStatus` is the useful one. */
  roundCodes: string[];
  /** Per round, because a round is closed on its own last day, not the month's. */
  roundStatus: RoundStatus[];
  completeThrough: string;
};

/**
 * Should this freeze be refused because the data has not reached the period?
 *
 * Returns null when the freeze is safe, or the reason when it is not. Pure, and
 * separate from the routes, so one rule covers rounds and months and a test can
 * pin it.
 *
 * THE TWO QUESTIONS ARE NOT THE SAME. `isClosedDay`/`isClosedMonth` ask whether
 * the period is OVER. This asks whether the data ARRIVED. A period can be long
 * finished and still have an import that stops halfway through it — that is the
 * `incomplete` state in list-periods, and it is the one that never fixes itself.
 *
 * `reach` is the EARLIEST coverage_end across sources, never the latest. One
 * short file makes the whole period short: a close rate whose numerator stopped
 * before its denominator did is not a slightly-old number, it is a wrong one.
 * A null reach means no source can say how far it goes, and not knowing is not
 * permission — it refuses too.
 */
export function freezeRefusal(
  completeThrough: string,
  reach: string | null,
): { reason: string; completeThrough: string; reach: string | null } | null {
  if (reach === null) {
    return {
      reason: "no source reports a coverage end, so there is no way to tell whether the data reaches this period",
      completeThrough, reach,
    };
  }
  if (reach >= completeThrough) return null;
  return {
    reason: `imported data stops ${reach}, before this period ends ${completeThrough}`,
    completeThrough, reach,
  };
}

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

      /* Each round judged on its own dates. Same three words as a period, and
         they mean the same things: open is waiting on the calendar, incomplete
         is waiting on an import, final is safe to close. */
      const roundStatus: RoundStatus[] = list
        .slice()
        .sort((a, b) => a.start_date.localeCompare(b.start_date))
        .map((r) => {
          const stillRunning = r.end_date >= today;
          const gap = stillRunning ? null : freezeRefusal(r.end_date, reach);
          return {
            code: r.code,
            start: r.start_date,
            end: r.end_date,
            status: (stillRunning ? "open" : gap ? "incomplete" : "final") as PeriodStatus,
            reason: stillRunning
              ? `still running — it ends ${r.end_date}`
              : gap
                ? gap.reason
                : null,
          };
        });

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
        roundStatus,
        completeThrough: lastEnding,
      };
    });
}
