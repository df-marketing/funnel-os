-- ═══════════════════════════════════════════════════════════════════════════
-- 0085 — Offer and month read the same credited sale rows as By round.
--
-- A model can move a sale between rounds, therefore it also moves it between
-- the months those rounds are named for. Leads, attendance and ad delivery do
-- not move: they are facts that happened in their original round.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_metrics_by_offer as
with offers as (
  select unnest(array['preview', 'middle']) as product
),
ads as (
  select client_id, round_id, sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null), sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads
  group by client_id, round_id
),
events_by_round as materialized (
  select client_id, attr_round_id as round_id,
         count(*) filter (where event_type = 'lead') as leads,
         count(*) filter (where event_type = 'attendance') as attendance
  from v_attributed_events
  group by client_id, attr_round_id
),
sales_by_round_offer as materialized (
  select client_id, attr_round_id as round_id, product,
         sum(attr_weight) as buys,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight) as rev,
         sum(attr_weight) filter (where attr_source = 'Paid Ads') as paid_buys,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where attr_source = 'Paid Ads') as paid_rev
  from v_attributed_events
  where event_type = 'sale' and product in ('preview', 'middle')
  group by client_id, attr_round_id, product
)
select
  r.client_id,
  o.product,
  r.round_id || '·' || o.product as cut_key,
  r.round_id as cut_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as cut_sub,
  r.start_date,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend, a.reach, a.impressions, a.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
           then coalesce(e.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
           then coalesce(e.attendance, 0) end,
      case when o.product = 'preview' and s.client_id is not null then coalesce(x.buys, 0) end,
      case when o.product = 'middle' and s.client_id is not null then coalesce(x.buys, 0) end,
      case when o.product = 'preview' and s.client_id is not null then coalesce(x.rev, 0) end,
      case when o.product = 'middle' and s.client_id is not null then coalesce(x.rev, 0) end,
      p.preview_price, p.middle_price
    ),
    case when o.product = 'preview' and s.client_id is not null then coalesce(x.paid_buys, 0) end,
    case when o.product = 'preview' and s.client_id is not null then coalesce(x.paid_rev, 0) end,
    case when o.product = 'middle' and s.client_id is not null then coalesce(x.paid_rev, 0) end
  ) as m,
  o.product as group_key,
  coalesce(j.stage_name, case o.product
    when 'preview' then 'Preview offer' else 'Middle offer' end) as group_label,
  null::text as group_sub
from v_rounds r
cross join offers o
left join ads a on a.client_id = r.client_id and a.round_id = r.round_id
left join events_by_round e on e.client_id = r.client_id and e.round_id = r.round_id
left join sales_by_round_offer x
  on x.client_id = r.client_id and x.round_id = r.round_id and x.product = o.product
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
left join client_journey_config j
  on j.client_id = r.client_id and j.stage_slug = o.product;

create or replace view v_metrics_by_month as
with round_months as (
  select r.client_id, r.round_id,
         fo_round_month(r.round_id, r.start_date, r.end_date) as month_start
  from v_rounds r
),
ads as (
  select rm.client_id, rm.month_start,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null), sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join round_months rm on rm.client_id = a.client_id and rm.round_id = a.round_id
  group by rm.client_id, rm.month_start
),
events_by_month as materialized (
  select rm.client_id, rm.month_start,
         count(*) filter (where e.event_type = 'lead') as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_attributed_events e
  join round_months rm on rm.client_id = e.client_id and rm.round_id = e.attr_round_id
  group by rm.client_id, rm.month_start
),
sales_by_month as materialized (
  select rm.client_id, rm.month_start,
         sum(e.attr_weight) filter (where e.product = 'preview') as prev_buy,
         sum(e.attr_weight) filter (where e.product = 'middle') as mid_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight)
           filter (where e.product = 'preview') as prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight)
           filter (where e.product = 'middle') as mid_rev,
         sum(e.attr_weight) filter (
           where e.product = 'preview' and e.attr_source = 'Paid Ads'
         ) as paid_prev_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (
           where e.product = 'preview' and e.attr_source = 'Paid Ads'
         ) as paid_prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (
           where e.product = 'middle' and e.attr_source = 'Paid Ads'
         ) as paid_mid_rev
  from v_attributed_events e
  join round_months rm on rm.client_id = e.client_id and rm.round_id = e.attr_round_id
  where e.event_type = 'sale'
  group by rm.client_id, rm.month_start
),
sessions as (
  select rm.client_id, rm.month_start, count(*) as sessions
  from v_round_sessions s
  join round_months rm on rm.client_id = s.client_id and rm.round_id = s.round_id
  where s.session_date is not null
  group by rm.client_id, rm.month_start
),
months as (
  select distinct client_id, month_start from round_months
),
spans as (
  select client_id, month_start, count(distinct round_id)::int as round_count
  from round_months
  group by client_id, month_start
)
select
  m.client_id,
  to_char(m.month_start, 'YYYY-MM') as cut_key,
  to_char(m.month_start, 'Mon YYYY') as cut_label,
  coalesce(sp.round_count, 0) || ' round'
    || case when coalesce(sp.round_count, 0) = 1 then '' else 's' end as cut_sub,
  m.month_start,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend, a.reach::bigint, a.impressions, a.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = m.client_id)
           then coalesce(e.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = m.client_id)
             and coalesce(se.sessions, 0) > 0
           then coalesce(e.attendance, 0) end,
      case when ss.client_id is not null then coalesce(x.prev_buy, 0) end,
      case when ss.client_id is not null then coalesce(x.mid_buy, 0) end,
      case when ss.client_id is not null then coalesce(x.prev_rev, 0) end,
      case when ss.client_id is not null then coalesce(x.mid_rev, 0) end,
      p.preview_price, p.middle_price
    ),
    case when ss.client_id is not null then coalesce(x.paid_prev_buy, 0) end,
    case when ss.client_id is not null then coalesce(x.paid_prev_rev, 0) end,
    case when ss.client_id is not null then coalesce(x.paid_mid_rev, 0) end
  ) as m
from months m
left join spans sp on sp.client_id = m.client_id and sp.month_start = m.month_start
left join ads a on a.client_id = m.client_id and a.month_start = m.month_start
left join events_by_month e on e.client_id = m.client_id and e.month_start = m.month_start
left join sales_by_month x on x.client_id = m.client_id and x.month_start = m.month_start
left join sessions se on se.client_id = m.client_id and se.month_start = m.month_start
left join v_sales_seen ss on ss.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id;

grant select on v_metrics_by_offer, v_metrics_by_month to anon, authenticated;

commit;

-- CHECK AFTER RUNNING, THROUGH THE APP'S ANON KEY:
-- Month revenue sums to Total, and preview + middle offer revenue across all
-- rounds sums to the same Total. With the default Entry model no figure moves.
