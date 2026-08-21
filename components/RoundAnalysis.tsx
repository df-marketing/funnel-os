import type { Cut, RoundContext } from "@/lib/funnel/data";
import { fmt, type MetricKey, type Metrics } from "@/lib/funnel/spine";
import { OBJECTIVES, num, type ObjectiveKey } from "@/lib/funnel/chart";
import { runsFor } from "@/lib/funnel/scroll";
import { ScrollPanel } from "./ScrollPanel";
import {
  movesFor, issuesIn, rankedIssues, tooThinIn, missedTargetIn, diffAssets, candidatesFrom,
  moveChip, roundProgress, MIN_SAMPLE, MATERIAL_PCT, SHARE_SHIFT_PTS,
  MIN_ASSET_OUTCOME, MIN_SPEND_MULTIPLE, MAX_CANDIDATES, RATE_MULTIPLE, OBJECTIVE_OUTCOME,
  type Move, type RankedMove, type Asset,
} from "@/lib/funnel/analysis";

/**
 * This round, worked through the CRO process in its own order.
 *
 * The seven steps are the seven sections, numbered as they are numbered in the
 * process, so the screen and the method can be read against each other. Steps
 * 1–5 are arithmetic and are computed. Step 6 is a claim about cause and step 7
 * is a decision about money — the screen brings the evidence to both and stops
 * there, because a dashboard that writes your hypothesis is a dashboard that
 * gets believed when it is wrong.
 *
 * Where a number is too thin to act on, it says so instead of ranking it.
 */

/**
 * The five figures above the steps, led by whatever the round is being judged on.
 *
 * Spend first always — it is the input, and every rate below is a rate per
 * pound of it. Then the objective's own metric and what a unit of it cost,
 * because a screen that asks you to pick an objective and then doesn't show it
 * is asking a question it ignores. The remainder fills from the standing
 * context rates, minus anything already up there.
 */
const CONTEXT_KPIS: MetricKey[] = ["leads", "attPct", "prevPct", "roas"];

function kpisFor(objective: ObjectiveKey): MetricKey[] {
  const o = OBJECTIVES[objective];
  const head: MetricKey[] = ["spend", o.metric, o.efficiency];
  return [...head, ...CONTEXT_KPIS.filter((k) => !head.includes(k))].slice(0, 5);
}

const money = (v: number | null) => (v === null ? "—" : (fmt(v, "m") ?? "—"));

/**
 * "1 lead" / "2 leads", as one string.
 *
 * Written out because JSX inserts whitespace between adjacent expressions, so
 * `{n} lead{n === 1 ? "" : "s"}` rendered on screen as "2 lead s".
 */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Spend, or the fact that there isn't any.
 *
 * "SGD —" reads as a missing figure. These assets have no spend because no ad
 * in the export answers to their name — untracked leads, not unmeasured money —
 * and that is worth saying in words.
 */
const spendOf = (a: { spend: number | null } | null | undefined) =>
  a && a.spend !== null ? `SGD ${money(a.spend)}` : "no spend in the export";

function Chip({ move }: { move: Move }) {
  const chip = moveChip(move);
  if (chip.tone === "none") return <span className="chip none">no comparison</span>;
  return (
    <span className={`chip ${chip.tone}`}>
      {chip.text} <em>vs previous</em>
    </span>
  );
}

/** One numbered section of the process. */
function Step({
  n, title, aim, children,
}: {
  n: string;
  title: string;
  aim: string;
  children: React.ReactNode;
}) {
  return (
    <section className="cro-step">
      <div className="cro-head">
        <span className="cro-n">{n}</span>
        <div>
          <b>{title}</b>
          <span>{aim}</span>
        </div>
      </div>
      <div className="cro-body">{children}</div>
    </section>
  );
}

