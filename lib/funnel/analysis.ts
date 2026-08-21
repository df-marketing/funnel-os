/**
 * The CRO process, as arithmetic.
 *
 *   1. By month to date
 *   2. By week or round, with the variables recorded
 *   3. If a rate fell — new ad? budget moved? targeting changed? section changed?
 *   4. Findings: goal metric amount
 *   5. Results: metrics with issues
 *   6. Hypothesis: why
 *   7. Solution: things to test next round
 *
 * Steps 1–5 are computable and are computed here. Step 6 is a claim about CAUSE
 * and step 7 is a decision about MONEY; neither is the app's to make, so what it
 * produces for those is a shortlist of candidates with the evidence attached,
 * labelled as candidates. A dashboard that writes the hypothesis for you is a
 * dashboard that gets believed when it is wrong.
 *
 * Two rules run through everything:
 *
 *   - A number nobody measured is never compared. Absent stays absent.
 *   - A rate on a thin denominator is reported and never ranked. Preview take-up
 *     on 6 attendees moves 16 points if one more person buys, and the mockup's
 *     own footer promises not to call a winner on fewer than 30.
 *
 * No React and no next/cache, so all of it can be tested.
 */

import type { Metrics, MetricKey, Fmt } from "./spine";
import { SPINE, isGroup } from "./spine";
import { num, OBJECTIVES, type ObjectiveKey } from "./chart";

/** Which way is good. `neutral` metrics are reported and never judged. */
export type Direction = "up" | "down" | "neutral";

export const DIRECTION: Record<MetricKey, Direction> = {
  // volume — bigger is better, but spend and delivery are inputs, not results
  spend: "neutral", reach: "neutral", freq: "neutral", impr: "neutral", clicks: "neutral",
  leads: "up", att: "up", prevBuy: "up", midBuy: "up",
  prevRev: "up", midRev: "up", rev: "up",
  prevPrice: "neutral", midPrice: "neutral",
  // rates — all of them want to go up
  ctr: "up", leadgen: "up", attPct: "up", prevPct: "up", midPct: "up",
  // costs go down, returns go up
  cpm: "down", cpc: "down", cpl: "down", cpAtt: "down", cpa: "down",
  prevAov: "up", midAov: "up",
  prevRoas: "up", midRoas: "up", roas: "up",
};

/**
 * What each derived metric was computed FROM, so its confidence can be judged.
 *
 * A metric with no entry here is a count of something and is as solid as the
 * count. A metric with one is a ratio, and a ratio is only worth acting on when
 * the thing underneath it is big enough to survive one more person changing
 * their mind.
 */
export const DENOM: Partial<Record<MetricKey, MetricKey>> = {
  ctr: "impr", cpm: "impr", cpc: "clicks", leadgen: "clicks",
  attPct: "leads", cpl: "leads",
  prevPct: "att", cpAtt: "att",
  midPct: "prevBuy", cpa: "prevBuy", prevAov: "prevBuy", prevRoas: "prevBuy",
  midAov: "midBuy", midRoas: "midBuy",
  roas: "prevBuy",
};

/** Below this, a rate is reported and never ranked. The mockup's own promise. */
export const MIN_SAMPLE = 30;
/** Smaller than this either way and the metric did not move, it wobbled. */
export const FLAT_PCT = 2;
/** At or past this, a move is worth a line on the screen. */
export const MATERIAL_PCT = 10;

export type Verdict = "better" | "worse" | "flat" | "unknown";

export type Move = {
  key: MetricKey;
  label: string;
  fmt: Fmt;
  direction: Direction;
  now: number | null;
  prev: number | null;
  base: number | null;
  target: number | null;
  /** Change against the previous period, in percent. Null when it can't be one. */
  deltaPct: number | null;
  /** Distance from target, in percent of target. Null when no target is set. */
  vsTargetPct: number | null;
  verdict: Verdict;
  /** The count this rate rests on, and whether that count is enough. */
  sample: number | null;
  /** What that count IS — "14" means nothing without "Preview Offer Purchases". */
  sampleOf: string | null;
  thin: boolean;
};

