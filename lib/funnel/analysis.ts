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
import { num } from "./chart";

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
export function candidatesFrom(assets: Asset[], roundLabel: string): Candidate[] {
  const paid = assets.filter((a) => (a.spend ?? 0) > 0);
  if (!paid.length) return [];

  const totalSpend = paid.reduce((s, a) => s + (a.spend ?? 0), 0);
  const totalLeads = paid.reduce((s, a) => s + a.leads, 0);
  const roundCpl = totalLeads > 0 ? totalSpend / totalLeads : null;
  const money = (v: number) => v.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const out: Candidate[] = [];

  for (const a of paid.filter((a) => a.leads === 0).sort((x, y) => (y.spend ?? 0) - (x.spend ?? 0))) {
    out.push({
      kind: "cut",
      headline: `${a.name} spent and returned nothing`,
      detail: `SGD ${money(a.spend ?? 0)} on ${a.kind === "audience" ? "this audience" : "this creative"} in ${roundLabel}, and no lead carries its name. Worth checking the tracking before cutting it — an untagged lead looks exactly like no lead.`,
      evidence: `${a.name} · SGD ${money(a.spend ?? 0)} · 0 leads · ${a.spend_share ?? "—"}% of round spend`,
    });
  }

  if (roundCpl !== null) {
    for (const a of paid.filter((a) => a.leads > 0)) {
      const cpl = (a.spend ?? 0) / a.leads;
      if (cpl >= roundCpl * 1.5) {
        out.push({
          kind: "watch",
          headline: `${a.name} costs ${(cpl / roundCpl).toFixed(1)}× the round's own CPL`,
          detail: `One round is not enough to call it — compare it on the ${a.kind === "audience" ? "Targeted views" : "Ads"} tab, where every round is summed, before moving budget.`,
          evidence: `${a.name} · CPL ${money(cpl)} vs ${money(roundCpl)} for ${roundLabel} · ${a.leads} leads`,
        });
      }
    }
  }

  return out.slice(0, 6);
}

// ── Presentation helpers ───────────────────────────────────────────────────

/** "▲ 12.4%" / "▼ 3.1%" / "=" — the arrow says direction of MOVEMENT, not good. */
export function moveChip(m: Move): { text: string; tone: "good" | "bad" | "flat" | "none" } {
  if (m.verdict === "unknown" || m.deltaPct === null) return { text: "—", tone: "none" };
  const arrow = m.deltaPct > 0 ? "▲" : m.deltaPct < 0 ? "▼" : "=";
  const tone =
    m.verdict === "better" ? "good" : m.verdict === "worse" ? "bad" : "flat";
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
