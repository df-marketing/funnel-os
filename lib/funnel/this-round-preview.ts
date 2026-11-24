import type { Cut, Stage } from "./data";
import type { JourneyVocabulary } from "./journey-strip";
import { previewCell } from "./chart";
import { monthOf } from "./cuts";
import { projectRoundJourney } from "./round-journey.mjs";

export type RoundWindow = {
  round_id: string;
  code?: string | null;
  start_date: string;
  end_date: string;
};

export type ThisRoundPreviewData = {
  stages: Stage[];
  /** Null means metric scope could not be confirmed. Fail closed on stage values. */
  vocabulary: JourneyVocabulary | null;
  /** These are the fully filtered By Round rows, not the legacy This Round cut. */
  roundCuts: Cut[];
  monthCuts: Cut[];
  roundSchedule: RoundWindow[];
  sourceKeepsSpend: boolean;
  baseline?: Cut | null;
};

const dateKey = /^\d{4}-\d{2}-\d{2}$/;
const monthKey = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const lex = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function validDate(s: string) {
  if (!dateKey.test(s)) return false;
  const day = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === s;
}

/** Repeated IDs are evidence of inconsistent configuration or a truncated
 * join: never choose or sum one of the copies arbitrarily. */
function uniqueBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const seen = new Map<string, T>();
  const repeated = new Set<string>();
  for (const row of rows) {
    const id = key(row);
    if (!id || repeated.has(id)) continue;
    if (seen.has(id)) {
      seen.delete(id);
      repeated.add(id);
    } else seen.set(id, row);
  }
  return seen;
}

type ProjectedCut = ReturnType<typeof projectRoundJourney>["cuts"][number];
type ProjectedRow = ReturnType<typeof projectRoundJourney>["rows"][number];
export type PreviewMove = ProjectedRow & {
  value: number | null;
  previous: number | null;
  baseline: number | null;
  change: { kind: "unavailable" | "same" | "from-zero" | "percent"; value?: number };
};

function comparison(value: number | null, previous: number | null): PreviewMove["change"] {
  if (value === null || previous === null) return { kind: "unavailable" };
  if (value === previous) return { kind: "same" };
  if (previous === 0) return { kind: "from-zero", value };
  return { kind: "percent", value: ((value - previous) / Math.abs(previous)) * 100 };
}

function moves(rows: ProjectedRow[], current: ProjectedCut | null, prior: ProjectedCut | null, baseline: ProjectedCut | null) {
  return rows.map((row): PreviewMove => {
    const value = current?.m[row.key] ?? null;
    const previous = prior?.m[row.key] ?? null;
    return { ...row, value, previous, baseline: baseline?.m[row.key] ?? null, change: comparison(value, previous) };
  });
}

const coreStageKeys = new Set(["impr", "clicks", "leads", "att", "prevBuy", "midBuy"]);

/** Reuse By Round's configured value projection. Its RPC merges declared
 * measurements and costs into m, so conflicting keys must be blanked rather
 * than passed off as a trusted core value. */
function project(
  data: ThisRoundPreviewData, clientId: string, cuts: Cut[], baseline: Cut | null,
) {
  const stages = [...uniqueBy(data.stages.filter((stage) => stage.client_id === clientId),
    (stage) => stage.stage_slug).values()]
    .sort((a, b) => a.stage_order - b.stage_order || lex(a.stage_slug, b.stage_slug));
  const vocabulary = (data.vocabulary ?? []).filter((item) => item.client_id === null || item.client_id === clientId);
  const extraKeys = new Set(vocabulary.filter((item) => !item.is_core).map((item) => item.metric_key));
  const unverifiable = new Set<string>();
  for (const key of extraKeys) {
    if (coreStageKeys.has(key) || key === "spend") unverifiable.add(key);
    const costKey = `cp_${key}`;
    if (extraKeys.has(costKey)) unverifiable.add(costKey);
  }
  // RPC vocabulary access can fail independently of cuts: even spend may
  // have been overwritten by an unverified declaration. Leave numbers absent.
  function verified(cut: Cut): Cut {
    if (data.vocabulary === null) return { ...cut, m: {} };
    const m = { ...(cut.m ?? {}) } as Record<string, unknown>;
    for (const key of unverifiable) delete m[key];
    return { ...cut, m: m as Cut["m"] };
  }
  return projectRoundJourney({
    stages, clientId, vocabulary, sourceKeepsSpend: data.sourceKeepsSpend,
    cuts: cuts.map(verified), baseline: baseline ? verified(baseline) : null,
    total: null,
  });
}

