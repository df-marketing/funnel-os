-- ═══════════════════════════════════════════════════════════════════════════
-- 0097 — a round belongs to one period, not to every period it touches.
--
-- WHAT WAS WRONG. 0069 ruled that a month is the rounds NAMED for it, whole,
-- and fixed By month. It said in its own notes that the calendar-window
-- listing beside it was "unchanged" — and left the second definition of
-- "month" alive in the one place that still used dates: the window filter.
--
-- fo_filter_ok and fo_filter_people_ok admitted a round when it OVERLAPPED the
-- window:
--
--     p_round_end >= from  and  p_round_start <= to
--
-- Two of Shely's thirteen rounds cross a month boundary — 0826-01 runs 31 Jul
-- to 6 Aug, 0926-01 runs 28 Aug to 3 Sep — so each of them overlaps two
-- windows and was counted in both, whole, every time. Measured before this
-- migration:
--
--     By month            Aug 4,997.27   Sep 3,936.68     (0069's rule, right)
--     August window       8,933.95                        (= 4,997.27 + 3,936.68)
--
-- 8,933.95 is August plus the whole of a September round. The same round is
-- then counted again in September's window, so adding two consecutive windowed
-- months double-counts every straddling round. No set of classes anyone ran
-- corresponds to 8,933.95, which is the same complaint the client made on
-- 2026-09-07 about the 6k August, reappearing through a different door.
--
-- It leaked in both directions and it was not only the integration. The UI's
-- period picker built each month option as min(start_date)..max(end_date) of
-- the rounds named for that month (lib/funnel/data.ts), so August's window
-- ended on the last day any August round ran — 28 Aug or later — and September's
-- began on 28 Aug. Selecting either month pulled in the other's round. A single
-- round option had the same hole: its own dates, matched by overlap, admit any
-- other round sharing a day with it.
--
-- THE RULING, which is 0069's ruling applied to windows. A round is atomic: it
-- is the unit a class is sold in, and it cannot be split across periods. So it
-- gets ONE day — an anchor — and a window admits it when the window CONTAINS
-- that day. Containment on a single day has the property overlap does not:
-- disjoint windows partition the rounds, so no round is ever in two of them and
-- adjacent periods add up exactly.
--
-- THE ANCHOR is the first day of the round that falls inside the month the
-- round is named for:
--
--     anchor = greatest(start_date, first day of the named month)
--
--     0826-01  31 Jul – 6 Aug   named Aug   → 2026-08-01
--     0926-01  28 Aug – 3 Sep   named Sep   → 2026-09-01
--     0526-02  13 – 19 May      named May   → 2026-05-13   (start_date)
--
-- Two properties hold by construction, and they are the whole correctness
-- argument:
--
--   1. The anchor is always INSIDE the round. fo_round_month only trusts the
--      named month when it lies between the start and end months, so the named
--      month's first day is never past end_date, and greatest() never passes it
--      either.
--   2. The anchor is always inside the NAMED month. If the named month is the
--      start month the anchor is start_date; otherwise it is that month's 1st.
--
-- (2) is why a plain calendar window now agrees with By month exactly: the
-- August window admits precisely the August-named rounds. By month and a
-- windowed August stop being two answers.
--
-- For a round that does not cross a month boundary the anchor IS start_date, so
-- nothing about eleven of the thirteen rounds changes. A round whose code is in
-- no known shape — Northsea's NS-W1 — falls back to the start month and so
-- anchors on start_date, same as before.
--
-- WHAT THIS CHANGES for a free date range, honestly stated: p_from/p_to now
-- mean "rounds belonging to this period" rather than "rounds that touched these
-- dates". A range of 1–31 Aug returns 0826-01 whole, including the spend it made
-- on 31 July, and does not return 0926-01's late-August spend at all. That is
-- the 0069 ruling and it is the only reading under which the app has one
-- definition of a period instead of two. It also means a range narrower than a
-- round no longer slices it — asking for 1–3 Aug returns 0826-01 entire or not
-- at all. Round-level reporting cannot honour a sub-round window and was never
-- really doing so; it was returning the whole round and labelling it as the
-- window's.
--
-- WHY code AND NOT round_id. fo_round_month(round_id, …) looks the code up in
-- rounds, which makes it STABLE and costs a lookup per call. v_ads applies the
-- filter per ad row, so calling it there would be 0090's mistake again —
-- fo_resolve running 4,890 times instead of 52. fo_round_anchor takes the code
-- as an argument instead, which makes it IMMUTABLE and pure: two substring
-- matches and a date comparison, no table access, inlinable. All three call
-- sites already join rounds, so the code is in scope for free.
--
-- WHY THE TWO VIEWS ARE BUILT BY DYNAMIC SQL. The first attempt at this
-- migration failed, safely, on:
--
--     ERROR 42P16: cannot change name of view column "product_id" to "measures"
--
-- v_ads is `select r.client_id, a.*, …` and a view freezes what `*` meant on the
-- day it was created. 0091 created it; 20260909072902 then added `measures` to
-- ads_performance. Re-running the same text expands `a.*` one column wider than
-- the live view, so every column past that point shifts and CREATE OR REPLACE
-- refuses. v_attributed_events has the same shape over v_event_attribution,
-- which 20260909063435 redefined after 0091 created the view above it.
--
-- Writing the frozen lists out by hand would mean reconstructing them from the
-- migration history — which is exactly the reasoning that produced the error, so
-- doing more of it is not the fix. Instead each view is rebuilt by reading its
-- OWN current column list out of information_schema and projecting exactly that,
-- whatever it turns out to be. The query keeps its wider inner select; the outer
-- projection is pinned to what already exists.
--
-- This is also why attr_anchor is NOT added as a column. It lives inside the
-- `prepared` CTE where the predicate needs it and is projected away, so neither
-- view's column list changes at all — nothing to append, nothing to shift, and
-- no caller reading by position can notice.
--
-- WHAT IS NOT TOUCHED. fo_round_month keeps its signature and its callers —
-- v_metrics_by_month is already correct and this migration does not alter a
-- single figure it produces. Frozen month insights (0041) keep the reading they
-- had; fixing a filter does not fix a report, and that is what freezing is for.
-- Round labels still print real dates, so "0926-01 · 28 Aug–3 Sep" still says
-- when the class actually ran — only the filter window moved.
--
-- BLAST RADIUS. Three live views call these predicates — v_rounds, v_ads and
-- v_attributed_events. Everything else inherits: v_events reads
-- v_attributed_events, and every metrics view reads v_rounds/v_ads/v_events.
-- No view's column list changes.
--
-- Safe to re-run. Section 2 is cleanup in its own transaction so that a
-- straggler cannot roll back the fix.
--
-- ROLLBACK: re-run 0068's fo_filter_ok/fo_filter_people_ok (the definitions
-- testing p_round_end >= from_date), then re-run the v_rounds definition from
-- 20260909160000, and v_ads + v_attributed_events from 0091. Then
--   drop function if exists fo_round_anchor(text, date, date);
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 0. PRE-FLIGHT — read-only, run it alone if section 1 ever fails ═══════
-- The frozen column lists the rebuild has to reproduce. Nothing here writes.
--
--   select table_name,
--          string_agg(column_name, ', ' order by ordinal_position) as frozen_columns
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('v_ads', 'v_attributed_events', 'v_rounds')
--    group by table_name;
--
-- v_ads should NOT list `measures` — it is on ads_performance but was added
-- after the view was created, and v_ads_measures (20260909072902) is where it
-- is meant to be read. If it DOES list measures, the view was recreated at some
-- point and the projection below will simply carry it through; either way the
-- rebuild matches what is there rather than what the history implies.

