-- Stop paying to build an empty object on every read.
--
-- WHAT WAS MEASURED, 21 September 2026, against production.
--
-- fo_cut calls fo_stage_extras unconditionally and only afterwards asks whether
-- the result was empty:
--
--     v_extras := fo_stage_extras(p_view, p_client);
--     if v_extras <> '{}'::jsonb then ...          -- 0068_a_filter_is_a_set.sql
--
-- Timed on its own, for shely:
--
--     v_metrics_total       583ms   returned {}
--     v_metrics_by_round    522ms   returned {}
--     v_journey_strip       448ms   returned {}
--     v_metrics_by_lp       410ms   returned {}
--
-- Net of a ~220ms round trip that is roughly 200-360ms of real work per call,
-- producing nothing. A filter change fires four fo_cut calls, so somewhere near
-- a second of CPU per interaction is spent building empty objects — on a
-- shared-CPU nano instance where three concurrent reads have already produced a
-- statement timeout.
--
-- WHY IT IS EMPTY. journey_metrics holds seven rows and exactly one is
-- non-core: `appointments`, global, source 'events'. So:
--
--   * the EVENTS branch is live but finds no appointment events for this
--     client, after scanning v_events joined to v_rounds to discover that;
--   * the ADS branch is pure waste. Nothing declares an ads measure — the
--     migration that added it said so at the time — yet it still scans
--     v_ads_measures joined to v_rounds on every single call.
--
-- v_rounds is not a cheap thing to scan twice for nothing. It runs
-- fo_filter_people_ok and fo_country_selection per round.
--
-- THE FIX is two one-time filters. Each branch gains an uncorrelated EXISTS
-- over `declared`, which the planner evaluates once as an InitPlan and uses to
-- skip the branch entirely rather than scanning to find nothing.
--
-- NOTHING ABOUT THE ANSWER CHANGES. A branch is skipped only when no row could
-- have contributed to it: no declared metric of that source means that branch's
-- join could only ever produce zero rows. The day somebody declares an ads
-- measure, the EXISTS is true and the branch runs exactly as it does today.
--
-- This is the conservative half of the problem. The events branch still scans
-- to find nothing whenever a client has no appointment events, because `events`
-- has no client_id and finding out costs the same join. Left alone deliberately
-- — it is live, it is correct, and guessing at it is how a read starts
-- disagreeing with itself.
--
-- SAFE TO RE-RUN. create or replace, same signature, same grants.

