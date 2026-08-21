/**
 * Renders "This round" against synthetic data and prints it as plain text.
 *
 * The CRO screen is mostly prose assembled from numbers, and prose assembled
 * from numbers goes wrong in ways a type checker cannot see: a label lowercased
 * into "cp attendance (sgd)", a sample size printed as a bare "on 14". Both of
 * those were caught here and nowhere else.
 *
 * Runs under scripts/tsconfig.render.json, which turns the automatic JSX
 * runtime on: the app's own tsconfig sets jsx:preserve because Next does that
 * transform, and without Next the components arrive untransformed.
 *
 * Run: npm run render:round
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoundAnalysis } from "../components/RoundAnalysis";
import type { Cut, RoundContext } from "../lib/funnel/data";

const cut = (k: string, period: string, start: string, end: string, m: Record<string, unknown>) =>
  ({ cut_key: k, cut_label: k, cut_sub: null, period, start_date: start, end_date: end, m }) as unknown as Cut;

const cuts: Cut[] = [
  cut("0826-01", "this round", "2026-08-05", "2026-08-18",
      { spend: 2380, leads: 304, att: 81, prevBuy: 14, midBuy: 0, rev: 4158, cpl: 7.83,
        attPct: 26.6, prevPct: 17.3, roas: 3.0, ctr: 1.52, leadgen: 25.8, clicks: 1180, impr: 248692, cpAtt: 29.4, cpa: 170 }),
  cut("0726-03", "previous", "2026-07-24", "2026-07-28",
      { spend: 1752, leads: 132, att: 29, prevBuy: 6, midBuy: 2, rev: 4200, cpl: 13.27,
        attPct: 21.7, prevPct: 18.5, roas: 2.4, ctr: 1.71, clicks: 940, impr: 190000, cpAtt: 60.4, cpa: 292 }),
];
const baseline = cut("BASE", "baseline", "", "", { cpl: 13.27, attPct: 21.7, prevPct: 18.5, roas: 2.1, leads: 180, spend: 1900, att: 40 });

const A = (round: string, name: string, spend: number | null, leads: number, share: number | null,
           att = 0, prev_buys = 0, rev = 0) =>
  ({ round_id: round, kind: "audience" as const, name, spend, leads, spend_share: share,
     att, prev_buys, rev });

const context: RoundContext = {
  months: [
    cut("2026-07", "", "", "", { spend: 5100, leads: 380, att: 92, rev: 9800, cpl: 13.4, roas: 1.9 }),
    cut("2026-08", "", "", "", { spend: 2380, leads: 304, att: 81, rev: 4158, cpl: 7.83, roas: 3.0 }),
  ],
  assets: [
    A("0826-01", "Cold_Broad", 900, 120, 37.8, 40, 8, 2376),
    A("0826-01", "Cold_CorporateTrainers", 600, 0, 25.2, 0, 0, 0),
    A("0826-01", "Cold_NewTest", 480, 12, 20.2, 0, 0, 0),
    A("0826-01", "Cold_Consultants", 400, 60, 16.8, 41, 6, 1782),
    A("0726-03", "Cold_Broad", 300, 40, 17.1),
    A("0726-03", "Cold_CorporateTrainers", 700, 30, 40.0),
    A("0726-03", "Cold_Consultants", 400, 40, 22.8),
    A("0726-03", "Cold_Retired", 352, 22, 20.1),
  ],
  targets: { cpl: 9, attPct: 30, roas: 2.5 },
  /**
   * The real curve out of Shely's Clarity export, on the renderer's round.
   *
   * 58 sessions against this round's 1,180 clicks is 4.9% coverage, so the
   * panel should call it a sample — the case that will actually be on screen,
   * and the one most likely to be read as if it described the whole round.
   */
  scroll: [{
    run_id: "run-1", round_id: "0826-01", page_label: "Shely's Landing Page",
    device: "mobile", sessions: 58, page_views: 60,
    captured_from: "2026-08-06", captured_to: "2026-08-08",
    points: [
      { depth: 5, visitors: 55, drop_off_pct: 5.17 },
      { depth: 10, visitors: 35, drop_off_pct: 39.66 },
      { depth: 15, visitors: 34, drop_off_pct: 41.38 },
      { depth: 20, visitors: 32, drop_off_pct: 44.83 },
      { depth: 25, visitors: 31, drop_off_pct: 46.55 },
      { depth: 30, visitors: 31, drop_off_pct: 46.55 },
      { depth: 35, visitors: 30, drop_off_pct: 48.28 },
      { depth: 40, visitors: 29, drop_off_pct: 50 },
      { depth: 45, visitors: 29, drop_off_pct: 50 },
      { depth: 50, visitors: 28, drop_off_pct: 51.72 },
      { depth: 55, visitors: 28, drop_off_pct: 51.72 },
      { depth: 60, visitors: 28, drop_off_pct: 51.72 },
      { depth: 65, visitors: 28, drop_off_pct: 51.72 },
      { depth: 70, visitors: 27, drop_off_pct: 53.45 },
      { depth: 75, visitors: 27, drop_off_pct: 53.45 },
      { depth: 80, visitors: 27, drop_off_pct: 53.45 },
      { depth: 85, visitors: 27, drop_off_pct: 53.45 },
      { depth: 90, visitors: 26, drop_off_pct: 55.17 },
      { depth: 95, visitors: 26, drop_off_pct: 55.17 },
      { depth: 100, visitors: 15, drop_off_pct: 74.14 },
    ],
  }],
};

for (const [name, ctx, obj] of [
  ["with targets", context, "att"],
  ["no targets", { ...context, targets: {} }, "rev"],
  // The default state of every round in the database: nothing measured. It has
  // to read as an open question, not as a broken panel.
  ["no clarity export", { ...context, scroll: [] }, "att"],
  ["objective = revenue", context, "rev"],
  ["objective = preview purchases", context, "prevBuy"],
] as const) {
  const html = renderToStaticMarkup(
    React.createElement(RoundAnalysis, {
      cuts, baseline, context: ctx, objective: obj, today: "2026-08-10",
    }),
  );
  const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, "'").replace(/\s+/g, " ").trim();
  console.log(`\n═══ ${name} · objective=${obj} ═══\n`);
  console.log(text);
}
