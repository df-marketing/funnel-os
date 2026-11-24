/**
 * By Round's display projection. Never derive custom counts, rates or costs.
 * A missing/unsafe number remains null; zero remains zero.
 */
const CORE = Object.freeze({
  impressions: "impr", clicks: "clicks", leads: "leads",
  attendance: "att", preview_purchases: "prevBuy", middle_purchases: "midBuy",
});

/** @param {unknown} value */
export function roundNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @typedef {{metric: string, metric_key: string, client_id: string|null,
 * source: string, event_type: string|null, is_core: boolean}} Vocabulary
 * @param {{
 * stages: import("./data").Stage[], vocabulary: Vocabulary[], clientId: string,
 * sourceKeepsSpend: boolean,
 * baseline: import("./data").Cut|null, total: import("./data").Cut|null,
 * cuts: import("./data").Cut[]
 * }} input
 */
export function projectRoundJourney(input) {
  const stages = [...input.stages].sort((a, b) => a.stage_order - b.stage_order);
  const definitions = stages.map((s) => {
    const name = s.stage_metric ?? "";
    const core = Object.hasOwn(CORE, name) ? /** @type {Record<string,string>} */ (CORE)[name] : undefined;
    const candidates = input.vocabulary.filter((v) =>
      v.metric === s.stage_metric && (v.client_id === null || v.client_id === input.clientId));
    const declared = candidates.length === 1 ? candidates[0] : null;
    let reason = "";
    if (!core) {
      if (!declared) reason = "measurement mapping is missing or ambiguous";
      else if (declared.is_core || !["ads", "events"].includes(declared.source)
        || !declared.metric_key || ["spend", "reach", "freq", "prevRev", "midRev", "prevPrice", "midPrice", "rev",
          "ctr", "leadgen", "attPct", "prevPct", "midPct", "cpm", "cpc", "cpl", "cpAtt",
          "cpa", "prevAov", "prevRoas", "midAov", "midRoas", "roas", ...Object.values(CORE)].includes(declared.metric_key))
        reason = "measurement mapping cannot be used safely";
      else if (input.vocabulary.filter((v) => !v.is_core
        && (v.client_id === null || v.client_id === input.clientId)
        && v.metric_key === declared.metric_key).length > 1)
        reason = "multiple declarations contribute to this measurement";
      else if (declared.source === "events" && declared.event_type === "sale")
        reason = "custom sale counts are unavailable because round credit may differ from the configured attribution";
      else if (declared.source === "events" && !declared.event_type)
        reason = "event type is not configured";
      else if (declared.source === "ads" && !input.sourceKeepsSpend)
        reason = "custom ads counts are unavailable with this source filter";
    }
    return {
      key: `journey:${s.stage_order}:${s.stage_slug}`,
      label: s.stage_name,
      metricKey: core ?? declared?.metric_key ?? null,
      reason,
    };
  });
  /** @param {import("./data").Cut|null} cut */
  const project = (cut) => {
    if (!cut) return null;
    const raw = /** @type {Record<string,unknown>} */ (cut.m ?? {});
    /** @type {{spend: number|null} & Record<string,number|null>} */
    const m = { spend: roundNumber(raw.spend) };
    for (const d of definitions)
      m[d.key] = d.reason || !d.metricKey ? null : roundNumber(raw[d.metricKey]);
    return { ...cut, m };
  };
  return {
    rows: [
      { key: "spend", label: "Ads Spent", fmt: /** @type {const} */ ("m") },
      ...definitions.map((d) => ({ key: d.key, label: d.label, fmt: /** @type {const} */ ("i") })),
    ],
    choices: definitions.map((d) => ({ key: d.key, label: d.label })),
    unavailable: definitions.filter((d) => d.reason).map((d) => `${d.label}: ${d.reason}.`),
    baseline: project(input.baseline),
    total: project(input.total),
    cuts: input.cuts.map((c) => project(c)).filter((c) => c !== null),
  };
}

/**
 * Adapt projected cells to the existing chart's outcome slot without re-reading
 * or calculating any measurement.
 * @param {ReturnType<typeof projectRoundJourney>} projection
 * @param {string} key
 */
export function roundPlotCuts(projection, key) {
  return projection.cuts.map((c) => ({
    ...c, m: { spend: c.m.spend, leads: c.m[key] ?? null },
  }));
}
