/**
 * The graph view's model: input → objective → efficiency, across the tab's cut.
 *
 * Three panels stacked on one shared x-axis, in that order, because that is the
 * order the question is asked in: we spent this, it produced that, so it cost
 * this much per unit. Reading it top to bottom IS the argument.
 *
 * Kept free of React and of next/cache so the arithmetic can be tested. What
 * goes wrong in a chart is not that it throws — it is that a bar is the wrong
 * height or a missing month quietly plots as zero, and neither of those raises
 * anything. The scales, the gaps and the geometry are all decided here.
 */

import type { Cut } from "./data";
import type { MetricKey, Metrics, Fmt } from "./spine";
import { fmt } from "./spine";

/** What the client is actually trying to produce. Efficiency follows from it. */
export type ObjectiveKey = "leads" | "att" | "prevBuy" | "rev";

export const OBJECTIVE_KEYS: ObjectiveKey[] = ["leads", "att", "prevBuy", "rev"];

export type ObjectiveDef = {
  /** The thing being produced. */
  label: string;
  metric: MetricKey;
  metricFmt: Fmt;
  /** What a unit of it cost — or, for revenue, what it returned. */
  efficiency: MetricKey;
  efficiencyLabel: string;
  efficiencyFmt: Fmt;
  /** Which direction is good. Cost falls, return rises; the caption says so. */
  betterWhen: "lower" | "higher";
};

/**
 * Objective decides efficiency; you don't get to pick them independently.
 *
 * Cost per attendee against a revenue objective would be two different
 * questions on one screen, and the reader would have no way to tell which of
 * them the line is answering.
 */
export const OBJECTIVES: Record<ObjectiveKey, ObjectiveDef> = {
  leads: {
    label: "Leads", metric: "leads", metricFmt: "i",
    efficiency: "cpl", efficiencyLabel: "Cost per lead (SGD)", efficiencyFmt: "m",
    betterWhen: "lower",
  },
  att: {
    label: "Overall Attendance", metric: "att", metricFmt: "i",
    efficiency: "cpAtt", efficiencyLabel: "Cost per attendance (SGD)", efficiencyFmt: "m",
    betterWhen: "lower",
  },
  prevBuy: {
    label: "Preview Offer Purchases", metric: "prevBuy", metricFmt: "i",
    efficiency: "cpa", efficiencyLabel: "Cost per acquisition (SGD)", efficiencyFmt: "m",
    betterWhen: "lower",
  },
  rev: {
    label: "Total Revenue (SGD)", metric: "rev", metricFmt: "m",
    efficiency: "roas", efficiencyLabel: "Overall ROAS", efficiencyFmt: "d1",
    betterWhen: "higher",
  },
};

export const isObjective = (v: string | null | undefined): v is ObjectiveKey =>
  !!v && (OBJECTIVE_KEYS as string[]).includes(v);

/** Table or graph. In the URL, like the filter, so a graph can be sent to someone. */
/**
 * What the right-hand axis carries.
 *
 * The input is always ad spend — that half of the question never changes, so
 * everything here is choosing the other line. Two lines, because a third would
 * need a third axis, and three axes on one plot is a puzzle rather than a chart.
 *
 * ── WHY THIS IS ONE LIST AND NOT TWO CONTROLS ─────────────────────────────
 * It used to be Objective (four) times Spend-vs (two). Eight states reached
 * through two controls, and the screenshot that killed it showed "Overall
 * Attendance" lit up in BOTH rows at once, four hundred pixels apart, because
 * the second control's first option is by construction the same string as the
 * first control's selection.
 *
 * That pairing is real in the code — an efficiency has to know its own
 * denominator — but on screen it was a data structure leaking into an
 * interface. The graph asks one question, "spend against what", and the answer
 * is one metric. So: one list, grouped into the amount and its efficiency, so
 * eight options still scan as two kinds.
 *
 * `objective` survives on This round, where it genuinely names a goal rather
 * than picking a line.
 */
