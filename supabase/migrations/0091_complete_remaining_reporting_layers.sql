-- 0091 — every live report reads one attribution model and one audience cut.
--
-- This is deliberately one read boundary.  The selector does not ship until
-- the two asset reports, their round companions, the journey strip and all
-- existing metric reports can see the same transaction-local setting.

begin;

-- An audience is a set for the same reason source/country are sets.  The
-- setting is only ever set by fo_cut; direct REST reads retain the unfiltered
-- default and cannot accidentally become a second reporting path.
create or replace function fo_filter_audience_ok(p_audience text)
returns boolean language sql stable as $$
  with f as (
    select string_to_array(nullif(current_setting('funnel.audience', true), ''), ',') as xs
  )
  select xs is null or p_audience = any(xs) from f;
$$;
grant execute on function fo_filter_audience_ok(text) to anon, authenticated;

-- A source filter describes data provenance, not attribution history.  The
-- old Previous Paid Ads label must not revive just because an older function
-- definition remains in the migration chain.
create or replace function fo_source_keeps_spend()
returns boolean language sql stable as $$
  with f as (
    select string_to_array(nullif(current_setting('funnel.source', true), ''), ',') as source
  )
  select f.source is null or f.source <@ array['Paid Ads']::text[] from f;
$$;
grant execute on function fo_source_keeps_spend() to anon, authenticated;

-- One contextual lead for a person's non-sale actions.  Sales do not use this
-- view: v_event_attribution supplies every selected/weighted touch itself.
-- Even split never divides an attendance row, so its whole attendance context
-- is the latest stated lead before the attendance/sale sequence.
create or replace view v_contact_entry as
with model as materialized (select fo_attribution_model() as name),
leads as materialized (
  select r.client_id, e.contact_id, e.round_id, e.event_date, e.event_id,
         e.source, e.utm_campaign, e.ad_set, e.ad, e.variant,
         coalesce(d.market, r.country) as market,
         d.landing_page
  from events e
  join rounds r on r.round_id = e.round_id
  left join v_campaign_dimensions d
    on d.client_id = r.client_id and d.campaign is not distinct from e.utm_campaign
  where e.event_type = 'lead' and e.contact_id is not null
), ranked as (
  select l.*, row_number() over (
    partition by l.client_id, l.contact_id
    order by
      case when m.name in ('entry_paid','last_paid') and l.source = 'Paid Ads' then 0
           when m.name in ('entry_paid','last_paid') then 1 else 0 end,
      case when m.name in ('last_touch','last_paid','even_split') then l.event_date end desc,
      case when m.name in ('entry','entry_paid') then l.event_date end asc,
      l.event_id
  ) as pick
  from leads l cross join model m
)
select client_id, contact_id, round_id as attr_round_id, source as attr_source,
       utm_campaign as attr_utm_campaign, ad_set as attr_ad_set, ad as attr_ad,
       variant as attr_variant, market as attr_country, landing_page
from ranked where pick = 1;
grant select on v_contact_entry to anon, authenticated;

-- Both person facts and ad delivery now answer the same Audience filter.  A
-- lead has its own audience; attendance borrows the selected lead context;
-- sales use their selected attribution touch (and retain fractional weights).
create or replace view v_attributed_events as
with campaign_dimensions as materialized (select * from v_campaign_dimensions),
entry_context as materialized (select * from v_contact_entry),
prepared as (
  select a.*,
         -- attr_country already exists on v_attributed_events (0082), so it
         -- must remain the first appended column. Postgres does not permit a
         -- replacement view to insert a new column ahead of it.
         coalesce(d.market, r.country) as attr_country,
         r.product_id as attr_product_id,
         r.start_date as attr_start_date,
         r.end_date as attr_end_date,
         case
           when a.event_type = 'attendance' then c.attr_ad_set
           when a.event_type = 'sale' then a.attr_ad_set
           else a.ad_set
         end as attr_audience,
         case when a.event_type = 'attendance' then c.attr_ad else a.attr_ad end as attr_creative
  from v_event_attribution a
  join rounds r on r.client_id = a.client_id and r.round_id = a.attr_round_id
  left join campaign_dimensions d
    on d.client_id = a.client_id and d.campaign is not distinct from a.attr_utm_campaign
  left join entry_context c
    on c.client_id = a.client_id and c.contact_id = a.contact_id
)
select * from prepared p
where fo_filter_people_ok(
        p.attr_product_id,
        p.attr_country,
        p.attr_start_date,
        p.attr_end_date
      )
  and fo_filter_source_ok(coalesce(p.attr_source, 'Unattributed'))
  and fo_filter_audience_ok(coalesce(nullif(btrim(p.attr_audience), ''), '(unsplit)'));
