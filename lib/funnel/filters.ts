/**
 * MULTI-SELECT FILTERS, AS PURE FUNCTIONS.
 *
 * Every selector in the filter bar — product, channel, country, source,
 * period — is a set. Clicking a button toggles its member; the pressed buttons
 * are the selection; an empty selection means everything. That is the whole
 * mechanism, and it lives here with no React and no server imports so it can
 * be tested directly.
 *
 * The set travels as ONE comma-separated string, both in the URL
 * (?source=Paid%20Ads,Organic) and into the database, where fo_cut sets it as
 * a transaction-local setting and the predicates read it with
 * string_to_array(..., ','). One representation end to end, so nothing has to
 * be parsed twice or agree by hand.
 *
 * A single value is a one-element set. Every caller that ever passed one value
 * — the integration routes included — keeps working unchanged.
 */

/** The list separator. No product id, channel, country or bucket contains one. */
export const SEP = ",";

/** The members of a selection. Null or "" is the empty set — "everything". */
export const listOf = (v: string | null | undefined): string[] =>
  v ? v.split(SEP).map((s) => s.trim()).filter(Boolean) : [];

export const has = (v: string | null | undefined, key: string): boolean =>
  listOf(v).includes(key);

/**
 * The selection with one member flipped. Back to null when the last member
 * leaves, so "nothing selected" is one value everywhere rather than "" here
 * and null there.
 */
export const toggle = (v: string | null | undefined, key: string): string | null => {
  const l = listOf(v);
  const next = l.includes(key) ? l.filter((x) => x !== key) : [...l, key];
  return next.length ? next.join(SEP) : null;
};

/**
 * WHICH SOURCES OWN THE SPEND.
 *
 * Spend has no source — it is all paid — so a selection keeps it only when
 * every member was bought by the ads. Paid Ads is the money for THIS round's
 * people; Previous Paid Ads is the money an EARLIER round spent on people who
 * closed here. Together they are exactly what 0020's ROAS counts, so together
 * they keep the spend. Previous Paid Ads on its own does not: this round's
 * spend did not buy those people. Anything else in the set blanks it.
 *
 * Mirrors fo_source_keeps_spend() in 0068 exactly; the screen's note and the
 * database's blanking must never disagree.
 */
export const SPEND_BUCKETS = ["Paid Ads", "Previous Paid Ads"] as const;

export const keepsSpend = (source: string | null | undefined): boolean => {
  const l = listOf(source);
  if (!l.length) return true;
  return l.includes("Paid Ads") && l.every((b) => (SPEND_BUCKETS as readonly string[]).includes(b));
};

/** A period's identity in a selection: its own dates, so the database can read it without a lookup. */
export const windowKey = (from: string, to: string): string => `${from}..${to}`;

/** "Paid Ads", "Paid Ads or Organic", "Paid Ads, AOAI or Organic" — for the note under the bar. */
export const joinOr = (v: string | null | undefined): string => {
  const l = listOf(v);
  if (l.length <= 1) return l[0] ?? "";
  return `${l.slice(0, -1).join(", ")} or ${l[l.length - 1]}`;
};