export type VsKey = "leads" | "att" | "prevBuy" | "rev" | "cpl" | "cpAtt" | "cpa" | "roas";

export type VsOption = {
  key: VsKey;
  metric: MetricKey;
  /** On the button. Short, because eight of them share a control bar. */
  short: string;
  /** On the axis and in the legend, where there is room to be exact. */
  label: string;
  fmt: Fmt;
  /** Which row it sits in: the outcome itself, or the efficiency of it. */
  kind: "amount" | "efficiency";
  betterWhen: "lower" | "higher";
};

export const VS_OPTIONS: VsOption[] = [
  { key: "leads",   metric: "leads",   short: "Leads",      label: "Leads",                   fmt: "i",  kind: "amount",     betterWhen: "higher" },
  { key: "att",     metric: "att",     short: "Attendance", label: "Overall Attendance",      fmt: "i",  kind: "amount",     betterWhen: "higher" },
  { key: "prevBuy", metric: "prevBuy", short: "Purchases",  label: "Preview Offer Purchases", fmt: "i",  kind: "amount",     betterWhen: "higher" },
  { key: "rev",     metric: "rev",     short: "Revenue",    label: "Total Revenue (SGD)",     fmt: "m",  kind: "amount",     betterWhen: "higher" },
  { key: "cpl",     metric: "cpl",     short: "Cost per lead",       label: "Cost per lead (SGD)",       fmt: "m",  kind: "efficiency", betterWhen: "lower" },
  { key: "cpAtt",   metric: "cpAtt",   short: "Cost per attendance", label: "Cost per attendance (SGD)", fmt: "m",  kind: "efficiency", betterWhen: "lower" },
  { key: "cpa",     metric: "cpa",     short: "CPA",                 label: "Cost per acquisition (SGD)",fmt: "m",  kind: "efficiency", betterWhen: "lower" },
  // The one that goes UP when it improves. It sits with the efficiencies
  // because that is what it measures, not because it is a cost.
  { key: "roas",    metric: "roas",    short: "ROAS",                label: "Overall ROAS",              fmt: "d1", kind: "efficiency", betterWhen: "higher" },
];

export const vsOption = (k: VsKey) => VS_OPTIONS.find((o) => o.key === k) ?? VS_OPTIONS[5];
export const isVs = (v: string | null | undefined): v is VsKey =>
  !!v && VS_OPTIONS.some((o) => o.key === v);

export type ViewMode = "table" | "graph";
export type ViewOpts = { mode: ViewMode; objective: ObjectiveKey; vs: VsKey };

/**
 * Attendance, because that is the objective the brief named: "let's say client
 * only cares for attendance then it would be overall attendance". It is a
 * default and not a decision — the picker is one click away and the choice
 * lives in the URL.
 */
export const DEFAULT_OPTS: ViewOpts = { mode: "table", objective: "att", vs: "cpAtt" };

/**
 * Tabs whose cut is one-dimensional, so it can be an x-axis.
 *
 * Round × source is left out because it has two dimensions and no honest single
 * axis — its columns are rounds split by source, and lining them up left to
 * right would draw a time series that jumps back in time every few bars. This
 * round is left out because it is being rebuilt around the CRO steps, where the
 * comparison is the point rather than the trend.
 */
export const GRAPHABLE = new Set([
  "month", "week", "round", "source", "targeting", "ads", "class", "preview", "middle",
]);

/**
 * Postgres numerics arrive as strings over PostgREST, and absent arrives as
 * null. Anything that isn't a finite number stays null all the way to the
 * drawing, where it becomes a gap rather than a zero.
 */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * A round-numbered top for the axis, at or above the largest value.
 *
 * Bars drawn against the raw maximum make the tallest one touch the ceiling in
 * every panel, which makes three different scales look like one.
 */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const n = max / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * base;
}

