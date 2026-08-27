-- ═══════════════════════════════════════════════════════════════════════════
-- Three things the integration proved wrong, from AcqOS's defect report.
--
-- 1. A week was a round wearing a week's label.
-- 2. The offer cut returned four columns and no way to tell them apart.
-- 3. CPA and ROAS could not be reconciled against the counts beside them.
--
-- ROLLBACK: re-run 0027's v_metrics_by_week, 0024's v_metrics_by_offer and
--   0020's fo_paid_returns, in that order. No data is touched by any of this;
--   all three objects are derived.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. CPA and ROAS say what they divided by.
--
-- 0020 made CPA and ROAS count only what advertising produced, which is right
-- and is the reason 0526-03 reads '—' rather than a triumphant 3.62 for six
-- sales its ads did not make. What it never did was SAY so in the data.
--
-- The month reports prevBuy 9 and cpa 815.75. 2447.26 / 9 is 271.92, so the
-- number on screen is unreconcilable against the number beside it — you have to
-- know that only 3 of those 9 customers came from an ad. AcqOS read the two
-- together, found they did not divide, and filed it as an arithmetic bug. It
-- isn't one; it is a denominator nobody was shown.
--
-- So the three ad-produced figures ride along in the same object. Nothing that
-- exists changes value. Same signature, so the six views calling this do not
-- need dropping, and the SPINE ignores keys it does not list.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function fo_paid_returns(
  m               jsonb,
  p_paid_prev_buy bigint,     -- customers advertising acquired
  p_paid_prev_rev numeric,    -- preview revenue advertising produced
  p_paid_mid_rev  numeric     -- middle revenue advertising produced
) returns jsonb
language sql
immutable
as $$
  select m || jsonb_build_object(
    'cpa',      (m->>'spend')::numeric / nullif(p_paid_prev_buy, 0),
    'prevRoas', p_paid_prev_rev / nullif((m->>'spend')::numeric, 0),
    'midRoas',  p_paid_mid_rev  / nullif((m->>'spend')::numeric, 0),
    'roas',     (p_paid_prev_rev + p_paid_mid_rev) / nullif((m->>'spend')::numeric, 0),
    -- The denominators, so the four above can be checked rather than trusted.
    -- Absent, not zero, wherever the four are: a cut that cannot tell paid
    -- revenue from community revenue passes NULL here and must not claim it
    -- measured none.
    'paidPrevBuy', p_paid_prev_buy,
    'paidPrevRev', p_paid_prev_rev,
    'paidMidRev',  p_paid_mid_rev
  );
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. A week is seven days.
--
-- Every figure in this view was bucketed by date_trunc('week', ROUND START) —
-- so a round's whole total landed in the single week its first day fell in, and
-- then got a label naming that week's seven days. Shely's 0526-03 ran 23–27 May
-- and was filed under "18 May – 24 May", a window beginning five days before
-- the round did and ending four days before it finished. Week 22, which the
-- round actually spent three days in, did not appear at all. The week spends
-- were byte-identical to the round spends, which is the tell: nothing was ever
-- aggregated by day.
--
-- Now every row is placed on the week of ITS OWN date, in the client's own
-- calendar — the same +8 localDay() buckets imports by, so a 4am opt-in lands
-- on the day the person thinks they opted in.
--
-- ADS ARE THE EXCEPTION, and refusing rather than guessing is the whole point.
-- A Meta export with no day breakdown carries one row per ad set for the entire
-- reporting window, dated to the START of that window — all 76 of Shely's ad
-- rows say 2026-05-01, a date inside neither round. Bucketing on it would put
-- every cent of May in the week of 27 April, which is worse than what this view
-- did before. So an ads row is placeable only if its date falls inside its own
-- round, and unless EVERY row for a client is placeable the ads figures are
-- withheld from every week — spend, reach, impressions, clicks, and each ratio
-- built on them.
--
-- All-or-nothing per client, not row-by-row: half the spend under a week
-- heading is a wrong number, and a wrong number reads exactly like a right one.
-- A dash does not. Northsea's four weekly rounds each carry an ads row dated to
-- their own start, so they pass and their weeks are complete.
--
-- The rule is data-driven and self-clearing. The day a real day-broken-down
-- export lands, that client's weeks fill in with no change here.
-- ───────────────────────────────────────────────────────────────────────────
create or replace view v_metrics_by_week as
with
-- Can this client's ad rows be placed on a day at all? A row dated outside the
-- round it belongs to is a reporting-window marker, not the day money moved.
ads_placeable as (
  select client_id, bool_and(dated) as day_level
  from (
    select r.client_id, (a.date between r.start_date and r.end_date) as dated
    from v_ads a join v_rounds r on r.round_id = a.round_id
  ) t
  group by client_id
),
ads as (
  select r.client_id,
         date_trunc('week', a.date)::date as week_start,
         sum(a.spend) as spend,
         -- 0016: reach is distinct people and cannot be added. Taken off the
         -- coarsest row available. A week holding several days of campaign rows
         -- still over-counts anyone reached on two of them — REACH_NOTE says so
         -- on every response, and that caveat is now more load-bearing here.
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join v_rounds r on r.round_id = a.round_id
  join ads_placeable d on d.client_id = r.client_id and d.day_level
  group by 1, 2
),
-- The join to v_rounds is what applies the product and period filter — v_events
-- carries none of its own — while the bucket comes from the event's own instant.
ev as (
  select r.client_id,
         date_trunc('week', (e.event_date at time zone 'Asia/Singapore')::date)::date as week_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join v_rounds r on r.round_id = e.round_id
  group by 1, 2
),
-- A sale lands in the week the money arrived. On a calendar cut that is what a
-- week's revenue means; the round it is credited to is By round's question.
sales as (
  select r.client_id,
         date_trunc('week', (e.event_date at time zone 'Asia/Singapore')::date)::date as week_start,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events e join v_rounds r on r.round_id = e.lead_round_id
  where e.event_type = 'sale' and e.lead_round_id is not null
  group by 1, 2
),
-- A week with no class has no attendance to report, as distinct from a week
-- where nobody turned up. Bucketed by the session's own date, like everything
-- else here.
cls as (
  select client_id, date_trunc('week', session_date)::date as week_start, count(*) as sessions
  from v_round_sessions
  where session_date is not null
  group by 1, 2
),
-- The spine is the weeks that HAVE something, not the weeks rounds start in.
weeks as (
  select client_id, week_start from ads
  union
  select client_id, week_start from ev
  union
  select client_id, week_start from sales
),
-- Which rounds this week overlaps — a week may touch two, and a round may touch
-- two weeks. That is the fact the old cut_sub, always "1 round", could not say.
spans as (
  select w.client_id, w.week_start,
         string_agg(distinct r.round_id, ', ' order by r.round_id) as rounds
  from weeks w
  join v_rounds r
    on r.client_id = w.client_id
   and r.start_date <= w.week_start + 6
   and r.end_date   >= w.week_start
  group by 1, 2
)
select
  w.client_id,
  to_char(w.week_start, 'IYYY-"W"IW')       as cut_key,
  to_char(w.week_start, 'DD Mon') || ' – ' || to_char(w.week_start + 6, 'DD Mon') as cut_label,
  sp.rounds                                 as cut_sub,
  w.week_start,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = w.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = w.client_id)
            and coalesce(cls.sessions, 0) > 0
           then coalesce(ev.attendance, 0) end,
      case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
      case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(sales.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_mid_rev,  0) end
  ) as m
