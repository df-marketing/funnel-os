/**
 * Attribution — which round's spend produced this lead, and which class closed
 * this sale.
 *
 * The brief's rule, and the reason `attribution_method` exists as a column:
 *
 *   "Determine lead_round_id — from the UTM captured at opt-in where it exists,
 *    from the opt-in date falling inside a round's window where it doesn't.
 *    WHICH METHOD WAS USED IS STORED ON THE ROW, so an inferred attribution is
 *    distinguishable from a known one."
 *
 * A date-window attribution is a weaker claim than a UTM one, and the app has to
 * be able to say which it made. That's why this never returns a round without
 * also returning how it got there.
 */

import { localDay } from "./csv";

export type Round = {
  round_id: string;
  client_id: string;
  start_date: string;
  end_date: string;
  /**
   * Every class this round runs, not one. A round with classes on the 5th and
   * the 7th used to have nowhere to put the second, so a Zoom export named
   * after it resolved to no round at all and every row parked.
   *
   * Kept as a list rather than a single date because the schedule is not
   * predictable — some rounds run one class, some several.
   */
  session_dates: string[];
};

export type AdSetRun = { ad_set: string; round_id: string; date: string };

export type Attribution = {
  roundId: string | null;
  method: "utm" | "date_window" | null;
};

/** Rounds carry local calendar dates, so slicing one is already the local day. */
const day = (d: string) => d.slice(0, 10);

/**
 * UTM path: the utm_campaign names an ad set. The round is the one that ad set
 * was actually running in on the opt-in date — that's the round whose budget
 * paid for this lead. If the ad set ran in several rounds, the one whose window
 * contains the date wins; failing that, the nearest earlier run.
 */
export function attributeLead(
  optInDate: string,
  utmCampaign: string | null,
  rounds: Round[],
  adSetRuns: AdSetRun[],
): Attribution {
  // The opt-in is an INSTANT; the round window is a pair of local dates. Compare
  // them on the same clock, or a 4am opt-in falls into the previous round.
  const d = localDay(optInDate);

  if (utmCampaign) {
    const runs = adSetRuns
      .filter((r) => r.ad_set === utmCampaign)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (runs.length) {
      const inWindow = runs.find((r) => {
        const round = rounds.find((x) => x.round_id === r.round_id);
        return round && day(round.start_date) <= d && d <= day(round.end_date);
      });
      if (inWindow) return { roundId: inWindow.round_id, method: "utm" };

      const earlier = [...runs].reverse().find((r) => r.date <= d);
      if (earlier) return { roundId: earlier.round_id, method: "utm" };
      return { roundId: runs[0].round_id, method: "utm" };
    }
  }

  // Date-window fallback — weaker, and recorded as such.
  const containing = rounds.find((r) => day(r.start_date) <= d && d <= day(r.end_date));
  if (containing) return { roundId: containing.round_id, method: "date_window" };

  // Outside every window: the most recent round that had already opened.
  const prior = [...rounds]
    .filter((r) => day(r.start_date) <= d)
    .sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
  return prior ? { roundId: prior.round_id, method: "date_window" } : { roundId: null, method: null };
}

/**
 * close_round_id = the MOST RECENT attendance event before the purchase, same
 * contact. v8 fix 2: if John attends class A then class B and buys after B, the
 * sale closed at B. One sale, one closing class.
 */
export function closeRoundFor(
  purchaseAt: string,
  attendances: Array<{ round_id: string | null; event_date: string }>,
): string | null {
  const before = attendances
    .filter((a) => a.round_id && a.event_date <= purchaseAt)
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
  return before.length ? before[0].round_id : null;
}

/**
 * The round named inside a campaign name, if one is.
 *
 * A period-level Meta export dates every row to the START of the reporting
 * window — "1 May 2026" for a 1-31 May report — and that date falls inside no
 * round, so the date-window rule finds nothing and the whole file is refused.
 * The campaign name carries the answer: DF_SG_Preview_Sprint1_0526_02 is round
 * 0526-02, and DF_SG_Preview_Sprint1_0526_03_AI is 0526-03.
 *
 * Matched against rounds that EXIST rather than parsed out of the string, so
 * this can only ever pick a real round — a campaign naming a round nobody has
 * created still resolves to nothing, which is the correct answer. Underscores
 * and hyphens are treated alike because Meta's naming convention uses one and
 * round ids use the other.
 *
 * Longest id first, so 0526-031 can never be matched by 0526-03.
 */
export function roundFromCampaign(campaign: string | null, rounds: Round[]): Round | null {
  if (!campaign) return null;
  const hay = campaign.toLowerCase().replace(/_/g, "-");
  const candidates = [...rounds].sort((a, b) => b.round_id.length - a.round_id.length);
  return candidates.find((r) => hay.includes(r.round_id.toLowerCase().replace(/_/g, "-"))) ?? null;
}

/** Which round's class this attendance row belongs to, given a session label or id. */
export function resolveRoundRef(ref: string, rounds: Round[]): string | null {
  const s = ref.trim();
  const exact = rounds.find((r) => r.round_id.toLowerCase() === s.toLowerCase());
  if (exact) return exact.round_id;
  const bySession = rounds.find((r) => r.session_dates.some((d) => day(d) === day(s)));
  if (bySession) return bySession.round_id;
  const contains = rounds.find((r) => s.toLowerCase().includes(r.round_id.toLowerCase()));
  return contains ? contains.round_id : null;
}

/** preview | middle from whatever the payment export calls the product. */
export function resolveProduct(raw: string): "preview" | "middle" | null {
  const s = raw.toLowerCase();
  if (/middle|3000|3,000|2-day|two-day|back|mastermind/.test(s)) return "middle";
  if (/preview|297|2-hour|two-hour|front|workshop/.test(s)) return "preview";
  return null;
}