/**
 * The ceiling, adjusted so every gridline LABEL is a number the panel can hold.
 *
 * A count of people ran 0 · 13 · 25 while the middle line actually sat at 12.5,
 * because the integer formatter rounded the label and nothing rounded the line.
 * Off by half a person, and the kind of wrong that is read a hundred times
 * before anyone checks it. An even ceiling makes the midpoint whole.
 */
export function axisMax(max: number, f: Fmt): number {
  const nice = niceMax(max);
  // TICKS gridlines means TICKS-1 gaps; a count has to divide by that exactly or
  // the labels drift off their own lines.
  return f === "i" ? Math.ceil(nice / (TICKS - 1)) * (TICKS - 1) : nice;
}


export type Point = { key: string; label: string; sub: string | null; value: number | null };

export type Series = {
  role: "input" | "against";
  axis: "left" | "right";
  label: string;
  fmt: Fmt;
  points: Point[];
  /** Axis ceiling. Always > 0, so dividing by it is always safe. */
  max: number;
  /** Every value is absent — said in words rather than drawn as a flat zero. */
  empty: boolean;
};

export type ChartModel = {
  left: Series;
  right: Series;
  columns: { key: string; label: string; sub: string | null }[];
  vs: VsOption;
  /** Cuts that carried nothing on either line. Named under the chart, not hidden. */
  blanks: string[];
};

function seriesFor(
  role: Series["role"], axis: Series["axis"], label: string, key: MetricKey, f: Fmt, cuts: Cut[],
): Series {
  const points: Point[] = cuts.map((c) => ({
    key: c.cut_key,
    label: c.cut_label ?? c.cut_key,
    sub: c.cut_sub ?? null,
    value: num((c.m as Metrics)?.[key]),
  }));
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  return {
    role, axis, label, fmt: f, points,
    max: axisMax(Math.max(0, ...values), f),
    empty: values.length === 0,
  };
}

/**
 * Two series on one plot, each with its own axis.
 *
 * Separate scales rather than one shared: spend runs in thousands and cost per
 * attendee in tens, so a single axis would press the second line flat along the
 * floor and it would read as a collapse rather than as a different unit. That
 * is what the left and right axes are for, and why each is labelled with the
 * series it belongs to.
 *
 * The Total column is deliberately not passed in by the caller: a total is not
 * a point on a time axis.
 */
export function chartModel(cuts: Cut[], vs: VsKey): ChartModel {
  const opt = vsOption(vs);
  const left = seriesFor("input", "left", "Ads Spent (SGD)", "spend", "m", cuts);
  const right = seriesFor("against", "right", opt.label, opt.metric, opt.fmt, cuts);

  const blanks = cuts
    .filter((c) =>
      [left, right].every((s) => s.points.find((q) => q.key === c.cut_key)?.value === null))
    .map((c) => c.cut_label ?? c.cut_key);

  return {
    left, right,
    columns: cuts.map((c) => ({ key: c.cut_key, label: c.cut_label ?? c.cut_key, sub: c.cut_sub ?? null })),
    vs: opt,
    blanks,
  };
}

/** Cell text, or the same em dash the table uses. One idea of absent. */
export const cell = (v: number | null, f: Fmt): string => (v === null ? "—" : (fmt(v, f) ?? "—"));

// ── Geometry ───────────────────────────────────────────────────────────────
// One plot area, two y-axes, in viewBox units.

export const TICKS = 5;   // 0, a quarter, half, three quarters, the ceiling

export const GEO = {
  padL: 80,      // left axis labels — money, and money is wide
  padR: 80,      // right axis labels
  padT: 18,      // above the plot
  minCol: 132,   // narrowest a column may get before the chart starts scrolling
  plotH: 300,
  axisH: 64,     // x labels, which may run to two lines, and their sub-labels
  /**
   * The width the plot spreads itself across when it can.
   *
   * Columns are not a fixed size. Two rounds drawn at a fixed column width left
   * the chart huddled in the left third of the pane with the rest empty, so the
   * width is a target and the columns divide it — the same drawing spread out,
   * rather than a small drawing in a big box. Past `minCol` per column it stops
   * dividing and starts scrolling instead, because squeezing further would just
   * pile the labels back on top of each other.
   */
  targetW: 1400,
  /** Roughly one character of the x-axis label font, for fitting text. */
  charW: 6.6,
} as const;

