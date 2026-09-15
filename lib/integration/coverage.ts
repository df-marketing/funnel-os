/**
 * How far the imported data actually reaches, for the integration API.
 *
 * v_import_status carries one row per source. A single "last observation date"
 * has to pick one of them, and picking the newest is the wrong way round:
 * shely's ads reach 2026-05-31 while attendance and sales stop on 05-28. Told
 * the window runs to 05-31, Ground Up would compute a close rate whose
 * numerator is missing three days and never know it.
 *
 * So the answer is the EARLIEST end, not the latest — where coverage runs out,
 * not how far the best-covered file happens to go.
 */
export type ImportStatusRow = {
  source: string;
  imported_at: string;
  coverage_start: string | null;
  coverage_end: string | null;
  is_stale: boolean;
  days_behind: number | null;
};

/**
 * A source with no coverage_end has no known reach, so it makes the whole
 * answer unknown rather than being quietly skipped.
 *
 * This can still only speak for sources that have committed a batch: one never
 * imported at all is absent from v_import_status entirely, and no single date
 * can report that. The per-source list in the response is what shows it.
 */
export function coverageEnds(sources: ImportStatusRow[]): string | null {
  if (!sources.length) return null;
  let earliest: string | null = null;
  for (const source of sources) {
    if (!source.coverage_end) return null;
    if (earliest === null || source.coverage_end < earliest) earliest = source.coverage_end;
  }
  return earliest;
}

/** The most recent import across every source — a fact about the clock, not about reach. */
export function lastImported(sources: ImportStatusRow[]): string | null {
  return sources.reduce<string | null>(
    (latest, source) => (latest === null || source.imported_at > latest ? source.imported_at : latest),
    null,
  );
}

/**
 * The caveat, at the top level of every read.
 *
 * These two fields already existed, nested inside `coverage`. That was enough
 * to be correct and not enough to be noticed: a caller writing
 * `data.metrics.roas` gets a number, and nothing about the expression it is
 * written in suggests there is a second field deciding whether the number means
 * anything. The one that got missed is the one that matters — a stale ROAS is
 * not a slightly-old ROAS, it is a ratio whose numerator stopped before its
 * denominator did.
 *
 * So it is hoisted. Same values, same source, spread beside the payload rather
 * than under it, so `anySourceStale` sits at the same depth as the numbers it
 * qualifies and a caller has to step over it rather than down into it.
 *
 * `coverage` keeps both fields as well. This is additive on purpose — AcqOS
 * reads `coverage.lastObservationDate` today, and a contract change that
 * silently moves a field is how the caveat gets lost a second time.
 */
export function staleness(sources: ImportStatusRow[]) {
  return {
    /** True if ANY source is behind. One short file makes the whole read partial. */
    anySourceStale: sources.some((source) => source.is_stale),
    /** Where coverage runs out — the EARLIEST end, per the note above. */
    lastObservationDate: coverageEnds(sources),
    /** The worst gap, so a caller can decide how stale is too stale. */
    daysBehind: sources.reduce<number | null>(
      (worst, source) =>
        source.days_behind === null || !source.is_stale ? worst
          : worst === null || source.days_behind > worst ? source.days_behind : worst,
      null,
    ),
    /** Which sources are short, named. An empty array reads as "none are". */
    staleSources: sources.filter((source) => source.is_stale).map((source) => source.source),
  };
}
