-- ═══════════════════════════════════════════════════════════════════════════
-- The parked count must answer the same question as the numbers beside it.
--
-- The integration endpoint returned stage values for a date window and parked
-- counts for all time, in one response, with nothing marking the difference.
-- An August report carried May's parked rows as its caveat.
--
-- unmatched_rows has no observation date of its own — only parked_at, which is
-- when the import ran, and this app has already learnt once that the clock is
-- not the data (0019). What a parked row does have is the batch it arrived in,
-- and a batch knows the span it covers. So a row is placed in the window when
-- its batch's coverage overlaps it: the same overlap test the round filter uses
-- in 0023, applied one level up.
--
-- That is coarser than the stage numbers, which is why the shape says so rather
-- than pretending otherwise. `undated` counts rows that no window can place —
-- a batch with no coverage dates, or no batch at all — so they can never be
-- quietly dropped from both the in-window count and the caller's attention.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function fo_unmatched_cut(
  p_client text,
  p_from   date default null,
  p_to     date default null
) returns jsonb
language sql
stable
as $$
  with waiting as (
    select
      u.reason,
      b.coverage_start,
      b.coverage_end
    from unmatched_rows u
    left join import_batches b on b.batch_id = u.import_batch_id
    where u.client_id = p_client
      and not coalesce(u.auto_resolved, false)
      and u.resolved_at is null
  ),
  placed as (
    select
      reason,
      (coverage_start is not null and coverage_end is not null) as datable,
      (
        coverage_start is not null and coverage_end is not null
        and (p_from is null or coverage_end   >= p_from)
        and (p_to   is null or coverage_start <= p_to)
      ) as in_window
    from waiting
  )
  select jsonb_build_object(
    'count',   (select count(*) from placed where in_window),
    'allTime', (select count(*) from placed),
    'undated', (select count(*) from placed where not datable),
    'reasons', coalesce((
      select jsonb_object_agg(coalesce(reason, 'unknown'), n)
      from (
        select reason, count(*) as n
        from placed
        where in_window
        group by reason
      ) grouped
    ), '{}'::jsonb)
  );
$$;

grant execute on function fo_unmatched_cut(text, date, date) to anon, authenticated;
