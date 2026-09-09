-- ═══════════════════════════════════════════════════════════════════════════
-- 0083 — core reports sum the credit, not the duplicated sale row.
--
-- The previous view supplies one weighted row per credited touch. Counts and
-- revenue below the lead line therefore use SUM(attr_weight), never COUNT(*).
-- Leads and attendance remain physical events and keep COUNT(*). Ads have no
-- attribution row at all, so spend and delivery remain untouched.
--
-- Entry is the default and is deliberately required to reproduce the current
-- totals exactly: spend 20474.78, leads 1889, attendance 682, revenue 83927.
-- Under Even Split those totals must remain identical while round columns may
-- become fractional.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- The existing helper accepts an integer customer count. Even Split can make
-- that count fractional, so this overload preserves the same ROAS/CPA formula
-- without rounding a credited half-sale into a whole customer.
create or replace function fo_paid_returns(
  m               jsonb,
  p_paid_prev_buy numeric,
  p_paid_prev_rev numeric,
  p_paid_mid_rev  numeric
) returns jsonb
language sql
immutable
as $$
  select m || jsonb_build_object(
    'cpa',      (m->>'spend')::numeric / nullif(p_paid_prev_buy, 0),
    'prevRoas', p_paid_prev_rev / nullif((m->>'spend')::numeric, 0),
    'midRoas',  p_paid_mid_rev  / nullif((m->>'spend')::numeric, 0),
    'roas',     (p_paid_prev_rev + p_paid_mid_rev) / nullif((m->>'spend')::numeric, 0)
  );
$$;

grant execute on function fo_paid_returns(jsonb, numeric, numeric, numeric)
  to anon, authenticated;

create or replace view v_metrics_total as
with ads as (
  select client_id, sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads group by client_id
),
ev as (
  select client_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance,
         sum(attr_weight) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
         sum(attr_weight) filter (where event_type = 'sale' and product = 'middle')  as mid_buy,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where event_type = 'sale' and product = 'preview') as prev_rev,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where event_type = 'sale' and product = 'middle')  as mid_rev,
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
  group by client_id
)
select
  c.client_id,
  'TOTAL'::text as cut_key,
  'Total'::text as cut_label,
  'all rounds'::text as cut_sub,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = c.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = c.client_id)
           then coalesce(ev.attendance, 0) end,
      case when s.client_id is not null then coalesce(ev.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(ev.mid_buy,  0) end,
      case when s.client_id is not null then coalesce(ev.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(ev.mid_rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(ev.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(ev.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(ev.paid_mid_rev,  0) end
  ) as m
from v_clients c
left join ads on ads.client_id = c.client_id
left join ev  on ev.client_id  = c.client_id
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

create or replace view v_metrics_by_round as
with cls as (
  select client_id, round_id, count(*) as sessions
  from v_round_sessions group by client_id, round_id
),
ads as (
  select client_id, round_id,
         sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, round_id
),
ev as (
  select client_id, attr_round_id as round_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance
  from v_attributed_events
  group by client_id, attr_round_id
),
sales as (
  select client_id, attr_round_id as round_id,
         sum(attr_weight) filter (where product = 'preview') as prev_buy,
         sum(attr_weight) filter (where product = 'middle')  as mid_buy,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'preview') as prev_rev,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'middle')  as mid_rev,
         sum(attr_weight) filter (where product = 'preview' and attr_source = 'Paid Ads') as paid_prev_buy,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'preview' and attr_source = 'Paid Ads') as paid_prev_rev,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight)
           filter (where product = 'middle' and attr_source = 'Paid Ads') as paid_mid_rev
  from v_attributed_events
  where event_type = 'sale'
  group by client_id, attr_round_id
)
select
  r.client_id,
  r.round_id as cut_key,
  r.round_id as cut_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as cut_sub,
  r.start_date,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
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
    case when s.client_id is not null then coalesce(sales.paid_mid_rev, 0) end
  ) as m
from v_rounds r
left join cls   on cls.client_id = r.client_id and cls.round_id = r.round_id
left join ads   on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev    on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales on sales.client_id = r.client_id and sales.round_id = r.round_id
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, r.start_date;

grant select on v_metrics_total, v_metrics_by_round to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING, THROUGH THE APP'S ANON KEY ───────────────────────
-- Default Entry must return exactly:
-- 20474.78 spend · 1889 leads · 682 attendance · 83927 revenue · ROAS 1.80.
-- By round must still sum to Total. A later selector test changes per-round
-- sales only; it must not change either Total number.