-- ═══ 1. THE FIX ════════════════════════════════════════════════════════════
begin;

-- ── THE ONE DAY A ROUND IS FILED UNDER ─────────────────────────────────────
-- IMMUTABLE and lookup-free on purpose: this runs per ad row. Takes the code
-- rather than the round_id so there is nothing to look up.
create or replace function fo_round_anchor(p_code text, p_start date, p_end date)
returns date
language sql
immutable
as $$
  select greatest(p_start, coalesce(y.named, date_trunc('month', p_start)::date))
  from (
    select case
             when x.mm between 1 and 12
              and make_date(2000 + x.yy, x.mm, 1)
                  between date_trunc('month', p_start)::date
                      and date_trunc('month', p_end)::date
             then make_date(2000 + x.yy, x.mm, 1)
           end as named
    from (
      select nullif(substring(p_code from '^(\d{2})\d{2}-'), '')::int as mm,
             nullif(substring(p_code from '^\d{2}(\d{2})-'), '')::int as yy
    ) x
  ) y;
$$;
grant execute on function fo_round_anchor(text, date, date) to anon, authenticated;

-- ── THE PREDICATES, ON ONE DAY ─────────────────────────────────────────────
-- Product, channel, country and source are unchanged. Only the date test moved,
-- from overlapping a window to being contained by one.
create or replace function fo_filter_ok(
  p_product text, p_channel text, p_country text, p_anchor date
) returns boolean language sql stable as $$
  with f as (
    select
      string_to_array(nullif(current_setting('funnel.product', true), ''), ',') as product,
      string_to_array(nullif(current_setting('funnel.channel', true), ''), ',') as channel,
      string_to_array(nullif(current_setting('funnel.country', true), ''), ',') as country,
      nullif(current_setting('funnel.from', true), '')::date                    as from_date,
      nullif(current_setting('funnel.to',   true), '')::date                    as to_date,
      string_to_array(nullif(current_setting('funnel.periods', true), ''), ',') as periods
  )
  select
      (f.product is null or p_product = any(f.product))
  and (f.channel is null or p_channel = any(f.channel))
  and (f.country is null or p_country = any(f.country))
  and (f.from_date is null or p_anchor >= f.from_date)
  and (f.to_date   is null or p_anchor <= f.to_date)
  and (f.periods is null or exists (
        select 1 from unnest(f.periods) w
         where p_anchor >= split_part(w, '..', 1)::date
           and p_anchor <= split_part(w, '..', 2)::date))
  from f;