const LABELS = new Map<MetricKey, { label: string; fmt: Fmt }>(
  SPINE.filter((r) => !isGroup(r)).map((r) => {
    const row = r as { key: MetricKey; label: string; fmt: Fmt };
    return [row.key, { label: row.label, fmt: row.fmt }];
  }),
);

/**
 * One metric, this period against the last, the baseline, and any target.
 *
 * A percentage change needs something to be a percentage OF, so a move from
 * absent or from zero reports no percentage rather than infinity — the numbers
 * are both still shown and the reader can see what happened.
 */
export function compare(
  key: MetricKey,
  now: Metrics | null,
  prev: Metrics | null,
  base: Metrics | null,
  target: number | null,
): Move {
  const meta = LABELS.get(key) ?? { label: key, fmt: "d2" as Fmt };
  const direction = DIRECTION[key] ?? "neutral";
  const n = num(now?.[key]);
  const p = num(prev?.[key]);
  const b = num(base?.[key]);

  const denomKey = DENOM[key];
  const sample = denomKey ? num(now?.[denomKey]) : null;
  const thin = denomKey !== undefined && (sample === null || sample < MIN_SAMPLE);

  const deltaPct = n !== null && p !== null && p !== 0 ? ((n - p) / Math.abs(p)) * 100 : null;
  const vsTargetPct = n !== null && target !== null && target !== 0
    ? ((n - target) / Math.abs(target)) * 100
    : null;

  let verdict: Verdict = "unknown";
  if (n === null || p === null) verdict = "unknown";
  else if (direction === "neutral") verdict = "flat";
  else if (deltaPct === null) verdict = n === p ? "flat" : direction === "up"
    ? (n > p ? "better" : "worse")
    : (n < p ? "better" : "worse");
  else if (Math.abs(deltaPct) < FLAT_PCT) verdict = "flat";
  else verdict = (direction === "up" ? deltaPct > 0 : deltaPct < 0) ? "better" : "worse";

  return {
    key, ...meta, direction, now: n, prev: p, base: b, target,
    deltaPct, vsTargetPct, verdict, sample,
    sampleOf: denomKey ? (LABELS.get(denomKey)?.label ?? denomKey) : null,
    thin,
  };
}

/** Every spine metric, compared. The screen decides which of them to show. */
export function movesFor(
  now: Metrics | null,
  prev: Metrics | null,
  base: Metrics | null,
  targets: Record<string, number> = {},
): Move[] {
  return SPINE.filter((r) => !isGroup(r)).map((r) => {
    const key = (r as { key: MetricKey }).key;
    return compare(key, now, prev, base, targets[key] ?? null);
  });
}

/**
 * Step 5 — metrics with issues.
 *
 * Worse than last time, by enough to be a move rather than noise, and resting on
 * a big enough count to be worth acting on. A rate that got worse on eleven
 * attendees is listed separately as too thin, not silently dropped: it might be
 * the most important thing on the screen next round.
 */
export const issuesIn = (moves: Move[]) =>
  moves.filter((m) => m.verdict === "worse" && !m.thin
    && (m.deltaPct === null || Math.abs(m.deltaPct) >= MATERIAL_PCT));

export type RankedMove = Move & { onObjective: boolean };

/**
 * Step 5, ordered by the objective rather than by the spine.
 *
 * Ranked, never filtered. If the client's objective is attendance and CTR has
 * collapsed, that still belongs on the screen — a problem does not stop being a
 * problem because it sits upstream of what you said you cared about. What
 * changes is the order, and that the two metrics the round is being judged on
 * are marked as such, so a list of seven does not read as seven equals.
 *
 * Within each group the biggest move comes first, which is the order it was in
 * before this existed.
 */
export function rankedIssues(moves: Move[], objective: ObjectiveKey): RankedMove[] {
  const o = OBJECTIVES[objective];
  const own = new Set<MetricKey>([o.metric, o.efficiency]);
  return issuesIn(moves)
    .map((m) => ({ ...m, onObjective: own.has(m.key) }))
    .sort(
      (a, b) =>
        Number(b.onObjective) - Number(a.onObjective) ||
        Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0),
    );
}

export const tooThinIn = (moves: Move[]) =>
  moves.filter((m) => m.verdict === "worse" && m.thin);

export const missedTargetIn = (moves: Move[]) =>
  moves.filter((m) => m.target !== null && m.now !== null && m.direction !== "neutral"
    && (m.direction === "up" ? m.now < m.target : m.now > m.target));