/** A compact metric-vs-metric table used by steps 1, 2 and 5. */
function MoveTable({
  moves, nowLabel, prevLabel, showTarget,
}: {
  /**
   * Steps 1 and 2 pass plain moves; step 5 passes ranked ones. The marker is
   * driven off the flag rather than off a second prop, so a table that was
   * never ranked cannot accidentally claim a row is on the objective.
   */
  moves: Array<Move | RankedMove>;
  nowLabel: string;
  prevLabel: string;
  showTarget: boolean;
}) {
  if (!moves.length) return null;
  return (
    <div className="movetable-scroll">
      <table className="movetable">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">{nowLabel}</th>
            <th className="num">{prevLabel}</th>
            <th className="num">All rounds</th>
            {showTarget ? <th className="num">Target</th> : null}
            <th>Move</th>
          </tr>
        </thead>
        <tbody>
          {moves.map((m) => (
            <tr key={m.key} className={"onObjective" in m && m.onObjective ? "on-objective" : undefined}>
              <th scope="row">
                {m.label}
                {"onObjective" in m && m.onObjective ? (
                  <i className="goal" title="This is what the round is being judged on">
                    objective
                  </i>
                ) : null}
                {m.thin ? (
                  <i
                    className="thin"
                    title={`Rests on ${m.sample ?? 0} ${m.sampleOf ?? ""} — under ${MIN_SAMPLE}, so it is shown and not ranked`}
                  >
                    thin
                  </i>
                ) : null}
              </th>
              <td className="num strong">{m.now === null ? "—" : fmt(m.now, m.fmt)}</td>
              <td className="num">{m.prev === null ? "—" : fmt(m.prev, m.fmt)}</td>
              <td className="num">{m.base === null ? "—" : fmt(m.base, m.fmt)}</td>
              {showTarget ? (
                <td className="num">{m.target === null ? "—" : fmt(m.target, m.fmt)}</td>
              ) : null}
              <td>
                <Chip move={m} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RoundAnalysis({
  cuts, baseline, context, objective, today,
}: {
  /** The two columns from v_metrics_this_round: this round, then the previous. */
  cuts: Cut[];
  baseline: Cut | null;
  context: RoundContext | null;
  objective: ObjectiveKey;
  /** Passed in rather than read here, so the server and the tests agree on it. */
  today: string;
}) {
  const now = cuts.find((c) => (c as { period?: string }).period === "this round") ?? cuts[0] ?? null;
  const prev = cuts.find((c) => (c as { period?: string }).period === "previous") ?? cuts[1] ?? null;

  if (!now) {
    return (
      <div className="notice info">
        <span className="ico">?</span>
        <div>
          <b>No round has started yet under this filter.</b> This screen reads the newest round
          that has begun; narrow the filter to a period that contains one, or clear it.
        </div>
      </div>
    );
  }

  const targets = context?.targets ?? {};
  const moves = movesFor(now.m as Metrics, (prev?.m ?? null) as Metrics | null, (baseline?.m ?? null) as Metrics | null, targets);
  const byKey = new Map(moves.map((m) => [m.key, m]));
  const issues = rankedIssues(moves, objective);
  const thin = tooThinIn(moves);
  const missed = missedTargetIn(moves);
  const hasTargets = Object.keys(targets).length > 0;

  const goalKey = OBJECTIVES[objective].metric;
  const goal = byKey.get(goalKey);
  const effKey = OBJECTIVES[objective].efficiency;
  const eff = byKey.get(effKey);

  const roundId = now.cut_key;
  const prevId = prev?.cut_key ?? null;
  const progress = roundProgress(
    (now as { start_date?: string }).start_date ?? null,
    (now as { end_date?: string }).end_date ?? null,
    today,
  );

  // Step 1 — the month this round sits in, against the one before it.
  const months = context?.months ?? [];
  const thisMonth = months[months.length - 1] ?? null;
  const lastMonth = months.length > 1 ? months[months.length - 2] : null;
  const monthMoves = thisMonth
    ? movesFor(thisMonth.m as Metrics, (lastMonth?.m ?? null) as Metrics | null, (baseline?.m ?? null) as Metrics | null, targets)
        .filter((m) => ["spend", "leads", "att", "rev", "cpl", "roas"].includes(m.key))
    : [];

  // Step 3 — what carried money in this round versus the last one.
  const assets = (context?.assets ?? []) as Asset[];
  const nowAssets = assets.filter((a) => a.round_id === roundId);
  const prevAssets = prevId ? assets.filter((a) => a.round_id === prevId) : [];
  const changes = prevId ? diffAssets(nowAssets, prevAssets) : [];
  const candidates = candidatesFrom(nowAssets, roundId, objective);

  return (
    <>
      <div className="pane-head">
        <h1>This round — {roundId}</h1>
        <p>
          What the round is doing while it runs, and what the numbers do and don&rsquo;t support.
          {progress ? <> {progress}.</> : null}
        </p>
      </div>

      {/* The five figures worth knowing before reading anything else. */}
      <div className="kpis">
        {kpisFor(objective).map((k) => {
          const m = byKey.get(k);
          if (!m) return null;
          return (
            <div className="kpi" key={k}>
              <span className="kpi-label">{m.label}</span>
              <span className="kpi-value">{m.now === null ? "—" : fmt(m.now, m.fmt)}</span>
              <span className="kpi-sub">
                <Chip move={m} />
                {m.thin ? (
                  <i className="thin" title={`Under ${MIN_SAMPLE}, so this is shown and not ranked`}>
                    on {fmt(m.sample ?? 0, "i")} {m.sampleOf ?? ""}
                  </i>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      <Step n="01" title="Month to date" aim="the first question management asks">
        {thisMonth ? (
          <>
            <p className="cro-lead">
              <b>{thisMonth.cut_label}</b> so far, against{" "}
              {lastMonth ? <b>{lastMonth.cut_label}</b> : "no earlier month"}. A round belongs to
              the month it started in, so this round is inside these figures rather than beside
              them.
            </p>
            <MoveTable
              moves={monthMoves}
              nowLabel={thisMonth.cut_label ?? "This month"}
              prevLabel={lastMonth?.cut_label ?? "Previous"}
              showTarget={false}
            />
          </>
        ) : (
          <p className="cro-lead">No month has any data under this filter.</p>
        )}
      </Step>

      <Step n="02" title={`Round by round — ${roundId}${prevId ? ` against ${prevId}` : ""}`} aim="with the variables recorded">
        {prevId ? null : (
          <p className="cro-lead">
            <b>This is the first round on record here</b>, so there is nothing to compare it
            against. Every move below reads &ldquo;no comparison&rdquo; rather than being measured
            from zero.
          </p>
        )}
        <MoveTable
          moves={moves.filter((m) => m.now !== null || m.prev !== null)}
          nowLabel={roundId}
          prevLabel={prevId ?? "Previous"}
          showTarget={hasTargets}
        />
        {hasTargets ? null : (
          <p className="cro-foot">
            <b>No target is set for this client</b>, so the comparison is against the previous
            round and the all-round baseline only. The process asks for a target as the third
            comparison; nothing in this database has ever held one. One row in{" "}
            <span className="num">client_targets</span> per metric turns the column on.
          </p>
        )}
      </Step>

      <Step n="03" title="What changed upstream" aim="new ad · budget distribution · targeting · landing page">
        {!prevId ? (
          <p className="cro-lead">Nothing to diff — there is no previous round.</p>
        ) : changes.length ? (
          <ul className="changes">
            {changes.map((c) => (
              <li key={`${c.kind}-${c.name}-${c.change}`} className={c.change}>
                <span className="tag">{c.change}</span>
                <b>{c.name}</b>
                <span className="kindtag">{c.kind}</span>
                <span className="detail">
                  {c.change === "added" ? (
                    <>
                      {spendOf(c.now)} · {plural(c.now?.leads ?? 0, "lead")} · new this round
                      {c.now?.id_count ? ` · stands for ${c.now.id_count} untracked ads` : ""}
                    </>
                  ) : c.change === "dropped" ? (
                    <>
                      ran in {prevId} and not here · was {spendOf(c.prev)}
                      {c.prev?.spend_share !== null && c.prev?.spend_share !== undefined
                        ? ` · ${c.prev.spend_share}% of that round`
                        : ""}
                    </>
                  ) : (
                    <>
                      {c.prev?.spend_share ?? "—"}% → {c.now?.spend_share ?? "—"}% of round spend
                      {c.shareShift !== null ? (
                        <>
                          {" "}
                          ({c.shareShift > 0 ? "+" : ""}
                          {c.shareShift.toFixed(1)} pts)
                        </>
                      ) : null}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="cro-lead">
            <b>Nothing changed that this app can see.</b> The same audiences and creatives ran, and
            none of them moved more than {SHARE_SHIFT_PTS} points of the round&rsquo;s spend. If a
            rate moved anyway, the cause is not in the imported data.
          </p>
        )}

        {/* 3c — the landing page. The rest of step 3 diffs what the ad account
            changed; this is the only part that asks what the page did. */}
        <ScrollPanel
          runs={runsFor(context?.scroll ?? [], roundId)}
          roundId={roundId}
          leadGen={num((now.m as Metrics)?.leadgen)}
          clicks={num((now.m as Metrics)?.clicks)}
        />
      </Step>

      <Step n="04" title="Findings — goal metric amount" aim={`the objective is ${OBJECTIVES[objective].label.toLowerCase()}`}>
        {goal ? (
          <div className="finding">
            <div className="finding-value">
              <span className="kpi-label">{goal.label}</span>
              <span className="kpi-value">{goal.now === null ? "—" : fmt(goal.now, goal.fmt)}</span>
              <span className="kpi-sub">
                <Chip move={goal} />
              </span>
            </div>
            <p>
              <b>{goal.label}</b> came to{" "}
              <b>{goal.now === null ? "nothing recorded" : fmt(goal.now, goal.fmt)}</b> in {roundId}
              {prevId && goal.prev !== null ? (
                <>
                  , against <b>{fmt(goal.prev, goal.fmt)}</b> in {prevId}
                </>
              ) : null}
              {goal.base !== null ? (
                <>
                  , with <b>{fmt(goal.base, goal.fmt)}</b> as the all-round baseline
                </>
              ) : null}
              .{" "}
              {eff && eff.now !== null ? (
                <>
                  It cost <b>{fmt(eff.now, eff.fmt)}</b> on <b>{eff.label}</b>
                  {eff.thin ? (
                    <>
                      {" "}
                      — resting on {eff.sample ?? 0} {eff.sampleOf ?? ""}, too few to rank
                    </>
                  ) : null}
                  .
                </>
              ) : (
                <>
                  <b>{OBJECTIVES[objective].efficiencyLabel}</b> is not measurable on this round.
                </>
              )}
              {goal.target === null ? (
                <> No target is set for it, so nothing here says whether that is enough.</>
              ) : (
                <>
                  {" "}
                  Target is <b>{fmt(goal.target, goal.fmt)}</b>
                  {goal.vsTargetPct !== null ? (
                    <>
                      {" "}
                      — {Math.abs(goal.vsTargetPct).toFixed(1)}%{" "}
                      {goal.vsTargetPct >= 0 ? "above" : "below"} it
                    </>
                  ) : null}
                  .
                </>
              )}
            </p>
          </div>
        ) : null}
      </Step>

      <Step
        n="05"
        title="Results — metrics with issues"
        aim={`worse than ${prevId ?? "the previous round"} by ${MATERIAL_PCT}% or more · ${OBJECTIVES[objective].label.toLowerCase()} first`}
      >
        {issues.length ? (
          <>
            <MoveTable moves={issues} nowLabel={roundId} prevLabel={prevId ?? "Previous"} showTarget={hasTargets} />
            {issues.some((m) => m.onObjective) ? (
              <p className="cro-foot">
                The rows marked <i className="goal">objective</i> are the two this round is being
                judged on — {OBJECTIVES[objective].label} and{" "}
                {OBJECTIVES[objective].efficiencyLabel}. They are sorted to the top, not filtered
                to it: everything else here is still a real problem, and one of them may well be
                what moved the objective.
              </p>
            ) : (
              <p className="cro-foot">
                <b>Nothing on the objective itself got worse.</b> {OBJECTIVES[objective].label} and{" "}
                {OBJECTIVES[objective].efficiencyLabel} both held. What is listed above sits
                upstream of them, which is where to look before this round&rsquo;s result becomes
                next round&rsquo;s.
              </p>
            )}
          </>
        ) : (
          <p className="cro-lead">
            <b>Nothing got materially worse.</b> No metric fell by {MATERIAL_PCT}% or more against{" "}
            {prevId ?? "the previous round"} on a count big enough to act on.
          </p>
        )}

        {missed.length ? (
          <>
            <p className="cro-foot">
              <b>Short of target:</b>{" "}
              {missed.map((m) => `${m.label} ${fmt(m.now, m.fmt)} vs ${fmt(m.target, m.fmt)}`).join(" · ")}
            </p>
          </>
        ) : null}

        {thin.length ? (
          <p className="cro-foot">
            <b>Down, but too thin to act on:</b>{" "}
            {thin.map((m) => `${m.label} (on ${m.sample ?? 0})`).join(" · ")}. Under {MIN_SAMPLE},
            one more person moves these enough to reverse them, so they are listed and not ranked.
          </p>
        ) : null}
      </Step>

      <Step n="06" title="Hypothesis — why" aim="what the data can offer, and where it stops">
        {issues.length ? (
          <>
            <p className="cro-lead">
              {changes.length ? (
                <>
                  {issues.length} metric{issues.length === 1 ? "" : "s"} moved against you, and{" "}
                  {changes.length} thing{changes.length === 1 ? "" : "s"} changed upstream in the
                  same round. <b>That is a coincidence until you check it.</b> Both lists are
                  above; the app will not pick which caused which, because with one round of
                  evidence it cannot tell.
                </>
              ) : (
                <>
                  {issues.length} metric{issues.length === 1 ? "" : "s"} moved against you and{" "}
                  <b>nothing changed upstream that this app can see</b> — same audiences, same
                  creatives, no redistribution past {SHARE_SHIFT_PTS} points. That points outside
                  the imported data: the landing page, the offer, the market, or the class itself.
                </>
              )}
            </p>
            <ul className="hyps">
              {issues.slice(0, 4).map((m) => (
                <li key={m.key}>
                  <b>{m.label}</b> {fmt(m.prev, m.fmt)} → {fmt(m.now, m.fmt)}
                  {m.deltaPct !== null ? <> ({m.deltaPct.toFixed(1)}%)</> : null}
                  {/* a counted metric rests on itself — saying so adds nothing */}
                  {m.sample !== null && m.sampleOf ? (
                    <>
                      {" "}
                      · on {fmt(m.sample, "i")} {m.sampleOf}
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="cro-lead">
            No metric has an issue to explain. Step 6 exists to stop a hypothesis being written for
            a problem that isn&rsquo;t there.
          </p>
        )}
      </Step>

      <Step
        n="07"
        title="Solution — things to test next round"
        aim={`candidates, not decisions · judged on ${candidates.noun}s`}
      >
        {/* Which half of the comparison could not run. Above the list, because
            it changes what the list below it is claiming to cover. */}
        {candidates.shown.length && candidates.tooThin && !candidates.tooThin.all ? (
          <p className="cro-lead">
            <b>
              No {candidates.tooThin.kinds.join(" or ")} in {roundId} produced enough{" "}
              {candidates.tooThin.noun}s to compare on
            </b>{" "}
            — the most any managed was {candidates.tooThin.best}, against a floor of{" "}
            {candidates.tooThin.floor}. Everything below is a{" "}
            {candidates.tooThin.kinds.includes("audience") ? "creative" : "audience"} comparison
            only.
          </p>
        ) : null}

        {candidates.shown.length ? (
          <ul className="cands">
            {candidates.shown.map((c, i) => (
              <li key={i} className={c.kind}>
                <span className="tag">{c.kind}</span>
                <div>
                  <b>{c.headline}</b>
                  <p>{c.detail}</p>
                  <code>{c.evidence}</code>
                </div>
              </li>
            ))}
          </ul>
        ) : candidates.unavailable ? (
          <p className="cro-lead">
            <b>This database cannot break {candidates.noun}s down by audience yet.</b> Only leads
            carry an ad set, so attendance and purchases have to be attributed through each
            person&rsquo;s lead row — which migration <span className="num">0033</span> adds. Until
            it runs, this step can only be answered for the Leads objective. Nothing is guessed in
            the meantime.
          </p>
        ) : candidates.untracked !== null ? (
          <p className="cro-lead">
            <b>
              {roundId} produced {candidates.untracked} {candidates.noun}
              {candidates.untracked === 1 ? "" : "s"}, and not one of them can be traced to an
              audience that spent.
            </b>{" "}
            They all arrived through <span className="num">(unsplit)</span> — the bucket for people
            whose opt-in carried no ad set — which holds no spend, so there is nothing to credit or
            blame. This is a tracking gap, not a performance one: no budget decision can be made
            from it, and the fix is upstream, in the tags GoHighLevel writes. Switch the objective
            to <b>Leads</b> to see what the audiences did do.
          </p>
        ) : candidates.roundHasNone ? (
          <p className="cro-lead">
            <b>{roundId} produced no {candidates.noun}s at all</b>, so no audience or creative can
            be blamed for producing none. That is a fact about the round — or about a file that
            has not been imported for it — rather than about any one asset.
          </p>
        ) : candidates.tooThin ? (
          <p className="cro-lead">
            <b>
              No {candidates.tooThin.all ? "audience or creative" : candidates.tooThin.kinds.join(" or ")} in{" "}
              {roundId} produced enough {candidates.tooThin.noun}s to compare on.
            </b>{" "}
            The most any managed was {candidates.tooThin.best}, against a floor of{" "}
            {candidates.tooThin.floor}. At those counts one more {candidates.tooThin.noun} moves a
            cost per {candidates.tooThin.noun} by more than the gap being measured, so nothing is
            ranked. Switch the objective to <b>Leads</b> — every asset has enough of those — or
            read <b>Targeted views</b>, where every round is summed.
          </p>
        ) : (
          <p className="cro-lead">
            <b>Nothing in this round is far enough out of line to propose a test.</b> Every
            audience and creative that could be compared took money and returned {candidates.noun}s,
            and none is more than {RATE_MULTIPLE}× the round&rsquo;s own{" "}
            {OBJECTIVE_OUTCOME[objective].rate}.
          </p>
        )}
        <p className="cro-foot">
          {candidates.dropped ? (
            <>
              <b>
                {candidates.dropped} more candidate{candidates.dropped === 1 ? " is" : "s are"} not
                shown
              </b>{" "}
              — the list stops at {MAX_CANDIDATES} so it stays readable, and says so rather than
              looking complete.{" "}
            </>
          ) : null}
          Nothing is proposed on fewer than {MIN_ASSET_OUTCOME} {candidates.noun}s, and nothing is
          called a failure for spending less than {MIN_SPEND_MULTIPLE} {candidates.noun}s&rsquo;
          worth — at those sizes one more {candidates.noun} changes the answer. Every one of these
          is still one round of evidence,
          which is not enough to rank a creative on. They are candidates to test, and the call is
          yours rather than the tool&rsquo;s — the comparison that settles it is on{" "}
          <b>Targeted views</b> and <b>Ads</b>, where every round is summed.
        </p>
      </Step>

      <div className="notice info">
        <span className="ico">?</span>
        <div>
          <b>What this screen won&rsquo;t do.</b> Rank creatives on one round, call a winner on
          fewer than {MIN_SAMPLE} attendees, project revenue, or tell you why a number moved. Where
          a number is too thin to act on it says so instead of ranking it.
        </div>
      </div>
    </>
  );
}
