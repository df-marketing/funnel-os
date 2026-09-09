-- ═══════════════════════════════════════════════════════════════════════════
-- 0075 — the views read the rules, not the CASE.
--
-- 0073 made campaign meaning editable data. 0074 made that data visible to the
-- app's anon key. Neither changed a reading: v_ads, v_events, the country
-- picker and landing-page cuts still call fo_country / fo_landing_page.
--
-- This is the first migration that points a view at the new reader. It must be
-- inert: the 0073 checks established that all 46 campaign names resolve to the
-- same market and page as the old functions. The application-visible total is
-- therefore still:
--
--   spend 20,474.78 · leads 1,889 · attendance 682 · purchases 113
--   revenue 83,927.00 · ROAS 1.80 · CPA 365.62
--
-- A total alone is not proof. Country and landing-page cuts below are the
-- checks that prove the labelled rows are still present.
--
-- WHY A CACHE VIEW. fo_resolve evaluates a JSON rule list. Calling it once for
-- every ad/event row would make roughly nine thousand evaluations per read;
-- there are about 25 distinct campaign names. The active market and page rules
-- inspect campaign alone, so v_campaign_dimensions resolves each name once and
-- the readers join it. If a future rule reads source, ad_set or ad, it must not
-- use this campaign-only cache: resolve inline or widen the cache key first.
--
-- fo_country and fo_landing_page deliberately remain. They are proven fallback
-- anchors for a week of live use, not dead code to remove in a behaviour change.
--
-- Safe to re-run.
-- ROLLBACK: re-run the prior definitions from 0059, 0062, 0063, 0067, 0070
-- and 0071. Do not drop dimension_values or either legacy resolver.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- One labelled row per client/campaign, built from the physical tables so it
-- cannot form a cycle with v_ads or v_events.
create or replace view v_campaign_dimensions as
select c.client_id, c.campaign,
       fo_resolve(c.client_id, 'market', c.campaign) as market,
       fo_resolve(c.client_id, 'landing_page', c.campaign) as landing_page
from (
  select distinct r.client_id, a.campaign
  from ads_performance a
  join rounds r on r.round_id = a.round_id
  union
  select distinct r.client_id, e.utm_campaign as campaign
  from events e
  join rounds r on r.round_id = e.round_id
) c;

grant select on v_campaign_dimensions to anon, authenticated;

-- ── ROW READERS ───────────────────────────────────────────────────────────
create or replace view v_ads as
select r.client_id, a.*, r.product_id,
       coalesce(d.market, r.country) as country
from ads_performance a
join rounds r on r.round_id = a.round_id
left join v_campaign_dimensions d
  on d.client_id = r.client_id
 and d.campaign is not distinct from a.campaign
where fo_filter_ok(r.product_id, a.channel,
                   coalesce(d.market, r.country),
                   r.start_date, r.end_date);

create or replace view v_events as
select
  r.client_id,
  e.event_id, e.contact_id, e.round_id, e.event_type, e.event_date,
  e.lead_round_id, e.close_round_id, e.attribution_method, e.utm_campaign,
  e.source, e.match_status, e.product, e.minutes_watched,
  e.amount, e.refund_amount, e.refund_date, e.is_lead, e.import_batch_id,
  case
    when e.source = 'Paid Ads'
     and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
      then 'Previous Paid Ads'
    else e.source
  end as attribution_bucket,
  e.ad_set,
  e.ad,
  r.product_id,
  e.variant,
  -- An inherited country is a fact about the person and still wins. Campaign
  -- rules label the lead itself; the round remains the documented fallback.
  coalesce(e.country, d.market, r.country) as country
from events e
join rounds r on r.round_id = e.round_id
left join v_campaign_dimensions d
  on d.client_id = r.client_id
 and d.campaign is not distinct from e.utm_campaign
where fo_filter_people_ok(r.product_id,
                          coalesce(e.country, d.market, r.country),
                          r.start_date, r.end_date)
  and fo_filter_source_ok(
        coalesce(
          case
            when e.source = 'Paid Ads'
             and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
              then 'Previous Paid Ads'
            else e.source
          end,
          'Unattributed'));