$$;
grant execute on function fo_filter_ok(text, text, text, date) to anon, authenticated;

create or replace function fo_filter_people_ok(
  p_product text, p_country text, p_anchor date
) returns boolean language sql stable as $$
  with f as (
    select
      string_to_array(nullif(current_setting('funnel.product', true), ''), ',') as product,
      string_to_array(nullif(current_setting('funnel.country', true), ''), ',') as country,
      nullif(current_setting('funnel.from', true), '')::date                    as from_date,
      nullif(current_setting('funnel.to',   true), '')::date                    as to_date,
      string_to_array(nullif(current_setting('funnel.periods', true), ''), ',') as periods
  )
  select
      (f.product is null or p_product = any(f.product))
  and (f.country is null or p_country = any(f.country))
  and (f.from_date is null or p_anchor >= f.from_date)
  and (f.to_date   is null or p_anchor <= f.to_date)
  and (f.periods is null or exists (
        select 1 from unnest(f.periods) w
         where p_anchor >= split_part(w, '..', 1)::date
           and p_anchor <= split_part(w, '..', 2)::date))
  from f;
$$;
grant execute on function fo_filter_people_ok(text, text, date) to anon, authenticated;

-- ── THE THREE CALL SITES ───────────────────────────────────────────────────
-- v_rounds: the gate. Country logic is 20260909160000's, unchanged.
create or replace view v_rounds as
select r.*
from rounds r
/* Uncorrelated, so it is built once per query rather than once per round.
   Filtering inside the subquery rather than after it means that when no
   country is chosen, `market = any(null)` is null, no row qualifies, and the
   aggregate has nothing to group. */
