/**
 * Step 3, walked down the funnel: which STEP broke, and where to look first.
 *
 * analysis.ts already says which metrics got worse. That is a list of numbers,
 * and a list of numbers is not a diagnosis — "Lead Gen % fell 14%" and "CTR fell
 * 14%" read identically on a screen and mean two completely different jobs of
 * work. What turns one into the other is knowing that every rate sits BETWEEN
 * two stages, and that the thing to go and look at is upstream of the rate.
 *
 * The rule this file encodes, in the words it was given in:
 *
 *   "Analyse the stage of the funnel that has issue. If clicks stage is the
 *    issue, check ads performance. If ads hasn't changed even though numbers
 *    changed, check funnel stages above clicks, which is the ad targeting."
 *
 * So each broken step gets an ORDERED list of places to look, and each place
 * carries the evidence that either implicates it or clears it. A place with no
 * change is not silence — it is the finding that sends you one stage further up.
 *
 * Two rules inherited from analysis.ts, and for the same reasons:
 *
 *   - A rate on a thin denominator is reported and never ranked. `Move.thin`
 *     already carries that; this file passes it through and never overrides it.
 *   - A number nobody measured is never compared. A step this app cannot see
 *     into is marked `blind` and says so, rather than reporting "no change
 *     found" — which would read as evidence of innocence when it is only
 *     evidence of not having looked.
 *
 * No React and no next/cache, so all of it can be tested.
 */

import type { MetricKey, Metrics } from "./spine";
import { SPINE, fmt, isGroup } from "./spine";
import { compare, diffAssets, MATERIAL_PCT, type Asset, type AssetChange, type Move } from "./analysis";

/** The six journey metrics, as client_journey_config names them. */
export type JourneyMetric =
  | "impressions" | "clicks" | "leads"
  | "attendance" | "preview_purchases" | "middle_purchases";

/** One configured stage, as the journey stores it. */
export type StageRef = {
  order: number;
  slug: string;
  name: string;
  metric: JourneyMetric;
};

/** Somewhere a person can go and look, ordered by where to look FIRST. */
export type LookWhere = "creative" | "audience" | "landing-page";

export type Look = {
  where: LookWhere;
  /** Why this place, in the terms of the step that broke. */
  because: string;
  /** What actually changed here. Empty means nothing did — itself a finding. */
  changed: AssetChange[];
  /**
   * False when this app holds no evidence either way — no Clarity export for
   * the landing page, no 0033 columns for the assets. Distinct from an empty
   * `changed`, which means we looked and nothing had moved.
   */
  measured: boolean;
};

export type Step = {
  from: StageRef;
  to: StageRef;
  /** The rate between them. Null when this pair is not a known transition. */
  rate: MetricKey | null;
  rateLabel: string | null;
};

export type Diagnosis = {
  step: Step;
  /** The rate's own comparison — carries verdict, deltaPct, thin, sample. */
  move: Move | null;
  /** Where to look, first place first. Empty when the step is blind. */
  look: Look[];
  /**
   * The one place this points at: the first with something that changed, or —
   * when nothing changed anywhere — the LAST place, because "the ads are the
   * same" is exactly what sends you up to the targeting.
   */
  pointsAt: LookWhere | null;
  /** True when nothing changed at any place we could see. Rule 3's second half. */
  nothingChanged: boolean;
  /** True when this app cannot see into this step at all. */
  blind: boolean;
};

/**
 * Which rate sits between which two stages, and where to look when it falls.
 *
 * Keyed on the metric PAIR rather than on slugs, because slugs are the client's
 * to name — Shely's fourth stage is 'class', another client's might be 'webinar'
 * — while the metric is a fixed six-case set the whole app agrees on.
 *
 * The order inside `look` is the diagnosis. For CTR it is creative-then-audience
 * because the creative is what a person reacts to; the audience only decides who
 * got the chance to react. Reversing it would send someone to rebuild targeting
 * over an ad they had swapped out the day before.
 */
