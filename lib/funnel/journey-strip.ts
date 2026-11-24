import type { Cut, Stage, StripCard } from "./data";
import { projectRoundJourney, roundNumber } from "./round-journey.mjs";

export type JourneyVocabulary = Parameters<typeof projectRoundJourney>[0]["vocabulary"];

// Keep the filter-aware core ratios already provided by the reporting layer.
// Only custom stages use the preceding configured stage as their denominator.
const CORE = {
  impressions: { value: "impr" },
  clicks: { value: "clicks", rate: "ctr" },
  leads: { value: "leads", rate: "leadgen" },
  attendance: { value: "att", rate: "attPct" },
  preview_purchases: { value: "prevBuy", rate: "prevPct" },
  middle_purchases: { value: "midBuy", rate: "midPct" },
} as const;
const coreDefinitions = CORE as Record<string, { value: string; rate?: string }>;

const coreKeys = new Set(Object.values(coreDefinitions).flatMap(({ value, rate }) => (
  rate ? [value, rate] : [value]
)));

export function buildJourneyStrip({
  stages, clientId, total, vocabulary, sourceKeepsSpend,
}: {
  stages: Stage[];
  clientId: string;
  total: Cut | null;
  /** Null means scope/availability could not be verified; do not trust totals. */
  vocabulary: JourneyVocabulary | null;
  sourceKeepsSpend: boolean;
}): StripCard[] {
  const configured = stages.filter((stage) => stage.client_id === clientId);
  const occurrences = new Map<string, number>();
  for (const stage of configured) {
    occurrences.set(stage.stage_slug, (occurrences.get(stage.stage_slug) ?? 0) + 1);
  }
  // The stage list is the record of what exists, not the old metrics strip.
  // If even the canonical config has conflicting navigation IDs, do not pick
  // a row arbitrarily or calculate ratios across the missing stage.
  const canonical = configured.filter((stage) => stage.stage_slug && occurrences.get(stage.stage_slug) === 1)
    .sort((a, b) => a.stage_order - b.stage_order);
  const ordered = canonical.length === configured.length
    && new Set(canonical.map((stage) => stage.stage_order)).size === canonical.length;
  const scoped = (vocabulary ?? []).filter((item) => item.client_id === null || item.client_id === clientId);

  // fo_add_stage_costs merges declared keys and generated cp_<key> fields over
  // core totals. Do not read a key that may have been overwritten. This also
  // protects a custom count named the same as another key's generated cost.
  const extras = new Set(scoped.filter((item) => !item.is_core).map((item) => item.metric_key));
  const readings = vocabulary !== null && total !== null ? { ...total.m } as Record<string, unknown> : {};
  for (const key of extras) {
    if (coreKeys.has(key)) delete readings[key];
    const derived = `cp_${key}`;
    if (extras.has(derived)) delete readings[derived];
  }
  const projection = projectRoundJourney({
    stages: canonical, clientId, vocabulary: scoped, sourceKeepsSpend,
    baseline: null, cuts: [],
    total: total && vocabulary !== null ? { ...total, m: readings as Cut["m"] } : null,
  });

  let previous: number | null = null;
  return canonical.map((stage, index) => {
    const value = projection.total?.m[projection.choices[index].key] ?? null;
    const metric = stage.stage_metric ?? "";
    const core = Object.hasOwn(CORE, metric) ? coreDefinitions[metric] : undefined;
    const customRate = !core && ordered && value !== null && previous !== null && previous > 0
      ? (value / previous) * 100 : null;
    const rate = value === null ? null :
      core ? (core.rate ? roundNumber(readings[core.rate]) : null) : roundNumber(customRate);
    previous = value;
    return { ...stage, value, rate };
  });
}