grant select on v_attributed_events to anon, authenticated;

-- Compatibility boundary for any older read that still names v_events. It now
-- exposes the credited fields instead of manufacturing Previous Paid Ads.
-- The legacy aliases remain for one release so external saved queries do not
-- fail; application views read attr_* exclusively from this migration onward.
create or replace view v_events as
select client_id, event_id, contact_id, round_id, event_type, event_date,
       lead_round_id, close_round_id, attribution_method, utm_campaign,
       source, match_status, product, minutes_watched, amount, refund_amount,
       refund_date, is_lead, import_batch_id,
       coalesce(attr_source, 'Unattributed') as attribution_bucket,
       attr_ad_set as ad_set, attr_ad as ad, product_id, attr_variant as variant,
       attr_country as country,
       attr_round_id, attr_source, attr_weight
from v_attributed_events;
grant select on v_events to anon, authenticated;

create or replace view v_ads as
with campaign_dimensions as materialized (select * from v_campaign_dimensions)
select r.client_id, a.*, r.product_id, coalesce(d.market, r.country) as country
from ads_performance a
join rounds r on r.round_id = a.round_id
left join campaign_dimensions d
  on d.client_id = r.client_id and d.campaign is not distinct from a.campaign
where fo_filter_ok(r.product_id, a.channel, coalesce(d.market, r.country), r.start_date, r.end_date)
  and fo_filter_audience_ok(coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)'));
grant select on v_ads to anon, authenticated;

-- The options are derived from the same context as the reports.  No audience
-- registry can drift away from what GoHighLevel actually wrote.
create or replace view v_client_audiences as
select client_id, coalesce(nullif(btrim(attr_audience), ''), '(unsplit)') as audience,
       count(*) filter (where event_type = 'lead')::int as leads
from v_attributed_events
where attr_audience is not null or attr_source = 'Paid Ads'
group by 1, 2
order by client_id, leads desc, audience;
grant select on v_client_audiences to anon, authenticated;

-- Previous Paid Ads was an old display workaround, not a source.  All source
-- reads now use the model's attributed source, so the filter cannot offer a
-- value which no report recognises.
create or replace view v_client_sources as
select client_id, coalesce(attr_source, 'Unattributed') as bucket,
       case coalesce(attr_source, 'Unattributed')
         when 'Paid Ads' then 1 when 'Organic' then 2 when 'Unattributed' then 3 else 50 end as ord,
       null::text as note,
       count(*) filter (where event_type = 'lead')::int as leads,
       count(*)::int as event_rows
from v_attributed_events
group by 1, 2
order by client_id, ord;
grant select on v_client_sources to anon, authenticated;

