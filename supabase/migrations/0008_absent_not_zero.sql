-- ═══════════════════════════════════════════════════════════════════════════
-- ABSENT IS NOT ZERO — for sales, and for spend that names no audience.
--
-- The footer of every screen promises "blank means absent, not zero". fo_metrics
-- kept that promise for ads (p_has_ads blanks spend, CPM, CPC, CPL) and broke it
-- for everything else, because it coalesced the people and money inputs to 0
-- before doing any arithmetic.
--
-- What that produced, on real data, with no payments file ever imported:
--
--     0526-02 → spend 1378.24 · rev 0 · roas 0 · cpa null
--
-- CPA went blank, correctly — no denominator. Revenue and ROAS read a hard ZERO,
-- which is a measurement: it says the round earned nothing. The master sheet says
-- that round returned 6.0×. Nobody had loaded a sale yet; the app was reporting a
-- number about data that did not exist, and reporting it in the direction that
-- makes the work look worthless.
--
-- Compare an empty round under the old rule and you can see the inconsistency in
-- one row: spend is null so it renders "—", rev is 0 so it renders "0.00". Two
-- absences, two different answers.
--
-- Two changes, same idea:
--
--   1. fo_metrics no longer coalesces. NULL in, NULL out — and because SQL
--      arithmetic propagates NULL, every rate and ratio derived from a missing
--      input goes blank on its own. Each view now decides for itself where 0 is
--      a real measurement, and passes coalesce(x, 0) only there.
--
--   2. Ad rows that name no ad set stop being an audience called "". They were
--      appearing on Targeted views as a column with an empty header holding
--      every dollar and zero leads — and a Lead Gen % of 0.00%, which claims
--      those 856 clicks produced nobody. They produced 306 people; we just can't
--      say which audience they came from. That column is now labelled, and its
--      people-derived rows are blank rather than zero.
--
-- Requires 0003, 0006, 0007. Creates views and replaces one function — no table
-- is touched, and no signature changes, so nothing needs dropping.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The spine ──────────────────────────────────────────────────────────────
-- Same 13 parameters as before, so this is a body-only replacement and the
-- dependent views survive it.
create or replace function fo_metrics(
  p_has_ads           boolean,          -- does this cut have ANY ads_performance rows?
  p_spend             numeric,
  p_reach             bigint,
  p_impressions       bigint,
  p_clicks            bigint,
  p_leads             bigint,
  p_attendance        bigint,
  p_preview_purchases bigint,
  p_middle_purchases  bigint,
  p_preview_revenue   numeric,
  p_middle_revenue    numeric,
  p_preview_price     numeric,          -- configured unit price, from client_journey_config
  p_middle_price      numeric
) returns jsonb
language sql
immutable
as $$
  with m as (
    select
      -- blank-vs-zero: no ads rows for this cut => the ads metrics do not exist
      case when p_has_ads then p_spend       end as spend,
      case when p_has_ads then p_reach       end as reach,
      case when p_has_ads then p_impressions end as impressions,
      case when p_has_ads then p_clicks      end as clicks,
      -- NO coalesce. A caller that means zero passes zero; a caller that means
      -- "this was never measured" passes NULL and every metric below it blanks
      -- itself, because NULL + anything is NULL and NULL / anything is NULL.
      p_leads             as leads,
      p_attendance        as attendance,
      p_preview_purchases as prev_buy,
      p_middle_purchases  as mid_buy,
      p_preview_revenue   as prev_rev,
      p_middle_revenue    as mid_rev
  )
  select jsonb_build_object(
    -- ── METRICS (1–14) ────────────────────────────────────────────────────
    'spend',      spend,
    'reach',      reach,
    'freq',       impressions::numeric / nullif(reach, 0),
    'impr',       impressions,
    'clicks',     clicks,
    'leads',      leads,
    'att',        attendance,
    'prevBuy',    prev_buy,
    'midBuy',     mid_buy,
    'prevRev',    prev_rev,
    'midRev',     mid_rev,
    -- selling price is the configured unit price, shown only where the cut
    -- actually has purchases of that product ('—' otherwise, per the mockup)
    'prevPrice',  case when prev_buy > 0 then p_preview_price end,
    'midPrice',   case when mid_buy  > 0 then p_middle_price  end,
    'rev',        prev_rev + mid_rev,

    -- ── FUNNEL METRICS (15–19) ────────────────────────────────────────────
    'ctr',        clicks::numeric  * 100 / nullif(impressions, 0),
    'leadgen',    leads::numeric   * 100 / nullif(clicks, 0),
    'attPct',     attendance::numeric * 100 / nullif(leads, 0),
    'prevPct',    prev_buy::numeric   * 100 / nullif(attendance, 0),
    'midPct',     mid_buy::numeric    * 100 / nullif(prev_buy, 0),

    -- ── UNIT OF ECONOMICS (20–29) ─────────────────────────────────────────
    'cpm',        spend * 1000 / nullif(impressions, 0),
    'cpc',        spend / nullif(clicks, 0),
    'cpl',        spend / nullif(leads, 0),
    'cpAtt',      spend / nullif(attendance, 0),
    -- CPA is cost per *acquired customer*, and the mockup measures that against
    -- preview purchases (12,897.14 / 39 = 330.70), not preview+middle. The middle
    -- offer is sold to people already acquired by the preview.
    'cpa',        spend / nullif(prev_buy, 0),
    'prevAov',    prev_rev / nullif(prev_buy, 0),
    'prevRoas',   prev_rev / nullif(spend, 0),
    'midAov',     mid_rev / nullif(mid_buy, 0),
    'midRoas',    mid_rev / nullif(spend, 0),
    'roas',       (prev_rev + mid_rev) / nullif(spend, 0)
  )
  from m;
