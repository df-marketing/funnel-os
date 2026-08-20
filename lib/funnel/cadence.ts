/**
 * Which spine a selection has — By round, By week, or both.
 *
 * Separate from data.ts on purpose. These two functions decide whether a tab
 * appears in the sidebar at all, and a regression here doesn't throw or show a
 * wrong number: a nav entry is simply missing, which reads as "that feature was
 * never built". data.ts pulls in next/cache and can't be imported by the test
 * runner, so the logic that most needs a test lives where one can reach it.
 */

/**
 * How a product's campaigns run, and therefore which spine can report on it.
 *
 * 'round' — discrete cycles with a class at the end. Rounds are the unit, and a
 *           week column would just repeat one with a worse heading.
 * 'week'  — continuous traffic, no class, no round. There is nothing for By
 *           round to put in a column; weeks are the only spine that exists.
 */
export type Cadence = "round" | "week";

/** Only the fields cadence resolution needs — the full Product lives in data.ts. */
type HasCadence = { product_id: string; cadence?: Cadence | null };

/**
 * The cadences in play under the current product filter.
 *
 * One product when the filter names one, all of them when it doesn't. A client
 * selling a round product and a weekly one gets both tabs while looking at
 * "All", which is correct rather than a compromise: both statements are true of
 * that mix, and hiding either would deny half the account exists.
 *
 * Falls back to rounds when nothing says otherwise — a database that hasn't run
 * 0026 yet returns products with no cadence at all, and every round in it is a
 * round. The fallback keeps that database's sidebar exactly as it was rather
 * than emptying the Overview group until the migration lands.
 */
export function cadencesFor(products: HasCadence[], product: string | null): Cadence[] {
  const inScope = product ? products.filter((p) => p.product_id === product) : products;
  const found = new Set(inScope.map((p) => p.cadence).filter(Boolean));
  if (!found.size) return ["round"];
  return (["round", "week"] as const).filter((c) => found.has(c));
}

/**
 * The Overview tab to land on when the open one has no spine under it.
 *
 * Filtering to an evergreen product while standing on By round would otherwise
 * leave you on a tab that isn't in the sidebar, reading an empty table. The
 * table would be right, and it would look exactly like a broken filter.
 */
export function resolveSpine(view: string, cadences: Cadence[]): string {
  if (view === "round" && !cadences.includes("round")) return "week";
  if (view === "week" && !cadences.includes("week")) return "round";
  return view;
}