export function buildThisRoundPreview(
  data: ThisRoundPreviewData,
  clientId: string,
  today: string,
  requestedRound?: string,
  requestedMetric?: string,
) {
  const schedules = uniqueBy(data.roundSchedule, (row) => row.round_id);
  const roundCuts = uniqueBy(data.roundCuts, (row) => row.cut_key);
  const eligible = validDate(today) ? [...roundCuts.values()].flatMap((cut) => {
    const window = schedules.get(cut.cut_key);
    return window && validDate(window.start_date) && validDate(window.end_date)
      && window.start_date <= window.end_date && window.start_date <= today
      ? [{ cut, window }] : [];
  }).sort((a, b) => lex(b.window.start_date, a.window.start_date) || lex(a.cut.cut_key, b.cut.cut_key)) : [];
  const requested = requestedRound ? eligible.findIndex(({ cut }) => cut.cut_key === requestedRound) : -1;
  const index = requested >= 0 ? requested : 0;
  const selected = eligible[index] ?? null;
  const previous = eligible[index + 1] ?? null;
  const unavailableRound = Boolean(requestedRound && requested < 0);
  const { rows, choices, cuts: measured, baseline, unavailable } = project(
    data, clientId, [selected?.cut, previous?.cut].filter((cut): cut is Cut => cut !== undefined), data.baseline ?? null,
  );
  const roundMoves = moves(rows, measured[0] ?? null, measured[1] ?? null, baseline);
  // Focus is explicit: configuration controls what can be measured, not the
  // client's decision about what effect counts as a business goal.
  const focus = choices.some((choice) => choice.key === requestedMetric)
    ? roundMoves.find((row) => row.key === requestedMetric) ?? null : null;
  const month = selected ? monthOf(selected.window) : null;
  const months = uniqueBy(data.monthCuts.filter((cut) => monthKey.test(cut.cut_key)), (cut) => cut.cut_key);
  const currentMonth = month ? months.get(month) ?? null : null;
  // Do not substitute the newest unrelated month when this round's aggregate
  // is missing or outside the filter. Do not compare month amounts to a round.
  const previousMonth = currentMonth ? [...months.values()]
    .filter((cut) => cut.cut_key < currentMonth.cut_key)
    .sort((a, b) => lex(b.cut_key, a.cut_key))[0] ?? null : null;
  const { cuts: measuredMonths } = project(
    data, clientId, [currentMonth, previousMonth].filter((cut): cut is Cut => cut !== null), null,
  );

  return {
    eligible, selected, previous, unavailableRound, focus, choices, roundMoves,
    baseline: data.baseline ?? null, vocabularyUnavailable: data.vocabulary === null, unavailable,
    month, currentMonth, previousMonth,
    monthMoves: moves(rows, measuredMonths[0] ?? null, measuredMonths[1] ?? null, null),
  };
}

export function formatThisRoundValue(value: number | null, fmt: PreviewMove["fmt"]) {
  return previewCell(value, fmt);
}

export function formatThisRoundMove(change: PreviewMove["change"]): string {
  if (change.kind === "unavailable") return "—";
  if (change.kind === "same") return "No change";
  const n = change.value;
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (change.kind === "from-zero") return n > 0 ? "↑ from 0" : "↓ from 0";
  // Avoid displaying a nonzero but tiny change as precisely zero.
  if (n !== 0 && Math.abs(n) < 0.1) return n > 0 ? "↑ <0.1%" : "↓ <0.1%";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
