-- ═══════════════════════════════════════════════════════════════════════════
-- 0086 — A sequence keeps its people; credited sales follow the model.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_metrics_by_variant as
with leads as (
  select client_id, nullif(btrim(variant), '') as variant, count(*) as leads
  from v_attributed_events
  where event_type = 'lead' and nullif(btrim(variant), '') is not null
  group by client_id, nullif(btrim(variant), '')
),
attendance as (
  select client_id, nullif(btrim(variant), '') as variant, count(*) as attendance
  from v_attributed_events
  where event_type = 'attendance' and nullif(btrim(variant), '') is not null
  group by client_id, nullif(btrim(variant), '')
),
sales as (
  select client_id, nullif(btrim(attr_variant), '') as variant,
         sum(attr_weight) filter (where product = 'preview') as prev_buy,
         sum(attr_weight) filter (where product = 'middle') as mid_buy,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'preview') as prev_rev,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'middle') as mid_rev
  from v_attributed_events
  where event_type = 'sale' and nullif(btrim(attr_variant), '') is not null
  group by client_id, nullif(btrim(attr_variant), '')
),
cells as (
  select client_id, variant from leads
  union select client_id, variant from attendance
  union select client_id, variant from sales
)
select c.client_id, c.variant as cut_key, c.variant as cut_label, null::text as cut_sub,
  fo_metrics(
    false, null::numeric, null::bigint, null::bigint, null::bigint,
    coalesce(l.leads, 0), coalesce(a.attendance, 0),
    case when seen.client_id is not null then coalesce(s.prev_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.prev_rev, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_rev, 0) end,
    p.preview_price, p.middle_price
  ) as m,
  row_number() over (partition by c.client_id order by c.variant)::int as ord
from cells c
left join leads l on l.client_id = c.client_id and l.variant = c.variant
left join attendance a on a.client_id = c.client_id and a.variant = c.variant
left join sales s on s.client_id = c.client_id and s.variant = c.variant
left join v_sales_seen seen on seen.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

create or replace view v_metrics_by_variant_round as
with leads as (
  select client_id, attr_round_id as round_id, nullif(btrim(variant), '') as variant, count(*) as leads
  from v_attributed_events
  where event_type = 'lead' and nullif(btrim(variant), '') is not null
  group by client_id, attr_round_id, nullif(btrim(variant), '')
),
attendance as (
  select client_id, attr_round_id as round_id, nullif(btrim(variant), '') as variant, count(*) as attendance
  from v_attributed_events
  where event_type = 'attendance' and nullif(btrim(variant), '') is not null
  group by client_id, attr_round_id, nullif(btrim(variant), '')
),
sales as (
  select client_id, attr_round_id as round_id, nullif(btrim(attr_variant), '') as variant,
         sum(attr_weight) filter (where product = 'preview') as prev_buy,
         sum(attr_weight) filter (where product = 'middle') as mid_buy,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'preview') as prev_rev,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'middle') as mid_rev
  from v_attributed_events
  where event_type = 'sale' and nullif(btrim(attr_variant), '') is not null
  group by client_id, attr_round_id, nullif(btrim(attr_variant), '')
),
cells as (
  select client_id, round_id, variant from leads
  union select client_id, round_id, variant from attendance
  union select client_id, round_id, variant from sales
)
select
  c.client_id, c.variant || '·' || c.round_id as cut_key,
  c.round_id as cut_label, to_char(r.start_date, 'Mon DD') as cut_sub,
  c.variant as group_key, c.variant as group_label, null::text as group_sub,
  r.start_date,
  fo_metrics(
    false, null::numeric, null::bigint, null::bigint, null::bigint,
    coalesce(l.leads, 0), coalesce(a.attendance, 0),
    case when seen.client_id is not null then coalesce(s.prev_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_buy, 0) end,
    case when seen.client_id is not null then coalesce(s.prev_rev, 0) end,
    case when seen.client_id is not null then coalesce(s.mid_rev, 0) end,
    p.preview_price, p.middle_price
  ) as m,
  row_number() over (partition by c.client_id, c.variant order by r.start_date)::int as ord
from cells c
join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join leads l on l.client_id = c.client_id and l.round_id = c.round_id and l.variant = c.variant
left join attendance a on a.client_id = c.client_id and a.round_id = c.round_id and a.variant = c.variant
left join sales s on s.client_id = c.client_id and s.round_id = c.round_id and s.variant = c.variant
left join v_sales_seen seen on seen.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

grant select on v_metrics_by_variant, v_metrics_by_variant_round to anon, authenticated;

commit;

-- CHECK: These views retain their no-spend shape. Under Entry, their sales
-- match the existing reading; under Even Split their weighted sales still sum.