grant select on v_ads, v_events to anon, authenticated;

-- ── COUNTRY FILTER SUPPORT ────────────────────────────────────────────────
create or replace view v_client_countries as
with from_ads as (
  select r.client_id, d.market as country, a.round_id
  from ads_performance a
  join rounds r on r.round_id = a.round_id
  join v_campaign_dimensions d
    on d.client_id = r.client_id
   and d.campaign is not distinct from a.campaign
  where d.market is not null
),
from_events as (
  select r.client_id, e.country, e.round_id
  from events e
  join rounds r on r.round_id = e.round_id
  where e.country is not null
),
from_rounds as (
  select client_id, country, round_id from rounds where country is not null
),
all_of_them as (
  select * from from_ads
  union select * from from_events
  union select * from from_rounds
)
select client_id, country, count(distinct round_id)::int as round_count
from all_of_them
group by client_id, country
order by client_id, country;

grant select on v_client_countries to anon, authenticated;

create or replace function fo_round_country_ok(p_round_id text, p_round_country text)
returns boolean
language sql
stable
as $$
  with f as (
    select nullif(
             string_to_array(nullif(current_setting('funnel.country', true), ''), ','),
             '{}'
           ) as cs
  )
  select f.cs is null
      or p_round_country = any(f.cs)
      or exists (
           select 1
           from ads_performance a
           join rounds r on r.round_id = a.round_id
           join v_campaign_dimensions d
             on d.client_id = r.client_id
            and d.campaign is not distinct from a.campaign
           where a.round_id = p_round_id and d.market = any(f.cs)
         )
      or exists (
           select 1
           from events e
           join rounds r on r.round_id = e.round_id
           left join v_campaign_dimensions d
             on d.client_id = r.client_id
            and d.campaign is not distinct from e.utm_campaign
           where e.round_id = p_round_id
             and coalesce(e.country, d.market) = any(f.cs)
         )
  from f;
$$;

grant execute on function fo_round_country_ok(text, text) to anon, authenticated;

create or replace function fo_round_country_pick(p_round_id text, p_round_country text)
returns text
language sql
stable
as $$
  with f as (
    select nullif(
             string_to_array(nullif(current_setting('funnel.country', true), ''), ','),
             '{}'
           ) as cs
  )
  select case
    when f.cs is null then p_round_country
    when p_round_country = any(f.cs) then p_round_country
    else (
      select m
      from unnest(f.cs) m
      where exists (
              select 1
              from ads_performance a
              join rounds r on r.round_id = a.round_id
              join v_campaign_dimensions d
                on d.client_id = r.client_id
               and d.campaign is not distinct from a.campaign
              where a.round_id = p_round_id and d.market = m
            )
         or exists (
              select 1
              from events e
              join rounds r on r.round_id = e.round_id
              left join v_campaign_dimensions d
                on d.client_id = r.client_id
               and d.campaign is not distinct from e.utm_campaign
              where e.round_id = p_round_id
                and coalesce(e.country, d.market) = m
            )
      limit 1
    )
  end
  from f;
$$;

grant execute on function fo_round_country_pick(text, text) to anon, authenticated;