// ── Step 3: what changed upstream ──────────────────────────────────────────

export type Asset = {
  round_id: string;
  kind: "audience" | "creative";
  name: string;
  spend: number | null;
  leads: number;
  spend_share: number | null;
  /** Only on '(ad ids)' — how many untracked ads that one row stands for. */
  id_count?: number | null;
  /**
   * What the asset produced beyond the opt-in — appended by 0033, attributed
   * through each person's lead row because only leads carry an ad set.
   *
   * Optional so a database that has not run 0033 degrades to the lead-only
   * behaviour instead of reading every asset as having produced nobody.
   */
  att?: number | null;
  prev_buys?: number | null;
  rev?: number | null;
};

export type AssetChange = {
  kind: Asset["kind"];
  name: string;
  change: "added" | "dropped" | "reweighted";
  now: Asset | null;
  prev: Asset | null;
  /** Percentage points of the round's spend gained or lost. Reweighted only. */
  shareShift: number | null;
};

/** A share moving by this many points of the round is a redistribution. */
export const SHARE_SHIFT_PTS = 5;

/**
 * Floors for step 7, so a candidate is never proposed on noise.
 *
 * The first real run of this screen offered "Static_ContentAtScale_Text costs
 * 3.5× the round's own CPL" on TWO leads. One more lead would have halved that
 * multiple. The screen's own footer promises not to rank a creative on one
 * round, and proposing one on two leads is that promise broken quietly.
 *
 * MIN_ASSET_LEADS is deliberately below the 30 used for rates: step 7 offers
 * something to TEST, not a winner to back, and 10 leads at 3× the round average
 * is worth a test. It is still stated on the screen so the reader knows what
 * was filtered out.
 *
 * MIN_SPEND_MULTIPLE guards the other candidate: an asset that spent less than
 * two leads' worth cannot be blamed for producing no leads.
 */
export const MIN_ASSET_OUTCOME = 10;
export const MIN_SPEND_MULTIPLE = 2;
/** How far off the round's own rate an asset has to be to be worth a test. */
export const RATE_MULTIPLE = 1.5;

/**
 * Which outcome each objective judges an asset on, and what to call it.
 *
 * Revenue counts PREVIEW PURCHASES, not sales of every kind, because that is
 * already what the app says ROAS rests on — see DENOM.roas above. A ratio and
 * the sample it is trusted on have to agree, or the screen would refuse to rank
 * ROAS on six purchases in step 2 and then rank an audience on two in step 7.
 */
export const OBJECTIVE_OUTCOME: Record<
  ObjectiveKey,
  { count: "leads" | "att" | "prev_buys"; noun: string; rate: string }
> = {
  leads:   { count: "leads",     noun: "lead",             rate: "cost per lead" },
  att:     { count: "att",       noun: "attendee",         rate: "cost per attendance" },
  prevBuy: { count: "prev_buys", noun: "preview purchase", rate: "cost per purchase" },
  rev:     { count: "prev_buys", noun: "preview purchase", rate: "ROAS" },
};

/** What this asset produced, for the objective in play. Null = 0033 not run. */
export function outcomeOf(a: Asset, objective: ObjectiveKey): number | null {
  const field = OBJECTIVE_OUTCOME[objective].count;
  if (field === "leads") return a.leads;
  const v = a[field];
  return v === undefined || v === null ? null : v;
}

/**
 * Which audiences and creatives are new, gone, or carrying a different share.
 *
 * Share rather than amount, because a round that spent twice as much moved every
 * amount and redistributed nothing. An audience holding 12% of one round and 34%
 * of the next is the change worth seeing, whatever the totals did.
 */
