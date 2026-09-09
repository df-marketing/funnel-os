-- ═══════════════════════════════════════════════════════════════════════════
-- 0090 — Landing pages use the credited touch for sales.
--
-- A landing page is known on an ad or lead. Attendance borrows it from the
-- lead in the same round; a sale uses the campaign selected by attribution.
-- The expensive filtered rows and campaign rules are each read once.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_metrics_by_lp as
with campaign_dimensions as materialized (select * from v_campaign_dimensions),
ads_rows as materialized (select * from v_ads),
events_rows as materialized (select * from v_attributed_events),
ads as (
  select a.client_id, d.landing_page as lp, sum(a.spend) as spend,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from ads_rows a join campaign_dimensions d
    on d.client_id = a.client_id and d.campaign is not distinct from a.campaign
  where d.landing_page is not null group by a.client_id, d.landing_page
),
lead_lp as (
  select distinct on (e.client_id, e.contact_id, e.attr_round_id)
    e.client_id, e.contact_id, e.attr_round_id as round_id, d.landing_page as lp
  from events_rows e join campaign_dimensions d
    on d.client_id = e.client_id and d.campaign is not distinct from e.attr_utm_campaign
  where e.event_type = 'lead' and e.contact_id is not null and d.landing_page is not null
  order by e.client_id, e.contact_id, e.attr_round_id, e.event_date, e.event_id
),
leads as (
  select e.client_id, d.landing_page as lp, count(*) as leads
  from events_rows e join campaign_dimensions d
    on d.client_id = e.client_id and d.campaign is not distinct from e.attr_utm_campaign
  where e.event_type = 'lead' and d.landing_page is not null group by e.client_id, d.landing_page
),
attendance as (
  select l.client_id, l.lp, count(*) as attendance
  from events_rows e join lead_lp l
    on l.client_id = e.client_id and l.contact_id = e.contact_id and l.round_id = e.attr_round_id
  where e.event_type = 'attendance' group by l.client_id, l.lp
),
sales as (
  select e.client_id, d.landing_page as lp,
         sum(e.attr_weight) filter (where e.product = 'preview') as prev_buy,
         sum(e.attr_weight) filter (where e.product = 'middle') as mid_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview') as prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle') as mid_rev,
         sum(e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle' and e.attr_source = 'Paid Ads') as paid_mid_rev
  from events_rows e join campaign_dimensions d
    on d.client_id = e.client_id and d.campaign is not distinct from e.attr_utm_campaign
  where e.event_type = 'sale' and d.landing_page is not null group by e.client_id, d.landing_page
),
cells as (select client_id, lp from ads union select client_id, lp from leads union select client_id, lp from sales)
select c.client_id, c.lp as cut_key, c.lp as cut_label, null::text as cut_sub,
  fo_paid_returns(fo_metrics(coalesce(a.ad_rows, 0) > 0, a.spend, null::bigint, a.impressions, a.clicks,
    coalesce(l.leads, 0), coalesce(t.attendance, 0),
    case when seen.client_id is not null then coalesce(s.prev_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.prev_rev, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_rev, 0) end,
    p.preview_price, p.middle_price),
    case when seen.client_id is not null then coalesce(s.paid_prev_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.paid_prev_rev, 0) end,
    case when seen.client_id is not null then coalesce(s.paid_mid_rev, 0) end) as m,
  row_number() over (partition by c.client_id order by c.lp)::int as ord
from cells c left join ads a on a.client_id = c.client_id and a.lp = c.lp
left join leads l on l.client_id = c.client_id and l.lp = c.lp
left join attendance t on t.client_id = c.client_id and t.lp = c.lp
left join sales s on s.client_id = c.client_id and s.lp = c.lp
left join v_sales_seen seen on seen.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

create or replace view v_metrics_by_lp_round as
with campaign_dimensions as materialized (select * from v_campaign_dimensions),
ads_rows as materialized (select * from v_ads),
events_rows as materialized (select * from v_attributed_events),
ads as (
  select a.client_id, a.round_id, d.landing_page as lp, sum(a.spend) as spend,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from ads_rows a join campaign_dimensions d
    on d.client_id = a.client_id and d.campaign is not distinct from a.campaign
  where d.landing_page is not null group by a.client_id, a.round_id, d.landing_page
),
lead_lp as (
  select distinct on (e.client_id, e.contact_id, e.attr_round_id)
    e.client_id, e.contact_id, e.attr_round_id as round_id, d.landing_page as lp
  from events_rows e join campaign_dimensions d
    on d.client_id = e.client_id and d.campaign is not distinct from e.attr_utm_campaign
  where e.event_type = 'lead' and e.contact_id is not null and d.landing_page is not null
  order by e.client_id, e.contact_id, e.attr_round_id, e.event_date, e.event_id
),
leads as (
  select e.client_id, e.attr_round_id as round_id, d.landing_page as lp, count(*) as leads
  from events_rows e join campaign_dimensions d
    on d.client_id = e.client_id and d.campaign is not distinct from e.attr_utm_campaign
  where e.event_type = 'lead' and d.landing_page is not null group by e.client_id, e.attr_round_id, d.landing_page
),
attendance as (
  select l.client_id, l.round_id, l.lp, count(*) as attendance
  from events_rows e join lead_lp l
    on l.client_id = e.client_id and l.contact_id = e.contact_id and l.round_id = e.attr_round_id
  where e.event_type = 'attendance' group by l.client_id, l.round_id, l.lp
),
sales as (
  select e.client_id, e.attr_round_id as round_id, d.landing_page as lp,
         sum(e.attr_weight) filter (where e.product = 'preview') as prev_buy,
         sum(e.attr_weight) filter (where e.product = 'middle') as mid_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview') as prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle') as mid_rev,
         sum(e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle' and e.attr_source = 'Paid Ads') as paid_mid_rev
  from events_rows e join campaign_dimensions d
    on d.client_id = e.client_id and d.campaign is not distinct from e.attr_utm_campaign
  where e.event_type = 'sale' and d.landing_page is not null
  group by e.client_id, e.attr_round_id, d.landing_page
),
cells as (select client_id, round_id, lp from ads union select client_id, round_id, lp from leads union select client_id, round_id, lp from sales)
select c.client_id, c.lp || '·' || c.round_id as cut_key, c.round_id as cut_label,
  to_char(r.start_date, 'Mon DD') as cut_sub, c.lp as group_key, c.lp as group_label,
  null::text as group_sub, r.start_date,
  fo_paid_returns(fo_metrics(coalesce(a.ad_rows, 0) > 0, a.spend, null::bigint, a.impressions, a.clicks,
    coalesce(l.leads, 0), coalesce(t.attendance, 0),
    case when seen.client_id is not null then coalesce(s.prev_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.prev_rev, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_rev, 0) end,
    p.preview_price, p.middle_price),
    case when seen.client_id is not null then coalesce(s.paid_prev_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.paid_prev_rev, 0) end,
    case when seen.client_id is not null then coalesce(s.paid_mid_rev, 0) end) as m,
  row_number() over (partition by c.client_id, c.lp order by r.start_date)::int as ord
from cells c join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join ads a on a.client_id = c.client_id and a.round_id = c.round_id and a.lp = c.lp
left join leads l on l.client_id = c.client_id and l.round_id = c.round_id and l.lp = c.lp
left join attendance t on t.client_id = c.client_id and t.round_id = c.round_id and t.lp = c.lp
left join sales s on s.client_id = c.client_id and s.round_id = c.round_id and s.lp = c.lp
left join v_sales_seen seen on seen.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

grant select on v_metrics_by_lp, v_metrics_by_lp_round to anon, authenticated;
commit;