-- ── LANDING-PAGE CUTS ─────────────────────────────────────────────────────
-- Page is a property of the campaign that opened this round, never a later
-- action by the same person. Keep the established per-round joins unchanged.
create or replace view v_metrics_by_lp as
with ads as (
  select a.client_id, d.landing_page as lp,
         sum(a.spend) as spend, sum(a.impressions) as impressions,
         sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join v_campaign_dimensions d
    on d.client_id = a.client_id
   and d.campaign is not distinct from a.campaign
  where d.landing_page is not null
  group by 1, 2
),
lead_lp as (
  select distinct on (e.client_id, e.contact_id, e.round_id)
         e.client_id, e.contact_id, e.round_id, d.landing_page as lp
  from v_events e
  join v_campaign_dimensions d
    on d.client_id = e.client_id
   and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and e.contact_id is not null
    and d.landing_page is not null
  order by e.client_id, e.contact_id, e.round_id, e.event_date
),
ev_leads as (
  select e.client_id, d.landing_page as lp, count(*) as leads
  from v_events e
  join v_campaign_dimensions d
    on d.client_id = e.client_id
   and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and d.landing_page is not null
  group by 1, 2
),
ev_att as (
  select l.client_id, l.lp, count(*) as attendance
  from v_events e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id and l.round_id = e.round_id
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
  c.client_id, c.lp as cut_key, c.lp as cut_label, null::text as cut_sub,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend, null::bigint, a.impressions, a.clicks,
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
with ads as (
  select a.client_id, a.round_id, d.landing_page as lp,
         sum(a.spend) as spend, sum(a.impressions) as impressions,
         sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join v_campaign_dimensions d
    on d.client_id = a.client_id
   and d.campaign is not distinct from a.campaign
  where d.landing_page is not null
  group by 1, 2, 3
),
lead_lp as (
  select distinct on (e.client_id, e.contact_id, e.round_id)
         e.client_id, e.contact_id, e.round_id, d.landing_page as lp
  from v_events e
  join v_campaign_dimensions d
    on d.client_id = e.client_id
   and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and e.contact_id is not null
    and d.landing_page is not null
  order by e.client_id, e.contact_id, e.round_id, e.event_date
),
ev_leads as (
  select e.client_id, e.round_id, d.landing_page as lp, count(*) as leads
  from v_events e
  join v_campaign_dimensions d
    on d.client_id = e.client_id
   and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and d.landing_page is not null
  group by 1, 2, 3
),
ev_att as (
  select l.client_id, l.round_id, l.lp, count(*) as attendance
  from v_events e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id and l.round_id = e.round_id
  where e.event_type = 'attendance'
  group by 1, 2, 3
),
ev_sale as (
  select l.client_id, l.round_id, l.lp,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
    count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_mid_rev
  from v_events e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id
   and l.round_id = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2, 3
),
cells as (
  select client_id, round_id, lp from ads
  union select client_id, round_id, lp from ev_leads
)
select
  c.client_id,
  c.lp || '·' || c.round_id as cut_key,
  c.round_id as cut_label,
  to_char(r.start_date, 'Mon DD') as cut_sub,
  c.lp as group_key,
  c.lp as group_label,
  null::text as group_sub,
  r.start_date,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend, null::bigint, a.impressions, a.clicks,
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

-- ── CHECK AFTER RUNNING — through the app's anon key, never only the editor
-- 1. Baseline, after the migration:
--      select r->'m' from fo_cut('v_metrics_total', 'shely') as r;
--    Expect spend 20474.78 · leads 1889 · attendance 682 · revenue 83927.00
--           · ROAS 1.80 · CPA 365.62.
--
-- 2. Country set checks (set_config is transaction-local on purpose):
--      begin;
--      select set_config('funnel.country', 'SG', true);
--      select count(*), sum((r->'m'->>'spend')::numeric)
--        from fo_cut('v_metrics_by_round', 'shely') as r;
--      rollback;
--    Expect 12 · 19485.25. Repeat with MY: 1 · 989.53; SG,MY: 12 · 20474.78.
--
-- 3. Landing pages:
--      select r->>'cut_key', r->'m'->>'spend', r->'m'->>'leads',
--             r->'m'->>'attendance', r->'m'->>'roas'
--        from fo_cut('v_metrics_by_lp', 'shely') as r;
--    Expect LP1: 11853.47 · 738 · show 26.8% · ROAS 1.88;
--           LP2: 3056.16 · 216 · show 20.4% · ROAS 0.66;
--           Lead Form: 5565.15 spend · 595 leads.
--
-- 4. Northsea's landing pages still read. Its market resolves NULL and its
--    round list is unchanged.