create or replace function fo_stage_extras(p_view text, p_client text)
returns jsonb
language sql
stable
as $$
  with
  -- The declared metrics this client is entitled to: its own, plus the global
  -- ones. Same rule the importer applies when choosing which headers to map.
  declared as (
    select jm.metric, jm.metric_key, jm.source, jm.event_type, jm.product
    from journey_metrics jm
    where jm.is_core = false
      and (jm.client_id is null or jm.client_id = p_client)
  ),
  wanted as (
    select distinct d.event_type from declared d
    where d.source = 'events' and d.event_type is not null
  ),
  ev_counted as (
    select
      case p_view
        when 'v_metrics_by_round'  then e.round_id
        when 'v_metrics_baseline'  then e.round_id
        -- The round's named month, not the event's calendar month. The anchor
        -- always sits inside the named month, so this IS fo_round_month without
        -- the per-row lookup that function costs.
        when 'v_metrics_by_month'  then to_char(fo_round_anchor(r.code, r.start_date, r.end_date), 'YYYY-MM')
        when 'v_metrics_by_week'   then to_char(date_trunc('week', (e.event_date at time zone 'Asia/Singapore')::date), 'IYYY-"W"IW')
        when 'v_metrics_total'     then 'TOTAL'
        when 'v_journey_strip'     then 'TOTAL'
      end as cut_key,
      d.metric_key,
      count(*)::numeric as n
    from v_events e
    join v_rounds r on r.round_id = e.round_id
    join declared d
      on  d.source = 'events'
      and d.event_type = e.event_type
      and (d.product is null or e.product = d.product)
    where r.client_id = p_client
      -- Redundant against the join above, and that is the point: as a plain
      -- restriction it can reach the scan of v_events, where idx_events_type
      -- lives. As a join condition it could only be applied afterwards.
      and e.event_type in (select event_type from wanted)
      -- ONE-TIME FILTER. Uncorrelated, so the planner runs it once as an
      -- InitPlan and skips this whole branch when nothing declares an events
      -- metric, rather than scanning v_events to find nothing.
      and (select exists (select 1 from declared d2 where d2.source = 'events'))
    group by 1, 2
  ),
  /*
   * THE BRANCH THAT WAS MISSING.
   *
   * v_ads_measures rather than v_ads because v_ads froze its column list before
   * `measures` existed (20260909072902 says so, and 20260911100000 learned it
   * the hard way). The join on `measures ? d.metric` is what keeps absent
   * absent: no key, no row, no zero.
   */
  ads_counted as (
    select
      case p_view
        when 'v_metrics_by_round'  then a.round_id
        when 'v_metrics_baseline'  then a.round_id
        when 'v_metrics_by_month'  then to_char(fo_round_anchor(r.code, r.start_date, r.end_date), 'YYYY-MM')
        -- The ad row's own date, matching what v_metrics_by_week already does
        -- for spend and clicks. A week is a real calendar bucket, so the
        -- round's month rule has nothing to say here.
        when 'v_metrics_by_week'   then to_char(date_trunc('week', a.date), 'IYYY-"W"IW')
        when 'v_metrics_total'     then 'TOTAL'
        when 'v_journey_strip'     then 'TOTAL'
      end as cut_key,
      d.metric_key,
      sum((a.measures ->> d.metric)::numeric) as n
    from v_ads_measures a
    join v_rounds r on r.round_id = a.round_id
    join declared d on d.source = 'ads' and a.measures ? d.metric
    where r.client_id = p_client
      -- The same one-time filter, and today this is the one that matters: no
      -- client declares an ads measure, so this branch has always scanned
      -- v_ads_measures and v_rounds to return nothing. v_rounds is not free —
      -- it runs fo_filter_people_ok and fo_country_selection per round.
      and (select exists (select 1 from declared d2 where d2.source = 'ads'))
    group by 1, 2
  ),
  /*
   * Summed before aggregation. jsonb_object_agg raises on a duplicate key, so
   * an events metric and an ads metric sharing a metric_key would have taken
   * the entire read down instead of returning one wrong figure.
   */
  summed as (
    select cut_key, metric_key, sum(n) as n
    from (select * from ev_counted union all select * from ads_counted) u
    where cut_key is not null
    group by 1, 2
  ),
  per_key as (
    select cut_key, jsonb_object_agg(metric_key, n) as x
    from summed
    group by cut_key
  )
  select coalesce(jsonb_object_agg(cut_key, x), '{}'::jsonb) from per_key;
$$;

grant execute on function fo_stage_extras(text, text) to anon, authenticated;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. NOTHING MOVED. shely's control figures must be untouched:
--
--      select (r->'m'->>'spend')::numeric as spend, (r->'m'->>'leads')::int as leads,
--             (r->'m'->>'att')::int as att, (r->'m'->>'rev')::numeric as rev
--        from fo_cut('v_metrics_total','shely') as r;
--
--    Expect 20474.78 · 1889 · 682 · 83927.00
--
-- 2. STILL EMPTY, FASTER. Should return {} as before, in noticeably less time:
--
--      select fo_stage_extras('v_metrics_total','shely');
--
-- 3. THE DECLARED METRIC STILL WORKS. appointments is global and source
--    'events', so the events branch must still be reachable:
--
--      select jm.metric, jm.metric_key, jm.source, jm.event_type
--        from journey_metrics jm where jm.is_core = false;
--
--    One row: appointments · events · appointment. If that row is ever given a
--    client with appointment events, fo_stage_extras must start returning them.
