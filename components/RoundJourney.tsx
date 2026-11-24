import Link from "next/link";
import type { Dashboard } from "@/lib/funnel/data";
import { createReadClient } from "@/lib/supabase/read";
import { verifiedPreviewCut } from "@/lib/funnel/period-reporting";
import { keepsSpend } from "@/lib/funnel/filters";
import { projectRoundJourney, roundPlotCuts } from "@/lib/funnel/round-journey.mjs";
import { chartModel } from "@/lib/funnel/chart";
import { SpineTable } from "./SpineTable";
import { SpineChart } from "./SpineChart";

export async function RoundJourney({ data, clientId, currency, params, reportingPreview = false }: {
  data: Pick<Dashboard, "stages" | "baseline" | "total" | "columns" | "filter" | "elsewhere" | "reportingPreview">;
  clientId: string;
  currency?: string | null;
  params: Record<string, string | undefined>;
  reportingPreview?: boolean;
}) {
  // The page has already checked client access. These are metadata reads only;
  // figures still come from the existing filtered fo_cut calls.
  let vocabulary;
  if (reportingPreview) {
    vocabulary = data.reportingPreview?.vocabulary ?? null;
  } else {
    const db = createReadClient();
    const fields = "metric, metric_key, client_id, source, event_type, is_core";
    const [global, scoped] = await Promise.all([
      db.from("journey_metrics").select(fields).is("client_id", null),
      db.from("journey_metrics").select(fields).eq("client_id", clientId),
    ]);
    vocabulary = global.error || scoped.error ? [] : [...(global.data ?? []), ...(scoped.data ?? [])];
  }
  const trusted = (cut: Dashboard["total"]) => reportingPreview && cut
    ? verifiedPreviewCut(cut, clientId, vocabulary) : cut;
  const projection = projectRoundJourney({
    stages: reportingPreview ? data.stages.filter((item) => item.client_id === clientId) : data.stages,
    clientId, vocabulary: vocabulary ?? [],
    sourceKeepsSpend: keepsSpend(data.filter.source),
    baseline: trusted(data.baseline), total: trusted(data.total),
    cuts: data.columns.map((cut) => trusted(cut)!),
  });
  const graph = params.mode === "graph";
  const selected = projection.choices.find((c) => c.key === params.roundMetric)
    ?? projection.choices.find((c) => projection.cuts.some((cut) => cut.m[c.key] != null))
    ?? projection.choices[0];
  const href = (mode: string, metric = selected?.key, clearAsset = false) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value && (key !== "reporting" || reportingPreview)) q.set(key, value);
    q.set("client", clientId); q.set("view", "round"); q.set("mode", mode);
    if (clearAsset) q.delete("asset");
    if (metric) q.set("roundMetric", metric);
    return `/?${q}`;
  };
  // Reuse the existing plot geometry, with its one outcome slot populated
  // exclusively from the same projected cells the table renders.
  const selectedFmt = selected ? projection.rows.find((row) => row.key === selected.key)?.fmt ?? "i" : "i";
  const model = selected ? chartModel(roundPlotCuts(projection, selected.key), "leads",
    reportingPreview ? { reportingPreview: true, option: {
      key: selected.key, metric: "leads", short: selected.label, label: selected.label,
      fmt: selectedFmt, kind: "amount", betterWhen: "higher",
    } } : undefined) : null;
  if (model && selected) {
    model.right.label = selected.label;
    model.vs = { ...model.vs, label: selected.label, short: selected.label };
  }
  return <>
    <div className="pane-controls">
      <div className="seg small" role="group" aria-label="View">
        <Link href={href("table")} aria-pressed={!graph}>Table</Link>
        <Link href={href("graph")} aria-pressed={graph}>Graph</Link>
      </div>
      {data.filter.asset ? <Link className="drill-chip" href={href(graph ? "graph" : "table", selected?.key, true)}
        title={`Stop looking at ${data.filter.asset} on its own`}>
        <span>{data.filter.asset}</span><b aria-hidden>×</b>
      </Link> : null}
      {graph ? <div className="vs"><div className="vs-row">
        <span className="filter-label">Spend vs</span>
        <div className="filter-opts">
          {projection.choices.map((c) => <Link key={c.key} href={href("graph", c.key)}
            className="filter-opt" aria-pressed={selected?.key === c.key}>{c.label}</Link>)}
        </div>
      </div></div> : null}
    </div>
    <div className="pane-head"><h1>By round</h1><p>Configured journey stages, one column per round.</p></div>
    {!projection.choices.length ? <div className="notice info">No journey stages are configured.</div> : null}
    {projection.unavailable.length ? <div className="notice info">
      <span className="ico">?</span><div>{projection.unavailable.map((message) =>
        <p key={message}>{message}</p>)}</div>
    </div> : null}
    {graph ? model ? <SpineChart title="Input against outcome"
      sub={`ad spend against ${selected?.label ?? "configured stage"}`} cuts={projection.cuts}
      vs="leads" model={model} reportingPreview={reportingPreview} currency={currency} elsewhere={data.elsewhere}
      notice="The Table view shows the Total and Baseline separately; neither is plotted as a round." /> : null :
      <SpineTable title="Round comparison" sub="configured journey order · one column per round"
        rows={projection.rows} reportingPreview={reportingPreview} baseline={projection.baseline} total={projection.total}
        cuts={projection.cuts} currency={currency}
        note="Unavailable measurements remain —; measured zero remains 0. Custom rates and costs are not derived." />}
  </>;
}