-- Weekly products keep a calendar spine, but every person-side number still
-- has to be read through the selected attribution model.  Older revisions read
-- v_events here, which made the Credit selector silently stop at this tab.
create or replace view v_metrics_by_week as
with ads_placeable as (
  select client_id, bool_and(dated) as day_level from (
    select r.client_id, (a.date between r.start_date and r.end_date) as dated
    from v_ads a join v_rounds r on r.client_id = a.client_id and r.round_id = a.round_id
  ) q group by client_id
), ads as (
  select a.client_id, date_trunc('week', a.date)::date as week_start,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null), sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join v_rounds r on r.client_id = a.client_id and r.round_id = a.round_id
  join ads_placeable p on p.client_id = a.client_id and p.day_level
  group by 1, 2
), ev as (
  select client_id, date_trunc('week', (event_date at time zone 'Asia/Singapore')::date)::date as week_start,
         count(*) filter (where event_type = 'lead') as leads,
         count(*) filter (where event_type = 'attendance') as attendance
  from v_attributed_events
  where event_type in ('lead', 'attendance')
  group by 1, 2
), sales as (
  select client_id, date_trunc('week', (event_date at time zone 'Asia/Singapore')::date)::date as week_start,
         sum(attr_weight) filter (where product = 'preview') as prev_buy,
         sum(attr_weight) filter (where product = 'middle') as mid_buy,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (where product = 'preview') as prev_rev,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (where product = 'middle') as mid_rev,
         sum(attr_weight) filter (where product = 'preview' and attr_source = 'Paid Ads') as paid_prev_buy,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (where product = 'preview' and attr_source = 'Paid Ads') as paid_prev_rev,
         sum((amount - coalesce(refund_amount, 0)) * attr_weight) filter (where product = 'middle' and attr_source = 'Paid Ads') as paid_mid_rev
  from v_attributed_events where event_type = 'sale'
  group by 1, 2
), cls as (
  select s.client_id, date_trunc('week', s.session_date)::date as week_start, count(*) as sessions
  from v_round_sessions s join v_rounds r on r.client_id=s.client_id and r.round_id=s.round_id
  where s.session_date is not null group by 1, 2
), weeks as (
  select client_id, week_start from ads union select client_id, week_start from ev union select client_id, week_start from sales
), spans as (
  select w.client_id, w.week_start, string_agg(distinct r.round_id, ', ' order by r.round_id) as rounds
  from weeks w join v_rounds r on r.client_id=w.client_id and r.start_date <= w.week_start + 6 and r.end_date >= w.week_start
  group by 1, 2
)
select w.client_id, to_char(w.week_start, 'IYYY-"W"IW') as cut_key,
       to_char(w.week_start, 'DD Mon') || ' – ' || to_char(w.week_start + 6, 'DD Mon') as cut_label,
       sp.rounds as cut_sub, w.week_start,
       fo_paid_returns(fo_metrics(coalesce(a.ad_rows,0)>0, a.spend, a.reach::bigint,
         a.impressions::bigint, a.clicks::bigint,
         case when exists (select 1 from v_leads_seen z where z.client_id=w.client_id) then coalesce(e.leads,0) end,
         case when exists (select 1 from v_attendance_seen z where z.client_id=w.client_id) and coalesce(c.sessions,0)>0 then coalesce(e.attendance,0) end,
         case when seen.client_id is not null then coalesce(s.prev_buy,0) end,
         case when seen.client_id is not null then coalesce(s.mid_buy,0) end,
         case when seen.client_id is not null then coalesce(s.prev_rev,0) end,
         case when seen.client_id is not null then coalesce(s.mid_rev,0) end,
         prices.preview_price, prices.middle_price),
         case when seen.client_id is not null then coalesce(s.paid_prev_buy,0) end,
         case when seen.client_id is not null then coalesce(s.paid_prev_rev,0) end,
         case when seen.client_id is not null then coalesce(s.paid_mid_rev,0) end) as m
from weeks w
left join spans sp on sp.client_id=w.client_id and sp.week_start=w.week_start
left join ads a on a.client_id=w.client_id and a.week_start=w.week_start
left join ev e on e.client_id=w.client_id and e.week_start=w.week_start
left join sales s on s.client_id=w.client_id and s.week_start=w.week_start
left join cls c on c.client_id=w.client_id and c.week_start=w.week_start
left join v_sales_seen seen on seen.client_id=w.client_id
left join v_client_prices prices on prices.client_id=w.client_id;
grant select on v_metrics_by_week to anon, authenticated;

