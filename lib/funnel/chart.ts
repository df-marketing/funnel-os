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
export type ViewMode = "table" | "graph";
export type ViewOpts = { mode: ViewMode; objective: ObjectiveKey };

/**
 * Attendance, because that is the objective the brief named: "let's say client
 * only cares for attendance then it would be overall attendance". It is a
 * default and not a decision — the picker is one click away and the choice
 * lives in the URL.
 */
export const DEFAULT_OPTS: ViewOpts = { mode: "table", objective: "att" };

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
  return f === "i" ? Math.ceil(nice / 2) * 2 : nice;
}

export type Point = { key: string; label: string; sub: string | null; value: number | null };

export type Panel = {
  role: "input" | "objective" | "efficiency";
  title: string;
  fmt: Fmt;
  points: Point[];
  /** Axis ceiling. Always > 0, so dividing by it is always safe. */
  max: number;
  /** Every value is absent — the panel draws an explanation, not an empty grid. */
  empty: boolean;
};

export type ChartModel = {
  panels: Panel[];
  columns: { key: string; label: string; sub: string | null }[];
  objective: ObjectiveDef;
  /** Cuts that carried no value in any panel. Named under the chart, not hidden. */
  blanks: string[];
};

function panelFor(
  role: Panel["role"], title: string, key: MetricKey, f: Fmt, cuts: Cut[],
): Panel {
  const points: Point[] = cuts.map((c) => ({
    key: c.cut_key,
    label: c.cut_label ?? c.cut_key,
    sub: c.cut_sub ?? null,
    value: num((c.m as Metrics)?.[key]),
  }));
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  return {
    role, title, fmt: f, points,
    max: axisMax(Math.max(0, ...values), f),
    empty: values.length === 0,
  };
}

/**
 * Build the three panels for one tab's columns.
 *
 * The Total column is deliberately NOT passed in by the caller: a total is not
 * a point on a time axis, and plotting it beside the rounds it is made of would
 * put a bar six times the height of the others at the right-hand edge and make
 * every real column unreadable.
 */
export function chartModel(cuts: Cut[], objective: ObjectiveKey): ChartModel {
  const def = OBJECTIVES[objective];
  const panels = [
    panelFor("input", "Ads Spent (SGD)", "spend", "m", cuts),
    panelFor("objective", def.label, def.metric, def.metricFmt, cuts),
    panelFor("efficiency", def.efficiencyLabel, def.efficiency, def.efficiencyFmt, cuts),
  ];
  const blanks = cuts
    .filter((c) => panels.every((p) => p.points.find((q) => q.key === c.cut_key)?.value === null))
    .map((c) => c.cut_label ?? c.cut_key);
  return {
    panels,
    columns: cuts.map((c) => ({ key: c.cut_key, label: c.cut_label ?? c.cut_key, sub: c.cut_sub ?? null })),
    objective: def,
    blanks,
  };
}

/** Cell text, or the same em dash the table uses. One idea of absent. */
export const cell = (v: number | null, f: Fmt): string => (v === null ? "—" : (fmt(v, f) ?? "—"));

// ── Geometry ───────────────────────────────────────────────────────────────
// Fixed drawing constants, in viewBox units. The SVG scales with CSS; these
// never change, so a chart of two columns and a chart of forty are the same
// drawing at different widths rather than two different-looking charts.

export const GEO = {
  padL: 76,      // room for the y-axis labels, which are money and can be wide
  padR: 20,
  padT: 22,      // the panel title sits above the plot
  col: 110,      // one column's full width
  bar: 48,       // the bar inside it, centred
  panelH: 118,   // the plot area only
  gap: 44,       // between panels, enough for the next title
  axisH: 46,     // x labels under the last panel
} as const;

export const chartWidth = (n: number) => GEO.padL + Math.max(1, n) * GEO.col + GEO.padR;
export const chartHeight = () => 3 * (GEO.padT + GEO.panelH) + 2 * GEO.gap + GEO.axisH;

/** Centre of column i, in viewBox x units. */
export const colX = (i: number) => GEO.padL + i * GEO.col + GEO.col / 2;

/** Top edge of panel p's plot area. */
export const panelTop = (p: number) => p * (GEO.padT + GEO.panelH + GEO.gap) + GEO.padT;

/** How far up the plot a value sits, 0 at the baseline. */
export const barH = (value: number, max: number) =>
  Math.max(0, Math.min(1, value / max)) * GEO.panelH;

/**
 * The polyline for the efficiency panel, split wherever a value is missing.
 *
 * Returns one array per unbroken run. A single line drawn straight across a
 * blank round would assert a trend through a number that was never measured —
 * the one thing this app refuses everywhere else.
 */
export function lineRuns(points: Point[], max: number, top: number): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([colX(i), top + GEO.panelH - barH(p.value, max)]);
  });
  if (run.length) runs.push(run);
  return runs;
}

/** Three gridlines: floor, middle, ceiling. More is noise at this size. */
export const ticks = (max: number) => [0, max / 2, max];
