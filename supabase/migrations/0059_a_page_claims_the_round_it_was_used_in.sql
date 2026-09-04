-- ═══════════════════════════════════════════════════════════════════════════
-- 0059 — a landing page claims the round it was used in.
--
-- 0058 built the combined view person-level (the page that FIRST acquired
-- somebody, claiming everything they ever did) and the round view per-round.
-- Two readings of the same thing, so the drill-down did not sum to the tab it
-- drills out of:
--
--     LP1  attendance  156 across its rounds   ·   164 on the combined row
--     LP2  attendance   44 across its rounds   ·    51 on the combined row
--
-- Fifteen attendances, and every one of them is somebody who came back for a
-- LATER round WITHOUT a landing page — organic, or a campaign that carried no
-- LP token. Nought of them attended a round on a page different from the one
-- they used for it, so this is not an attribution argument between LP1 and LP2:
-- it is a page claiming rounds it was not in.
--
-- Per-round wins, and the combined view is the one that changes. A landing
-- page's job is to turn a click into a lead and that lead into an attendee for
-- THAT round. What the same person does three rounds later, having arrived by
-- some other route, is not the page's doing.
--
-- Deliberately different from creative and audience, which stay person-level:
-- there the documented question is "which creative ACQUIRED this person", and a
-- creative's value does include what that person goes on to do. A page is
-- narrower — it is the door for one round, not the reason somebody exists.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_metrics_by_lp as
with ads as (
  select client_id, fo_landing_page(campaign) as lp,
         sum(spend) as spend, sum(impressions) as impressions,
         sum(clicks) as clicks, count(*) as ad_rows
  from v_ads where fo_landing_page(campaign) is not null
  group by 1, 2
),
-- the page they used FOR THAT ROUND, which is the only round it can claim
lead_lp as (
  select distinct on (client_id, contact_id, round_id)
         client_id, contact_id, round_id, fo_landing_page(utm_campaign) as lp
  from v_events
  where event_type = 'lead' and contact_id is not null
    and fo_landing_page(utm_campaign) is not null
  order by client_id, contact_id, round_id, event_date
),
ev_leads as (
  select client_id, fo_landing_page(utm_campaign) as lp, count(*) as leads
  from v_events
  where event_type = 'lead' and fo_landing_page(utm_campaign) is not null
  group by 1, 2
),
ev_att as (
  select l.client_id, l.lp, count(*) as attendance
  from v_events e
  join lead_lp l
    on l.client_id = e.client_id and l.contact_id = e.contact_id and l.round_id = e.round_id
  where e.event_type = 'attendance'
  group by 1, 2
),
ev_sale as (
  select l.client_id, l.lp,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
    count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_mid_rev
  from v_events e
  join lead_lp l
    on l.client_id = e.client_id and l.contact_id = e.contact_id
   and l.round_id = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2
),
cells as (
  select client_id, lp from ads
  union select client_id, lp from ev_leads
)
select
  c.client_id,
  c.lp        as cut_key,
  c.lp        as cut_label,
  null::text  as cut_sub,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend,
      null::bigint,                       -- 0016: reach is not additive
      a.impressions, a.clicks,
      coalesce(l.leads, 0), coalesce(t.attendance, 0),
      case when s.client_id is not null then coalesce(v.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(v.mid_buy,  0) end,
      case when s.client_id is not null then coalesce(v.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(v.mid_rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(v.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.paid_mid_rev,  0) end
  ) as m,
  row_number() over (partition by c.client_id order by c.lp)::int as ord
from cells c
left join ads      a on a.client_id = c.client_id and a.lp = c.lp
left join ev_leads l on l.client_id = c.client_id and l.lp = c.lp
left join ev_att   t on t.client_id = c.client_id and t.lp = c.lp
left join ev_sale  v on v.client_id = c.client_id and v.lp = c.lp
left join v_sales_seen   s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, ord;

grant select on v_metrics_by_lp to anon, authenticated;

commit;