left join (
  select round_id, min(market) as pick
  from v_round_markets
  where market = any(fo_country_selection())
  group by round_id
) picks on picks.round_id = r.round_id
where fo_filter_people_ok(
        r.product_id,
        case
          -- Nothing chosen: the country is not consulted at all.
          when fo_country_selection() is null then r.country
          -- The round declares a country and it was chosen.
          when r.country = any(fo_country_selection()) then r.country
          -- Otherwise a chosen market this round genuinely ran in, or NULL when
          -- it ran in none — which correctly fails the predicate. `min` is a
          -- deterministic choice among several; any single match admits the
          -- round, and v_ads and v_events then narrow what is counted INSIDE
          -- it, per row.
          else picks.pick
        end,
        fo_round_anchor(r.code, r.start_date, r.end_date)
      );
grant select on v_rounds to anon, authenticated;

-- v_ads: per ad row, which is why the anchor function is pure.
--
-- Projected through its own frozen column list, for the reason in the header:
-- `a.*` means more today than it did when 0091 ran, and the live view is
-- entitled to the narrower shape it was born with.
do $do$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_ads';

  if v_cols is null then
    raise exception 'v_ads does not exist; this migration replaces, it does not create';
  end if;

  execute format($f$
    create or replace view v_ads as
    with campaign_dimensions as materialized (select * from v_campaign_dimensions)
    select %s from (
      select r.client_id, a.*, r.product_id, coalesce(d.market, r.country) as country
      from ads_performance a
      join rounds r on r.round_id = a.round_id
      left join campaign_dimensions d
        on d.client_id = r.client_id and d.campaign is not distinct from a.campaign
      where fo_filter_ok(r.product_id, a.channel, coalesce(d.market, r.country),
                         fo_round_anchor(r.code, r.start_date, r.end_date))
        and fo_filter_audience_ok(coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)'))
    ) s
  $f$, v_cols);
end
$do$;
grant select on v_ads to anon, authenticated;

-- v_attributed_events: same treatment, same reason — `select * from prepared`
-- froze whatever v_event_attribution exposed in 0091, and 20260909063435 changed
-- it afterwards. attr_anchor stays INSIDE prepared and is projected away, so the
-- column list is untouched and attr_country keeps the leading position 0082
-- requires.
do $do$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_attributed_events';

  if v_cols is null then
    raise exception 'v_attributed_events does not exist; this migration replaces, it does not create';
  end if;

  execute format($f$
    create or replace view v_attributed_events as
    with campaign_dimensions as materialized (select * from v_campaign_dimensions),
    entry_context as materialized (select * from v_contact_entry),
    prepared as (
      select a.*,
             coalesce(d.market, r.country) as attr_country,
             r.product_id as attr_product_id,
             r.start_date as attr_start_date,
             r.end_date   as attr_end_date,
             case
               when a.event_type = 'attendance' then c.attr_ad_set
               when a.event_type = 'sale' then a.attr_ad_set
               else a.ad_set
             end as attr_audience,
             case when a.event_type = 'attendance' then c.attr_ad else a.attr_ad end as attr_creative,
             fo_round_anchor(r.code, r.start_date, r.end_date) as attr_anchor
      from v_event_attribution a
      join rounds r on r.client_id = a.client_id and r.round_id = a.attr_round_id
      left join campaign_dimensions d
        on d.client_id = a.client_id and d.campaign is not distinct from a.attr_utm_campaign
      left join entry_context c
        on c.client_id = a.client_id and c.contact_id = a.contact_id
    )
    select %s from prepared p
    where fo_filter_people_ok(p.attr_product_id, p.attr_country, p.attr_anchor)
      and fo_filter_source_ok(coalesce(p.attr_source, 'Unattributed'))
      and fo_filter_audience_ok(coalesce(nullif(btrim(p.attr_audience), ''), '(unsplit)'))
  $f$, v_cols);