export function diffAssets(now: Asset[], prev: Asset[]): AssetChange[] {
  const key = (a: Asset) => `${a.kind} ${a.name}`;
  const byNow = new Map(now.map((a) => [key(a), a]));
  const byPrev = new Map(prev.map((a) => [key(a), a]));
  const out: AssetChange[] = [];

  for (const [k, a] of byNow) {
    const before = byPrev.get(k);
    if (!before) {
      out.push({ kind: a.kind, name: a.name, change: "added", now: a, prev: null, shareShift: null });
      continue;
    }
    const shift =
      a.spend_share !== null && before.spend_share !== null
        ? a.spend_share - before.spend_share
        : null;
    if (shift !== null && Math.abs(shift) >= SHARE_SHIFT_PTS) {
      out.push({ kind: a.kind, name: a.name, change: "reweighted", now: a, prev: before, shareShift: shift });
    }
  }
  for (const [k, a] of byPrev) {
    if (!byNow.has(k)) {
      out.push({ kind: a.kind, name: a.name, change: "dropped", now: null, prev: a, shareShift: null });
    }
  }

  const rank = { added: 0, dropped: 1, reweighted: 2 } as const;
  return out.sort(
    (x, y) =>
      rank[x.change] - rank[y.change] ||
      Math.abs(y.shareShift ?? 0) - Math.abs(x.shareShift ?? 0) ||
      x.name.localeCompare(y.name),
  );
}

// ── Step 7: candidates to test ─────────────────────────────────────────────

export type Candidate = {
  kind: "cut" | "watch" | "keep";
  headline: string;
  detail: string;
  evidence: string;
};

/**
 * Things worth testing next round — offered, never decided.
 *
 * Only cases the arithmetic can stand behind: money spent for no leads at all,
 * and a cost per lead far off the round's own average. Both are stated with the
 * numbers that produced them so the reader can disagree on sight.
 *
 * Everything here is about ONE round, which is exactly the evidence the mockup's
 * footer says is not enough to rank creatives on. So they are candidates to
 * test, never a verdict, and the wording has to keep saying so.
 */
export const MAX_CANDIDATES = 6;

export type Candidates = {
  shown: Candidate[];
  dropped: number;
  /** The outcome these were judged on — "attendee", "lead". */
  noun: string;
  /**
   * Set when the objective's outcome is too small to rank on — PER KIND.
   *
   * Audiences and creatives are not equally thin, and pooling them hides it.
   * 0526-02 splits its spend across six audiences, none of which reached ten
   * attendees, while one creative carried twenty-one; a single pooled check
   * passes on the creative and the screen then says "no audience or creative is
   * more than 1.5× the round's rate", having compared no audience at all.
   *
   * `kinds` is the ones that could not be compared, and `all` says whether that
   * was both of them — which is the difference between an empty step 7 and a
   * partial one.
   */
  tooThin: {
    noun: string;
    best: number;
    floor: number;
    kinds: Array<Asset["kind"]>;
    all: boolean;
  } | null;
  /**
   * Set when the whole round produced none of this outcome. No asset can be
   * blamed for a nought every asset shares — a round with no attendance file
   * imported would otherwise propose cutting every audience it has.
   */
  roundHasNone: boolean;
  /**
   * The round DID produce this outcome, but none of it through an asset that
   * spent. Carries how many, because the number is the finding.
   *
   * This is 0526-03 exactly: all six preview purchases arrived through
   * '(unsplit)', which holds no spend, so no audience can be credited or
   * blamed. Reporting it as "the round produced none" would be a false
   * statement about a round that produced six.
   */
  untracked: number | null;
  /** True when 0033 has not been applied, so only leads are available. */
  unavailable: boolean;
};

