-- Retire source columns only after all live reporting reads attribution rows.
-- `v_event_attribution` keeps compatible *derived* placeholders while its
-- dependants move; the physical event facts are removed in this transaction.
begin;

create or replace view v_event_attribution as
with model as materialized (
  select fo_attribution_model() as name
), base as materialized (
  select r.client_id,
    e.event_id, e.contact_id, e.round_id, e.event_type, e.event_date,
    e.lead_round_id, null::text as close_round_id, e.attribution_method, e.utm_campaign,
    e.source, e.match_status, e.product, e.minutes_watched,
    e.amount, e.refund_amount, e.refund_date, false as is_lead, e.import_batch_id,
    e.ad_set, e.ad, e.variant, r.product_id, r.country
  from events e join rounds r on r.round_id = e.round_id
), sales as materialized (
  select * from base where event_type = 'sale'
), entry_touch as materialized (
  select distinct on (s.event_id) s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s join base l on l.client_id=s.client_id and l.contact_id=s.contact_id
    and l.event_type='lead' and l.event_date <= s.event_date
  order by s.event_id, l.event_date, l.event_id
), entry_paid_touch as materialized (
  select distinct on (s.event_id) s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s join base l on l.client_id=s.client_id and l.contact_id=s.contact_id
    and l.event_type='lead' and l.source='Paid Ads' and l.event_date <= s.event_date
  order by s.event_id, l.event_date, l.event_id
), last_touch as materialized (
  select distinct on (s.event_id) s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s join base l on l.client_id=s.client_id and l.contact_id=s.contact_id
    and l.event_type='lead' and l.event_date <= s.event_date
  order by s.event_id, l.event_date desc, l.event_id desc
), last_paid_touch as materialized (
  select distinct on (s.event_id) s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s join base l on l.client_id=s.client_id and l.contact_id=s.contact_id
    and l.event_type='lead' and l.source='Paid Ads' and l.event_date <= s.event_date
  order by s.event_id, l.event_date desc, l.event_id desc
), even_touch_once as materialized (
  select distinct on (s.event_id, p.round_id) s.event_id as sale_id, p.round_id, p.source, p.utm_campaign, p.ad_set, p.ad, p.variant
  from sales s join base p on p.client_id=s.client_id and p.contact_id=s.contact_id
    and p.event_type in ('lead','attendance') and p.round_id is not null and p.event_date <= s.event_date
  order by s.event_id, p.round_id, case when p.event_type='lead' then 0 else 1 end, p.event_date desc, p.event_id desc
), even_touch as materialized (
  select sale_id, round_id, source, utm_campaign, ad_set, ad, variant,
         1::numeric / count(*) over (partition by sale_id) as attr_weight
  from even_touch_once
), selected_touch as materialized (
  select e.sale_id,e.round_id,e.source,e.utm_campaign,e.ad_set,e.ad,e.variant,1::numeric as attr_weight from entry_touch e cross join model m where m.name='entry'
  union all select e.sale_id,e.round_id,e.source,e.utm_campaign,e.ad_set,e.ad,e.variant,1::numeric from entry_paid_touch e cross join model m where m.name='entry_paid'
  union all select e.sale_id,e.round_id,e.source,e.utm_campaign,e.ad_set,e.ad,e.variant,1::numeric from last_touch e cross join model m where m.name='last_touch'
  union all select e.sale_id,e.round_id,e.source,e.utm_campaign,e.ad_set,e.ad,e.variant,1::numeric from last_paid_touch e cross join model m where m.name='last_paid'
  union all select e.sale_id,e.round_id,e.source,e.utm_campaign,e.ad_set,e.ad,e.variant,e.attr_weight from even_touch e cross join model m where m.name='even_split'
), attributed_sales as (
  select s.*, coalesce(t.round_id,s.round_id) as attr_round_id,
    coalesce(t.source,s.source) as attr_source, coalesce(t.utm_campaign,s.utm_campaign) as attr_utm_campaign,
    coalesce(t.ad_set,s.ad_set) as attr_ad_set, coalesce(t.ad,s.ad) as attr_ad,
    coalesce(t.variant,s.variant) as attr_variant, coalesce(t.attr_weight,1::numeric) as attr_weight
  from sales s left join selected_touch t on t.sale_id=s.event_id
)
select b.*, b.round_id as attr_round_id, b.source as attr_source,
  b.utm_campaign as attr_utm_campaign, b.ad_set as attr_ad_set, b.ad as attr_ad,
  b.variant as attr_variant, 1::numeric as attr_weight
