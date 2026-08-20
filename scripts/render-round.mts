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
        attPct: 26.6, prevPct: 17.3, roas: 3.0, ctr: 1.52, clicks: 1180, impr: 248692, cpAtt: 29.4, cpa: 170 }),
  cut("0726-03", "previous", "2026-07-24", "2026-07-28",
      { spend: 1752, leads: 132, att: 29, prevBuy: 6, midBuy: 2, rev: 4200, cpl: 13.27,
        attPct: 21.7, prevPct: 18.5, roas: 2.4, ctr: 1.71, clicks: 940, impr: 190000, cpAtt: 60.4, cpa: 292 }),
];
const baseline = cut("BASE", "baseline", "", "", { cpl: 13.27, attPct: 21.7, prevPct: 18.5, roas: 2.1, leads: 180, spend: 1900, att: 40 });

const A = (round: string, name: string, spend: number | null, leads: number, share: number | null) =>
  ({ round_id: round, kind: "audience" as const, name, spend, leads, spend_share: share });

const context: RoundContext = {
  months: [
    cut("2026-07", "", "", "", { spend: 5100, leads: 380, att: 92, rev: 9800, cpl: 13.4, roas: 1.9 }),
    cut("2026-08", "", "", "", { spend: 2380, leads: 304, att: 81, rev: 4158, cpl: 7.83, roas: 3.0 }),
  ],
  assets: [
    A("0826-01", "Cold_Broad", 900, 120, 37.8),
    A("0826-01", "Cold_CorporateTrainers", 600, 0, 25.2),
    A("0826-01", "Cold_NewTest", 480, 12, 20.2),
    A("0826-01", "Cold_Consultants", 400, 60, 16.8),
    A("0726-03", "Cold_Broad", 300, 40, 17.1),
    A("0726-03", "Cold_CorporateTrainers", 700, 30, 40.0),
    A("0726-03", "Cold_Consultants", 400, 40, 22.8),
    A("0726-03", "Cold_Retired", 352, 22, 20.1),
  ],
  targets: { cpl: 9, attPct: 30, roas: 2.5 },
};

for (const [name, ctx, obj] of [
  ["with targets", context, "att"],
  ["no targets", { ...context, targets: {} }, "rev"],
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