$$;

-- Has this client ever had a sale land? Not "did this cut sell anything" — once
-- a payments file is in, a round that sold nothing really did sell nothing and
-- should read 0. Until then there is no evidence either way, and 0 is a lie.
--
-- Deliberately keyed on events rather than import_batches: a sales file whose
-- every row parked in Unmatched has been imported but has told us nothing.
create or replace view v_sales_seen as
select distinct client_id from v_events where event_type = 'sale';

-- ═══════════════════════════════════════════════════════════════════════════
-- BY ROUND
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_round as
with ads as (
  select client_id, round_id,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, round_id
),
ev as (
  select client_id, round_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance
  from v_events group by client_id, round_id
),
sales as (
  select client_id, lead_round_id as round_id,
         count(*) filter (where product = 'preview')                     as prev_buy,
         count(*) filter (where product = 'middle')                      as mid_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview') as prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle')  as mid_rev
  from v_events where event_type = 'sale' and lead_round_id is not null
  group by client_id, lead_round_id
)
select
  r.client_id,
  r.round_id                                  as cut_key,
  r.round_id                                  as cut_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as cut_sub,
  r.start_date,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
    -- leads and attendance are known: the files are in, this round had none
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    -- sales are known only once a sale exists for this client
    case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from rounds r
left join ads   on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev    on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales on sales.client_id = r.client_id and sales.round_id = r.round_id
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, r.start_date;

