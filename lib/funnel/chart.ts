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
 * The input is always ad spend — that half of the question never changes. What
 * you read it AGAINST does: the objective's own level, or what a unit of it
 * cost. Two lines, because a third would need a third axis, and three axes on
 * one plot is a puzzle rather than a chart.
 */
export type Against = "objective" | "efficiency";
export const AGAINST_KEYS: Against[] = ["objective", "efficiency"];

export type ViewMode = "table" | "graph";
export type ViewOpts = { mode: ViewMode; objective: ObjectiveKey; against: Against };

/**
 * Attendance, because that is the objective the brief named: "let's say client
 * only cares for attendance then it would be overall attendance". It is a
 * default and not a decision — the picker is one click away and the choice
 * lives in the URL.
 */
export const DEFAULT_OPTS: ViewOpts = { mode: "table", objective: "att", against: "efficiency" };

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
  objective: ObjectiveDef;
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
export function chartModel(cuts: Cut[], objective: ObjectiveKey, against: Against): ChartModel {
  const def = OBJECTIVES[objective];
  const left = seriesFor("input", "left", "Ads Spent (SGD)", "spend", "m", cuts);
  const right =
    against === "objective"
      ? seriesFor("against", "right", def.label, def.metric, def.metricFmt, cuts)
      : seriesFor("against", "right", def.efficiencyLabel, def.efficiency, def.efficiencyFmt, cuts);

  const blanks = cuts
    .filter((c) =>
      [left, right].every((s) => s.points.find((q) => q.key === c.cut_key)?.value === null))
    .map((c) => c.cut_label ?? c.cut_key);

  return {
    left, right,
    columns: cuts.map((c) => ({ key: c.cut_key, label: c.cut_label ?? c.cut_key, sub: c.cut_sub ?? null })),
    objective: def,
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
  col: 118,      // one column's full width
  plotH: 300,
  axisH: 52,     // x labels, and their sub-labels
} as const;

export const chartWidth = (n: number) => GEO.padL + Math.max(1, n) * GEO.col + GEO.padR;
export const chartHeight = () => GEO.padT + GEO.plotH + GEO.axisH;

/** Centre of column i, in viewBox x units. */
export const colX = (i: number) => GEO.padL + i * GEO.col + GEO.col / 2;

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
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([colX(i), valueY(p.value, max)]);
  });
  if (run.length) runs.push(run);
  return runs;
}