-- One function supplies both asset dimensions.  It reads v_attributed_events
-- exactly once, keeps delivery on the ad's own round, and only weights sale
-- counts/revenue.  The four public views below are thin stable names for the
-- existing UI and fo_cut whitelist.
create or replace function fo_asset_metrics(p_kind text, p_by_round boolean)
returns table(
  client_id text, cut_key text, cut_label text, cut_sub text,
  group_key text, group_label text, group_sub text, start_date date, m jsonb, ord integer
)
language sql stable as $$
with attributed as materialized (select * from v_attributed_events),
ads as (
  select a.client_id, a.round_id,
         coalesce(nullif(btrim(case when p_kind = 'ad' then a.ad else a.ad_set end), ''), '(unsplit)') as asset,
         sum(a.spend) as spend, sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  group by 1,2,3
), leads as (
  select e.client_id, e.attr_round_id as round_id,
         coalesce(nullif(btrim(case when p_kind = 'ad' then e.attr_ad else e.attr_audience end), ''),
                  case when e.attr_source = 'Paid Ads' then '(unsplit)' end) as asset,
         count(*)::bigint as leads
  from attributed e where e.event_type = 'lead'
    and (nullif(btrim(case when p_kind = 'ad' then e.attr_ad else e.attr_audience end), '') is not null
         or e.attr_source = 'Paid Ads')
  group by 1,2,3
), attendance as (
  select e.client_id, e.attr_round_id as round_id,
         coalesce(nullif(btrim(case when p_kind = 'ad' then e.attr_creative else e.attr_audience end), ''),
                  case when e.attr_source = 'Paid Ads' then '(unsplit)' end) as asset,
         count(*)::bigint as attendance
  from attributed e where e.event_type = 'attendance'
    and (nullif(btrim(case when p_kind = 'ad' then e.attr_creative else e.attr_audience end), '') is not null
         or e.attr_source = 'Paid Ads')
  group by 1,2,3
), sales as (
  select e.client_id, e.attr_round_id as round_id,
         coalesce(nullif(btrim(case when p_kind = 'ad' then e.attr_ad else e.attr_audience end), ''),
                  case when e.attr_source = 'Paid Ads' then '(unsplit)' end) as asset,
         sum(e.attr_weight) filter (where e.product = 'preview') as prev_buy,
         sum(e.attr_weight) filter (where e.product = 'middle') as mid_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview') as prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle') as mid_rev,
         sum(e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_buy,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'preview' and e.attr_source = 'Paid Ads') as paid_prev_rev,
         sum((e.amount - coalesce(e.refund_amount, 0)) * e.attr_weight) filter (where e.product = 'middle' and e.attr_source = 'Paid Ads') as paid_mid_rev
  from attributed e where e.event_type = 'sale'
    and (nullif(btrim(case when p_kind = 'ad' then e.attr_ad else e.attr_audience end), '') is not null
         or e.attr_source = 'Paid Ads')
  group by 1,2,3
), cells as (
  select client_id, round_id, asset from ads union
  select client_id, round_id, asset from leads union
  select client_id, round_id, asset from attendance union
  select client_id, round_id, asset from sales
), grouped as (
  select c.client_id, c.round_id, c.asset, r.start_date,
         a.spend, a.impressions, a.clicks, a.ad_rows,
         l.leads, t.attendance, s.prev_buy, s.mid_buy, s.prev_rev, s.mid_rev,
         s.paid_prev_buy, s.paid_prev_rev, s.paid_mid_rev
  from cells c join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
  left join ads a on a.client_id=c.client_id and a.round_id=c.round_id and a.asset=c.asset
  left join leads l on l.client_id=c.client_id and l.round_id=c.round_id and l.asset=c.asset
  left join attendance t on t.client_id=c.client_id and t.round_id=c.round_id and t.asset=c.asset
  left join sales s on s.client_id=c.client_id and s.round_id=c.round_id and s.asset=c.asset
), rolled as (
  select client_id, asset, case when p_by_round then round_id else null end as round_id,
         min(start_date) as start_date, sum(spend) as spend, sum(impressions) as impressions,
         sum(clicks) as clicks, sum(ad_rows) as ad_rows, sum(leads)::bigint as leads,
         sum(attendance)::bigint as attendance, sum(prev_buy) as prev_buy, sum(mid_buy) as mid_buy,
         sum(prev_rev) as prev_rev, sum(mid_rev) as mid_rev, sum(paid_prev_buy) as paid_prev_buy,
         sum(paid_prev_rev) as paid_prev_rev, sum(paid_mid_rev) as paid_mid_rev
  from grouped group by 1,2,3
)
select x.client_id,
  case when p_by_round then x.asset || '·' || x.round_id else x.asset end,
  case when p_by_round then x.round_id else x.asset end,
  case when p_by_round then to_char(x.start_date, 'Mon DD') else null end,
  case when p_by_round then x.asset else null end,
  case when p_by_round then case when x.asset='(unsplit)' then 'Unsplit spend' else x.asset end else null end,
  case when p_by_round and x.asset='(unsplit)' then 'paid, no asset recorded' else null end,
  x.start_date,
  fo_paid_returns(fo_metrics(x.ad_rows > 0, x.spend, null::bigint,
    x.impressions::bigint, x.clicks::bigint,
    coalesce(x.leads,0), coalesce(x.attendance,0),
    case when seen.client_id is not null then coalesce(x.prev_buy,0) end,
    case when seen.client_id is not null then coalesce(x.mid_buy,0) end,
    case when seen.client_id is not null then coalesce(x.prev_rev,0) end,
    case when seen.client_id is not null then coalesce(x.mid_rev,0) end,
    prices.preview_price, prices.middle_price),
    case when seen.client_id is not null then coalesce(x.paid_prev_buy,0) end,
    case when seen.client_id is not null then coalesce(x.paid_prev_rev,0) end,
    case when seen.client_id is not null then coalesce(x.paid_mid_rev,0) end),
  row_number() over (partition by x.client_id, case when p_by_round then x.asset end order by x.start_date, x.asset)::int
