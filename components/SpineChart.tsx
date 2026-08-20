import type { Cut } from "@/lib/funnel/data";
import {
  chartModel, chartWidth, chartHeight, colX, panelTop, barH, lineRuns, ticks, cell, GEO,
  type ObjectiveKey,
} from "@/lib/funnel/chart";

/**
 * The same columns as the table, drawn.
 *
 * Three panels on one shared x-axis — spend, what it produced, what a unit of
 * that cost — because that is the order the question gets asked in. Separate
 * scales rather than one: money, people and a ratio share no unit, and forcing
 * them onto one axis would flatten two of the three into the floor.
 *
 * Server-rendered SVG. No chart library, no client JavaScript, and no canvas:
 * the numbers are already on the server, the drawing is arithmetic, and a graph
 * that needs a 90 kB dependency to show six bars is a worse graph.
 *
 * A missing value is a gap — no bar, and the efficiency line breaks rather than
 * running straight through it. The whole app refuses to turn absent into zero;
 * a chart is where that refusal is easiest to lose and hardest to notice.
 */
export function SpineChart({
  title, sub, cuts, objective, notice, note,
}: {
  title: string;
  sub: string;
  cuts: Cut[];
  objective: ObjectiveKey;
  notice?: React.ReactNode;
  note?: React.ReactNode;
}) {
  const model = chartModel(cuts, objective);
  const W = chartWidth(cuts.length);
  const H = chartHeight();

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

      <div className="chart-scroll">
        <svg
          className="chart"
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={`${title}. ${model.panels.map((p) => p.title).join(", then ")}, across ${cuts.length} columns.`}
        >
          {model.panels.map((panel, pi) => {
            const top = panelTop(pi);
            const floor = top + GEO.panelH;
            return (
              <g key={panel.role}>
                <text className="chart-title" x={GEO.padL} y={top - 8}>
                  {panel.title}
                </text>

                {/* Gridlines and their labels. The floor line is solid, so the
                    baseline of a bar is never ambiguous against a tick. */}
                {ticks(panel.max).map((t) => {
                  const y = floor - barH(t, panel.max);
                  return (
                    <g key={t}>
                      <line
                        className={t === 0 ? "chart-axis" : "chart-grid"}
                        x1={GEO.padL} x2={W - GEO.padR} y1={y} y2={y}
                      />
                      <text className="chart-tick" x={GEO.padL - 10} y={y + 4} textAnchor="end">
                        {cell(t, panel.fmt)}
                      </text>
                    </g>
                  );
                })}

                {panel.empty ? (
                  <text className="chart-blank" x={GEO.padL + 14} y={top + GEO.panelH / 2}>
                    Not measured for any column here
                  </text>
                ) : panel.role === "efficiency" ? (
                  <>
                    {/* A ratio is a line: it says "this moved", where a bar says
                        "this much was produced". Runs are split at every gap. */}
                    {lineRuns(panel.points, panel.max, top).map((run, i) => (
                      <polyline
                        key={i}
                        className="chart-line"
                        points={run.map(([x, y]) => `${x},${y}`).join(" ")}
                      />
                    ))}
                    {panel.points.map((p, i) =>
                      p.value === null ? null : (
                        <g key={p.key}>
                          <circle
                            className="chart-dot"
                            cx={colX(i)}
                            cy={floor - barH(p.value, panel.max)}
                            r={5}
                          />
                          <text
                            className="chart-value"
                            x={colX(i)}
                            y={floor - barH(p.value, panel.max) - 12}
                            textAnchor="middle"
                          >
                            {cell(p.value, panel.fmt)}
                          </text>
                        </g>
                      ),
                    )}
                  </>
                ) : (
                  panel.points.map((p, i) =>
                    p.value === null ? (
                      // Absent gets a mark of its own. An empty slot and a bar of
                      // height zero look identical, and they are not the same fact.
                      <text
                        key={p.key}
                        className="chart-gap"
                        x={colX(i)}
                        y={floor - 8}
                        textAnchor="middle"
                      >
                        —
                      </text>
                    ) : (
                      <g key={p.key}>
                        <rect
                          className={`chart-bar ${panel.role}`}
                          x={colX(i) - GEO.bar / 2}
                          y={floor - barH(p.value, panel.max)}
                          width={GEO.bar}
                          height={Math.max(1, barH(p.value, panel.max))}
                          rx={3}
                        />
                        <text
                          className="chart-value"
                          x={colX(i)}
                          y={floor - barH(p.value, panel.max) - 8}
                          textAnchor="middle"
                        >
                          {cell(p.value, panel.fmt)}
                        </text>
                      </g>
                    ),
                  )
                )}
              </g>
            );
          })}

          {/* One x-axis under the bottom panel — the three share it, which is
              what makes them one argument rather than three charts. */}
          {model.columns.map((c, i) => (
            <g key={c.key}>
              <text
                className="chart-x"
                x={colX(i)}
                y={panelTop(2) + GEO.panelH + 24}
                textAnchor="middle"
              >
                {c.label}
              </text>
              {c.sub ? (
                <text
                  className="chart-xsub"
                  x={colX(i)}
                  y={panelTop(2) + GEO.panelH + 40}
                  textAnchor="middle"
                >
                  {c.sub}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </div>

      <p className="note chart-legend">
        <b>Input → objective → efficiency</b>, read downwards: what was spent, what it
        produced, and what one unit of that cost.{" "}
        {model.objective.betterWhen === "lower"
          ? "On the bottom panel, down is better."
          : "On the bottom panel, up is better."}{" "}
        Each panel has its own scale — money, people and a ratio share no unit, so a
        single axis would flatten two of them into the floor. A column with no
        measurement is a gap, never a zero, and the efficiency line breaks across it
        rather than drawing a trend through a number nobody has.
        {model.blanks.length ? (
          <>
            {" "}
            Nothing at all recorded yet for <b>{model.blanks.join(", ")}</b>.
          </>
        ) : null}
        {note ? <> {note}</> : null}
      </p>
    </>
  );
}
