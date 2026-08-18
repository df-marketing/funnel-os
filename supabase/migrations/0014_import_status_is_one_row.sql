-- ═══════════════════════════════════════════════════════════════════════════
-- THE IMPORT TAB SHOULD DESCRIBE THE LAST IMPORT, NOT EVERY ATTEMPT AT ONE.
--
-- v_import_status read `from import_batches` with no filter and no grouping,
-- so it returned every batch a client had ever produced — one row per source
-- was the intent, nine rows was the result:
--
--     ads         committed   03:11
--     ads         committed   03:28
--     attendance  DISCARDED   03:13     <-- an import that was cancelled
--     attendance  committed   03:13
--     attendance  committed   03:28
--     ...
--
-- Two things wrong with that, and the second is the serious one.
--
--   Which row wins is undefined. The Import tab and the header staleness pills
--   both read this view and take what arrives first. PostgREST does not promise
--   a view's own ORDER BY survives, so "Last import" could name an older batch
--   than the one whose rows are actually in the database.
--
--   A DISCARDED batch is reported as an import. Someone drops a file, reads the
--   diff, decides it is wrong and presses Discard — and the tab then tells them
--   that source was imported, with that file's row count and coverage. The one
--   action whose entire meaning is "this did not happen" was being recorded as
--   though it had. v_column_map already filtered on status; this view did not.
--
-- Now: one row per client and source, the newest COMMITTED batch, chosen by
-- distinct on rather than by hope.
--
-- ─── And a second fix, to what "stale" means ───────────────────────────────
--
-- It was: the last import is older than twice its expected cadence. Since the
-- cadence is written as '1 day' for every source, that reduced to "nothing has
-- been imported in the last two days" — which for an account whose most recent
-- round ended in May is true, permanent, and useless. The header read
--
--     Ads 2d stale · Attendance 2d stale · Leads 2d stale · Sales 2d stale
--
-- on a database whose figures were completely up to date. Four warnings that
-- are always on are the same as no warning at all, and they crowd out the one
-- that matters.
--
-- Stale now means: THIS SOURCE STOPS BEFORE THE ROUNDS DO. A source is stale
-- when its coverage ends before the last round that has already finished — that
-- is, when there is a round on the books for which we are missing data. Time
-- passing is not the signal; missing data is.
--
-- On the current database that turns four permanent warnings into one true one:
-- sales covers to 20 May while rounds run to 27 May, so 0526-03 has no sales
-- data — which is exactly the thing worth saying, and it was invisible before
-- because everything was shouting.
--
-- days_since is kept as it was, for the "3 days ago" label. It is a fact about
-- the clock and makes no claim.
--
-- Requires 0005 (status column). Replaces one view; no table is touched.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_import_status as
with latest as (
  -- one batch per source: the most recent one that actually landed
  select distinct on (client_id, source)
    client_id, source, imported_at, coverage_start, coverage_end,
    row_count, column_map, expected_cadence, stale_flag
  from import_batches
  where status = 'committed'
  order by client_id, source, imported_at desc
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
  l.client_id, l.source, l.imported_at, l.coverage_start, l.coverage_end,
  l.row_count, l.column_map, l.expected_cadence,
  -- stale_flag stays respected: a batch explicitly marked stale is stale
  -- whatever the dates say.
  l.stale_flag
    or l.coverage_end is null
    or (h.covered_through is not null and l.coverage_end < h.covered_through)
    as is_stale,
  extract(day from now() - l.imported_at)::int as days_since
from latest l
left join horizon h on h.client_id = l.client_id
order by l.client_id, l.source;

grant select on v_import_status to anon, authenticated;
