-- 1,675ms OF A 2,062ms QUERY, SPENT PRODUCING AN EMPTY OBJECT.
--
-- From the plan for v_journey_strip, not from a theory:
--
--   CTE extras
--     -> CTE Scan on journey_clients  (actual time=712.492..1675.166 rows=2 loops=1)
--          Output: fo_stage_extras('v_journey_strip', c_5.client_id)
--          Buffers: shared hit=6939
--
--   Execution Time: 2061.871 ms
--
-- `fo_stage_extras` costs about 840ms a call and is called twice. What the two
-- calls return:
--
--   shely            {}
--   northsea_supply  {"TOTAL": {"appt": 119}}
--
-- There is exactly one non-core event metric in the system — `appointments` —
-- and Shely has no appointment events at all. So opening Shely's homepage
-- scans v_events joined to v_rounds to establish that the answer is {}, and
-- then does it again for Northsea, a client the query did not ask for.
--
-- The second call happens because `extras` is MATERIALIZED. Materialisation is
-- an optimisation fence — that is exactly why 35 used it — and a fence blocks
-- the outer `client_id = 'shely'` from getting in as much as it blocks a qual
-- from getting out.
--
-- ── TWO PARTS. RUN PART 1 FIRST; IT MAKES THE APP WORK TODAY. ──────────────

-- ═══ PART 1 — the cliff ════════════════════════════════════════════════════
--
-- Every screen sits between 1.5 and 2.4 seconds against a 3-second limit, so
-- the difference between working and a blank page with an error is a tenth of
-- a second of noise. That is not a margin, and chasing individual queries under
-- it has cost seven migrations and one outage.
--
-- Fifteen seconds is not a licence to be slow — part 2 still makes it fast, and
-- a screen that takes fifteen seconds is a bug either way. It removes the cliff
-- so that being slow degrades instead of failing.

alter role anon set statement_timeout = '15s';
alter role authenticated set statement_timeout = '15s';

-- The setting applies to connections made after it is set. PostgREST pools
-- connections, so give it a moment or two before re-testing.


-- ═══ PART 2 — stop scanning for something that was never declared ══════════

begin;

/**
 * Counts for every declared metric, bucketed the way the cut buckets.
 *
 * UNCHANGED IN WHAT IT RETURNS. The join to journey_metrics already restricted
 * this to event types somebody declared; `wanted` states that restriction where
 * the planner can apply it to v_events BEFORE the join rather than after, so a
 * client with no appointment rows stops paying to scan every event it has.
 *
 * The empty case is the common one and was the most expensive: one metric is
 * declared across the whole system, and the client whose homepage this is has
 * no rows of that type.
 */
create or replace function fo_stage_extras(p_view text, p_client text)
returns jsonb
language sql
stable
as $$
  with wanted as (
    select distinct jm.event_type
    from journey_metrics jm
    where jm.source = 'events'
      and jm.is_core = false
      and jm.event_type is not null
  ),
  counted as (
    select
      case p_view
        when 'v_metrics_by_round'  then e.round_id
        when 'v_metrics_baseline'  then e.round_id
        when 'v_metrics_by_month'  then to_char(date_trunc('month', (e.event_date at time zone 'Asia/Singapore')::date), 'YYYY-MM')
        when 'v_metrics_by_week'   then to_char(date_trunc('week',  (e.event_date at time zone 'Asia/Singapore')::date), 'IYYY-"W"IW')
        when 'v_metrics_total'     then 'TOTAL'
        when 'v_journey_strip'     then 'TOTAL'
      end as cut_key,
      jm.metric_key,
      count(*)::bigint as n
    from v_events e
    join v_rounds r on r.round_id = e.round_id
    join journey_metrics jm
      on  jm.source = 'events'
      and jm.is_core = false
      and jm.event_type = e.event_type
      and (jm.product is null or e.product = jm.product)
    where r.client_id = p_client
      -- Redundant against the join above, and that is the point: as a plain
      -- restriction it can reach the scan of v_events, where idx_events_type
      -- lives. As a join condition it could only be applied afterwards.
      and e.event_type in (select event_type from wanted)
    group by 1, 2
  ),
  per_key as (
    select cut_key, jsonb_object_agg(metric_key, n) as x
    from counted where cut_key is not null
    group by cut_key
  )
  select coalesce(jsonb_object_agg(cut_key, x), '{}'::jsonb) from per_key;
$$;

grant execute on function fo_stage_extras(text, text) to anon, authenticated;

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- 1. SAME ANSWERS. This first, because a fast function returning different
--    numbers is worse than a slow one:
--
--      select fo_stage_extras('v_journey_strip', 'shely');
--        -- {}
--      select fo_stage_extras('v_journey_strip', 'northsea_supply');
--        -- {"TOTAL": {"appt": 119}}
--
--    Northsea's 119 appointments must still be 119. That figure is the entire
--    reason this function exists.
--
-- 2. FASTER:
--
--      explain (analyze) select fo_stage_extras('v_journey_strip', 'shely');
--        -- was ~840ms
--
--      v_journey_strip was 2.36s
--      fo_cut('v_journey_strip', 'shely') was a timeout
--
-- 3. THE APP. Part 1 alone should bring every screen back even if part 2 helps
--    less than hoped. If a page still fails after both, the remaining cost is
--    somewhere this plan did not reach and the next step is its own EXPLAIN,
--    not another guess.
--
-- 4. THE TOTALS, unmoved:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
--    And Shely's journey strip: 434,575 impressions · 7,433 clicks · 1,889
--    leads · 682 attendance · 88 preview · 25 upsell.
