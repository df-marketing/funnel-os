-- ═══════════════════════════════════════════════════════════════════════════
-- 0098 — a declared ads measure reaches the screen.
--
-- REQUIREMENT 4, and it is far smaller than the plan says.
--
-- The 8 September schema plan priced this as "a 14th argument across 93 call
-- sites" and deferred it. That was true when it was written. It stopped being
-- true on 9 September, when 20260909180000 introduced fo_stage_extras and
-- fo_cut began merging its output into every row through fo_merge_stage. The
-- merge point now exists; nothing needs a new argument.
--
-- What is actually missing is one branch. fo_stage_extras reads:
--
--     where jm.source = 'events'
--
-- and nothing else. A client may declare an ads measurement — video views,
-- ThruPlays — and the IMPORT SIDE IS ALREADY COMPLETE: pipeline.ts reads
-- journey_metrics where source = 'ads', matches the export header against the
-- metric name and its aliases, and writes ads_performance.measures keyed by the
-- metric. 20260909072902 added the column and v_ads_measures to read it.
--
-- So the figure is captured, stored, and then dropped on the floor, because the
-- only function that merges declared metrics into a cut has no idea ads exist.
-- This adds that branch. Requirement 4 closes.
--
-- ── THREE THINGS FIXED ON THE WAY ──────────────────────────────────────────
--
-- 1. THE MONTH WAS THE EVENT'S, NOT THE ROUND'S. The events branch bucketed by
--    date_trunc('month', e.event_date), which is 0045's rule — the one 0069
--    overturned and 20260911100000 finished overturning. v_metrics_by_month
--    keys on the round's NAMED month, so for a round that straddles a boundary
--    the two disagree and a declared count lands on the wrong month's row, or
--    on no row at all. Four rounds straddle today (0926-01, 0826-01,
--    ACME-SG-0126-02, ZEN-W4).
--
--    Latent, not live: there are currently no appointment events anywhere, so
--    the only declared metric produces nothing to misfile. Fixed now because
--    the first client to declare a metric would have found it, and it would
--    have looked like a missing number rather than a misplaced one.
--
--    It uses fo_round_anchor rather than fo_round_month: the anchor always
--    falls inside the named month, so to_char(anchor,'YYYY-MM') IS the named
--    month, and the anchor is IMMUTABLE with no table lookup. fo_round_month
--    would cost a lookup per row.
--
-- 2. A CLIENT'S DECLARATION LEAKED TO EVERY CLIENT. The events branch filtered
--    on source and is_core but never on client_id, though the column exists and
--    the importer honours it (`if (row.client_id !== null && row.client_id !==
--    clientId) continue`). One client declaring "appointments" would have put
--    an appointments column on everybody. Both branches now match the
--    importer's rule: a row belongs to this client, or to everyone.
--
-- 3. TWO BRANCHES CAN NAME THE SAME KEY. jsonb_object_agg raises on a duplicate
--    key, so an events metric and an ads metric sharing a metric_key would have
--    taken the whole read down rather than returning a wrong number. The
--    branches are summed before aggregation, so a collision adds up instead.
--
-- ── WHERE EACH FIGURE LANDS ────────────────────────────────────────────────
--
--   By round, Baseline   the round the ad row belongs to
--   By month             the round's NAMED month, same as every other figure
--   By week              the AD ROW'S OWN DATE, which is what v_metrics_by_week
--                        already does for spend and clicks. Weeks are real
--                        calendar buckets; the round rule does not apply there.
--   Total, Journey strip TOTAL
--
-- Absent stays absent. A row whose measures object has no such key contributes
-- nothing rather than zero — `measures ? metric` is a join condition, so an
-- omitted measurement is missing, not measured as none. That is the same rule
-- the importer applies when it leaves an unmapped header out of the object.
--
-- Safe to re-run. Nothing changes for any client until a journey_metrics row
-- names an ads measure, and today none does.
--
-- ROLLBACK: re-run the fo_stage_extras definition from 20260909180000.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

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

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. NOTHING MOVED. No client declares an ads measure today, so every figure
--    must be identical to before:
--
--      select (r->'m'->>'spend')::numeric as spend, (r->'m'->>'leads')::int as leads,
--             (r->'m'->>'att')::int as att, (r->'m'->>'rev')::numeric as rev
--        from fo_cut('v_metrics_total','shely') as r;
--
--    Expect 20474.78 · 1889 · 682 · 83927.00.
--
-- 2. THE BRANCH WORKS. Declare one, put a figure on one ad row, read it back,
--    then undo. Run the whole block and read the three rows it prints:
--
--      begin;
--      insert into journey_metrics (metric, metric_key, label, source, is_core, seq, client_id)
--      values ('video_views','vv','Video views','ads',false,15,'shely');
--
--      update ads_performance set measures = jsonb_build_object('video_views', 1234)
--       where id = (select id from ads_performance a join rounds r on r.round_id = a.round_id
--                    where r.client_id = 'shely' order by a.date limit 1);
--
--      select 'total' as cut, fo_stage_extras('v_metrics_total','shely') as extras
--      union all select 'round', fo_stage_extras('v_metrics_by_round','shely')
--      union all select 'month', fo_stage_extras('v_metrics_by_month','shely');
--      rollback;
--
--    Expect {"TOTAL": {"vv": 1234}} for the first, and for the other two the
--    same 1234 under the round it was put on and under THAT ROUND'S NAMED
--    MONTH. The rollback puts everything back — nothing is left behind.
--
-- 3. ABSENT IS NOT ZERO. Inside the same transaction, every OTHER round and
--    month must be missing from the object entirely, not present with 0.
