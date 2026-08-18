-- ═══════════════════════════════════════════════════════════════════════════
-- BY MONTH — management's first question, and the last unwired overview tab.
--
-- Every other comparison view already exists; this one was the only tab whose
-- SQL had never been written, so the app said "not wired yet" rather than
-- showing an answer to the question it is most often asked.
--
-- The cut is rounds.start_date grouped to a calendar month. A month is not a
-- new dimension — it is rounds, rolled up one level. That matters, because it
-- means every number on this tab is the same number as on By round, added the
-- same way, and the two tabs cannot disagree.
--
-- Three decisions worth stating, because each one could reasonably have gone
-- the other way:
--
--   1. A round belongs to the month it STARTED in, not to the month each ad
--      impression or opt-in happened in. 0526-02 ran 13–19 May and is May.
--      A round straddling a month boundary lands whole in its opening month
--      rather than being split — splitting it would put spend in one month and
--      the class that spend paid for in another, and every closing rate would
--      then be measured against a denominator from a different column.
--
--   2. Revenue counts on the month of the round that PRODUCED the lead, exactly
--      as By round counts it on lead_round_id. A June buyer whose lead came from
--      a May ad is May's return on May's spend. This is the whole reason the app
--      exists, and it must not change just because the columns got wider.
--
--   3. Reach is summed across the rounds in a month, which double-counts anyone
--      Meta showed the ads to in both. That is already true of the Total column
--      on every other tab — reach cannot be added, and Meta only reports it
--      per query. Consistent-and-known beats a different wrong number here.
--
-- A month appears if it contains a round, even when that round has no data yet:
-- By round shows the empty rounds, so By month shows the empty months. A tab
-- that quietly hid them would be claiming those months don't exist.
--
-- Requires 0008 (fo_metrics without coalesce, v_sales_seen). Creates one view.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_metrics_by_month as
with months as (
  select client_id,
         date_trunc('month', start_date)::date as month_start,
         count(*)::int                         as round_count
  from rounds
  group by 1, 2
),
ads as (
  select r.client_id,
         date_trunc('month', r.start_date)::date as month_start,
         sum(a.spend)       as spend,
         sum(a.reach)       as reach,
         sum(a.impressions) as impressions,
         sum(a.clicks)      as clicks,
         count(*)           as ad_rows
  from v_ads a
  join rounds r on r.round_id = a.round_id
  group by 1, 2
),
ev as (
  select r.client_id,
         date_trunc('month', r.start_date)::date as month_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e
  join rounds r on r.round_id = e.round_id
  group by 1, 2
),
-- lead_round_id, not round_id: see decision 2 above.
sales as (
  select r.client_id,
         date_trunc('month', r.start_date)::date as month_start,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev
  from v_events e
  join rounds r on r.round_id = e.lead_round_id
  where e.event_type = 'sale' and e.lead_round_id is not null
  group by 1, 2
)
select
  m.client_id,
  to_char(m.month_start, 'YYYY-MM')                       as cut_key,
  to_char(m.month_start, 'Mon YYYY')                      as cut_label,
  m.round_count || ' round' || case when m.round_count = 1 then '' else 's' end as cut_sub,
  m.month_start,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
    -- leads and attendance are known: the files are in, this month had none
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    -- sales are known only once a sale exists for this client
    case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from months m
left join ads   on ads.client_id   = m.client_id and ads.month_start   = m.month_start
left join ev    on ev.client_id    = m.client_id and ev.month_start    = m.month_start
left join sales on sales.client_id = m.client_id and sales.month_start = m.month_start
left join v_sales_seen s   on s.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id
order by m.client_id, m.month_start;

grant select on v_metrics_by_month to anon, authenticated;
