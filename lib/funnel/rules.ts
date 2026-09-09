/**
 * WHAT A CAMPAIGN NAME MEANS, AS DATA.
 *
 * The reading half of 0073, mirrored here so the rules can be tested without a
 * database. `lib/funnel/filters.ts` already does this for the spend-blinding
 * rule and the two have to agree case for case; this is the same arrangement.
 *
 * The database is the one that decides. This copy exists so a rule can be
 * checked before anybody runs SQL against production, and so the screen that
 * previews a rule change can show what moves without a round trip.
 */

/** The four fields a rule may look at. Every one is already stored on the row. */
export type RuleField = "campaign" | "ad_set" | "ad" | "source";

export type RuleOp =
  | "contains" | "not_contains" | "is" | "is_not"
  | "starts_with" | "ends_with" | "is_empty" | "is_not_empty"
  | "one_of" | "regex";

export type Rule = { field?: RuleField; op?: RuleOp; value?: string };

export type DimensionValue = {
  key: string;
  ord: number;
  /** `none` resolves to null; `catch_all` matches whatever is left. */
  flags?: { none?: boolean; catch_all?: boolean };
  rules?: Rule[];
};

/** The row being labelled. Only `campaign` is ever always present. */
export type Row = {
  campaign?: string | null;
  ad_set?: string | null;
  ad?: string | null;
  source?: string | null;
};

const up = (v: string | null | undefined) => (v ?? "").toUpperCase();

export function ruleOk(rule: Rule, row: Row): boolean {
  const field = rule.field ?? "campaign";
  const op = rule.op ?? "contains";
  const value = rule.value ?? "";
  const raw = row[field] ?? "";

  switch (op) {
    case "contains":     return up(raw).includes(up(value));
    case "not_contains": return !up(raw).includes(up(value));
    case "is":           return up(raw).trim() === up(value).trim();
    case "is_not":       return up(raw).trim() !== up(value).trim();
    case "starts_with":  return up(raw).startsWith(up(value));
    case "ends_with":    return up(raw).endsWith(up(value));
    case "is_empty":     return raw.trim() === "";
    case "is_not_empty": return raw.trim() !== "";
    case "one_of":
      return value.split(",").map((x) => up(x).trim()).includes(up(raw).trim());
    case "regex":
      // Case-insensitive, matching Postgres's ~* — the two functions being
      // replaced are both case-insensitive regex, so this carries all of
      // today's behaviour on the first day.
      try { return new RegExp(value, "i").test(raw); } catch { return false; }
    // An operator nobody implemented must not quietly match everything.
    default: return false;
  }
}

/**
 * The first value whose rules match, in the values' own display order — which
 * is why "LP2 before LP1" is a position in a list rather than a hidden priority
 * number. A value flagged `none` resolves to null: that is how "this is not a
 * landing page at all" is said, and it must be able to outrank the catch-all.
 */
export function resolve(values: DimensionValue[], row: Row): string | null {
  const ordered = [...values].sort((a, b) => a.ord - b.ord || a.key.localeCompare(b.key));
  for (const v of ordered) {
    const hit = v.flags?.catch_all || (v.rules ?? []).some((r) => ruleOk(r, row));
    if (!hit) continue;
    return v.flags?.none ? null : v.key;
  }
  return null;
}
