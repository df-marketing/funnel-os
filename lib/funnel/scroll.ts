/**
 * Scroll depth read against Lead Gen %.
 *
 * These are two independent measurements of the same population and neither one
 * can be checked on its own:
 *
 *   Clarity   of the sessions that reached the page, this share got this far down
 *   Funnel OS of the clicks that left the ad, this share opted in
 *
 * Lead Gen % is leads ÷ OUTBOUND CLICKS — see v_metrics_*, it has been that
 * since 0003 — which makes the denominators the same population read at the
 * same moment: a click is someone arriving on the page, a Clarity session is
 * someone arriving on the page. That is the whole reason these two numbers can
 * be put beside each other, and it is worth stating because a scroll curve read
 * against leads-per-lead-or-per-impression would be meaningless.
 *
 * The one claim worth making from the pair is a CONSTRAINT, not a rate:
 * everybody who opted in had to reach the form first, so retention at the
 * form's depth can never be below Lead Gen %. That bounds where the form can
 * be, and — when the bound is violated — proves one of the two numbers wrong.
 * Everything else here is descriptive: where the audience is lost, and how much
 * of the round Clarity actually watched.
 */

import { MIN_SAMPLE } from "./analysis";

export type ScrollPoint = { depth: number; visitors: number; drop_off_pct: number | null };

/** One imported Clarity export, with its curve. */
export type ScrollRun = {
  run_id: string;
  round_id: string;
  page_label: string | null;
  device: string;
  sessions: number;
  page_views: number | null;
  captured_from: string | null;
  captured_to: string | null;
  points: ScrollPoint[];
};

export type CurvePoint = {
  depth: number;
  visitors: number;
  /** Share of sessions still on the page at this depth. */
  pct: number;
  /** Points of the audience lost since the reading above this one. */
  lostPts: number;
  lost: number;
};

/**
 * Clarity's sample is a sample. Below this share of the round's clicks it is
 * described as one rather than read as the round — half is the point at which
 * "most of the traffic" stops being true.
 */
export const THIN_COVERAGE_PCT = 50;

/** A fall worth naming. Smaller steps are the ordinary shape of a long page. */
export const BIG_DROP_PTS = 10;

export const pctOf = (n: number, of: number): number | null =>
  of > 0 ? (n * 100) / of : null;

/** The curve as shares, with each step's loss attached to the step. */
export function curveOf(points: ScrollPoint[], sessions: number): CurvePoint[] {
  const sorted = [...points].sort((a, b) => a.depth - b.depth);
  let prev = sessions;
  return sorted.map((p) => {
    const lost = prev - p.visitors;
    const out: CurvePoint = {
      depth: p.depth,
      visitors: p.visitors,
      pct: pctOf(p.visitors, sessions) ?? 0,
      lost,
      lostPts: pctOf(lost, sessions) ?? 0,
    };
    prev = p.visitors;
    return out;
  });
}

/**
 * The single worst step, and where it is.
 *
 * The first reading's loss counts: Clarity's shallowest band is 5% of page
 * height, so "lost before 5%" is people who arrived and left without the page
 * moving at all. That is the most actionable band on the whole curve and
 * starting the comparison at the second reading would hide it.
 */
export function biggestDrop(curve: CurvePoint[]): CurvePoint | null {
  if (!curve.length) return null;
  return curve.reduce((worst, p) => (p.lostPts > worst.lostPts ? p : worst), curve[0]);
}

export type Ceiling =
  | { kind: "bounded"; depth: number; pct: number; leadGen: number }
  | { kind: "unbounded"; depth: number; pct: number; leadGen: number }
  | { kind: "impossible"; depth: number; pct: number; leadGen: number }
  | { kind: "unknown" };

/**
 * How far down the page the opt-in form can possibly be.
 *
 * Nobody opts in from a part of the page they never saw, so at the form's depth
 * the share still reading must be at least the share that converted. The
 * deepest reading that clears Lead Gen % is therefore an upper bound on where
 * the form sits — a fact derived from two numbers neither of which knows where
 * the form is.
 *
 * Three outcomes, and the third is the valuable one:
 *   bounded     the form is at or above this depth
 *   unbounded   even the last reading clears it — scroll is not the constraint
 *   impossible  not even the FIRST reading clears it, so more people converted
 *               than ever scrolled. One of the two sources is wrong; the screen
 *               says so instead of drawing a conclusion from it.
 */
export function ceilingOf(curve: CurvePoint[], leadGen: number | null): Ceiling {
  if (leadGen === null || !curve.length) return { kind: "unknown" };

  const deepest = curve.filter((p) => p.pct >= leadGen).sort((a, b) => b.depth - a.depth)[0];
  if (!deepest) {
    const top = curve[0];
    return { kind: "impossible", depth: top.depth, pct: top.pct, leadGen };
  }
  const last = curve[curve.length - 1];
  const kind = deepest.depth === last.depth ? "unbounded" : "bounded";
  return { kind, depth: deepest.depth, pct: deepest.pct, leadGen };
}

export type Coverage = {
  sessions: number;
  clicks: number | null;
  /** Sessions as a share of the round's clicks. Null when clicks are absent. */
  pct: number | null;
  /** Under MIN_SAMPLE sessions, or well under the round's clicks. */
  thin: boolean;
  /** Clarity counted more sessions than the ad account counted clicks. */
  over: boolean;
};

/**
 * How much of the round Clarity was actually watching.
 *
 * A curve measured on 58 sessions describes a round that bought 377 clicks
 * perfectly well — as a sample. It stops describing it when the sample is
 * small enough that a single unusual visit moves a band, which is the same
 * MIN_SAMPLE line the round comparison already draws at 30.
 *
 * `over` is its own case rather than a big number: more sessions than clicks
 * means the page has traffic the ad account did not buy — organic, direct, a
 * second campaign — and the curve then describes a wider audience than Lead
 * Gen %'s denominator does. Worth knowing, not an error.
 */
export function coverageOf(sessions: number, clicks: number | null): Coverage {
  const pct = clicks !== null ? pctOf(sessions, clicks) : null;
  return {
    sessions,
    clicks,
    pct,
    thin: sessions < MIN_SAMPLE || (pct !== null && pct < THIN_COVERAGE_PCT),
    over: pct !== null && pct > 100,
  };
}

export type ScrollRead = {
  run: ScrollRun;
  curve: CurvePoint[];
  worst: CurvePoint | null;
  ceiling: Ceiling;
  coverage: Coverage;
  /** Share of sessions gone before the shallowest reading — arrived and left. */
  bouncedPts: number;
};

/** Everything the screen needs about one run, computed once. */
export function readRun(run: ScrollRun, leadGen: number | null, clicks: number | null): ScrollRead {
  const curve = curveOf(run.points, run.sessions);
  return {
    run,
    curve,
    worst: biggestDrop(curve),
    ceiling: ceilingOf(curve, leadGen),
    coverage: coverageOf(run.sessions, clicks),
    bouncedPts: curve[0]?.lostPts ?? 0,
  };
}

/**
 * The run that describes a round, when more than one does.
 *
 * Device exports are separate files, so a round can hold a mobile curve and a
 * desktop one. They are not summable — two curves over different denominators
 * average into a number that describes nobody — so the screen shows each on its
 * own and this only decides which is read first: the largest sample, because it
 * is the one whose bands mean the most.
 */
export function runsFor(runs: ScrollRun[], roundId: string): ScrollRun[] {
  return runs
    .filter((r) => r.round_id === roundId)
    .sort((a, b) => b.sessions - a.sessions || a.device.localeCompare(b.device));
}
