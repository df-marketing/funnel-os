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