const TRANSITIONS: Record<string, { rate: MetricKey; look: LookWhere[] }> = {
  "impressions>clicks": { rate: "ctr", look: ["creative", "audience"] },
  "clicks>leads": { rate: "leadgen", look: ["landing-page", "audience"] },
  "leads>attendance": { rate: "attPct", look: ["audience"] },
  "attendance>preview_purchases": { rate: "prevPct", look: ["audience"] },
  // Nothing in v_round_assets counts middle-offer purchases per asset, so no
  // audience can be credited or blamed for this one. Blind, and says so.
  "preview_purchases>middle_purchases": { rate: "midPct", look: [] },
};

/** Why each place, phrased for the step that sent you there. */
const BECAUSE: Record<LookWhere, Record<string, string>> = {
  creative: {
    ctr: "the creative is what a person reacts to — a new ad, or a dropped one, moves CTR before anything else does",
  },
  audience: {
    ctr: "the ads are the same, so what changed is who was shown them",
    leadgen: "the page is the same, so what changed is who arrived on it",
    attPct: "these audiences brought the leads that did not turn up",
    prevPct: "these audiences brought the attendees who did not buy",
  },
  "landing-page": {
    leadgen: "the click landed and the opt-in did not follow, which is the page's own job",
  },
};

const LABELS = new Map<MetricKey, string>(
  SPINE.filter((r) => !isGroup(r)).map((r) => {
    const row = r as { key: MetricKey; label: string };
    return [row.key, row.label];
  }),
);

/** Consecutive pairs of the configured journey, in stage order. */
export function stepsOf(stages: StageRef[]): Step[] {
  const ordered = [...stages].sort((a, b) => a.order - b.order);
  const out: Step[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    const t = TRANSITIONS[`${from.metric}>${to.metric}`];
    out.push({
      from,
      to,
      rate: t?.rate ?? null,
      rateLabel: t ? (LABELS.get(t.rate) ?? t.rate) : null,
    });
  }
  return out;
}

/**
 * Every step of the funnel, diagnosed.
 *
 * Returned whole and in funnel order rather than filtered to the broken ones,
 * because "CTR held and Lead Gen % fell" is a different story from "Lead Gen %
 * fell" alone, and the caller cannot reconstruct the first from the second. The
 * caller filters; this decides nothing about what is worth showing.
 *
 * `scrollRuns` is how many landing-page scroll curves were imported for this
 * round. Zero does not mean the page was fine — it means nobody measured it,
 * which is what `measured: false` says.
 */
export function diagnose(args: {
  stages: StageRef[];
  now: Metrics | null;
  prev: Metrics | null;
  base: Metrics | null;
  targets?: Record<string, number>;
  assetsNow: Asset[];
  assetsPrev: Asset[];
  scrollRuns?: number;
}): Diagnosis[] {
  const { stages, now, prev, base, targets = {}, assetsNow, assetsPrev, scrollRuns = 0 } = args;
  const changes = diffAssets(assetsNow, assetsPrev);

  /**
   * Whether the asset rows can speak to an outcome at all. A database that has
   * not run 0033 returns assets without `att`/`prev_buys`, and reading that
   * absence as "nothing changed" would clear an audience this app never checked.
   */
  const assetsMeasured = assetsNow.length > 0 || assetsPrev.length > 0;

  return stepsOf(stages).map((step): Diagnosis => {
    const t = step.rate ? TRANSITIONS[`${step.from.metric}>${step.to.metric}`] : null;
    const move = step.rate ? compare(step.rate, now, prev, base, targets[step.rate] ?? null) : null;

    if (!t || !t.look.length) {
      return { step, move, look: [], pointsAt: null, nothingChanged: false, blind: true };
    }

    const look: Look[] = t.look.map((where) => {
      const measured = where === "landing-page" ? scrollRuns > 0 : assetsMeasured;
      return {
        where,
        because: BECAUSE[where]?.[step.rate as string] ?? `worth checking against the ${step.from.name} stage`,
        // The landing page has no asset rows of its own; its evidence is the
        // scroll curve, which lives outside this diff. Empty here is correct.
        changed: where === "landing-page"
          ? []
          : changes.filter((c) => c.kind === (where === "creative" ? "creative" : "audience")),
        measured,
      };
    });

    const anyMeasured = look.some((l) => l.measured);
    const withChange = look.find((l) => l.changed.length > 0);
    const nothingChanged = anyMeasured && !withChange;

    return {
      step,
      move,
      look,
      // Nothing changed anywhere we could see → the last place is where rule 3
      // sends you: past the thing that stayed the same, to the stage above it.
      pointsAt: withChange?.where ?? (anyMeasured ? look[look.length - 1].where : null),
      nothingChanged,
      blind: !anyMeasured,
    };
  });
}

