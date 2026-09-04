/**
 * WHICH CUT A TAB READS.
 *
 * Its own module, with no server imports, so the routing can be tested
 * directly. It used to sit in data.ts beside the fetch it feeds, which meant
 * the only way to check it was to run the app and look — and the one time it
 * broke, that is exactly how it was found: by looking at a screenshot.
 */

export type Cut2 =
  | "month" | "week" | "round" | "adset" | "source" | "roundsource"
  | "adround" | "adsetround"
  | "ad" | "session" | "preview" | "middle" | "thisround"
  | "variant" | "variantround"
  | "landing" | "landinground";

const NEEDS_MONTHS = new Set(["month"]);
/**
 * Whether this tab is in the sidebar is not decided here — see `cadencesFor`.
 * A product that runs in rounds offers By round; one that runs continuously
 * offers By week. The data says which; this file only knows how to fetch both.
 */
const NEEDS_WEEKS = new Set(["week"]);
const NEEDS_ROUNDS = new Set(["round"]);
const NEEDS_ADSETS = new Set(["targeting"]);
const NEEDS_SOURCES = new Set(["source"]);
const NEEDS_ROUND_SOURCE = new Set(["roundsource"]);
const NEEDS_ADS = new Set(["ads"]);
/**
 * A stage tab compares along the dimension its journey declares, and these two
 * were built as tabs of their own before that was wired.
 *
 *   Leads                    the landing page — what turns a click into a lead
 *   Live Webinar Attendance  the reminder sequence — what gets them in the room
 *
 * The attendance stage used to compare rounds.session_label, which on this
 * client is one distinct label per round — "Class 19 May", "Class 28 May",
 * twelve of them — so that tab was By round wearing different words. The
 * sequence is the thing that stage is actually testing.
 *
 * v_metrics_by_session is left in place: a client whose rounds share a class
 * format has a real comparison there, and this one does not.
 */
const NEEDS_SESSION = new Set<string>([]);
const NEEDS_VARIANT = new Set(["class"]);
const NEEDS_LANDING = new Set(["lp"]);
export const NEEDS_OFFER = new Set(["preview", "middle"]);
export const NEEDS_THIS_ROUND = new Set(["analysis"]);
export const NEEDS_UNMATCHED_DETAIL = new Set(["unmatched"]);
export { NEEDS_MONTHS, NEEDS_WEEKS, NEEDS_ROUNDS, NEEDS_ADSETS, NEEDS_SOURCES, NEEDS_ROUND_SOURCE, NEEDS_ADS, NEEDS_SESSION, NEEDS_VARIANT, NEEDS_LANDING };

/**
 * THE ASSET SWITCH LIVES INSIDE THE TAB'S OWN BRANCH, DELIBERATELY.
 *
 * It was briefly two extra branches ahead of these, and because a set naming
 * "ads" was tested before the branch that handles "ads", the tab returned the
 * drilled cut whether or not anything was drilled into — so the Ads tab drew
 * rounds, repeated, instead of creatives.
 *
 * One tab, one branch, and the asset decides only what that branch returns.
 * Nothing outside the two asset tabs reads it at all.
 */
export const cutFor = (view: string, asset: string | null = null): Cut2 | null =>
  NEEDS_MONTHS.has(view) ? "month"
  : NEEDS_WEEKS.has(view) ? "week"
  : NEEDS_ROUNDS.has(view) ? "round"
  : NEEDS_ADSETS.has(view) ? (asset ? "adsetround" : "adset")
  : NEEDS_SOURCES.has(view) ? "source"
  : NEEDS_ROUND_SOURCE.has(view) ? "roundsource"
  : NEEDS_ADS.has(view) ? (asset ? "adround" : "ad")
  : NEEDS_VARIANT.has(view) ? (asset ? "variantround" : "variant")
  : NEEDS_LANDING.has(view) ? (asset ? "landinground" : "landing")
  : NEEDS_SESSION.has(view) ? "session"
  // the two offer tabs share one view, told apart by a product filter, so a
  // metric cannot mean one thing on Preview and another on Middle
  : view === "preview" ? "preview"
  : view === "middle" ? "middle"
  : NEEDS_THIS_ROUND.has(view) ? "thisround"
  : null;

/**
 * One asset's rounds, or every asset.
 *
 * The round cuts carry every asset at once so a single fetch serves both
 * states. Drilled in, only one group is wanted. group_key rather than the
 * label, because the label is prettified for the screen and "(unsplit)" is not
 * "Unsplit spend".
 *
 * Its own function so the table and the plot cannot disagree — they did once,
 * and the drilled table showed one audience while the chart beside it drew all
 * six.
 */
export const narrowToAsset = <T extends { group_key?: string | null }>(
  cuts: T[],
  view: string,
  asset: string | null,
): T[] => {
  const flat = cutFor(view);
  const isAssetTab = flat === "adset" || flat === "ad" || flat === "variant" || flat === "landing";
  return isAssetTab && asset ? cuts.filter((c) => c.group_key === asset) : cuts;
};

/**
 * The month a round belongs to is the one its NAME declares, not the one it
 * happened to open in. Rounds are MMYY-NN and run about a week, so two of
 * Shely's twelve start in the month before the one they are called after:
 *
 *     0826-01   31 Jul → 6 Aug     called August, opened in July
 *     0926-01   28 Aug → 3 Sept    called September, opened in August
 *
 * Bucketing on start_date filed both a month early. September then had no
 * round at all, so it was never offered — the September round was sitting
 * under August, and the only way to reach it was to know that.
 *
 * The name is only trusted when it overlaps the round's actual dates; a
 * round named something that does not is filed by when it ran.
 */
export const monthOf = (r: { round_id: string; start_date: string; end_date: string }) => {
  const m = /^(\d{2})(\d{2})-/.exec(r.round_id);
  if (!m) return r.start_date.slice(0, 7);
  const named = `20${m[2]}-${m[1]}`;
  if (m[1] < "01" || m[1] > "12") return r.start_date.slice(0, 7);
  return named >= r.start_date.slice(0, 7) && named <= r.end_date.slice(0, 7)
    ? named
    : r.start_date.slice(0, 7);
};
