-- ═══════════════════════════════════════════════════════════════════════════
-- Funnel OS — the 29 metrics.
--
-- Every view is the same spine with different columns, so the metric maths lives
-- in ONE function and each view only decides how to cut the data.
--
-- The two rules the PRD calls out are encoded here and nowhere else:
--
--   BLANK vs ZERO   a cut with no ads_performance rows has no spend, so spend,
--                   reach, frequency, impressions, clicks, CTR, lead-gen, every
--                   CP* and every ROAS return NULL — not 0. A class doesn't buy
--                   traffic; the round does. Organic has no spend. Not zero,
--                   not infinite — absent.
--
--   ZERO-DENOM      every ratio divides by NULLIF(denominator, 0), so a missing
--                   denominator renders '—' instead of 0%, and never #DIV/0!.
--
-- The frontend receives NULL and prints '—'. It never decides which is which.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists fo_metrics cascade;

-- Parameters are p_-prefixed deliberately: inside a SQL function body, a column
-- name from the FROM clause outranks a same-named parameter, so a parameter
-- called `spend` would be silently shadowed by the blanked `spend` column (or
-- worse, the other way round) and blank-vs-zero would stop working.
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
      coalesce(p_leads, 0)             as leads,
      coalesce(p_attendance, 0)        as attendance,
      coalesce(p_preview_purchases, 0) as prev_buy,
      coalesce(p_middle_purchases, 0)  as mid_buy,
      coalesce(p_preview_revenue, 0)   as prev_rev,
      coalesce(p_middle_revenue, 0)    as mid_rev
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

-- ═══════════════════════════════════════════════════════════════════════════
-- Building blocks
-- ═══════════════════════════════════════════════════════════════════════════

-- Configured unit prices, one row per client.
create or replace view v_client_prices as
select
  client_id,
  max(unit_price) filter (where stage_slug = 'preview')  as preview_price,
  max(unit_price) filter (where stage_slug = 'middle')   as middle_price,
  max(unit_price) filter (where stage_slug = 'checkout') as checkout_price
from client_journey_config
group by client_id;

-- Clients, for the switcher. Derived from the journey config — client is a
-- dimension, and the journey is what makes a client real to this app.
create or replace view v_clients as
select
  client_id,
  min(client_name) as client_name,
  min(client_note) as client_note,
  count(*)         as stage_count
from client_journey_config
group by client_id
order by client_id;

-- Journey stages, in order. Drives the Customer Journey strip AND the Compare nav
-- group — change a client's journey and the views change with it.
create or replace view v_journey as
select
  client_id, stage_order, stage_name, stage_slug,
  compare_dimension, stage_metric, stage_rate_label, unit_price
from client_journey_config
order by client_id, stage_order;

-- Every ads_performance row with its client attached (ads_performance scopes
-- through round_id — there's no client_id on the table).
create or replace view v_ads as
select r.client_id, a.*
from ads_performance a
join rounds r on r.round_id = a.round_id;

-- Every event with its client, plus the derived attribution bucket.
--
-- "Previous Paid Ads" is not a source. It's the sales where the round that
-- produced the lead isn't the round whose class closed it — AND the source is
-- Paid Ads. An Organic lead from August buying in October is still Organic.
create or replace view v_events as
select
  r.client_id,
  e.*,
  case
    when e.source = 'Paid Ads'
     and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
      then 'Previous Paid Ads'
    else e.source
  end as attribution_bucket
from events e
join rounds r on r.round_id = e.round_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- BY ROUND  — Overview / By round     (fully wired)
--
-- Note the deliberate asymmetry, straight from the schema doc:
--   leads + attendance are counted on round_id      — whose class was this?
--   revenue + purchases are counted on lead_round_id — whose spend produced it?
-- So a lead from 0526-02 who attends 0526-03's class and buys there is counted
-- in 0526-03's attendance and in 0526-02's revenue. Both true, same total.
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
    ev.leads, ev.attendance,
    sales.prev_buy, sales.mid_buy, sales.prev_rev, sales.mid_rev,
    p.preview_price, p.middle_price
  ) as m
from rounds r
left join ads   on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev    on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales on sales.client_id = r.client_id and sales.round_id = r.round_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, r.start_date;

