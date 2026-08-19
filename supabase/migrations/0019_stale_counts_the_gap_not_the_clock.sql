-- ═══════════════════════════════════════════════════════════════════════════
-- 0019 — "Sales 0d stale" is a sentence that argues with itself.
--
-- 0014 got the RULE right: a source is stale when its coverage ends before the
-- last round that has already finished, because time passing is not evidence of
-- missing data — missing data is. Sales covers 20 May, rounds run to 27 May, so
-- 0526-03 has no sales and the flag is correct.
--
-- The header then printed that flag next to `days_since`, which counts days
-- since the file was imported. Import it this morning and the pill reads
-- "Sales 0d stale": stale, and zero days so. Two true facts about two different
-- clocks, glued into one number that means nothing. It has now sent two people
-- looking for a bug that isn't there.
--
-- days_behind is the number the sentence was always trying to say: how many
-- days of finished rounds this source says nothing about. It is exactly the
-- distance the staleness test itself measures, so the pill and the rule can no
-- longer disagree.
--
-- NULL when the source is not behind. A source that is stale only because
-- someone set stale_flag by hand has no gap to report, and the header prints
-- "Sales stale" with no number rather than inventing a zero — the same reason
-- every other absent figure on the screen reads "—".
--
-- days_since stays exactly as it was. It is a fact about the clock, it makes no
-- claim, and the Import tab still shows it as "Last import".
--
-- Appended, not replaced: create or replace view only permits adding columns at
-- the end, so days_behind goes last and every existing reader is untouched.
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
  extract(day from now() - l.imported_at)::int as days_since,
  -- how far short of the finished rounds this source stops, in days
  case
    when h.covered_through is not null
     and l.coverage_end is not null
     and l.coverage_end < h.covered_through
    then (h.covered_through - l.coverage_end)::int
  end as days_behind
from latest l
left join horizon h on h.client_id = l.client_id
order by l.client_id, l.source;

grant select on v_import_status to anon, authenticated;
