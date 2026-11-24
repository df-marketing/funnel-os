import Link from "next/link";
import type { Dashboard } from "@/lib/funnel/data";
import { chartModel, type PreviewVsOption } from "@/lib/funnel/chart";
import { keepsSpend } from "@/lib/funnel/filters";
import { periodReporting, type ReportingCut } from "@/lib/funnel/period-reporting";
import { SpineChart } from "./SpineChart";
import { SpineTable } from "./SpineTable";

export function PeriodReporting({
  data, clientId, view, currency, mode, requestedMetric,
}: {
  data: Dashboard;
  clientId: string;
  view: ReportingCut;
  currency?: string | null;
  mode: "table" | "graph";
  requestedMetric?: string;
}) {
  const projected = periodReporting({
    stages: data.stages, clientId, vocabulary: data.reportingPreview?.vocabulary ?? null,
    sourceKeepsSpend: keepsSpend(data.filter.source),
    view, columns: data.columns, total: data.total, baseline: data.baseline,
  });
  const viewInfo = {
    month: { title: "By month", columns: "one column per reporting month" },
    week: { title: "By week", columns: "one column per reporting week" },
    source: { title: "By source", columns: "one column per acquisition source" },
    roundsource: { title: "Round × source", columns: "rounds split by acquisition source" },
  } as const;
  const { title, columns } = viewInfo[view];
  const graphable = view !== "roundsource";
  const graph = graphable && mode === "graph";
  const options: PreviewVsOption[] = projected.rows.filter((row) => row.outcome).map((row) => ({
    key: row.key, metric: row.key, short: row.label, label: row.label, fmt: row.fmt,
    kind: "amount", betterWhen: "higher",
  }));
  const selected = options.find((option) => option.key === requestedMetric)
    ?? options.find((option) => projected.columns.some((row) => row.m[option.key] != null))
    ?? options[0];
  const href = (nextMode: "table" | "graph", key = selected.key) => {
    const q = new URLSearchParams({ client: clientId, view, reporting: "preview", mode: nextMode, vs: key });
    for (const name of ["product", "channel", "country", "source", "audience", "attribution", "periods"] as const) {
      const value = data.filter[name];
      if (value) q.set(name, value);
    }
    return `/?${q}`;
  };
  const groupNote = "Unique Reach and Frequency are omitted because these inputs do not establish exact deduplicated reach for this breakdown.";
  return <>
    {graphable ? <div className="pane-controls">
      <div className="seg small" role="group" aria-label="View">
        <Link href={href("table")} aria-pressed={mode === "table"}>Table</Link>
        <Link href={href("graph")} aria-pressed={mode === "graph"}>Graph</Link>
      </div>
      {graph ? <div className="vs"><div className="vs-row">
        <span className="filter-label">Spend vs</span>
        <div className="filter-opts">{options.map((option) => <Link
          key={option.key} href={href("graph", option.key)} className="filter-opt" aria-pressed={option.key === selected.key}>
          {option.short}
        </Link>)}</div>
      </div></div> : null}
    </div> : null}
    <div className="pane-head">
      <h1>{title}</h1>
      <p>Configured journey measurements and recorded financial metrics.</p>
    </div>
    {view === "month" || view === "week" ? <div className="notice info">
      {view === "month"
        ? "Rounds are grouped whole in the month named by their code when it fits their dates; otherwise they use their opening month. Sales follow the selected credit model."
        : "Weeks group activity on its recorded dates (Singapore time). The period picker still selects whole rounds, so a retained round can contribute to neighboring calendar weeks."}
    </div> : <div className="notice info">
      Sources follow the selected credit model. Only paid acquisition has ad spend.
      {view === "roundsource" ? " Use By source or By round for a one-dimensional graph." : null}
    </div>}
    {projected.sourceCustomUnavailable ? <div className="notice info">
      Custom stage measurements are not available by acquisition source. Use By round or By month for supported custom figures.
    </div> : null}
    {projected.weeklyAdsUnavailable ? <div className="notice info">
      Custom Meta measurements are unavailable in the weekly comparison because calendar placement cannot be verified. Use By month for the named-round roll-up.
    </div> : null}
    <p>{groupNote} A dash is unavailable, not zero. Recorded sales revenue and Paid ROAS cover supported core sales only, not custom stage counts.</p>
    {graph
      ? <SpineChart title={`${title} comparison`} sub={`ad spend against ${selected.label}`}
          cuts={projected.columns} vs="leads" model={chartModel(projected.columns, "leads", { reportingPreview: true, option: selected })}
          reportingPreview currency={currency} elsewhere={data.elsewhere} />
      : projected.columns.length
        ? <SpineTable title={`${title} comparison`} sub={columns} rows={projected.rows}
            cuts={projected.columns} baseline={projected.baseline} total={projected.total} currency={currency} reportingPreview />
        : <div className="notice info">No columns match these filters. This does not mean the measurements were zero.</div>}
  </>;
}
