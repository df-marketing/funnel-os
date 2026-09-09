-- ═══════════════════════════════════════════════════════════════════════════
-- 0084 — Source is the credit source, not a second attribution model.
--
-- Previous Paid Ads existed only to preserve an entry-attribution exception.
-- v_attributed_events already supplies the selected credit source and weighted
-- sale rows, so the two source reports can use one definition. Paid Ads owns
-- delivery and spend; every other source deliberately has those cells blank.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- A source filter owns paid spend only when it selects Paid Ads and nothing
-- else. The retired Previous Paid Ads label can no longer make spend appear.
create or replace function fo_source_keeps_spend()
returns boolean language sql stable as $$
  with f as (
    select string_to_array(nullif(current_setting('funnel.source', true), ''), ',') as source
  )
  select f.source is null or f.source <@ array['Paid Ads']::text[]
  from f;
$$;

create or replace view v_metrics_by_source as
with events_by_source as materialized (
  select
    client_id,
    coalesce(attr_source, 'Unattributed') as source,
    count(*) filter (where event_type = 'lead') as leads,
    count(*) filter (where event_type = 'attendance') as attendance,
    sum(attr_weight) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
    sum(attr_weight) filter (where event_type = 'sale' and product = 'middle') as mid_buy,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight)
      filter (where event_type = 'sale' and product = 'preview') as prev_rev,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight)
      filter (where event_type = 'sale' and product = 'middle') as mid_rev,
    sum(attr_weight) filter (
      where event_type = 'sale' and product = 'preview' and attr_source = 'Paid Ads'
    ) as paid_prev_buy,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (
      where event_type = 'sale' and product = 'preview' and attr_source = 'Paid Ads'
    ) as paid_prev_rev,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (
      where event_type = 'sale' and product = 'middle' and attr_source = 'Paid Ads'
    ) as paid_mid_rev
  from v_attributed_events
  group by client_id, coalesce(attr_source, 'Unattributed')
),
ads as (
  select client_id, sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null), sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads
  group by client_id
),
shares as (
  select client_id, sum(leads) as all_leads
  from events_by_source
  group by client_id
)
select
  e.client_id,
  e.source as cut_key,
  e.source as cut_label,
  case when sh.all_leads > 0
       then to_char(round(100.0 * e.leads / sh.all_leads), 'FM999') || '% of leads'
       else 'no leads' end as cut_sub,
  case e.source
    when 'Paid Ads' then 1
    when 'Organic' then 2
    when 'Unattributed' then 3
    else 50
  end as ord,
  fo_paid_returns(
    fo_metrics(
      e.source = 'Paid Ads' and coalesce(a.ad_rows, 0) > 0,
      case when e.source = 'Paid Ads' then a.spend end,
      case when e.source = 'Paid Ads' then a.reach end,
      case when e.source = 'Paid Ads' then a.impressions end,
      case when e.source = 'Paid Ads' then a.clicks end,
      case when exists (select 1 from v_leads_seen z where z.client_id = e.client_id)
           then coalesce(e.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = e.client_id)
           then coalesce(e.attendance, 0) end,
      case when s.client_id is not null then coalesce(e.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(e.mid_buy, 0) end,
      case when s.client_id is not null then coalesce(e.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(e.mid_rev, 0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(e.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(e.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(e.paid_mid_rev, 0) end
  ) as m
from events_by_source e
left join ads a on a.client_id = e.client_id
left join shares sh on sh.client_id = e.client_id
left join v_sales_seen s on s.client_id = e.client_id
left join v_client_prices p on p.client_id = e.client_id;

create or replace view v_metrics_by_round_source as
with cls as (
  select client_id, round_id, count(*) as sessions
  from v_round_sessions
  group by client_id, round_id
),
events_by_source as materialized (
  select
    client_id, attr_round_id as round_id,
    coalesce(attr_source, 'Unattributed') as source,
    count(*) filter (where event_type = 'lead') as leads,
    count(*) filter (where event_type = 'attendance') as attendance
  from v_attributed_events
  group by client_id, attr_round_id, coalesce(attr_source, 'Unattributed')
),
sales_by_source as materialized (
  select
    client_id, attr_round_id as round_id,
    coalesce(attr_source, 'Unattributed') as source,
    sum(attr_weight) filter (where product = 'preview') as prev_buy,
    sum(attr_weight) filter (where product = 'middle') as mid_buy,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight)
      filter (where product = 'preview') as prev_rev,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight)
      filter (where product = 'middle') as mid_rev,
    sum(attr_weight) filter (where product = 'preview' and attr_source = 'Paid Ads') as paid_prev_buy,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (
      where product = 'preview' and attr_source = 'Paid Ads'
    ) as paid_prev_rev,
    sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (
      where product = 'middle' and attr_source = 'Paid Ads'
    ) as paid_mid_rev
  from v_attributed_events
  where event_type = 'sale'
  group by client_id, attr_round_id, coalesce(attr_source, 'Unattributed')
),
ads as (
  select client_id, round_id, sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null), sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads
  group by client_id, round_id
),
cells as (
  select client_id, round_id, source from events_by_source
  union
  select client_id, round_id, source from sales_by_source
)
select
  r.client_id,
  r.round_id || '·' || c.source as cut_key,
  c.source as cut_label,
  null::text as cut_sub,
  r.round_id as group_key,
  r.round_id as group_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as group_sub,
  r.start_date,
  case c.source
    when 'Paid Ads' then 1
    when 'Organic' then 2
    when 'Unattributed' then 3
    else 50
  end as ord,
  fo_paid_returns(
    fo_metrics(
      c.source = 'Paid Ads' and coalesce(a.ad_rows, 0) > 0,
      case when c.source = 'Paid Ads' then a.spend end,
      case when c.source = 'Paid Ads' then a.reach end,
      case when c.source = 'Paid Ads' then a.impressions end,
      case when c.source = 'Paid Ads' then a.clicks end,
      case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
           then coalesce(e.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
             and coalesce(cls.sessions, 0) > 0
           then coalesce(e.attendance, 0) end,
      case when s.client_id is not null then coalesce(x.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(x.mid_buy, 0) end,
      case when s.client_id is not null then coalesce(x.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(x.mid_rev, 0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(x.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(x.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(x.paid_mid_rev, 0) end
  ) as m
from cells c
join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join cls on cls.client_id = c.client_id and cls.round_id = c.round_id
left join events_by_source e
  on e.client_id = c.client_id and e.round_id = c.round_id and e.source = c.source
left join sales_by_source x
  on x.client_id = c.client_id and x.round_id = c.round_id and x.source = c.source
left join ads a on a.client_id = c.client_id and a.round_id = c.round_id
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id

union all

select
  client_id, cut_key || '·Total', 'Total', null::text,
  cut_key, cut_key, cut_sub, start_date, 0, m
from v_metrics_by_round
where (m->>'leads')::bigint > 0
   or coalesce((m->>'rev')::numeric, 0) > 0
   or (m->>'spend') is not null;

grant execute on function fo_source_keeps_spend() to anon, authenticated;
grant select on v_metrics_by_source, v_metrics_by_round_source to anon, authenticated;

commit;

-- CHECK AFTER RUNNING, THROUGH THE APP'S ANON KEY:
-- `v_metrics_by_source` must no longer return Previous Paid Ads. Its source
-- rows' revenue must sum to Total, and its Paid Ads row keeps all ad spend.