/**
 * The steps that actually broke, worst first.
 *
 * Same floors as issuesIn(): worse than last time by enough to be a move rather
 * than noise, and resting on a count big enough to act on. A step whose rate is
 * thin is left out of THIS list and still present in the full one, so it can be
 * reported without being ranked.
 */
export const brokenSteps = (all: Diagnosis[]) =>
  all
    .filter((d) => d.move?.verdict === "worse" && !d.move.thin
      && (d.move.deltaPct === null || Math.abs(d.move.deltaPct) >= MATERIAL_PCT))
    .sort((a, b) => Math.abs(b.move?.deltaPct ?? 0) - Math.abs(a.move?.deltaPct ?? 0));

/**
 * One line a person can read, per broken step.
 *
 * Deliberately states the evidence and stops. It does not say "cut this
 * audience" — that is a decision about money, and analysis.ts already draws
 * that line for step 7. What this gives the reader is where to go and look.
 */
export function explainStep(d: Diagnosis): string {
  const rate = d.step.rateLabel ?? `${d.step.from.name} → ${d.step.to.name}`;
  const delta = d.move?.deltaPct;
  /**
   * No percentage means the previous figure was zero or absent, and "moved" is
   * the least informative word available for the case that most needs one — a
   * step going 0% → 12% is the whole story of that period. Name both numbers
   * instead, the same way moveChip() prints "▲ from 0" rather than a dash.
   */
  const moved = delta !== null && delta !== undefined
    ? `${delta < 0 ? "fell" : "rose"} ${Math.abs(delta).toFixed(1)}%`
    : d.move
      ? `went from ${fmt(d.move.prev, d.move.fmt) ?? "no reading"} to ${fmt(d.move.now, d.move.fmt) ?? "no reading"}`
      : "moved";
  const between = `between ${d.step.from.name} and ${d.step.to.name}`;

  if (d.blind) {
    return `${rate} ${moved} ${between}. Nothing in this app breaks that step down, so there is no evidence here either way.`;
  }

  /**
   * One side of the comparison is absent, so there is no move to describe.
   *
   * Checked before `thin` and before the verdict, because compare() returns
   * "unknown" here and every later branch reads a non-worse verdict as good
   * news: June's Attendance % went from 12.78% to nothing measured and came
   * back as "worth keeping". Absent is not zero and it is certainly not a win.
   */
  if (d.move && d.move.verdict === "unknown") {
    const missing = d.move.now === null ? "this period" : "the period before";
    return `${rate} has no reading for ${missing} ${between}, so it cannot be called better or worse.`;
  }

  if (d.move?.thin) {
    return `${rate} ${moved} ${between}, on ${d.move.sample ?? 0} ${d.move.sampleOf ?? "records"} — reported, not ranked.`;
  }
  const place = d.pointsAt === "creative" ? "the creatives"
    : d.pointsAt === "audience" ? "the audiences"
    : "the landing page";
  const n = d.look.find((l) => l.where === d.pointsAt)?.changed.length ?? 0;
  const noun = d.pointsAt === "creative" ? "creative" : "audience";

  /**
   * A step that held or improved is not a place to go and look, and phrasing it
   * as one turns a win into a worry. 0526-03 raised CTR after four creatives
   * were swapped; "start at the creatives" made the round's one clear success
   * read as its problem. Same evidence, opposite sentence.
   */
  if (d.move?.verdict !== "worse") {
    if (d.move?.verdict === "flat") return `${rate} held ${between}.`;
    return n > 0
      ? `${rate} ${moved} ${between}, after ${n} ${noun}${n === 1 ? "" : "s"} changed — worth keeping.`
      : `${rate} ${moved} ${between}, with no ${noun} changed.`;
  }

  if (d.nothingChanged) {
    const same = d.look[0]?.where === "creative" ? "the ads are the same"
      : d.look[0]?.where === "landing-page" ? "the page is the same"
      : "nothing was swapped";
    return `${rate} ${moved} ${between}, and ${same} — so look at ${place}.`;
  }
  return `${rate} ${moved} ${between}, and ${n} ${noun}${n === 1 ? "" : "s"} changed — start at ${place}.`;
}

