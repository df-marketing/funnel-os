import type { Cut } from "@/lib/funnel/data";
import {
  chartModel, chartWidth, chartHeight, colX, valueY, floorY, lineRuns, ticksFor, cell,
  labelChars, wrapLabel, clipLabel, GEO,
  type VsKey, type Series,
} from "@/lib/funnel/chart";

/**
 * One plot, two lines, an axis each.
 *
 * Ad spend on the left, and on the right whatever you are reading it against —
 * the objective's own level, or what a unit of it cost. Two axes rather than
 * one because spend runs in thousands and cost per attendee in tens: sharing a
 * scale would press the second line flat along the floor, where it would read
 * as a collapse instead of as a different unit.
 *
 * Two series, not three. A third would need a third axis, and three axes on one
 * plot is a puzzle rather than a chart.
 *
 * Server-rendered SVG. No chart library and no client JavaScript: the numbers
 * are already on the server and the drawing is arithmetic.
 *
 * A missing value is a gap — no point, and the line BREAKS rather than running
 * through it. Every dashboard of this shape draws straight across a blank and
 * calls it a trend; the blank is a fact, and this is the one place where losing
 * that rule costs nothing visible and changes what the chart says.
 */
export function SpineChart({
  title, sub, cuts, vs, notice, note,
}: {
  title: string;
  sub: string;
  cuts: Cut[];
  vs: VsKey;
  notice?: React.ReactNode;
  note?: React.ReactNode;
}) {
  const model = chartModel(cuts, vs);
  const n = cuts.length;
  const W = chartWidth(n);
  const H = chartHeight();
  const floor = floorY();
  const chars = labelChars(n);

  if (!cuts.length) {
    return (
      <>
        <div className="cap">
          <b>{title}</b>
          <span>{sub}</span>
        </div>
        <div className="notice info">
          <span className="ico">?</span>
          <div>
            <b>Nothing to plot.</b> This cut has no columns under the current filter, so
            there is no axis to draw. The table says the same thing with the same rows.
          </div>
        </div>
      </>
    );
  }

  /**
   * Where a value label goes.
   *
   * The two series label in opposite directions so that where the lines cross
   * the numbers don't land on each other — but a point sitting ON the floor or
   * the ceiling has no room in its preferred direction, and its label was
   * printing straight through the x-axis heading. So the preference yields to
   * the edge, and only then to the other series.
   */
  const labelY = (y: number, above: boolean) => {
    const wanted = above ? y - 11 : y + 18;
    if (wanted > floor - 6) return y - 11;
    if (wanted < GEO.padT + 12) return y + 18;
    return wanted;
  };

  /** One series' line, its points, and its value labels. */
  const draw = (s: Series, labelAbove: boolean) =>
    s.empty ? null : (
      <g className={`s-${s.axis}`}>
        {lineRuns(s.points, s.max).map((run, i) => (
          <polyline key={i} className="chart-line" points={run.map(([x, y]) => `${x},${y}`).join(" ")} />
        ))}
        {s.points.map((p, i) =>
          p.value === null ? null : (
            <g key={p.key}>
              <circle className="chart-dot" cx={colX(i, s.points.length)} cy={valueY(p.value, s.max)} r={4.5} />
              <text
                className="chart-value"
                x={colX(i, s.points.length)}
                y={labelY(valueY(p.value, s.max), labelAbove)}
                textAnchor="middle"
              >
                {cell(p.value, s.fmt)}
              </text>
            </g>
          ),
        )}
      </g>
    );

  return (
    <>
      <div className="cap">
        <b>{title}</b>
        <span>{sub}</span>
      </div>

      {notice ? (
        <div className="notice">
          <span className="ico">!</span>
          <div>{notice}</div>
        </div>
      ) : null}

      <div className="chart-box">
        <div className="chart-key">
          <i className="s-left">
            <span className="rule" />
            {model.left.label}
            <em>left axis</em>
          </i>
          <i className="s-right">
            <span className="rule" />
            {model.right.label}
            <em>right axis</em>
          </i>
        </div>

        <div className="chart-scroll">
          <svg
            className="chart"
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            // stretches to the pane, and scrolls rather than shrinking below the
            // width its own labels need
            style={{ minWidth: W }}
            role="img"
            aria-label={`${model.left.label} against ${model.right.label}, across ${cuts.length} columns.`}
          >
            {/* Gridlines come off the LEFT axis only. Two sets of horizontal
                rules at different intervals would look like a printing fault. */}
            {ticksFor(model.left.max).map((t, i) => {
              const y = valueY(t, model.left.max);
              return (
                <g key={t}>
                  <line
                    className={i === 0 ? "chart-axis" : "chart-grid"}
                    x1={GEO.padL} x2={W - GEO.padR} y1={y} y2={y}
                  />
                  <text className="chart-tick s-left" x={GEO.padL - 12} y={y + 4} textAnchor="end">
                    {cell(t, model.left.fmt)}
                  </text>
                </g>
              );
            })}

            {/* The right axis gets labels at the same heights, reading its own
                scale — which is what makes two units on one plot legible. */}
            {ticksFor(model.right.max).map((t) => (
              <text
                key={t}
                className="chart-tick s-right"
                x={W - GEO.padR + 12}
                y={valueY(t, model.right.max) + 4}
                textAnchor="start"
              >
                {cell(t, model.right.fmt)}
              </text>
            ))}

            {draw(model.left, true)}
            {draw(model.right, false)}

            {/* A column where neither line has a value still gets its place on
                the axis. Dropping it would close the gap and shorten the run. */}
            {model.columns.map((c, i) => {
              const blank =
                model.left.points[i]?.value === null && model.right.points[i]?.value === null;
              return (
                <g key={c.key}>
                  {blank ? (
                    <text className="chart-gap" x={colX(i, n)} y={floor - 10} textAnchor="middle">
                      —
                    </text>
                  ) : null}
                  {/* SVG doesn't wrap, so the label is folded here and each line
                      placed itself. The untruncated name stays in <title>. */}
                  <text className="chart-x" x={colX(i, n)} y={floor + 22} textAnchor="middle">
                    <title>{c.sub ? `${c.label} — ${c.sub}` : c.label}</title>
                    {wrapLabel(c.label, chars).map((line, li) => (
                      <tspan key={li} x={colX(i, n)} dy={li === 0 ? 0 : 14}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {c.sub ? (
                    <text
                      className="chart-xsub"
                      x={colX(i, n)}
                      y={floor + 22 + wrapLabel(c.label, chars).length * 14 + 4}
                      textAnchor="middle"
                    >
                      {/* the sub-label is a size smaller, so more of it fits in the same column */}
                      {clipLabel(c.sub, chars + 8)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {model.left.empty || model.right.empty ? (
        <div className="notice info">
          <span className="ico">?</span>
          <div>
            <b>{(model.left.empty ? model.left : model.right).label} has no measurement on this
            cut</b>, so that line is absent rather than drawn along the floor. A flat line at
            zero would claim a number that was never recorded.
          </div>
        </div>
      ) : null}

      <p className="note chart-legend">
        <b>Input against outcome.</b> Ad spend is the input and never changes; the right-hand
        line is what you are reading it against, chosen above.{" "}
        {model.vs.kind === "efficiency"
          ? model.vs.betterWhen === "lower"
            ? "On this reading, spend rising while the right line falls is the shape you want."
            : "On this reading, spend rising while the right line rises with it is the shape you want."
          : "That is the outcome itself — pick a row below it to see what a unit of it cost."}{" "}
        Each line has its own axis — sharing one would flatten the smaller of the two into
        the floor. A column with no measurement is a gap, and the line breaks across it
        rather than drawing a trend through a number nobody has.
        {model.blanks.length ? (
          <>
            {" "}
            Nothing recorded at all for <b>{model.blanks.join(", ")}</b>.
          </>
        ) : null}
        {note ? <> {note}</> : null}
      </p>
    </>
  );
}
