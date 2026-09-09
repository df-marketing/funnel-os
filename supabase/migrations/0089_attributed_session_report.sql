-- ═══════════════════════════════════════════════════════════════════════════
-- 0089 — Session format keeps its actual delivery; sales follow credit.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_metrics_by_session as
with labels as (
  select r.client_id, rl.label, count(*)::int as round_count, min(r.start_date) as first_start
  from v_rounds r
  join v_round_labels rl on rl.round_id = r.round_id
  group by r.client_id, rl.label
),
attributed as materialized (
  select * from v_attributed_events
),
ads as (
  select r.client_id, rl.label, sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null), sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join v_rounds r on r.client_id = a.client_id and r.round_id = a.round_id
  join v_round_labels rl on rl.round_id = r.round_id
  group by r.client_id, rl.label
),
events_by_label as (
  select r.client_id, rl.label,
         count(*) filter (where e.event_type = 'lead') as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from attributed e
  join v_rounds r on r.client_id = e.client_id and r.round_id = e.attr_round_id
  join v_round_labels rl on rl.round_id = r.round_id
  group by r.client_id, rl.label
),
sales_by_label as (
  select r.client_id, rl.label,
         sum(e.attr_weight) filter (where e.product = 'preview') as prev_buy,
         sum(e.attr_weight) filter (where e.product = 'middle') as mid_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview') as prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle') as mid_rev,
         sum(e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle' and e.attr_source = 'Paid Ads') as paid_mid_rev
  from attributed e
  join v_rounds r on r.client_id = e.client_id and r.round_id = e.attr_round_id
  join v_round_labels rl on rl.round_id = r.round_id
  where e.event_type = 'sale'
  group by r.client_id, rl.label
)
select l.client_id, l.label as cut_key, l.label as cut_label,
  l.round_count || ' round' || case when l.round_count = 1 then '' else 's' end as cut_sub,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0, a.spend, a.reach::bigint, a.impressions, a.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = l.client_id) then coalesce(e.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = l.client_id) then coalesce(e.attendance, 0) end,
      case when seen.client_id is not null then coalesce(s.prev_buy, 0) end,
      case when seen.client_id is not null then coalesce(s.mid_buy, 0) end,
      case when seen.client_id is not null then coalesce(s.prev_rev, 0) end,
      case when seen.client_id is not null then coalesce(s.mid_rev, 0) end,
      p.preview_price, p.middle_price
    ),
    case when seen.client_id is not null then coalesce(s.paid_prev_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.paid_prev_rev, 0) end,
    case when seen.client_id is not null then coalesce(s.paid_mid_rev, 0) end
  ) as m,
  row_number() over (partition by l.client_id order by l.first_start, l.label)::int as ord
from labels l
left join ads a on a.client_id = l.client_id and a.label = l.label
left join events_by_label e on e.client_id = l.client_id and e.label = l.label
left join sales_by_label s on s.client_id = l.client_id and s.label = l.label
left join v_sales_seen seen on seen.client_id = l.client_id
left join v_client_prices p on p.client_id = l.client_id;

grant select on v_metrics_by_session to anon, authenticated;

commit;
