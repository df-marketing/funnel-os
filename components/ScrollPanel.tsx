import { readRun, BIG_DROP_PTS, THIN_COVERAGE_PCT, type ScrollRun } from "@/lib/funnel/scroll";
import { MIN_SAMPLE } from "@/lib/funnel/analysis";

/**
 * Step 3c — the landing page, read against the round it ran in.
 *
 * The only claim this makes from the pair of numbers is the constraint: nobody
 * opts in from a part of the page they never saw, so retention at the form's
 * depth cannot be below Lead Gen %. Everything else on screen is description —
 * where the audience goes, and how much of the round Clarity was watching.
 *
 * It does not name page sections, because Clarity's export doesn't know them,
 * and it does not put a scroll figure anywhere near the metric spine, because
 * sessions and clicks are different populations.
 */

const pct1 = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

/**
 * Counts with a separator, the same way every other number on this screen is
 * written. "1180 outbound clicks" beside "SGD 2,380.00" reads as a different
 * kind of number, which is exactly what it is not.
 */
const count = (n: number) => n.toLocaleString("en-SG");

/** A date range as one string, or nothing if the export didn't carry one. */
function window(from: string | null, to: string | null) {
  if (!from) return null;
  const d = (s: string) =>
    new Date(`${s}T00:00:00Z`).toLocaleDateString("en-SG", {
      day: "numeric", month: "short", timeZone: "UTC",
    });
  return to && to !== from ? `${d(from)} – ${d(to)}` : d(from);
}

export function ScrollPanel({
  runs, roundId, leadGen, clicks,
}: {
  runs: ScrollRun[];
  roundId: string;
  /** The round's Lead Gen % — leads ÷ outbound clicks. Null when unmeasured. */
  leadGen: number | null;
  /** The round's outbound clicks, for the coverage check. */
  clicks: number | null;
}) {
  if (!runs.length) {
    return (
      <p className="cro-foot">
        <b>The landing-page question is not answered for this round.</b> No Microsoft Clarity scroll
        export covering {roundId} has been imported. Drop one on the Import tab — Clarity&rsquo;s{" "}
        <span className="num">Scroll</span> export, unedited, with the round&rsquo;s dates in its
        picker — and the curve will be read against this round&rsquo;s Lead Gen % here. It is left
        open rather than quietly dropped from the list.
      </p>
    );
  }

  return (
    <div className="scroll-panel">
      {runs.map((run) => (
        <Curve key={run.run_id} run={run} leadGen={leadGen} clicks={clicks} />
      ))}
      {runs.length > 1 && (
        <p className="cro-foot">
          Each device export is shown on its own. They are not added together — two curves over
          different denominators average into a number that describes nobody.
        </p>
      )}
    </div>
  );
}

