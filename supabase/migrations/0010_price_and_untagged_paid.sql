-- ═══════════════════════════════════════════════════════════════════════════
-- THE MIDDLE OFFER HAS NO SINGLE PRICE — and untagged paid leads are not free.
--
-- 1. middle_price was configured as 3,000. The master sheet shows May's middle
--    ticket closing at 1,197 · 1,298.50 · 1,400 · 1,700 · 2,000 and never once
--    at 3,000. There is no single number that is right, so the honest value is
--    no number: Middle Selling Price renders '—' and Middle Offer AOV, which is
--    computed from money that actually moved, carries the truth.
--
--    Preview stays 297. That one really is fixed for everyone.
--
--    If the business does have a list price it discounts from, set it here and
--    Middle Selling Price starts reading again. Absent is a statement, not a
--    placeholder.
--
-- 2. FOURTEEN PAID LEADS WITH NO AD SET WERE FALLING OUT OF TARGETED VIEWS
--    ENTIRELY — including both buyers.
--
--        SALE 297 preview → their lead: {"utm_campaign": null, "source": "Paid Ads"}
--        SALE 297 preview → their lead: {"utm_campaign": null, "source": "Paid Ads"}
--
--    They are Paid Ads because their GoHighLevel campaign says so
--    (DF_SG_Preview_Sprint1_0526_02 is a Meta campaign). They have no ad set
--    because 23 people in the master export never appear in either round file,
--    and utm_term only exists there. No ad set is not the same as no ad.
--
--    Calling them Organic would say they cost nothing to acquire, which would
--    move 594.00 of revenue out of Paid Ads, blank the paid ROAS and invent an
--    organic return on spend that never happened. So they stay Paid Ads — but
--    they stop vanishing. The 'Unsplit spend' column already holds ad money
--    that names no audience; it now holds the paid people who name none either.
--    Same column, same reason: real, paid, unsplittable.
--
--    Organic and community leads still belong to no audience column, because
--    for them there genuinely was no ad.
--
-- Requires 0009. Changes one config value and one view.
-- ═══════════════════════════════════════════════════════════════════════════

update client_journey_config
   set unit_price = null
 where stage_slug = 'middle' and client_id = 'shely';

create or replace view v_metrics_by_adset as
with ads as (
  select client_id, nullif(btrim(ad_set), '') as ad_set,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, nullif(btrim(ad_set), '')
),
-- The audience that ACQUIRED each person: the earliest lead of theirs carrying
-- a utm. Paid leads with no utm resolve to the unsplit bucket instead of to
-- nothing, so their attendance and purchases stay attached to paid money.
lead_audience as (
  select distinct on (client_id, contact_id)
         client_id, contact_id,
         coalesce(nullif(btrim(utm_campaign), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad_set
  from v_events
  where event_type = 'lead'
    and contact_id is not null
    and (nullif(btrim(utm_campaign), '') is not null or source = 'Paid Ads')
  order by client_id, contact_id, event_date
),
-- A LEAD is counted on its OWN tag, not on the acquiring lead's. The two differ
-- for anyone who opted in twice, and routing those through the first audience
-- inflated the lead total. That second opt-in really did come from the second
-- ad set — it is the events with no tag of their own that need the detour.
ev_leads as (
  select client_id,
         coalesce(nullif(btrim(utm_campaign), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad_set,
         count(*) as leads
  from v_events
  where event_type = 'lead'
    and (nullif(btrim(utm_campaign), '') is not null or source = 'Paid Ads')
  group by 1, 2
),
ev_after as (
  select
    la.client_id, la.ad_set,
    count(*) filter (where e.event_type = 'attendance') as attendance,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buy,
    count(*) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_rev
  from v_events e
  join lead_audience la
    on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type <> 'lead'
  group by la.client_id, la.ad_set
),
ev as (
  select
    coalesce(l.client_id, a.client_id) as client_id,
    coalesce(l.ad_set, a.ad_set)       as ad_set,
    l.leads, a.attendance, a.prev_buy, a.mid_buy, a.prev_rev, a.mid_rev
  from ev_leads l
  full join ev_after a on a.client_id = l.client_id and a.ad_set = l.ad_set
),
-- ads with no ad set and paid people with no ad set are the same column
cut as (
  select
    coalesce(ads.client_id, ev.client_id) as client_id,
    case when ads.ad_set is null and ev.ad_set is null then '(unsplit)'
         else coalesce(ads.ad_set, ev.ad_set) end as ad_set,
    ads.spend, ads.reach, ads.impressions, ads.clicks, ads.ad_rows,
    ev.leads, ev.attendance, ev.prev_buy, ev.mid_buy, ev.prev_rev, ev.mid_rev
  from ads
  full join ev on ev.client_id = ads.client_id and ev.ad_set = ads.ad_set
),
-- sum() widens bigint to numeric, and fo_metrics is typed on bigint for the
-- counts. Cast back explicitly rather than letting the call fail to resolve.
rolled as (
  select client_id, ad_set,
         sum(spend)::numeric      as spend,
         sum(reach)::bigint       as reach,
         sum(impressions)::bigint as impressions,
         sum(clicks)::bigint      as clicks,
         sum(ad_rows)::bigint     as ad_rows,
         sum(leads)::bigint       as leads,
         sum(attendance)::bigint  as attendance,
         sum(prev_buy)::bigint    as prev_buy,
         sum(mid_buy)::bigint     as mid_buy,
         sum(prev_rev)::numeric   as prev_rev,
         sum(mid_rev)::numeric    as mid_rev
  from cut group by client_id, ad_set
)
select
  r.client_id,
  r.ad_set                                                  as cut_key,
  case when r.ad_set = '(unsplit)' then 'Unsplit spend' else r.ad_set end as cut_label,
  case when r.ad_set = '(unsplit)'
       then 'paid, no ad set recorded' end                  as cut_sub,
  fo_metrics(
    coalesce(r.ad_rows, 0) > 0,
    r.spend, r.reach, r.impressions, r.clicks,
    coalesce(r.leads, 0), coalesce(r.attendance, 0),
    case when s.client_id is not null then coalesce(r.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(r.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(r.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(r.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m,
  case when r.ad_set = '(unsplit)' then -1 else coalesce(r.spend, 0) end as sort_spend,
  -- Fixed column order: spend, then leads, then name, so it is total rather
  -- than merely mostly-decided. Unsplit always last — real money, not an
  -- audience.
  row_number() over (
    partition by r.client_id
    order by
      case when r.ad_set = '(unsplit)' then 1 else 0 end,
      coalesce(r.spend, 0) desc,
      coalesce(r.leads, 0) desc,
      r.ad_set
  )::int                                                    as ord
from rolled r
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by 1, ord;

grant select on v_metrics_by_adset to anon, authenticated;