from base b where b.event_type <> 'sale'
union all
select s.client_id,s.event_id,s.contact_id,s.round_id,s.event_type,s.event_date,
  s.lead_round_id,s.close_round_id,s.attribution_method,s.utm_campaign,
  s.source,s.match_status,s.product,s.minutes_watched,s.amount,s.refund_amount,
  s.refund_date,s.is_lead,s.import_batch_id,s.ad_set,s.ad,s.variant,s.product_id,s.country,
  s.attr_round_id,s.attr_source,s.attr_utm_campaign,s.attr_ad_set,s.attr_ad,s.attr_variant,s.attr_weight
from attributed_sales s;
grant select on v_event_attribution to anon, authenticated;

-- `v_round_assets` is a legacy read of v_events. It has no downstream
-- dependants (checked before this migration), so take it down and restore it
-- around the narrower compatibility boundary. Do not use CASCADE here.
drop view v_round_assets;

-- The compatibility view is now intentionally narrower.
drop view v_events;
create view v_events as
select client_id,event_id,contact_id,round_id,event_type,event_date,
  lead_round_id,attribution_method,utm_campaign,source,match_status,product,
  minutes_watched,amount,refund_amount,refund_date,import_batch_id,
  coalesce(attr_source,'Unattributed') as attribution_bucket,
  attr_ad_set as ad_set,attr_ad as ad,product_id,attr_variant as variant,
  attr_round_id,attr_source,attr_weight
from v_attributed_events;
grant select on v_events to anon, authenticated;

create view v_round_assets as
with named as (
  select r.client_id, a.round_id, 'audience'::text as kind,
    coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)') as name,
    sum(a.spend) as spend, 0 as ids
  from v_ads a join v_rounds r on r.round_id = a.round_id
  group by r.client_id, a.round_id,
    coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)')
  union all
  select r.client_id, a.round_id, 'creative'::text,
    case when btrim(a.ad) ~ '^[0-9]+$' then '(ad ids)'
         else coalesce(nullif(btrim(a.ad), ''), '(unsplit)') end,
    sum(a.spend), count(distinct a.ad) filter (where btrim(a.ad) ~ '^[0-9]+$')::integer
  from v_ads a join v_rounds r on r.round_id = a.round_id
  group by r.client_id, a.round_id,
    case when btrim(a.ad) ~ '^[0-9]+$' then '(ad ids)'
         else coalesce(nullif(btrim(a.ad), ''), '(unsplit)') end
), lead_asset as (
  select distinct on (e.contact_id, e.round_id)
    e.contact_id, e.round_id,
    coalesce(nullif(btrim(e.ad_set), ''), '(unsplit)') as audience,
    case when btrim(e.ad) ~ '^[0-9]+$' then '(ad ids)'
         else coalesce(nullif(btrim(e.ad), ''), '(unsplit)') end as creative
  from v_events e
  where e.event_type = 'lead'
  order by e.contact_id, e.round_id, e.event_date
), got as (
  select r.client_id, e.round_id, 'audience'::text as kind,
    coalesce(nullif(btrim(e.ad_set), ''), '(unsplit)') as name,
    count(*) as leads, 0 as ids
  from v_events e join v_rounds r on r.round_id = e.round_id
  where e.event_type = 'lead'
  group by r.client_id, e.round_id,
    coalesce(nullif(btrim(e.ad_set), ''), '(unsplit)')
  union all
  select r.client_id, e.round_id, 'creative'::text,
    case when btrim(e.ad) ~ '^[0-9]+$' then '(ad ids)'
         else coalesce(nullif(btrim(e.ad), ''), '(unsplit)') end,
    count(*), count(distinct e.ad) filter (where btrim(e.ad) ~ '^[0-9]+$')::integer
  from v_events e join v_rounds r on r.round_id = e.round_id
  where e.event_type = 'lead'
  group by r.client_id, e.round_id,
    case when btrim(e.ad) ~ '^[0-9]+$' then '(ad ids)'
         else coalesce(nullif(btrim(e.ad), ''), '(unsplit)') end
), produced as (
  select r.client_id, e.lead_round_id as round_id, 'audience'::text as kind,
    la.audience as name,
    count(*) filter (where e.event_type = 'attendance') as att,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buys,
    coalesce(sum(coalesce(e.amount, 0) - coalesce(e.refund_amount, 0))
      filter (where e.event_type = 'sale'), 0) as rev
  from v_events e
  join v_rounds r on r.round_id = e.lead_round_id
  join lead_asset la on la.contact_id = e.contact_id and la.round_id = e.lead_round_id
  where e.event_type in ('attendance', 'sale')
  group by r.client_id, e.lead_round_id, la.audience
  union all
  select r.client_id, e.lead_round_id, 'creative'::text, la.creative,
    count(*) filter (where e.event_type = 'attendance'),
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview'),
    coalesce(sum(coalesce(e.amount, 0) - coalesce(e.refund_amount, 0))
      filter (where e.event_type = 'sale'), 0)
  from v_events e
  join v_rounds r on r.round_id = e.lead_round_id
  join lead_asset la on la.contact_id = e.contact_id and la.round_id = e.lead_round_id
  where e.event_type in ('attendance', 'sale')
  group by r.client_id, e.lead_round_id, la.creative
), joined as (
  select coalesce(s.client_id, g.client_id) as client_id,
    coalesce(s.round_id, g.round_id) as round_id,
    coalesce(s.kind, g.kind) as kind, coalesce(s.name, g.name) as name,
    s.spend, g.leads, greatest(coalesce(s.ids, 0), coalesce(g.ids, 0)) as ids
  from named s full join got g
    on g.client_id = s.client_id and g.round_id = s.round_id
    and g.kind = s.kind and g.name = s.name
), with_outcomes as (
  select j.client_id, j.round_id, j.kind, j.name, j.spend, j.leads, j.ids,
    p.att, p.prev_buys, p.rev
  from joined j left join produced p
    on p.client_id = j.client_id and p.round_id = j.round_id
    and p.kind = j.kind and p.name = j.name
)
select client_id, round_id, kind, name, spend,
  coalesce(leads, 0)::integer as leads,
  round(100 * spend / nullif(sum(spend) over (partition by client_id, round_id, kind), 0), 1) as spend_share,
  nullif(ids, 0) as id_count,
  coalesce(att, 0)::integer as att,
  coalesce(prev_buys, 0)::integer as prev_buys,
  coalesce(rev, 0) as rev
