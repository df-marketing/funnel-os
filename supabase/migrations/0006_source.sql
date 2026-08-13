-- ═══════════════════════════════════════════════════════════════════════════
-- BY SOURCE  — Overview / By source
--
-- The master sheet splits every round into Total · Paid Ads · Previous Paid Ads
-- · AOAI · Organic. This is that split, as columns on the same spine as every
-- other view — same 29 metrics, same order, same blank-vs-zero rule.
--
-- The bucket is not a new concept: v_events already derives attribution_bucket,
-- including the Previous Paid Ads rule (a Paid Ads person whose closing round
-- isn't the round that produced the lead). This view only groups by it.
--
-- SPEND BELONGS TO PAID ADS, AND ONLY TO PAID ADS.
-- An AOAI member costs nothing to acquire and an organic lead costs nothing to
-- acquire, so their spend is not zero — it does not exist. fo_metrics is told
-- has_ads = false for those columns, which blanks spend, CPM, CPC, CPL, CPA and
-- both ROAS rows rather than dividing by zero. That matches the master sheet,
-- where those cells are empty and the ratios read #DIV/0!.
--
-- Run in the Supabase SQL editor. Creates views only — no table is touched.
-- ═══════════════════════════════════════════════════════════════════════════

-- Column order is fixed rather than data-driven: a column that appears and
-- disappears as rows land would move the others sideways between page loads.
create or replace view v_source_buckets as
select * from (values
  ('Paid Ads',          1, 'utm captured at opt-in'),
  ('Previous Paid Ads', 2, 'paid lead from an earlier round'),
  ('AOAI',              3, 'community member'),
  ('AI Community',      4, 'community member'),
  ('Organic',           5, 'no utm, no community tag'),
  ('Unattributed',      6, 'source not recorded')
) as t(bucket, ord, note);

create or replace view v_metrics_by_source as
with ev as (
  select
    client_id,
    coalesce(attribution_bucket, 'Unattributed') as bucket,
    count(*) filter (where event_type = 'lead')       as leads,
    count(*) filter (where event_type = 'attendance') as attendance,
    count(*) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
    count(*) filter (where event_type = 'sale' and product = 'middle')  as mid_buy,
    sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'preview') as prev_rev,
    sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle')  as mid_rev
  from v_events
  group by client_id, coalesce(attribution_bucket, 'Unattributed')
),
ads as (
  select client_id, sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id
),
share as (
  select client_id, sum(leads) as all_leads from ev group by client_id
)
select
  ev.client_id,
  ev.bucket                                   as cut_key,
  ev.bucket                                   as cut_label,
  case
    when share.all_leads > 0
      then to_char(round(100.0 * ev.leads / share.all_leads), 'FM999') || '% of leads'
    else coalesce(b.note, 'no leads')
  end                                         as cut_sub,
  coalesce(b.ord, 99)                         as ord,
  fo_metrics(
    -- only the paid column has spend behind it
    ev.bucket = 'Paid Ads' and coalesce(ads.ad_rows, 0) > 0,
    case when ev.bucket = 'Paid Ads' then ads.spend       end,
    case when ev.bucket = 'Paid Ads' then ads.reach       end,
    case when ev.bucket = 'Paid Ads' then ads.impressions end,
    case when ev.bucket = 'Paid Ads' then ads.clicks      end,
    ev.leads, ev.attendance,
    ev.prev_buy, ev.mid_buy, ev.prev_rev, ev.mid_rev,
    p.preview_price, p.middle_price
  ) as m
from ev
left join v_source_buckets b on b.bucket = ev.bucket
left join ads   on ads.client_id   = ev.client_id
left join share on share.client_id = ev.client_id
left join v_client_prices p on p.client_id = ev.client_id
order by ev.client_id, coalesce(b.ord, 99);

grant select on v_source_buckets to anon, authenticated;
grant select on v_metrics_by_source to anon, authenticated;