from rolled x
left join v_sales_seen seen on seen.client_id=x.client_id
left join v_client_prices prices on prices.client_id=x.client_id;
$$;
grant execute on function fo_asset_metrics(text, boolean) to anon, authenticated;

create or replace view v_metrics_by_ad as
-- The established non-round asset tabs intentionally have only six columns.
-- Keep that contract: adding the round-only group columns before `m` would
-- rename an existing view column and PostgreSQL correctly refuses that.
select client_id, cut_key, cut_label, cut_sub, m, ord
from fo_asset_metrics('ad', false);
create or replace view v_metrics_by_ad_round as
select client_id, cut_key, cut_label, cut_sub, group_key, group_label, group_sub, start_date, m, ord
from fo_asset_metrics('ad', true);
create or replace view v_metrics_by_adset as
-- `sort_spend` is a legacy seventh column consumed by the audience tab.
-- It must stay between m and ord; removing it is an incompatible view change.
select client_id, cut_key, cut_label, cut_sub, m,
       case when cut_key = '(unsplit)' then -1::numeric
            else coalesce((m ->> 'spend')::numeric, 0::numeric) end as sort_spend,
       ord
from fo_asset_metrics('adset', false);
create or replace view v_metrics_by_adset_round as
select client_id, cut_key, cut_label, cut_sub, group_key, group_label, group_sub, start_date, m, ord
from fo_asset_metrics('adset', true);
grant select on v_metrics_by_ad, v_metrics_by_ad_round, v_metrics_by_adset, v_metrics_by_adset_round to anon, authenticated;

-- Keep the old ten-argument function out of PostgREST's resolver.  Existing
-- callers use named keys and remain compatible; the two new settings are now
-- guaranteed to be set for every app-visible report.
drop function if exists fo_cut(text, text, text, text, date, date, text, text, text, text);
create function fo_cut(
  p_view text, p_client text, p_product text default null, p_channel text default null,
  p_from date default null, p_to date default null, p_offer text default null,
  p_country text default null, p_source text default null, p_periods text default null,
  p_audience text default null, p_attribution text default 'entry'
) returns setof jsonb language plpgsql stable as $$
declare v_order text; v_row text := 'to_jsonb(t)'; v_where text := ''; v_extras jsonb; v_key text;
        v_shared integer;
