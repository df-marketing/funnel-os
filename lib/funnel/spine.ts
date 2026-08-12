/**
 * The metric spine — exactly the sheet's rows, in the sheet's order and grouping.
 *
 * This is the whole architecture in one array: every view is this same list of
 * rows with different columns. Adding round 0826-02 adds a column, not a formula.
 */

export type Fmt = "m" | "i" | "p" | "d1" | "d2";

export type SpineRow =
  | { group: string }
  | { key: MetricKey; label: string; fmt: Fmt; highlight?: boolean };

export type MetricKey =
  | "spend" | "reach" | "freq" | "impr" | "clicks" | "leads" | "att"
  | "prevBuy" | "midBuy" | "prevRev" | "midRev" | "prevPrice" | "midPrice" | "rev"
  | "ctr" | "leadgen" | "attPct" | "prevPct" | "midPct"
  | "cpm" | "cpc" | "cpl" | "cpAtt" | "cpa"
  | "prevAov" | "prevRoas" | "midAov" | "midRoas" | "roas";

export const SPINE: SpineRow[] = [
  { group: "Metrics" },
  { key: "spend",     label: "Ads Spent (SGD)",             fmt: "m" },
  { key: "reach",     label: "Reach",                       fmt: "i" },
  { key: "freq",      label: "Frequency",                   fmt: "d2" },
  { key: "impr",      label: "Impression",                  fmt: "i" },
  { key: "clicks",    label: "Outbound Clicks",             fmt: "i" },
  { key: "leads",     label: "Leads",                       fmt: "i" },
  { key: "att",       label: "Overall Attendance",          fmt: "i" },
  { key: "prevBuy",   label: "Preview Offer Purchases",     fmt: "i" },
  { key: "midBuy",    label: "Middle Offer Purchases",      fmt: "i" },
  { key: "prevRev",   label: "Preview Offer Revenue (SGD)", fmt: "m" },
  { key: "midRev",    label: "Middle Offer Revenue (SGD)",  fmt: "m" },
  { key: "prevPrice", label: "Preview Selling Price",       fmt: "m" },
  { key: "midPrice",  label: "Middle Selling Price",        fmt: "m" },
  { key: "rev",       label: "Total Revenue (SGD)",         fmt: "m" },

  { group: "Funnel Metrics" },
  { key: "ctr",     label: "Outbound CTR %",           fmt: "p" },
  { key: "leadgen", label: "Lead Gen %",               fmt: "p" },
  { key: "attPct",  label: "Attendance %",             fmt: "p" },
  { key: "prevPct", label: "Preview Offer Purchase %", fmt: "p" },
  { key: "midPct",  label: "Middle Offer Purchase %",  fmt: "p" },

  { group: "Unit Of Economics" },
  { key: "cpm",      label: "CPM (SGD)",               fmt: "m" },
  { key: "cpc",      label: "CPC (SGD)",               fmt: "m" },
  { key: "cpl",      label: "CPL (SGD)",               fmt: "m" },
  { key: "cpAtt",    label: "CP Attendance (SGD)",     fmt: "m" },
  { key: "cpa",      label: "CPA (SGD)",               fmt: "m" },
  { key: "prevAov",  label: "Preview Offer AOV (SGD)", fmt: "m" },
  { key: "prevRoas", label: "Preview ROAS",            fmt: "d1", highlight: true },
  { key: "midAov",   label: "Middle Offer AOV (SGD)",  fmt: "m" },
  { key: "midRoas",  label: "Middle ROAS",             fmt: "d1", highlight: true },
  { key: "roas",     label: "Overall ROAS",            fmt: "d1", highlight: true },
];

export const isGroup = (r: SpineRow): r is { group: string } => "group" in r;

/**
 * A metric bundle as it comes out of fo_metrics(). Values are strings (Postgres
 * numerics arrive as strings over PostgREST) or null. NULL is the whole point:
 * it means "this metric does not exist for this cut", and it renders as '—'.
 */
export type Metrics = Partial<Record<MetricKey, string | number | null>>;

/**
 * Format one cell. Returns null when the value is absent — the caller renders
 * '—'. No formatter ever turns a null into a 0.
 */
export function fmt(value: string | number | null | undefined, f: Fmt): string | null {
  if (value === null || value === undefined || value === "") return null;
  const v = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(v)) return null;
  switch (f) {
    case "m":  return v.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "i":  return Math.round(v).toLocaleString("en-SG");
    case "p":  return v.toFixed(2) + "%";
    case "d1": return v.toFixed(1);
    case "d2": return v.toFixed(2);
  }
}

/** Compact form for the journey strip cards. */
export function fmtCount(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const v = Number(value);
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-SG") : "—";
}

/** Highlight ROAS against the pinned baseline, as the mockup's legend describes. */
export function roasClass(
  raw: string | number | null | undefined,
  baseline: string | number | null | undefined,
  isTotal: boolean,
): string {
  if (isTotal || raw === null || raw === undefined || baseline === null || baseline === undefined) return "";
  const v = Number(raw), b = Number(baseline);
  if (!Number.isFinite(v) || !Number.isFinite(b) || b === 0) return "";
  if (v >= b * 1.5) return " win";
  if (v < b * 0.6) return " lose";
  return "";
}
