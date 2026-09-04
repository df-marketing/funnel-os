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
  | "ad" | "session" | "preview" | "middle" | "thisround";

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
const NEEDS_SESSION = new Set(["class"]);
export const NEEDS_OFFER = new Set(["preview", "middle"]);
export const NEEDS_THIS_ROUND = new Set(["analysis"]);
export const NEEDS_UNMATCHED_DETAIL = new Set(["unmatched"]);
export { NEEDS_MONTHS, NEEDS_WEEKS, NEEDS_ROUNDS, NEEDS_ADSETS, NEEDS_SOURCES, NEEDS_ROUND_SOURCE, NEEDS_ADS, NEEDS_SESSION };

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
  : NEEDS_SESSION.has(view) ? "session"
  // the two offer tabs share one view, told apart by a product filter, so a
  // metric cannot mean one thing on Preview and another on Middle
  : view === "preview" ? "preview"
  : view === "middle" ? "middle"
  : NEEDS_THIS_ROUND.has(view) ? "thisround"
  : null;
