import Link from "next/link";
import type { Dashboard, Cut } from "@/lib/funnel/data";
import type { StageComparison } from "@/lib/funnel/stage-comparison";
import { createReadClient } from "@/lib/supabase/read";
import { verifiedPreviewCut } from "@/lib/funnel/period-reporting";
import { keepsSpend } from "@/lib/funnel/filters";
import { projectRoundJourney, roundPlotCuts } from "@/lib/funnel/round-journey.mjs";
import { chartModel } from "@/lib/funnel/chart";
import { SpineTable } from "./SpineTable";
import { SpineChart } from "./SpineChart";

export async function StageComparisonPane({
  comparison, data, clientId, currency, params, reportingPreview = false,
}: {
  comparison: StageComparison;
  data: Pick<Dashboard, "view" | "baseline" | "total" | "columns" | "filter" | "elsewhere" | "reportingPreview">;
  clientId: string;
  currency?: string | null;
  params: Record<string, string | undefined>;
  reportingPreview?: boolean;
}) {
  const { stage } = comparison;
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
  const trusted = (cut: Cut | null) => reportingPreview && cut ? verifiedPreviewCut(cut, clientId, vocabulary) : cut;
  const projection = projectRoundJourney({
    stages: [stage], clientId, vocabulary: vocabulary ?? [],
    sourceKeepsSpend: keepsSpend(data.filter.source) && !(reportingPreview && comparison.cut === "week"),
    baseline: trusted(data.baseline), total: trusted(data.total), cuts: data.columns.map((cut) => trusted(cut)!),
  });
  const selected = projection.choices[0];
  const graph = params.mode === "graph";
  const asset = data.filter.asset;
  const dimension = asset ? `${asset}, by round` : `By ${comparison.by}`;
  const href = (mode: "table" | "graph", pickedAsset = asset) => {
    const q = new URLSearchParams();
    for (const key of ["product", "channel", "country", "source", "audience", "attribution", "periods"] as const) {
      if (data.filter[key]) q.set(key, data.filter[key]!);
    }
    q.set("client", clientId); q.set("view", data.view); q.set("mode", mode);
    if (reportingPreview) q.set("reporting", "preview");
    if (comparison.assetCut && pickedAsset) q.set("asset", pickedAsset);
    return `/?${q}`;
  };

  const weightedPurchase = data.filter.attribution === "even_split"
    && (stage.stage_metric === "preview_purchases" || stage.stage_metric === "middle_purchases");
  const fmt = !reportingPreview && weightedPurchase ? "d2" : "i";
  const model = chartModel(roundPlotCuts(projection, selected.key), "leads",
    reportingPreview ? { reportingPreview: true, option: {
      key: selected.key, metric: "leads", short: selected.label, label: selected.label,
      fmt, kind: "amount", betterWhen: "higher",
    } } : undefined);
  model.right.label = selected.label;
  model.right.fmt = fmt;
  model.vs = { ...model.vs, label: selected.label, short: selected.label, fmt };
  const measurementExists = [projection.baseline, projection.total, ...projection.cuts]
    .some((column) => column?.m[selected.key] != null);
  const drill = comparison.assetCut && !asset ? (c: Cut) => href("table", c.group_key ?? c.cut_key) : undefined;
  return <>
    <div className="pane-controls">
      <div className="seg small" role="group" aria-label="View">
        <Link href={href("table")} aria-pressed={!graph}>Table</Link>
        <Link href={href("graph")} aria-pressed={graph}>Graph</Link>
      </div>
      {asset ? <Link className="drill-chip" href={href(graph ? "graph" : "table", null)}
        title={`Compare all ${comparison.label.toLowerCase()}`}><span>{asset}</span><b aria-hidden>×</b></Link> : null}
    </div>
    <div className="pane-head">
      <h1>{stage.stage_name}</h1>
      <p>{dimension} · configured journey stage.</p>
    </div>
    {comparison.fallback ? <div className="notice info">
      The configured breakdown ({stage.compare_dimension}) is not available for this measurement.
      Comparing by {comparison.by} instead.
    </div> : null}
    {projection.unavailable.length ? <div className="notice info">
      {projection.unavailable.map((message) => <p key={message}>{message}</p>)}
    </div> : !measurementExists ? <div className="notice info">
      No readings for {stage.stage_name} under the current filters. Missing readings are not zero.
    </div> : null}
    {graph
      ? <SpineChart title={`${stage.stage_name} comparison`} sub={dimension}
          cuts={projection.cuts} vs="leads" model={model} reportingPreview={reportingPreview} currency={currency} elsewhere={data.elsewhere} />
      : projection.cuts.length ? <SpineTable title={`${stage.stage_name} comparison`} sub={dimension}
          rows={projection.rows.map((row) => row.key === selected.key ? { ...row, fmt } : row)}
          baseline={projection.baseline} total={projection.total} cuts={projection.cuts}
          currency={currency} drillTo={drill} reportingPreview={reportingPreview}
          note={comparison.assetCut
            ? "Totals can include events that could not be assigned to an asset. Missing is —; measured zero stays zero."
            : "Missing is —; measured zero stays zero."} />
        : <div className="notice info">
            No columns match these filters. This does not mean the measurement was zero.
            {data.elsewhere ? <> Try All time{data.elsewhere.length ? ` or ${data.elsewhere.join(", ")}` : ""}.</> : null}
          </div>}
  </>;
}