/**
 * The one sentence that goes at the top: did the funnel break, or did it not?
 *
 * This is the distinction the whole report format turns on, and it is the one
 * thing a list of movements cannot say on its own. 0526-03 lost 18% of its
 * leads while every single conversion rate held or improved — the funnel was
 * fine and the delivery shrank. A deck that opened with "leads down 18%" and a
 * page of rate tables would have sent someone to fix a page that was working.
 *
 * Stated only where the arithmetic carries it. No step broke AND volume fell is
 * a fact about two numbers; why the delivery shrank is not, so it stops there.
 */
export type FunnelVerdict = {
  anyStepBroke: boolean;
  /** The step to start on. Null when none broke. */
  worst: { from: string; to: string; rate: MetricKey | null } | null;
  reading: string;
};

export function verdictOf(all: Diagnosis[], moves: Move[]): FunnelVerdict {
  /**
   * Nothing behind it. "No step got materially worse" is true of a first round
   * and reads as a finding, when what actually happened is that no comparison
   * was possible — the difference between a clean bill of health and an empty
   * examination room.
   */
  if (moves.length && moves.every((m) => m.prev === null)) {
    return {
      anyStepBroke: false,
      worst: null,
      reading: "This is the first period on record — there is nothing behind it to compare against, so no step can be called better or worse.",
    };
  }

  const broken = brokenSteps(all);
  const by = (k: MetricKey) => moves.find((m) => m.key === k) ?? null;
  const pct = (m: Move | null) => (m?.deltaPct ?? null);
  const say = (m: Move | null) =>
    pct(m) === null ? null : `${m!.label} ${pct(m)! < 0 ? "down" : "up"} ${Math.abs(pct(m)!).toFixed(1)}%`;

  if (broken.length) {
    const w = broken[0];
    return {
      anyStepBroke: true,
      worst: { from: w.step.from.name, to: w.step.to.name, rate: w.step.rate },
      reading: explainStep(w),
    };
  }

  /**
   * Nothing broke. If the objective's own volume fell anyway, the cause is
   * upstream of the funnel — fewer people entered it — and the numbers that
   * describe that are impressions, spend and CPM. Named, not interpreted.
   */
  const fell = [by("leads"), by("att"), by("prevBuy")]
    .find((m) => m && m.verdict === "worse" && !m.thin
      && (m.deltaPct === null || Math.abs(m.deltaPct) >= MATERIAL_PCT));

  if (fell) {
    const upstream = [say(by("impr")), say(by("spend")), say(by("cpm"))].filter(Boolean);
    return {
      anyStepBroke: false,
      worst: null,
      reading:
        `No step of the funnel got materially worse — every conversion rate held or improved. ` +
        `${fell.label} still fell ${Math.abs(fell.deltaPct ?? 0).toFixed(1)}%, so the change is upstream of the funnel` +
        (upstream.length ? `: ${upstream.join(", ")}.` : "."),
    };
  }

  return {
    anyStepBroke: false,
    worst: null,
    reading: "No step of the funnel got materially worse.",
  };
}