from weeks w
left join spans sp  on sp.client_id    = w.client_id and sp.week_start    = w.week_start
left join ads       on ads.client_id   = w.client_id and ads.week_start   = w.week_start
left join ev        on ev.client_id    = w.client_id and ev.week_start    = w.week_start
left join sales     on sales.client_id = w.client_id and sales.week_start = w.week_start
left join cls       on cls.client_id   = w.client_id and cls.week_start   = w.week_start
left join v_sales_seen s    on s.client_id = w.client_id
left join v_client_prices p on p.client_id = w.client_id
order by w.client_id, w.week_start;

grant select on v_metrics_by_week to anon, authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. An offer column says which offer it is.
--
-- This view is rounds × offers and was only ever read one offer at a time —
-- fo_cut takes p_offer, the Preview and Middle tabs each pass one, and on
-- screen the duplicate was invisible. The integration reads it unfiltered, and
-- got four columns whose key, label and sub were identical in pairs:
--
--     key='0526-02'  label='0526-02'  sub='May 13 – 19'   (preview)
--     key='0526-02'  label='0526-02'  sub='May 13 – 19'   (middle)
--
-- The only thing telling them apart was which of prevBuy and midBuy was null,
-- which is not an identifier. Two identical headings over different numbers is
-- worse than no table — a reader reads across the wrong one.
--
-- Fixed the way v_metrics_by_round_source already does it, because AcqOS parses
-- that shape today: the key carries both dimensions joined by '·', and the
-- group names the one the columns share. Here the round varies and the offer is
-- the group, which keeps cut_label as the round — so the two tabs on screen are
-- unchanged, and gain a spanning header naming the offer they are about.
--
-- The offer's name comes from the client's own journey, so it reads "Paid
-- Workshop Purchase ($297)" rather than "preview". A client with no such stage
-- falls back to a generic name rather than to nothing.
--
-- The three group columns are APPENDED. create or replace view may add columns
-- at the end and may not reorder them, so the first seven stay exactly where
-- they were.
-- ───────────────────────────────────────────────────────────────────────────
create or replace view v_metrics_by_offer as
with offers as (select unnest(array['preview', 'middle']) as product),
ads as (
  select client_id, round_id, sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads group by 1, 2
),
ev as (
  select client_id, round_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance
  from v_events group by 1, 2
),
sales as (
  select client_id, lead_round_id as round_id, product,
         count(*) as buys,
         sum(amount - coalesce(refund_amount, 0)) as rev,
         count(*) filter (where attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_buys,
         sum(amount - coalesce(refund_amount, 0)) filter (where attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_rev
  from v_events
  where event_type = 'sale' and lead_round_id is not null and product is not null
  group by 1, 2, 3
)
select
  r.client_id,
  o.product,
  r.round_id || '·' || o.product              as cut_key,
  r.round_id                                  as cut_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as cut_sub,
  r.start_date,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
           then coalesce(ev.attendance, 0) end,
      case when o.product = 'preview' and s.client_id is not null then coalesce(sp.buys, 0) end,
      case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.buys, 0) end,
      case when o.product = 'preview' and s.client_id is not null then coalesce(sp.rev,  0) end,
      case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.paid_buys, 0) end,
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.paid_rev,  0) end,
    case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.paid_rev,  0) end
  ) as m,
  o.product                                   as group_key,
  coalesce(j.stage_name,
           case o.product when 'preview' then 'Preview offer' else 'Middle offer' end) as group_label,
  null::text                                  as group_sub
from v_rounds r
cross join offers o
left join ads on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev  on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales sp on sp.client_id = r.client_id and sp.round_id = r.round_id and sp.product = 'preview'
left join sales sm on sm.client_id = r.client_id and sm.round_id = r.round_id and sm.product = 'middle'
left join v_sales_seen s    on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
left join client_journey_config j
       on j.client_id = r.client_id and j.stage_slug = o.product
order by r.client_id, o.product, r.start_date;

grant select on v_metrics_by_offer to anon, authenticated;