end
$do$;
grant select on v_attributed_events to anon, authenticated;

commit;

-- ═══ 2. CLEANUP — separate, so a straggler cannot undo section 1 ═══════════
-- The overlap predicates, retired. A plain DROP (never CASCADE): if some view
-- this migration did not find still calls one, Postgres refuses and names it,
-- which is the thing worth learning. Section 1 is already committed either way.
begin;
drop function if exists fo_filter_ok(text, text, text, date, date);
drop function if exists fo_filter_ok(text, text, date, date);
drop function if exists fo_filter_people_ok(text, text, date, date);
drop function if exists fo_filter_people_ok(text, date, date);
commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. THE ANCHOR, on the two rounds that straddle and one that does not. This is
--    the claim everything else rests on, so read it first:
--
--      select code, start_date, end_date,
--             fo_round_month(round_id, start_date, end_date) as named_month,
--             fo_round_anchor(code, start_date, end_date)    as anchor
--        from rounds where client_id = 'shely' order by start_date;
--
--    Expect 0826-01 → 2026-08-01, 0926-01 → 2026-09-01, and every other round's
--    anchor equal to its own start_date. Every anchor must fall between
--    start_date and end_date; if one does not, stop and do not trust the rest.
--
-- 2. THE BUG, gone. A calendar August must now read what By month reads:
--
--      select (r->'m'->>'spend')::numeric as aug_window
--        from fo_cut('v_metrics_total','shely',
--                    p_from => '2026-08-01', p_to => '2026-08-31') as r;
--
--    Expect 4997.27. It was 8933.95 — August plus the whole of 0926-01.
--
-- 3. ADJACENT MONTHS ADD UP, which is what overlap made impossible:
--
--      select (select (r->'m'->>'spend')::numeric from fo_cut('v_metrics_total','shely',
--                p_from=>'2026-08-01', p_to=>'2026-08-31') as r) as aug,
--             (select (r->'m'->>'spend')::numeric from fo_cut('v_metrics_total','shely',
--                p_from=>'2026-09-01', p_to=>'2026-09-30') as r) as sep;
--
--    Expect 4997.27 and 3936.68, summing to 8933.95 with no round counted twice.
--
-- 4. WINDOWED MONTH == BY MONTH, for every month, which is the invariant this
--    migration buys. Any row returned is a failure:
--
--      select m.cut_key, (m.m->>'spend')::numeric as by_month,
--             (w.m->>'spend')::numeric as by_window
--        from fo_cut('v_metrics_by_month','shely') as m
--        cross join lateral (
--          select r.m from fo_cut('v_metrics_total','shely',
--            p_from => (m.cut_key || '-01')::date,
--            p_to   => (date_trunc('month',(m.cut_key||'-01')::date)
--                       + interval '1 month - 1 day')::date) as r(m)
--        ) w
--       where coalesce((m.m->>'spend')::numeric,-1)
--          <> coalesce((w.m->>'spend')::numeric,-1);
--
-- 5. NOTHING MOVED IN TOTAL. The unfiltered figures must be untouched:
--
--      select (r->'m'->>'spend')::numeric as spend, (r->'m'->>'leads')::int as leads,
--             (r->'m'->>'attendance')::int as attendance, (r->'m'->>'rev')::numeric as rev
--        from fo_cut('v_metrics_total','shely') as r;
--
--    Expect 20474.78 · 1889 · 682 · 83927.00 — exactly as before.
--
-- 6. THE SUB-MONTH RANGE still works, and now returns whole rounds. 0068's
--    check, whose May rounds anchor on 13 and 20 May:
--
--      select (r->'m'->>'spend')::numeric
--        from fo_cut('v_metrics_total','shely',
--                    p_periods => '2026-05-13..2026-05-28,2026-07-01..2026-07-30') as r;
--
--    Expect a figure below the total, with June's rounds absent.
