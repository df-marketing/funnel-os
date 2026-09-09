-- ═══════════════════════════════════════════════════════════════════════════
-- 0077 — a landing-page read reuses its rows.
--
-- 0076 stopped each base reader from resolving a campaign per source row. The
-- landing-page view then used v_events independently for leads, attendance and
-- sales, so Postgres built that base reader again for each CTE. The answer was
-- still right but the app timed out before receiving it.
--
-- Build the filtered ads, filtered events and campaign labels once for each
-- landing-page request, then let every calculation below read those same rows.
-- These are MATERIALIZED CTES, not stored tables: a rule edit is still visible
-- on the next request. No metric definition or attribution changes here.
--
-- Safe to re-run. Baseline stays spend 20474.78 · leads 1889 · attendance 682
-- · revenue 83927.00 · ROAS 1.80.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_metrics_by_lp as
with campaign_dimensions as materialized (
  select * from v_campaign_dimensions
), ad_rows as materialized (
  select * from v_ads
), event_rows as materialized (
  select * from v_events
), ads as (
  select a.client_id, d.landing_page as lp,
         sum(a.spend) as spend, sum(a.impressions) as impressions,
         sum(a.clicks) as clicks, count(*) as ad_rows
  from ad_rows a
  join campaign_dimensions d on d.client_id = a.client_id
                           and d.campaign is not distinct from a.campaign
  where d.landing_page is not null
  group by 1, 2
), lead_lp as (
  select distinct on (e.client_id, e.contact_id, e.round_id)
         e.client_id, e.contact_id, e.round_id, d.landing_page as lp
  from event_rows e
  join campaign_dimensions d on d.client_id = e.client_id
                           and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and e.contact_id is not null
    and d.landing_page is not null
  order by e.client_id, e.contact_id, e.round_id, e.event_date
), ev_leads as (
  select e.client_id, d.landing_page as lp, count(*) as leads
  from event_rows e
  join campaign_dimensions d on d.client_id = e.client_id
                           and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and d.landing_page is not null
  group by 1, 2
), ev_att as (
  select l.client_id, l.lp, count(*) as attendance
  from event_rows e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id
             and l.round_id = e.round_id
  where e.event_type = 'attendance'
  group by 1, 2
), ev_sale as (
  select l.client_id, l.lp,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle') as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle') as mid_rev,
    count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_mid_rev
  from event_rows e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id
             and l.round_id = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2
), cells as (
  select client_id, lp from ads union select client_id, lp from ev_leads
)
select c.client_id, c.lp as cut_key, c.lp as cut_label, null::text as cut_sub,
  fo_paid_returns(fo_metrics(
    coalesce(a.ad_rows, 0) > 0, a.spend, null::bigint, a.impressions, a.clicks,
    coalesce(l.leads, 0), coalesce(t.attendance, 0),
    case when s.client_id is not null then coalesce(v.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.mid_buy, 0) end,
    case when s.client_id is not null then coalesce(v.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.mid_rev, 0) end,
    p.preview_price, p.middle_price
  ),
    case when s.client_id is not null then coalesce(v.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.paid_mid_rev, 0) end
  ) as m,
  row_number() over (partition by c.client_id order by c.lp)::int as ord
from cells c
left join ads a on a.client_id = c.client_id and a.lp = c.lp
left join ev_leads l on l.client_id = c.client_id and l.lp = c.lp
left join ev_att t on t.client_id = c.client_id and t.lp = c.lp
left join ev_sale v on v.client_id = c.client_id and v.lp = c.lp
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, ord;

create or replace view v_metrics_by_lp_round as
with campaign_dimensions as materialized (
  select * from v_campaign_dimensions
), ad_rows as materialized (
  select * from v_ads
), event_rows as materialized (
  select * from v_events
), ads as (
  select a.client_id, a.round_id, d.landing_page as lp,
         sum(a.spend) as spend, sum(a.impressions) as impressions,
         sum(a.clicks) as clicks, count(*) as ad_rows
  from ad_rows a
  join campaign_dimensions d on d.client_id = a.client_id
                           and d.campaign is not distinct from a.campaign
  where d.landing_page is not null
  group by 1, 2, 3
), lead_lp as (
  select distinct on (e.client_id, e.contact_id, e.round_id)
         e.client_id, e.contact_id, e.round_id, d.landing_page as lp
  from event_rows e
  join campaign_dimensions d on d.client_id = e.client_id
                           and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and e.contact_id is not null
    and d.landing_page is not null
  order by e.client_id, e.contact_id, e.round_id, e.event_date
), ev_leads as (
  select e.client_id, e.round_id, d.landing_page as lp, count(*) as leads
  from event_rows e
  join campaign_dimensions d on d.client_id = e.client_id
                           and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and d.landing_page is not null
  group by 1, 2, 3
), ev_att as (
  select l.client_id, l.round_id, l.lp, count(*) as attendance
  from event_rows e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id
             and l.round_id = e.round_id
  where e.event_type = 'attendance'
  group by 1, 2, 3
), ev_sale as (
  select l.client_id, l.round_id, l.lp,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle') as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle') as mid_rev,
    count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_mid_rev
  from event_rows e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id
             and l.round_id = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2, 3
), cells as (
  select client_id, round_id, lp from ads union select client_id, round_id, lp from ev_leads
)
select c.client_id, c.lp || '·' || c.round_id as cut_key,
  c.round_id as cut_label, to_char(r.start_date, 'Mon DD') as cut_sub,
  c.lp as group_key, c.lp as group_label, null::text as group_sub, r.start_date,
  fo_paid_returns(fo_metrics(
    coalesce(a.ad_rows, 0) > 0, a.spend, null::bigint, a.impressions, a.clicks,
    coalesce(l.leads, 0), coalesce(t.attendance, 0),
    case when s.client_id is not null then coalesce(v.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.mid_buy, 0) end,
    case when s.client_id is not null then coalesce(v.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.mid_rev, 0) end,
    p.preview_price, p.middle_price
  ),
    case when s.client_id is not null then coalesce(v.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.paid_mid_rev, 0) end
  ) as m,
  row_number() over (partition by c.client_id, c.lp order by r.start_date)::int as ord
from cells c
join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join ads a on a.client_id = c.client_id and a.round_id = c.round_id and a.lp = c.lp
left join ev_leads l on l.client_id = c.client_id and l.round_id = c.round_id and l.lp = c.lp
left join ev_att t on t.client_id = c.client_id and t.round_id = c.round_id and t.lp = c.lp
left join ev_sale v on v.client_id = c.client_id and v.round_id = c.round_id and v.lp = c.lp
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, group_key, start_date;

grant select on v_metrics_by_lp, v_metrics_by_lp_round to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING, THROUGH THE ANON KEY ─────────────────────────────
-- v_metrics_total remains 20474.78 spend · 1889 leads · 682 attendance ·
-- 83927.00 revenue. v_metrics_by_lp returns without timeout:
-- LP1 11853.47 spend · 738 leads · 26.8% show · 1.88 ROAS
-- LP2  3056.16 spend · 216 leads · 20.4% show · 0.66 ROAS
-- Lead Form 5565.15 spend · 595 leads.
