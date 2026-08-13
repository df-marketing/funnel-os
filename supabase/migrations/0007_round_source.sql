-- ═══════════════════════════════════════════════════════════════════════════
-- ROUND × SOURCE  — Overview / Round × source
--
-- The master sheet's actual layout: rounds across the top, each split into
-- Total · Paid Ads · Previous Paid Ads · AOAI · Organic. Two dimensions at
-- once, on the same 29-metric spine as every other view.
--
-- Requires 0006_source.sql (v_source_buckets). Creates a view — no table is
-- touched.
--
-- The per-round Total column is selected straight out of v_metrics_by_round
-- rather than re-aggregated here. That isn't laziness: it makes the Total
-- column reconcile with the By round tab by construction, so the two screens
-- can never drift apart.
--
-- The same asymmetry as v_metrics_by_round is preserved deliberately:
--   leads + attendance count on round_id       — whose class was this?
--   revenue + purchases count on lead_round_id — whose spend produced it?
-- Splitting by bucket must not quietly change which round a sale belongs to.
--
-- Spend attaches to the Paid Ads column only, for the reason given in 0006:
-- an organic lead's acquisition cost is absent, not zero.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_metrics_by_round_source as
with ev as (
  select
    client_id, round_id,
    coalesce(attribution_bucket, 'Unattributed') as bucket,
    count(*) filter (where event_type = 'lead')       as leads,
    count(*) filter (where event_type = 'attendance') as attendance
  from v_events
  group by 1, 2, 3
),
sales as (
  select
    client_id, lead_round_id as round_id,
    coalesce(attribution_bucket, 'Unattributed') as bucket,
    count(*) filter (where product = 'preview') as prev_buy,
    count(*) filter (where product = 'middle')  as mid_buy,
    sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview') as prev_rev,
    sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle')  as mid_rev
  from v_events
  where event_type = 'sale' and lead_round_id is not null
  group by 1, 2, 3
),
ads as (
  select client_id, round_id, sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by 1, 2
),
-- a cell exists if either side has rows for it; a source with nothing in a
-- round gets no column in that round rather than a column of zeroes
cells as (
  select client_id, round_id, bucket from ev
  union
  select client_id, round_id, bucket from sales
)
select
  r.client_id,
  r.round_id || '·' || c.bucket                as cut_key,
  c.bucket                                     as cut_label,
  null::text                                   as cut_sub,
  r.round_id                                   as group_key,
  r.round_id                                   as group_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as group_sub,
  r.start_date,
  coalesce(b.ord, 99)                          as ord,
  fo_metrics(
    c.bucket = 'Paid Ads' and coalesce(ads.ad_rows, 0) > 0,
    case when c.bucket = 'Paid Ads' then ads.spend       end,
    case when c.bucket = 'Paid Ads' then ads.reach       end,
    case when c.bucket = 'Paid Ads' then ads.impressions end,
    case when c.bucket = 'Paid Ads' then ads.clicks      end,
    ev.leads, ev.attendance,
    sales.prev_buy, sales.mid_buy, sales.prev_rev, sales.mid_rev,
    p.preview_price, p.middle_price
  ) as m
from cells c
join rounds r
  on r.round_id = c.round_id and r.client_id = c.client_id
left join ev
  on ev.client_id = c.client_id and ev.round_id = c.round_id and ev.bucket = c.bucket
left join sales
  on sales.client_id = c.client_id and sales.round_id = c.round_id and sales.bucket = c.bucket
left join ads
  on ads.client_id = c.client_id and ads.round_id = c.round_id
left join v_source_buckets b on b.bucket = c.bucket
left join v_client_prices p on p.client_id = c.client_id

union all

-- the per-round Total column, taken whole from By round so the two tabs agree
select
  client_id,
  cut_key || '·Total',
  'Total',
  null::text,
  cut_key,
  cut_key,
  cut_sub,
  start_date,
  0,
  m
from v_metrics_by_round
where (m->>'leads')::bigint > 0 or (m->>'rev')::numeric > 0 or (m->>'spend') is not null;

grant select on v_metrics_by_round_source to anon, authenticated;
