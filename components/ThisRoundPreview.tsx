import {
  buildThisRoundPreview, formatThisRoundMove, formatThisRoundValue,
  type PreviewMove, type ThisRoundPreviewData,
} from "@/lib/funnel/this-round-preview";

type Search = Record<string, string | string[] | undefined>;
const FILTERS = ["product", "channel", "country", "source", "audience", "attribution", "periods"] as const;
const one = (value: Search[string]) => typeof value === "string" ? value : undefined;
const rowLabel = (row: PreviewMove, currency: string | null | undefined) =>
  row.fmt === "m" && currency ? `${row.label} (${currency})` : row.label;

// Movement is against the previous column, not an assessment. Volumes,
// currencies, zero and missing all stay in their original measurement units.
function Measurements({ label, rows, selected, prior, reference, currency, focus }: {
  label: string;
  rows: PreviewMove[];
  selected: string;
  prior: string | null;
  reference?: string;
  currency?: string | null;
  focus?: string;
}) {
  return <div className="movetable-scroll">
    <table className="movetable" aria-label={label}>
      <thead><tr>
        <th scope="col">Measurement</th>
        <th scope="col" className="num">{selected}</th>
        {prior ? <th scope="col" className="num">{prior}</th> : null}
        {reference ? <th scope="col" className="num">Baseline: {reference}</th> : null}
        {prior ? <th scope="col" className="num">Change vs prior</th> : null}
      </tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key} className={focus === row.key ? "on-objective" : undefined}>
        <th scope="row">{rowLabel(row, currency)}</th>
        <td className="num strong">{formatThisRoundValue(row.value, row.fmt)}</td>
        {prior ? <td className="num">{formatThisRoundValue(row.previous, row.fmt)}</td> : null}
        {reference ? <td className="num">{formatThisRoundValue(row.baseline, row.fmt)}</td> : null}
        {prior ? <td className="num">{formatThisRoundMove(row.change)}</td> : null}
      </tr>)}</tbody>
    </table>
  </div>;
}

/** Development-only synthetic-client preview. The caller owns the gate,
 * authorization and scoped reads; this component makes no network calls. */
export function ThisRoundPreview({ clientId, currency, params, today, data }: {
  clientId: string;
  currency?: string | null;
  params: Search;
  today: string;
  data: ThisRoundPreviewData;
}) {
  const model = buildThisRoundPreview(data, clientId, today, one(params.analysisRound), one(params.analysisMetric));
  const { selected, previous, baseline, focus, currentMonth, previousMonth } = model;
  if (!selected) return <>
    <div className="pane-head"><h1>This round</h1></div>
    <div className="notice info"><span className="ico">?</span>
      <div><b>No started round is available under these filters.</b> Try another period or clear the filter.</div>
    </div>
  </>;
  const selectedLabel = selected.cut.cut_label || selected.cut.cut_key;
  const previousLabel = previous ? previous.cut.cut_label || previous.cut.cut_key : null;
  return <>
    <div className="pane-head">
      <h1>This round — {selectedLabel}</h1>
      <p>{one(params.analysisRound) && !model.unavailableRound ? "Selected round" : "Latest started round"}
        {" · "}{selected.window.start_date} to {selected.window.end_date}{" · "}same measurement scope as By Round</p>
    </div>

    <form action="/" method="get" className="pane-controls" aria-label="Select round and stage">
      <input type="hidden" name="client" value={clientId} />
      <input type="hidden" name="view" value="analysis" />
      <input type="hidden" name="reporting" value="preview" />
      {FILTERS.map((name) => {
        const value = one(params[name]);
        return value ? <input key={name} type="hidden" name={name} value={value} /> : null;
      })}
      <label className="filter-label">
        Round{" "}
        <select name="analysisRound" className="btn" defaultValue={model.unavailableRound ? "" : one(params.analysisRound) ?? ""}>
          <option value="">Latest started round</option>
          {model.eligible.map(({ cut, window }) => <option key={cut.cut_key} value={cut.cut_key}>
            {cut.cut_label || cut.cut_key} ({window.start_date} to {window.end_date})
          </option>)}
        </select>
      </label>
      {model.choices.length ? <label className="filter-label">
        Stage focus{" "}
        <select name="analysisMetric" className="btn" defaultValue={focus?.key ?? ""}>
          <option value="">All configured stages</option>
          {model.choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
        </select>
      </label> : null}
      <button type="submit" className="btn">Apply</button>
    </form>

    {model.unavailableRound ? <p className="notice info">The requested round has not started or is outside these filters. Showing the latest eligible round instead.</p> : null}
    {model.vocabularyUnavailable ? <p className="notice info">Measurement configuration could not be verified, so the preview is not showing values.</p> : null}

    {focus ? <div className="kpis" aria-label="Configured stage in focus">
      <div className="kpi">
        <span className="kpi-label">{rowLabel(focus, currency)}</span>
        <span className="kpi-value">{formatThisRoundValue(focus.value, focus.fmt)}</span>
        <span className="kpi-sub">
          {focus.change.kind === "unavailable" ? "No comparable measurement" : `${formatThisRoundMove(focus.change)} vs prior`}
        </span>
      </div>
    </div> : null}

    <section className="cro-step">
      <div className="cro-head"><div><h2>Round by round</h2></div></div>
      <div className="cro-body">
        {previousLabel ? <p className="cro-lead">Compared with the prior eligible round in the selected history: {previousLabel}.</p>
          : <p className="cro-lead">There is no earlier comparison under the active filters.</p>}
        <Measurements label="Configured journey measurements by round" rows={model.roundMoves}
          selected={selectedLabel} prior={previousLabel} reference={baseline ? baseline.cut_label || baseline.cut_key : undefined}
          focus={focus?.key} currency={currency} />
        {!model.choices.length ? <p className="cro-foot">This client has no verified configured stages for this view.</p> : null}
        <p className="cro-foot">A dash means unavailable, not zero. No conversion rates or efficiency estimates are inferred.</p>
      </div>
    </section>

    <section className="cro-step">
      <div className="cro-head"><div><h2>Named-month context</h2></div></div>
      <div className="cro-body">
        <p className="cro-lead">These are aggregates for the rounds named for each month under the active filters. They are not calendar month-to-date results.</p>
        {currentMonth ? <>
          {!previousMonth ? <p className="cro-foot">No earlier named month is available under these filters.</p> : null}
          <Measurements label="Named-month measurements" rows={model.monthMoves}
            selected={currentMonth.cut_label || currentMonth.cut_key}
            prior={previousMonth ? previousMonth.cut_label || previousMonth.cut_key : null} currency={currency} />
        </> : <p className="cro-foot">The selected round’s named month{model.month ? ` (${model.month})` : ""} has no available aggregate under these filters.</p>}
      </div>
    </section>

    <p className="cro-foot">Asset recommendations are not shown in this preview because their inputs do not share all of the active filters and credit settings.</p>
  </>;
}