-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED VIEWS
--
-- The bridge is events.utm_campaign -> ads_performance.ad_set. Two things get
-- normalised here that didn't before:
--
--   '' is not an ad set. A blank cell in a Meta export means the export didn't
--   say, and "didn't say" is not the name of an audience. Rows like that now
--   group into one labelled column instead of a column with an empty header.
--
--   That column gets NULL people, not zero. It has spend and clicks and no way
--   to know which leads they produced — so leads, attendance, CPL and Lead Gen %
--   are blank there. Reading 0 leads against 856 clicks would say the money
--   bought nobody, when what happened is that the export didn't record which
--   audience bought them.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_adset as
with ads as (
  select client_id, nullif(btrim(ad_set), '') as ad_set,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, nullif(btrim(ad_set), '')
),
ev as (
  select client_id, nullif(btrim(utm_campaign), '') as ad_set,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance,
         count(*) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
         count(*) filter (where event_type = 'sale' and product = 'middle')  as mid_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'preview') as prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle')  as mid_rev
  from v_events
  where nullif(btrim(utm_campaign), '') is not null
  group by client_id, nullif(btrim(utm_campaign), '')
)
select
  coalesce(ads.client_id, ev.client_id)                     as client_id,
  coalesce(ads.ad_set, ev.ad_set, '(unsplit)')              as cut_key,
  coalesce(ads.ad_set, ev.ad_set, 'Unsplit spend')          as cut_label,
  case when coalesce(ads.ad_set, ev.ad_set) is null
       then 'ads that name no ad set' end                   as cut_sub,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
    case when coalesce(ads.ad_set, ev.ad_set) is not null then coalesce(ev.leads, 0)      end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null then coalesce(ev.attendance, 0) end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.prev_buy, 0) end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.mid_buy, 0)  end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.prev_rev, 0) end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.mid_rev, 0)  end,
    p.preview_price, p.middle_price
  ) as m,
  -- the app sorts on this descending; unsplit spend is real but it isn't an
  -- audience, so it sits after every named one however large it is
  case when coalesce(ads.ad_set, ev.ad_set) is null then -1
       else coalesce(ads.spend, 0) end                      as sort_spend
from ads
full join ev on ev.client_id = ads.client_id and ev.ad_set = ads.ad_set
left join v_sales_seen s on s.client_id = coalesce(ads.client_id, ev.client_id)
left join v_client_prices p on p.client_id = coalesce(ads.client_id, ev.client_id)
order by 1, sort_spend desc;

-- ═══════════════════════════════════════════════════════════════════════════
-- CLIENT TOTAL
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_total as
with ads as (
  select client_id, sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads group by client_id
),
ev as (
  select client_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance,
         count(*) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
         count(*) filter (where event_type = 'sale' and product = 'middle')  as mid_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'preview') as prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle')  as mid_rev
  from v_events group by client_id
)
select
  c.client_id,
  'TOTAL'::text as cut_key,
  'Total'::text as cut_label,
  'all rounds'::text as cut_sub,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    case when s.client_id is not null then coalesce(ev.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(ev.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from v_clients c
left join ads on ads.client_id = c.client_id
left join ev  on ev.client_id  = c.client_id
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- BY SOURCE — spend still belongs to Paid Ads and only to Paid Ads.
-- ═══════════════════════════════════════════════════════════════════════════
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
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    case when s.client_id is not null then coalesce(ev.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(ev.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from ev
left join v_source_buckets b on b.bucket = ev.bucket
left join ads   on ads.client_id   = ev.client_id
left join share on share.client_id = ev.client_id
left join v_sales_seen s on s.client_id = ev.client_id
left join v_client_prices p on p.client_id = ev.client_id
order by ev.client_id, coalesce(b.ord, 99);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROUND × SOURCE — per-round Total still lifted whole out of By round, so the
-- two tabs cannot drift.
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
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
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
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id

union all

-- the per-round Total column, taken whole from By round so the two tabs agree.
-- rev is NULL until a sale exists, so it is coalesced here rather than compared
-- directly — a NULL comparison would make the whole OR-chain NULL and drop the
-- round out of the tab.
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
where (m->>'leads')::bigint > 0
   or coalesce((m->>'rev')::numeric, 0) > 0
   or (m->>'spend') is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- BASELINE — the pinned reference column. Same rule, NULL-safe: a client with
-- no sales yet simply has no baseline, rather than the comparison silently
-- vanishing on a NULL.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_baseline as
select distinct on (client_id)
  client_id, cut_key, cut_label, cut_sub, m
from v_metrics_by_round
where (m->>'spend') is not null and coalesce((m->>'rev')::numeric, 0) > 0
order by client_id, start_date;

grant select on v_sales_seen to anon, authenticated;
grant select on v_metrics_by_round to anon, authenticated;
grant select on v_metrics_by_adset to anon, authenticated;
grant select on v_metrics_total to anon, authenticated;
grant select on v_metrics_baseline to anon, authenticated;
grant select on v_metrics_by_source to anon, authenticated;
grant select on v_metrics_by_round_source to anon, authenticated;
