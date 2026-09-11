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
 *
 * ── AND, SINCE REQUIREMENT 3, PROPOSING ONE ────────────────────────────────
 *
 * The second half of this file builds proposals from the strings a client's
 * data already contains, so adding a source is a click rather than an INSERT.
 * It is pure: it never decides what is already covered. That question goes to
 * fo_resolve in the route, because coverage depends on the rows in the database
 * right now, and reading them through the mirror would answer for whatever the
 * caller happened to pass instead.
 */

/** The four fields a rule may look at. Every one is already stored on the row. */
export const RULE_FIELDS = ["campaign", "ad_set", "ad", "source"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_OPS = [
  "contains", "not_contains", "is", "is_not",
  "starts_with", "ends_with", "is_empty", "is_not_empty",
  "one_of", "regex",
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

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

/* ═══════════════════════════════════════════════════════════════════════════
 * REQUIREMENT 3 — writing a rule, and being offered one
 * ═══════════════════════════════════════════════════════════════════════════ */

export const TARGETS = ["source", "market", "landing_page", "product", "channel"] as const;
export type Target = (typeof TARGETS)[number];

/**
 * A stored row, as opposed to DimensionValue above which is only what `resolve`
 * needs to match. Kept separate deliberately: the matcher must stay callable
 * with a hand-written literal in a test, which it could not be if it demanded
 * a client_id and a target it has no use for.
 */
export type DimensionRow = {
  id?: string;
  client_id: string;
  target: Target;
  key: string;
  label: string | null;
  ord: number;
  note: string | null;
  flags: Record<string, unknown>;
  rules: Rule[];
};

export type Proposal = {
  key: string;
  label: string;
  rule: Required<Rule>;
  matches: number;
  samples: string[];
  why: string;
};

export const isRuleOp = (v: unknown): v is RuleOp => RULE_OPS.includes(v as RuleOp);
export const isRuleField = (v: unknown): v is RuleField => RULE_FIELDS.includes(v as RuleField);
export const isTarget = (v: unknown): v is Target => TARGETS.includes(v as Target);

/**
 * A value's key has to survive being a URL parameter, a jsonb key and a column
 * header, so it is deliberately narrow — but NOT lowercased. "SG" and "LP1" are
 * how people write them, and a key that reads sg is a key somebody will retype.
 */
export const cleanKey = (v: string) => v.trim().replace(/\s+/g, " ").slice(0, 40);

/** Agencies name campaigns with delimiters, so the delimiters are the signal. */
const SEGMENTS = /[_\-|/]+/;

/**
 * The leading segments of a campaign name.
 *
 * `DF_SG_WEBINAR_0526_01` offers `DF_SG_WEBINAR`, `DF_SG`, `DF`. Which of them
 * is the best rule is not decided here — see proposeFromCampaigns, which prefers
 * the SHORTEST prefix that still splits the set.
 */
export function prefixesOf(campaign: string): string[] {
  const parts = campaign.trim().split(SEGMENTS).filter(Boolean);
  const out: string[] = [];
  for (let n = Math.min(parts.length - 1, 3); n >= 1; n--) out.push(parts.slice(0, n).join("_"));
  return out;
}

/**
 * Propose values from campaign names.
 *
 * `covered` is the set of campaign names fo_resolve already answers for. A
 * prefix is only proposed when it explains campaigns nothing currently
 * explains — otherwise every setup screen would open by suggesting the rules
 * that are already there.
 */
export function proposeFromCampaigns(campaigns: string[], covered: Set<string>): Proposal[] {
  const open = [...new Set(campaigns.map((c) => (c ?? "").trim()).filter(Boolean))]
    .filter((c) => !covered.has(c));
  if (open.length < 2) return [];

  const hits = new Map<string, string[]>();
  for (const c of open) {
    for (const p of prefixesOf(c)) {
      const seen = hits.get(p) ?? [];
      seen.push(c);
      hits.set(p, seen);
    }
  }

  /*
   * Most campaigns explained first, then the SHORTEST prefix that explains
   * them. Both DF_SG and DF_SG_WEBINAR split this client's campaigns today, and
   * DF_SG is the better rule: it keeps working when DF_SG_MASTERCLASS turns up,
   * where the longer one silently stops matching and the spend lands nowhere.
   *
   * The shortest-wins tie-break used to fall out of an alphabetical sort by
   * accident. Stated properly here, because an accident is not a rule.
   */
  const out: Proposal[] = [];
  const claimed = new Set<string>();
  for (const [prefix, examples] of [...hits].sort(
    (a, b) => b[1].length - a[1].length || a[0].length - b[0].length || a[0].localeCompare(b[0]),
  )) {
    /*
     * A single campaign IS worth proposing, which is not obvious. Requiring two
     * dropped DF_SG_MASTERCLASS when it ran once beside two DF_SG_WEBINARs —
     * half the split offered, the other half silently unexplained, and the
     * spend landing nowhere. The noise this could cause is bounded by the two
     * guards below and by the cap: a prefix that covers everything is refused,
     * one already claimed is refused, and at most eight are ever shown.
     */
    if (examples.length === open.length) continue;          // splits nothing
    if (examples.every((c) => claimed.has(c))) continue;     // a shorter prefix already took these
    examples.forEach((c) => claimed.add(c));
    const key = cleanKey(prefix.split("_").pop() || prefix);
    out.push({
      key,
      label: key,
      rule: { op: "starts_with", field: "campaign", value: prefix },
      matches: examples.length,
      samples: examples.slice(0, 3),
      why: `${examples.length} campaign${examples.length === 1 ? "" : "s"} start with ${prefix}, and no rule explains them yet`,
    });
  }
  return out.slice(0, 8);
}

/**
 * Propose values from the export's own lead-source column.
 *
 * This is what makes affiliate work. The plan is explicit that a new source
 * arrives with no tracking parameter of its own — the campaign name says
 * nothing about it, and utm_source is not depended on — so the only honest
 * signal is the value the CRM export already wrote in its source column.
 *
 * Exact match, never contains: source values are written by a system, not typed
 * by a person, so a substring rule would be looser than the data warrants.
 */
export function proposeFromSources(sources: string[], covered: Set<string>): Proposal[] {
  const counts = new Map<string, number>();
  for (const s of sources) {
    const v = (s ?? "").trim();
    if (!v || covered.has(v)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([value, n]) => ({
      key: cleanKey(titleish(value)),
      label: titleish(value),
      rule: { op: "is" as RuleOp, field: "source" as RuleField, value },
      matches: n,
      samples: [value],
      why: `${n} row${n === 1 ? "" : "s"} arrived with source "${value}", which no rule names yet`,
    }));
}

/** affiliate_partner → Affiliate Partner. A label a person would have typed. */
const titleish = (v: string) =>
  v.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 60);

/**
 * Where a new value goes in the order.
 *
 * Priority is the value's own `ord`, then the rule's index within it — there is
 * no separate priority column, deliberately, because "LP2 is checked before
 * LP1" is exactly a value ordering.
 *
 * A new value lands ahead of any catch-all and behind everything specific. Put
 * it last outright and a catch-all would swallow it; put it first and it would
 * outrank the hand-made rules somebody has already tuned.
 */
export function nextOrd(existing: Array<{ ord: number; flags?: Record<string, unknown> | null }>): number {
  const specific = existing.filter((v) => !v.flags?.catch_all).map((v) => v.ord);
  const catchAll = existing.filter((v) => v.flags?.catch_all).map((v) => v.ord);
  const floor = specific.length ? Math.max(...specific) + 10 : 10;
  if (!catchAll.length) return floor;
  const ceiling = Math.min(...catchAll);
  return floor < ceiling ? floor : Math.max(10, ceiling - 5);
}

/**
 * Is this value safe to save? Returns the reason it is not, or null.
 *
 * A value with no rules and no catch-all flag can never match anything, which
 * is a column of dashes and no way to tell that from a broken filter.
 */
export function whyInvalid(v: Partial<DimensionRow>): string | null {
  if (!v.target || !isTarget(v.target)) return "pick what this value is for";
  if (!v.key || !cleanKey(v.key)) return "a value needs a key";
  if (!Array.isArray(v.rules)) return "rules must be a list";
  for (const r of v.rules) {
    if (!isRuleOp(r.op)) return `'${r.op}' is not an operator this app implements`;
    if (!isRuleField(r.field)) return `'${r.field}' is not a field a lead carries`;
    const needsValue = r.op !== "is_empty" && r.op !== "is_not_empty";
    if (needsValue && !String(r.value ?? "").trim()) return `${r.op} needs something to match against`;
    if (r.op === "regex") {
      try { new RegExp(r.value ?? ""); } catch { return `that regular expression does not parse: ${r.value}`; }
    }
  }
  const isCatchAll = Boolean(v.flags?.catch_all) || Boolean(v.flags?.none);
  if (!v.rules.length && !isCatchAll) return "a value with no rules matches nothing — add a rule, or mark it the catch-all";
  return null;
}