from with_outcomes
order by client_id, round_id, kind, spend desc nulls last, name;
grant select on v_round_assets to anon, authenticated;

-- Market is now resolved from the campaign dimension at read time. Keep the
-- round's declared country as the fallback when a campaign says nothing;
-- never copy either value onto an event again.
create or replace view v_client_countries as
with from_ads as (
  select r.client_id, d.market as country, a.round_id
  from ads_performance a
  join rounds r on r.round_id = a.round_id
  join v_campaign_dimensions d
    on d.client_id = r.client_id
   and d.campaign is not distinct from a.campaign
  where d.market is not null
), from_events as (
  select r.client_id, d.market as country, e.round_id
  from events e
  join rounds r on r.round_id = e.round_id
  join v_campaign_dimensions d
    on d.client_id = r.client_id
   and d.campaign is not distinct from e.utm_campaign
  where d.market is not null
), from_rounds as (
  select client_id, country, round_id from rounds where country is not null
), all_of_them as (
  select * from from_ads
  union select * from from_events
  union select * from from_rounds
)
select client_id, country, count(distinct round_id)::integer as round_count
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
        join v_campaign_dimensions d
          on d.client_id = r.client_id
         and d.campaign is not distinct from e.utm_campaign
        where e.round_id = p_round_id and d.market = any(f.cs)
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
      select chosen.market
      from unnest(f.cs) as chosen(market)
      where exists (
        select 1
        from ads_performance a
        join rounds r on r.round_id = a.round_id
        join v_campaign_dimensions d
          on d.client_id = r.client_id
         and d.campaign is not distinct from a.campaign
        where a.round_id = p_round_id and d.market = chosen.market
      ) or exists (
        select 1
        from events e
        join rounds r on r.round_id = e.round_id
        join v_campaign_dimensions d
          on d.client_id = r.client_id
         and d.campaign is not distinct from e.utm_campaign
        where e.round_id = p_round_id and d.market = chosen.market
      )
      limit 1
    )
  end
  from f;
$$;
grant execute on function fo_round_country_pick(text, text) to anon, authenticated;

alter table events
  drop column close_round_id,
  drop column is_lead,
  drop column country;

commit;
