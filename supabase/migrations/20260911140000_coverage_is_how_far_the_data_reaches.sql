-- ═══════════════════════════════════════════════════════════════════════════
-- 0101 — coverage is how far the data reaches, not where the last file stopped.
--
-- WHAT WAS WRONG, visible on every screen today:
--
--     Scroll 44d stale
--
-- Four Clarity curves are stored. Two cover 28 Aug – 3 Sep and were imported at
-- 06:08; two cover 15–21 July and were imported at 07:30. The header reported
-- the scroll source as 44 days behind, because 0019 reads the LATEST BATCH BY
-- IMPORT TIME and that batch is the July one. Real scroll coverage reaches
-- 3 September — eight days, not forty-four.
--
-- 0019's own title is "stale counts the gap, not the clock", and its rule is
-- right: compare where a source's data ends against the last round that has
-- finished. What it got wrong is which end. `distinct on ... order by
-- imported_at desc` answers "the last file that landed", which is the same
-- thing ONLY for a source that always moves forward.
--
-- Ads, leads, sales and attendance do move forward — each export covers the
-- days since the last one, so the newest import is also the furthest reach.
-- Scroll does not. Importing an older round is the normal case there: you
-- export Clarity for whichever round has a question, and that is frequently not
-- the most recent one. The same fault is available to any source the day
-- somebody re-imports an old file to fix a number.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- coverage_start becomes the MINIMUM and coverage_end the MAXIMUM across every
-- committed batch for that source. The pair then means what a coverage pair
-- should mean — the span this source covers — and the Import tab, which already
-- prints them as `start → end`, starts telling the truth for free.
--
-- is_stale and days_behind read the same maximum, so the pill, the figure and
-- the printed span can no longer disagree with each other.
--
-- Everything describing the IMPORT rather than the DATA stays on the latest
-- batch: imported_at, days_since, row_count, column_map, expected_cadence and
-- stale_flag. "Last import" is a fact about the clock and 0019 was right to
-- keep it that way.
--
-- ── WHAT MOVES ─────────────────────────────────────────────────────────────
--
-- Only sources that have ever been imported out of order. For Shely today that
-- is scroll alone: 44 days behind becomes 8. Ads, leads, sales and attendance
-- each have one forward-moving history, so their maximum IS their latest
-- batch's end and nothing about them changes.
--
-- The integration's coverage note improves with it. lib/integration/coverage.ts
-- takes the EARLIEST coverage_end across sources — "where coverage runs out" —
-- and was being handed a number that understated one source, so the whole
-- account read as less covered than it is.
--
-- Columns keep their names, types and order, so every reader is untouched.
--
-- Safe to re-run.
--
-- ROLLBACK: re-run the v_import_status definition from 0019.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_import_status as
with latest as (
  -- One batch per source: the most recent that actually landed. This is the
  -- IMPORT, and everything about the import still comes from here.
  select distinct on (client_id, source)
    client_id, source, imported_at,
    row_count, column_map, expected_cadence, stale_flag
  from import_batches
  where status = 'committed'
  order by client_id, source, imported_at desc
),
-- And this is the DATA: how far the source actually reaches, whatever order
-- the files arrived in.
reach as (
  select client_id, source,
         min(coverage_start) as coverage_start,
         max(coverage_end)   as coverage_end
  from import_batches
  where status = 'committed'
  group by client_id, source
),
-- The last round that has already ended. A round still running is not evidence
-- of missing data — its files are not due yet.
horizon as (
  select client_id, max(end_date) as covered_through
  from rounds
  where end_date <= current_date
  group by client_id
)
select
  l.client_id, l.source, l.imported_at,
  r.coverage_start, r.coverage_end,
  l.row_count, l.column_map, l.expected_cadence,
  -- stale_flag stays respected: a batch explicitly marked stale is stale
  -- whatever the dates say.
  l.stale_flag
    or r.coverage_end is null
    or (h.covered_through is not null and r.coverage_end < h.covered_through)
    as is_stale,
  extract(day from now() - l.imported_at)::int as days_since,
  -- how far short of the finished rounds this source stops, in days
  case
    when h.covered_through is not null
     and r.coverage_end is not null
     and r.coverage_end < h.covered_through
    then (h.covered_through - r.coverage_end)::int
  end as days_behind
from latest l
join reach r on r.client_id = l.client_id and r.source = l.source
left join horizon h on h.client_id = l.client_id
order by l.client_id, l.source;

grant select on v_import_status to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. Scroll stops claiming July. The others must not move at all:
--
--      select source, coverage_start, coverage_end, is_stale, days_behind
--        from v_import_status where client_id = 'shely' order by source;
--
--    Expect scroll covering 2026-07-15 → 2026-09-03 with days_behind 0 or null,
--    and ads / attendance / sales / leads exactly as they read before — their
--    histories only ever moved forward, so their maximum is their latest batch.
--
-- 2. The reach really is the furthest, not the newest:
--
--      select source, max(coverage_end) as furthest,
--             (array_agg(coverage_end order by imported_at desc))[1] as newest_import
--        from import_batches
--       where client_id = 'shely' and status = 'committed'
--       group by source order by source;
--
--    scroll is the row where those two differ. If any other source differs, it
--    was imported out of order too and was misreporting in the same way.