-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED VIEWS  — Compare / Targeted views     (fully wired)
--
-- The bridge is events.utm_campaign -> ads_performance.ad_set: the audience the
-- lead came from. People with no utm (organic, previous-round) have no audience,
-- so they land in the client total but in none of the audience columns — which
-- is exactly right, they cost nothing.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_adset as
with ads as (
  select client_id, ad_set,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads where ad_set is not null group by client_id, ad_set
),
ev as (
  select client_id, utm_campaign as ad_set,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance,
         count(*) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
         count(*) filter (where event_type = 'sale' and product = 'middle')  as mid_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'preview') as prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle')  as mid_rev
  from v_events where utm_campaign is not null group by client_id, utm_campaign
)
select
  coalesce(ads.client_id, ev.client_id) as client_id,
  coalesce(ads.ad_set, ev.ad_set)       as cut_key,
  coalesce(ads.ad_set, ev.ad_set)       as cut_label,
  null::text                            as cut_sub,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
    ev.leads, ev.attendance,
    ev.prev_buy, ev.mid_buy, ev.prev_rev, ev.mid_rev,
    p.preview_price, p.middle_price
  ) as m,
  coalesce(ads.spend, 0) as sort_spend
from ads
full join ev on ev.client_id = ads.client_id and ev.ad_set = ads.ad_set
left join v_client_prices p on p.client_id = coalesce(ads.client_id, ev.client_id)
order by 1, sort_spend desc;

-- ═══════════════════════════════════════════════════════════════════════════
-- CLIENT TOTAL — the "Total" column that leads every comparison view
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
    ev.leads, ev.attendance,
    ev.prev_buy, ev.mid_buy, ev.prev_rev, ev.mid_rev,
    p.preview_price, p.middle_price
  ) as m
from v_clients c
left join ads on ads.client_id = c.client_id
left join ev  on ev.client_id  = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- BASELINE — the pinned reference column that never scrolls away.
-- The mockup pins a single historical round as the yardstick; we pin the client's
-- earliest round that has both spend and sales, so it stays meaningful as rounds
-- are added rather than drifting to whatever is first alphabetically.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_baseline as
select distinct on (client_id)
  client_id, cut_key, cut_label, cut_sub, m
from v_metrics_by_round
where (m->>'spend') is not null and (m->>'rev')::numeric > 0
order by client_id, start_date;

-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOMER JOURNEY STRIP — one card per stage, values straight off the total.
-- Stage -> metric mapping is data (client_journey_config.stage_metric), so an
-- ecommerce client's strip is built by the same query with no branching.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_journey_strip as
select
  j.client_id, j.stage_order, j.stage_name, j.stage_slug, j.stage_rate_label,
  case j.stage_metric
    when 'impressions'       then (t.m->>'impr')
    when 'clicks'            then (t.m->>'clicks')
    when 'leads'             then (t.m->>'leads')
    when 'attendance'        then (t.m->>'att')
    when 'preview_purchases' then (t.m->>'prevBuy')
    when 'middle_purchases'  then (t.m->>'midBuy')
  end as value,
  case j.stage_metric
    when 'clicks'            then (t.m->>'ctr')
    when 'leads'             then (t.m->>'leadgen')
    when 'attendance'        then (t.m->>'attPct')
    when 'preview_purchases' then (t.m->>'prevPct')
    when 'middle_purchases'  then (t.m->>'midPct')
  end as rate
from v_journey j
left join v_metrics_total t on t.client_id = j.client_id
order by j.client_id, j.stage_order;

-- ═══════════════════════════════════════════════════════════════════════════
-- IMPORT + UNMATCHED — the Data group, and the staleness flag the header carries.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_import_status as
select
  client_id, source, imported_at, coverage_start, coverage_end, row_count,
  column_map, expected_cadence,
  stale_flag or (now() - imported_at) > coalesce(expected_cadence, interval '1 day') * 2
    as is_stale,
  extract(day from now() - imported_at)::int as days_since
from import_batches
order by client_id, source;

create or replace view v_unmatched_summary as
select
  client_id,
  count(*) filter (where not auto_resolved and resolved_at is null) as waiting,
  count(*) filter (where auto_resolved)                             as auto_resolved,
  coalesce(sum(revenue_held) filter (where resolved_at is null), 0) as revenue_held,
  count(*) filter (where resolved_at is null and revenue_held > 0)  as sales_held,
  count(distinct source) filter (where not auto_resolved and resolved_at is null) as source_count
from unmatched_rows
group by client_id;

create or replace view v_unmatched_by_reason as
select
  client_id, reason,
  count(*)                as rows_waiting,
  sum(revenue_held)       as revenue_held
from unmatched_rows
where not auto_resolved and resolved_at is null
group by client_id, reason
order by client_id, count(*) desc;

-- ═══════════════════════════════════════════════════════════════════════════
-- Grants — PostgREST serves these views to the anon key. Views run with the
-- owner's rights (security_invoker is off by default), so base-table RLS isn't
-- re-evaluated per row here; read access is what's granted.
-- ═══════════════════════════════════════════════════════════════════════════
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
