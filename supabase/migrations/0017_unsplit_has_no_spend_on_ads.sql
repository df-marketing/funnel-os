-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 — the Ads tab's Unsplit row must not claim it spent nothing.
--
-- 0016 taught v_metrics_by_adset that the (unsplit) bucket has no spend of its
-- own: the rows that land there are correction rows carrying reach and clicks
-- with spend 0.00, and 0.00 is not the same statement as "no spend recorded".
-- Left as 0.00 it also poisons CPL, which divided 0.00 by 9 leads and printed
-- "CPL 0.00" — a cost of nothing, on nine real people.
--
-- v_metrics_by_ad has exactly the same bucket and never got the same fix. Every
-- ad-set row and every round row in the ads file has a null `ad`, so all twenty
-- of them fold into (unsplit) there, and their spends are all 0.00.
--
-- The only change is nullif(spend, 0) on that one bucket, matching 0016 line
-- for line. Reach, impressions and clicks were already blanked in 0015 for the
-- same reason — delivery has no subject when nobody knows which creative it
-- was — so this closes the last column that was still answering.
--
-- Named creatives are untouched: a creative that genuinely spent 0.00 in a
-- round still reports 0.00, because it has ad rows and the bucket test is on
-- the literal '(unsplit)' key, not on the amount.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_ad as
with ads as (
  select client_id, nullif(btrim(ad), '') as ad,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, nullif(btrim(ad), '')
),
-- the creative that ACQUIRED each person: their earliest lead carrying one
lead_ad as (
  select distinct on (client_id, contact_id)
         client_id, contact_id,
         coalesce(nullif(btrim(ad), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad
  from v_events
  where event_type = 'lead' and contact_id is not null
    and (nullif(btrim(ad), '') is not null or source = 'Paid Ads')
  order by client_id, contact_id, event_date
),
-- a lead counts on its OWN creative; only later events need the detour
ev_leads as (
  select client_id,
         coalesce(nullif(btrim(ad), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad,
         count(*) as leads
  from v_events
  where event_type = 'lead'
    and (nullif(btrim(ad), '') is not null or source = 'Paid Ads')
  group by 1, 2
),
ev_after as (
  select la.client_id, la.ad,
    count(*) filter (where e.event_type = 'attendance') as attendance,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buy,
    count(*) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_rev
  from v_events e
  join lead_ad la on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type <> 'lead'
  group by la.client_id, la.ad
),
ev as (
  select coalesce(l.client_id, a.client_id) as client_id,
         coalesce(l.ad, a.ad)               as ad,
         l.leads, a.attendance, a.prev_buy, a.mid_buy, a.prev_rev, a.mid_rev
  from ev_leads l
  full join ev_after a on a.client_id = l.client_id and a.ad = l.ad
),
cut as (
  select coalesce(ads.client_id, ev.client_id) as client_id,
         case when ads.ad is null and ev.ad is null then '(unsplit)'
              else coalesce(ads.ad, ev.ad) end as ad,
         ads.spend, ads.reach, ads.impressions, ads.clicks, ads.ad_rows,
         ev.leads, ev.attendance, ev.prev_buy, ev.mid_buy, ev.prev_rev, ev.mid_rev
  from ads full join ev on ev.client_id = ads.client_id and ev.ad = ads.ad
),
rolled as (
  select client_id, ad,
         sum(spend)::numeric as spend, sum(reach)::bigint as reach,
         sum(impressions)::bigint as impressions, sum(clicks)::bigint as clicks,
         sum(ad_rows)::bigint as ad_rows, sum(leads)::bigint as leads,
         sum(attendance)::bigint as attendance, sum(prev_buy)::bigint as prev_buy,
         sum(mid_buy)::bigint as mid_buy, sum(prev_rev)::numeric as prev_rev,
         sum(mid_rev)::numeric as mid_rev
  from cut group by client_id, ad
)
select
  r.client_id,
  r.ad                                                        as cut_key,
  case when r.ad = '(unsplit)' then 'Unsplit spend' else r.ad end as cut_label,
  case when r.ad = '(unsplit)' then 'paid, no ad recorded'
       when r.ad ~ '^[0-9]+$' then 'Ad ID, no name in the export' end as cut_sub,
  fo_metrics(
    coalesce(r.ad_rows, 0) > 0,
    -- the one change: 0.00 in this bucket means "not recorded", not "free"
    case when r.ad = '(unsplit)' then nullif(r.spend, 0) else r.spend end,
    -- same rule as 0013: delivery has no subject in the unattributable bucket
    case when r.ad <> '(unsplit)' then r.reach       end,
    case when r.ad <> '(unsplit)' then r.impressions end,
    case when r.ad <> '(unsplit)' then r.clicks      end,
    coalesce(r.leads, 0), coalesce(r.attendance, 0),
    case when s.client_id is not null then coalesce(r.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(r.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(r.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(r.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m,
  row_number() over (
    partition by r.client_id
    order by case when r.ad = '(unsplit)' then 1 else 0 end,
             coalesce(r.leads, 0) desc, coalesce(r.spend, 0) desc, r.ad
  )::int as ord
from rolled r
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by 1, ord;

grant select on v_metrics_by_ad to anon, authenticated;