export function candidatesFrom(
  assets: Asset[],
  roundLabel: string,
  objective: ObjectiveKey = "leads",
): Candidates {
  const { count, noun, rate } = OBJECTIVE_OUTCOME[objective];
  const blank: Candidates = {
    shown: [], dropped: 0, noun, tooThin: null,
    roundHasNone: false, untracked: null, unavailable: false,
  };

  const paid = assets.filter((a) => (a.spend ?? 0) > 0);
  if (!paid.length) return blank;

  // A database that has not run 0033 has no attendance or purchases per asset.
  // Reading the missing column as 0 would propose cutting every audience in the
  // round, so it is reported as unmeasured instead.
  if (paid.some((a) => outcomeOf(a, objective) === null)) {
    return { ...blank, unavailable: true };
  }

  const got = (a: Asset) => outcomeOf(a, objective) ?? 0;
  const totalSpend = paid.reduce((s, a) => s + (a.spend ?? 0), 0);
  const totalGot = paid.reduce((s, a) => s + got(a), 0);
  const totalRev = paid.reduce((s, a) => s + (a.rev ?? 0), 0);

  /**
   * The same outcome counted across every asset, spending or not.
   *
   * Per kind and then the larger of the two, because `assets` holds audiences
   * AND creatives — two complete partitions of the same round. Summing both
   * would report every outcome twice.
   */
  const acrossAll = (kind: Asset["kind"]) =>
    assets.filter((a) => a.kind === kind).reduce((s, a) => s + (outcomeOf(a, objective) ?? 0), 0);
  const allGot = Math.max(acrossAll("audience"), acrossAll("creative"));

  if (totalGot === 0) {
    // Produced some, but none of it on an asset that spent — a tracking gap,
    // not a performance one, and the opposite advice follows from it.
    return allGot > 0
      ? { ...blank, untracked: allGot }
      : { ...blank, roundHasNone: true };
  }

  /** The round's own rate — what one of these cost it on average. */
  const roundCost = totalSpend / totalGot;
  /** For the revenue objective the ratio is a return, and it runs the other way. */
  const roundRoas = totalSpend > 0 ? totalRev / totalSpend : null;
  const money = (v: number) => v.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const where = (a: Asset) => (a.kind === "audience" ? "this audience" : "this creative");
  const tab = (a: Asset) => (a.kind === "audience" ? "Targeted views" : "Ads");

  const out: Candidate[] = [];

  /**
   * Spent enough to have bought one at the round's own rate, and bought none.
   *
   * For revenue "none" means no money back, which is a stronger claim than no
   * purchases — an asset can produce a middle-offer sale and no preview one.
   */
  const producedNothing = (a: Asset) =>
    objective === "rev" ? (a.rev ?? 0) === 0 : got(a) === 0;

  for (const a of paid
    .filter((a) => producedNothing(a) && (a.spend ?? 0) >= roundCost * MIN_SPEND_MULTIPLE)
    .sort((x, y) => (y.spend ?? 0) - (x.spend ?? 0))) {
    /**
     * Two different findings wear the same "produced none" shape, and telling
     * them apart is most of the value.
     *
     * No leads either means the money never reached a person this app can see —
     * which is as likely to be a tracking fault as a bad audience, and saying
     * "cut it" would be wrong. Leads but none of the objective's outcome is the
     * real one: the audience works and the people it brings do not convert. It
     * is invisible to a screen that only knows cost per lead, and it is the
     * reason this step follows the objective at all.
     */
    const gotLeads = a.leads > 0;
    const reached =
      objective === "rev" ? "bought anything" : noun === "attendee" ? "turned up" : "bought";

    out.push({
      kind: "cut",
      headline: gotLeads
        ? `${a.name} brought ${a.leads} leads and ${objective === "rev" ? "no revenue" : `no ${noun}s`}`
        : `${a.name} spent and returned nothing`,
      detail: gotLeads
        ? `SGD ${money(a.spend ?? 0)} on ${where(a)} in ${roundLabel} produced ${a.leads} ` +
          `lead${a.leads === 1 ? "" : "s"}, and not one of them ${reached}. On cost per lead this ` +
          `looks like a working audience — it is only visible as a problem because the objective ` +
          `is ${noun}s. One round is not proof; check it on the ${tab(a)} tab before cutting it.`
        : `SGD ${money(a.spend ?? 0)} on ${where(a)} in ${roundLabel}, and no lead carries its ` +
          `name at all. Worth checking the tracking before cutting it — an untagged lead looks ` +
          `exactly like no lead.`,
      evidence:
        `${a.name} · SGD ${money(a.spend ?? 0)} · ${a.leads} leads · ` +
        `0 ${noun}s · ${a.spend_share ?? "—"}% of round spend`,
    });
  }

  /**
   * Far off the round's own rate — but only where the asset produced enough of
   * the thing that one more would not have changed the answer.
   *
   * On real data this floor bites hard for every objective except leads: the
   * best audience in 0526-03 produced three attendees. That is reported rather
   * than ranked, which is the whole reason the floor exists.
   */
  const ranked = paid.filter((a) => got(a) >= MIN_ASSET_OUTCOME);

  for (const a of ranked) {
    if (objective === "rev") {
      if (roundRoas === null || roundRoas === 0) continue;
      const roas = (a.rev ?? 0) / (a.spend ?? 1);
      if (roas <= roundRoas / RATE_MULTIPLE) {
        out.push({
          kind: "watch",
          headline: `${a.name} returns ${(roas / roundRoas).toFixed(1)}× the round's own ROAS`,
          detail: `One round is not enough to call it — compare it on the ${tab(a)} tab, where every round is summed, before moving budget.`,
          evidence: `${a.name} · ROAS ${roas.toFixed(1)} vs ${roundRoas.toFixed(1)} for ${roundLabel} · ${got(a)} ${noun}s`,
        });
      }
      continue;
    }
    const cost = (a.spend ?? 0) / got(a);
    if (cost >= roundCost * RATE_MULTIPLE) {
      out.push({
        kind: "watch",
        headline: `${a.name} costs ${(cost / roundCost).toFixed(1)}× the round's own ${rate}`,
        detail: `One round is not enough to call it — compare it on the ${tab(a)} tab, where every round is summed, before moving budget.`,
        evidence: `${a.name} · ${money(cost)} per ${noun} vs ${money(roundCost)} for ${roundLabel} · ${got(a)} ${noun}s`,
      });
    }
  }

  /**
   * Which kinds could not be compared at all.
   *
   * An empty step 7 reads as "no candidates", which is a finding; "nothing
   * produced enough to compare" is a different finding, and where only one kind
   * is thin the screen has to stop short of claiming it checked both.
   */
  const kinds = [...new Set(paid.map((a) => a.kind))];
  const thinKinds = kinds.filter(
    (k) => !paid.some((a) => a.kind === k && got(a) >= MIN_ASSET_OUTCOME),
  );
  const tooThin = thinKinds.length
    ? {
        noun,
        floor: MIN_ASSET_OUTCOME,
        kinds: thinKinds,
        all: thinKinds.length === kinds.length,
        best: Math.max(...paid.filter((a) => thinKinds.includes(a.kind)).map(got)),
      }
    : null;

  /**
   * Capped, and the cap is reported. A list that quietly stops at six reads as
   * "these are all of them", which is the one thing a truncated list must not
   * say. The count of what was left out goes back to the caller to print.
   */
  return {
    shown: out.slice(0, MAX_CANDIDATES),
    dropped: Math.max(0, out.length - MAX_CANDIDATES),
    noun,
    tooThin,
    roundHasNone: false,
    untracked: null,
    unavailable: false,
  };
}