/** How wide each column is, given how many there are. */
export const colWidth = (n: number) =>
  Math.max(GEO.minCol, (GEO.targetW - GEO.padL - GEO.padR) / Math.max(1, n));

export const chartWidth = (n: number) => GEO.padL + Math.max(1, n) * colWidth(n) + GEO.padR;
export const chartHeight = () => GEO.padT + GEO.plotH + GEO.axisH;

/** Centre of column i, in viewBox x units. */
export const colX = (i: number, n: number) => GEO.padL + i * colWidth(n) + colWidth(n) / 2;

/** How many characters of label fit in one column, with a little air either side. */
export const labelChars = (n: number) => Math.max(6, Math.floor((colWidth(n) - 14) / GEO.charW));

/**
 * An x-axis label, broken over at most two lines so it fits its column.
 *
 * Ad set names are the reason this exists: "Cold_ConsultantsServiceProviders" is
 * five times its column wide, and six of them side by side rendered as one
 * unreadable smear across the axis. SVG does not wrap text, so the break has to
 * be chosen here.
 *
 * Split at a seam the name already has — an underscore, a space, a hyphen, or
 * the join in camelCase — nearest the middle, so the two halves come out as
 * even as the name allows. Only when there is no seam does it cut mid-word, and
 * only what still doesn't fit is truncated, with an ellipsis to say so. The full
 * text goes in a <title> either way, so nothing is lost, only folded.
 */
export function wrapLabel(label: string, max: number): string[] {
  const text = label.trim();
  if (text.length <= max) return [text];

  const seams: number[] = [];
  for (let i = 1; i < text.length; i++) {
    const prev = text[i - 1];
    if ("_ -·/".includes(prev)) seams.push(i);
    else if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(text[i])) seams.push(i);
  }

  const mid = text.length / 2;
  const fits = seams.filter((i) => i <= max && text.length - i <= max);
  const pick = (list: number[]) =>
    list.reduce((best, i) => (Math.abs(i - mid) < Math.abs(best - mid) ? i : best), list[0]);

  const at = fits.length ? pick(fits) : seams.length ? pick(seams) : Math.min(max, Math.ceil(mid));
  const clip = (t: string) => (t.length <= max ? t : t.slice(0, Math.max(1, max - 1)) + "…");
  return [clip(text.slice(0, at).trim()), clip(text.slice(at).trim())].filter(Boolean);
}

/** One line, cut to fit. Used for the smaller sub-label under each column. */
export const clipLabel = (label: string, max: number) =>
  label.length <= max ? label : label.slice(0, Math.max(1, max - 1)) + "…";

/** The plot floor — y grows downward, so this is the largest y in the plot. */
export const floorY = () => GEO.padT + GEO.plotH;

/** Where a value sits vertically on its own axis. */
export const valueY = (value: number, max: number) =>
  floorY() - Math.max(0, Math.min(1, value / max)) * GEO.plotH;

/** Gridline values for one axis, floor to ceiling. */
export const ticksFor = (max: number) =>
  Array.from({ length: TICKS }, (_, i) => (max * i) / (TICKS - 1));

/**
 * The polyline for one series, split wherever a value is missing.
 *
 * Returns one array per unbroken run. A single line drawn straight across a
 * blank round would assert a trend through a number that was never measured —
 * the one thing this app refuses everywhere else. Looker draws through the gap;
 * this doesn't, because the gap is a fact.
 */
export function lineRuns(points: Point[], max: number): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  const n = points.length;
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([colX(i, n), valueY(p.value, max)]);
  });
  if (run.length) runs.push(run);
  return runs;
}