begin
  v_order := case p_view
    when 'v_metrics_by_month' then 'month_start' when 'v_metrics_by_week' then 'week_start'
    when 'v_metrics_by_round' then 'start_date' when 'v_metrics_by_round_source' then 'start_date, ord'
    when 'v_metrics_by_ad_round' then 'group_key, start_date' when 'v_metrics_by_adset_round' then 'group_key, start_date'
    when 'v_metrics_by_variant_round' then 'group_key, start_date' when 'v_metrics_by_lp_round' then 'group_key, start_date'
    when 'v_metrics_by_offer' then 'start_date' when 'v_metrics_by_source' then 'ord'
    when 'v_metrics_by_adset' then 'ord' when 'v_metrics_by_ad' then 'ord' when 'v_metrics_by_session' then 'ord'
    when 'v_metrics_by_variant' then 'ord' when 'v_metrics_by_lp' then 'ord' when 'v_metrics_this_round' then 'ord'
    when 'v_metrics_total' then 'cut_key' when 'v_metrics_baseline' then 'cut_key' when 'v_journey_strip' then 'stage_order'
    else null end;
  if v_order is null then raise exception 'fo_cut: % is not a readable cut', p_view; end if;
  perform set_config('funnel.product', coalesce(p_product,''), true);
  perform set_config('funnel.channel', coalesce(p_channel,''), true);
  perform set_config('funnel.country', coalesce(p_country,''), true);
  perform set_config('funnel.source', coalesce(p_source,''), true);
  perform set_config('funnel.periods', coalesce(p_periods,''), true);
  perform set_config('funnel.from', coalesce(p_from::text,''), true);
  perform set_config('funnel.to', coalesce(p_to::text,''), true);
  perform set_config('funnel.audience', coalesce(p_audience,''), true);
  perform set_config('funnel.attribution', coalesce(p_attribution,'entry'), true);
  -- A country/channel cut can remove delivery while the person export remains
  -- whole. Blank spend-derived claims only when a spend-bearing option was
  -- actually left out of the selected set.
  if p_country is not null then
    perform set_config('funnel.country', '', true);
    select count(distinct coalesce(country, 'not stated')) into v_shared
      from v_ads where client_id = p_client and coalesce(spend, 0) <> 0;
    perform set_config('funnel.country', p_country, true);
    if coalesce(v_shared, 0) > 1 then
      v_row := 'case when to_jsonb(t) ? ''m'' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m'')) else to_jsonb(t) end';
    end if;
  end if;
  if p_channel is not null then
    perform set_config('funnel.channel', '', true);
    select count(distinct coalesce(channel, 'other')) into v_shared
      from v_ads where client_id = p_client and coalesce(spend, 0) <> 0
        and coalesce(channel, 'other') <> all(string_to_array(p_channel, ','));
    perform set_config('funnel.channel', p_channel, true);
    if coalesce(v_shared, 0) > 0 then
      v_row := 'case when to_jsonb(t) ? ''m'' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m'')) else to_jsonb(t) end';
    end if;
  end if;
  if not fo_source_keeps_spend() then
    v_row := 'case when to_jsonb(t) ? ''m'' then jsonb_set(to_jsonb(t), ''{m}'', fo_source_blind(to_jsonb(t)->''m'')) else to_jsonb(t) end';
  end if;
  v_extras := fo_stage_extras(p_view, p_client);
  if v_extras <> '{}'::jsonb then
    v_key := case when p_view = 'v_journey_strip' then '''TOTAL''' else 't.cut_key' end;
    v_row := 'fo_merge_stage(' || v_row || ', $3, ' || v_key || ')';
  end if;
  if p_view = 'v_metrics_by_offer' and p_offer is not null then
    v_where := ' and product = $2';
    return query execute format('select %s from %I t where client_id = $1%s order by %s', v_row, p_view, v_where, v_order)
      using p_client, p_offer, v_extras;
  else
    return query execute format('select %s from %I t where client_id = $1 order by %s', v_row, p_view, v_order)
      using p_client, p_offer, v_extras;
  end if;
end;
$$;
grant execute on function fo_cut(text, text, text, text, date, date, text, text, text, text, text, text) to anon, authenticated;

commit;

-- Verify through the anon key, never only the SQL editor:
-- 1. default Entry remains spend 20474.78 · leads 1889 · attendance 682 · revenue 83927.
-- 2. each model returns that same total; only grouped sales move.
-- 3. sum(m->>'rev') on each asset report equals Total when no audience is selected.