// ── Presentation helpers ───────────────────────────────────────────────────

/** "▲ 12.4%" / "▼ 3.1%" / "=" — the arrow says direction of MOVEMENT, not good. */
export function moveChip(m: Move): { text: string; tone: "good" | "bad" | "flat" | "none" } {
  if (m.verdict === "unknown") return { text: "—", tone: "none" };
  const tone = m.verdict === "better" ? "good" : m.verdict === "worse" ? "bad" : "flat";

  /**
   * A move OUT of zero has no percentage, and reporting it as "no comparison"
   * understated it badly: Middle Offer Purchases going 0 → 2 is the whole story
   * of that round, and the chip said nothing had happened.
   *
   * Only out of zero — a move INTO zero divides by the old figure and has a
   * perfectly good percentage of -100%, which is what it shows.
   */
  if (m.deltaPct === null) {
    if (m.now !== null && m.prev === 0 && m.now > 0) return { text: "▲ from 0", tone };
    return { text: "—", tone: "none" };
  }

  const arrow = m.deltaPct > 0 ? "▲" : m.deltaPct < 0 ? "▼" : "=";
  return { text: `${arrow} ${Math.abs(m.deltaPct).toFixed(1)}%`, tone };
}

/** How far through the round we are, or null when it has finished. */
export function roundProgress(start: string | null, end: string | null, today: string): string | null {
  if (!start || !end) return null;
  const day = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86_400_000);
  const s = day(start), e = day(end), t = day(today);
  if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(t)) return null;
  const total = e - s + 1;
  if (t > e) return `finished · ran ${total} day${total === 1 ? "" : "s"}`;
  if (t < s) return `starts in ${s - t} day${s - t === 1 ? "" : "s"}`;
  return `day ${t - s + 1} of ${total}`;
}
