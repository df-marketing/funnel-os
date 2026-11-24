import type { Cut, Stage } from "./data";
import { buildJourneyStrip, type JourneyVocabulary } from "./journey-strip";
import { roundNumber } from "./round-journey.mjs";
import { SPINE, isGroup, type Fmt } from "./spine";

export type ReportingCut = "month" | "week" | "source" | "roundsource";

type PeriodInputs = {
  stages: Stage[];
  clientId: string;
  vocabulary: JourneyVocabulary | null;
  sourceKeepsSpend: boolean;
  view: ReportingCut;
  columns: Cut[];
  total: Cut | null;
  baseline: Cut | null;
};
type PeriodRow = { key: string; label: string; fmt: Fmt; outcome: boolean };
const financial: PeriodRow[] = [
  { key: "spend", label: "Ad spend", fmt: "m", outcome: false },
  { key: "rev", label: "Recorded sales revenue", fmt: "m", outcome: true },
  { key: "roas", label: "Paid ROAS (×)", fmt: "d2", outcome: true },
];

const SENSITIVE_MEASURE_KEYS = new Set<string>(SPINE.flatMap((row) => isGroup(row) ? [] : [row.key]));

/** Shared boundary for opt-in graph/table reads. Raw JSON combines custom
 * readings and generated costs; fail closed on collisions or an unverified vocabulary. */
export function verifiedPreviewCut(cut: Cut, clientId: string, vocabulary: JourneyVocabulary | null): Cut {
  if (vocabulary === null) return { ...cut, m: {} };
  const extras = new Set(vocabulary.filter((metric) => !metric.is_core
    && (metric.client_id === null || metric.client_id === clientId)).map((metric) => metric.metric_key));
  const m = { ...cut.m } as Record<string, unknown>;
  for (const key of extras) {
    if (SENSITIVE_MEASURE_KEYS.has(key)) delete m[key];
    const derived = `cp_${key}`;
    if (extras.has(derived)) delete m[derived];
  }
  return { ...cut, m: m as Cut["m"] };
}

export function periodReporting(input: PeriodInputs) {
  const scoped = input.vocabulary?.filter((m) => m.client_id === null || m.client_id === input.clientId);
  // The RPC merges its custom payload over standard fields. Do not print a
  // core financial value that could have been replaced by a declaration.
  const collisions = new Set(scoped?.filter((m) => !m.is_core).map((m) => m.metric_key) ?? []);
  const options = buildJourneyStrip({
    stages: input.stages, clientId: input.clientId, total: null,
    vocabulary: input.vocabulary, sourceKeepsSpend: false,
  }).map((stage) => ({
    key: `stage:${stage.stage_slug}`, label: stage.stage_name,
    fmt: "i" as const,
    outcome: true,
  }));
  // Core weekly delivery knows when the backend withholds ad allocation. Its
  // custom-ads adjunct does not. Do not render unverified weekly custom ads
  // (nor imply their Total/Baseline can be reconciled from the visible weeks).
  const bySource = input.view === "source" || input.view === "roundsource";
  const customStageSlugs = new Set(input.stages
    .filter((stage) => stage.client_id === input.clientId
      && scoped?.some((definition) => !definition.is_core && definition.metric === stage.stage_metric))
    .map((stage) => stage.stage_slug));
  const safeCustomAds = input.view === "month" && input.sourceKeepsSpend;
  const project = (cut: Cut | null) => {
    if (!cut) return null;
    const raw = cut.m as Record<string, unknown>;
    const m = Object.fromEntries(financial.map(({ key }) => [
      key, scoped && !collisions.has(key) ? roundNumber(raw?.[key]) : null,
    ])) as Record<string, number | null> & { spend: number | null };
    for (const stage of buildJourneyStrip({
      stages: input.stages, clientId: input.clientId, total: cut, vocabulary: input.vocabulary,
      sourceKeepsSpend: safeCustomAds,
    })) {
      // SQL has no custom event/delivery source cut. Do not paint a custom
      // Total or a similarly named raw field into any per-source cell.
      m[`stage:${stage.stage_slug}`] = bySource && customStageSlugs.has(stage.stage_slug) ? null : stage.value;
    }
    return { ...cut, m };
  };
  const columns = input.columns.map(project).filter((c) => c !== null);
  const baseline = project(input.baseline);
  const total = project(input.total);
  return {
    rows: [financial[0], ...options, ...financial.slice(1)],
    columns, baseline, total,
    sourceCustomUnavailable: bySource && customStageSlugs.size > 0,
    weeklyAdsUnavailable: input.view === "week" && !!scoped?.some((metric) => !metric.is_core && metric.source === "ads"
      && input.stages.some((stage) => stage.client_id === input.clientId && stage.stage_metric === metric.metric)),
  };
}