function Curve({
  run, leadGen, clicks,
}: {
  run: ScrollRun; leadGen: number | null; clicks: number | null;
}) {
  const read = readRun(run, leadGen, clicks);
  const { curve, worst, ceiling, coverage } = read;
  const span = window(run.captured_from, run.captured_to);

  return (
    <div className="scroll-run">
      <div className="scroll-h">
        <b>{run.page_label ?? "Landing page"}</b>
        <span className="kindtag">{run.device === "all" ? "all devices" : run.device}</span>
        <span className="dim">
          {count(run.sessions)} sessions{span ? ` · ${span}` : ""}
        </span>
      </div>

      {/* THE READING — before the curve, because the curve is the evidence for
          it and almost nobody scrolls past twenty bars to find the point. */}
      <ul className="scroll-read">
        <li>
          <b>{pct1(read.bouncedPts)}</b> of sessions left before {curve[0]?.depth}% of the page —
          they arrived and the page never moved.
        </li>

        {worst && worst.lostPts >= BIG_DROP_PTS && worst.depth !== curve[0]?.depth && (
          <li>
            The biggest single fall is at <b>{worst.depth}% depth</b> — {count(worst.lost)} sessions,{" "}
            {pct1(worst.lostPts)} of everyone who arrived, gone in one band.
          </li>
        )}

        {ceiling.kind === "bounded" && (
          <li>
            <b>The opt-in form cannot sit below {ceiling.depth}% of the page.</b>{" "}
            {pct1(ceiling.leadGen)} of clicks became leads, and past {ceiling.depth}% fewer than
            that share of sessions is still reading. Nobody opts in from a screen they never
            reached, so if the form is lower than that, one of these two numbers is wrong.
          </li>
        )}

        {ceiling.kind === "unbounded" && (
          <li>
            <b>Scroll depth is not what is limiting lead gen here.</b> Even at the bottom of the
            page {pct1(ceiling.pct)} of sessions are still present, against {pct1(ceiling.leadGen)}{" "}
            of clicks that opted in — everyone who could have converted was still on the page.
            Whatever is costing leads, it is not people failing to reach the form.
          </li>
        )}

        {ceiling.kind === "impossible" && (
          <li className="warn">
            <b>These two measurements contradict each other.</b> {pct1(ceiling.leadGen)} of clicks
            became leads, but only {pct1(ceiling.pct)} of sessions got as far as {ceiling.depth}% of
            the page — so more people opted in than ever scrolled far enough to see a form. Either
            Clarity is watching a different slice of the traffic than the ad account is buying, or
            the click count is wrong. Nothing is concluded from the pair until that is settled.
          </li>
        )}

        {ceiling.kind === "unknown" && (
          <li>
            This round has no Lead Gen % — outbound clicks were not in the ads export — so the curve
            is shown on its own. The comparison needs both.
          </li>
        )}

        {coverage.over ? (
          <li>
            Clarity counted <b>{count(coverage.sessions)} sessions</b> against{" "}
            <b>{count(coverage.clicks!)} outbound clicks</b> in the ad account. The page has traffic the ads
            did not buy — organic, direct, or a campaign that isn&rsquo;t in the export — so this
            curve describes a wider audience than Lead Gen % divides by.
          </li>
        ) : coverage.thin ? (
          <li className="warn">
            <b>This is a sample, not the round.</b>{" "}
            {coverage.clicks !== null
              ? `${count(coverage.sessions)} sessions against ${count(coverage.clicks)} outbound clicks — Clarity saw ${pct1(coverage.pct)} of them.`
              : `${count(coverage.sessions)} sessions, and the round's click count is unknown.`}{" "}
            {coverage.sessions < MIN_SAMPLE
              ? `Under ${MIN_SAMPLE} sessions, a single unusual visit moves a whole band.`
              : `Under ${THIN_COVERAGE_PCT}% coverage the shape is worth reading and the exact percentages are not.`}
          </li>
        ) : null}
      </ul>

      {/* THE CURVE — every reading, so the bands above can be checked. */}
      <table className="scroll-curve">
        <thead>
          <tr>
            <th>Depth</th>
            <th>Still reading</th>
            <th className="n">Sessions</th>
            <th className="n">Share</th>
            <th className="n">Lost here</th>
          </tr>
        </thead>
        <tbody>
          {curve.map((p) => {
            const big = p.lostPts >= BIG_DROP_PTS;
            return (
              <tr key={p.depth} className={big ? "big-drop" : undefined}>
                <td>{p.depth}%</td>
                <td>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: `${p.pct.toFixed(1)}%` }} />
                    {/* Where Lead Gen % falls on the same axis. The one mark
                        that makes the two sources comparable by eye. */}
                    {leadGen !== null && leadGen <= 100 && (
                      <span className="bar-mark" style={{ left: `${leadGen.toFixed(1)}%` }} />
                    )}
                  </span>
                </td>
                <td className="n num">{count(p.visitors)}</td>
                <td className="n num">{pct1(p.pct)}</td>
                <td className="n num">{p.lost > 0 ? pct1(p.lostPts) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="cro-foot">
        Shares are out of <b>{count(run.sessions)} sessions</b> — Clarity&rsquo;s scroll base, not its page
        views: a view that never fired a scroll event is a view and is not on this curve.
        {leadGen !== null && (
          <> The vertical mark on each bar is this round&rsquo;s Lead Gen %, {pct1(leadGen)}.</>
        )}{" "}
        Depth is percent of page height, which is all Clarity exports — no section is named here
        because the file does not know where the sections are.
      </p>
    </div>
  );
}
