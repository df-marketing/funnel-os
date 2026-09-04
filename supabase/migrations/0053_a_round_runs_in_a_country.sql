-- ═══════════════════════════════════════════════════════════════════════════
-- 0053 — country is a property of a round.
--
-- A client can run several countries at once. That is a reporting question
-- inside one client's funnel, not a client-level grouping. A round that is
-- genuinely mixed (or whose country is unknown) stays NULL: absence is never
-- a default, so a country filter excludes it and All keeps it visible.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table rounds add column if not exists country text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'rounds'::regclass and conname = 'rounds_country_iso2_chk'
  ) then
    alter table rounds add constraint rounds_country_iso2_chk
      check (country is null or country ~ '^[A-Z]{2}$');
  end if;
end $$;

-- A single, legible country prefix is evidence. More than one is a mixed
-- round, and no prefix is not evidence, so both deliberately remain NULL.
with candidates as (
  select
    a.round_id,
    min(substring(a.campaign from '^DF_([A-Z]{2})_')) as country
  from ads_performance a
  where a.campaign ~ '^DF_[A-Z]{2}_'
  group by a.round_id
  having count(distinct substring(a.campaign from '^DF_([A-Z]{2})_')) = 1
)
update rounds r
set country = c.country
from candidates c
where r.round_id = c.round_id
  and r.country is null;

do $$
declare v_unknown integer;
begin
  select count(*) into v_unknown from rounds where country is null;
  raise notice 'Country could not be determined for % round(s); they remain unstated.', v_unknown;
end $$;

-- New signatures first. The views switch to them below, then the old signatures
-- can be removed without a dependency gap or an overloaded function lingering.
create or replace function fo_filter_ok(
  p_product      text,
  p_channel      text,
  p_country      text,
  p_round_start  date,
  p_round_end    date
) returns boolean
language sql
stable
as $$
  with f as (
    select
      nullif(current_setting('funnel.product', true), '')       as product,
      nullif(current_setting('funnel.channel', true), '')       as channel,
      nullif(current_setting('funnel.country', true), '')       as country,
      nullif(current_setting('funnel.from', true), '')::date    as from_date,
      nullif(current_setting('funnel.to', true), '')::date      as to_date
  )
  select
      (f.product is null or p_product = f.product)
  and (f.channel is null or p_channel = f.channel)
  and (f.country is null or p_country = f.country)
  and (f.from_date is null or p_round_end >= f.from_date)
  and (f.to_date is null or p_round_start <= f.to_date)
  from f;
$$;

create or replace function fo_filter_people_ok(
  p_product      text,
  p_country      text,
  p_round_start  date,
  p_round_end    date
) returns boolean
language sql
stable
as $$
  with f as (
    select
      nullif(current_setting('funnel.product', true), '')       as product,
      nullif(current_setting('funnel.country', true), '')       as country,
      nullif(current_setting('funnel.from', true), '')::date    as from_date,
      nullif(current_setting('funnel.to', true), '')::date      as to_date
  )
  select
      (f.product is null or p_product = f.product)
  and (f.country is null or p_country = f.country)
  and (f.from_date is null or p_round_end >= f.from_date)
  and (f.to_date is null or p_round_start <= f.to_date)
  from f;
$$;

-- country is appended only. Reordering a replaceable view shifts columns in
-- its dependants, which is silent corruption rather than a harmless refactor.
create or replace view v_ads as
select r.client_id, a.*, r.product_id, r.country
from ads_performance a
join rounds r on r.round_id = a.round_id
where fo_filter_ok(r.product_id, a.channel, r.country, r.start_date, r.end_date);

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
  r.country
from events e
join rounds r on r.round_id = e.round_id
where fo_filter_people_ok(r.product_id, r.country, r.start_date, r.end_date);

grant select on v_ads, v_events to anon, authenticated;
grant execute on function fo_filter_ok(text, text, text, date, date) to anon, authenticated;
grant execute on function fo_filter_people_ok(text, text, date, date) to anon, authenticated;

drop function if exists fo_filter_ok(text, text, date, date);
drop function if exists fo_filter_people_ok(text, date, date);

-- Adding a defaulted parameter is a new overloaded function in Postgres. Drop
-- the old seven-argument form so every caller reaches this one code path.
drop function if exists fo_cut(text, text, text, text, date, date, text);

create or replace function fo_cut(
  p_view    text,
  p_client  text,
  p_product text default null,
  p_channel text default null,
  p_from    date default null,
  p_to      date default null,
  p_offer   text default null,
  p_country text default null
) returns setof jsonb
language plpgsql
stable
as $$
declare
  v_order  text;
  v_where  text := '';
  v_row    text;
  v_sel    text;
  v_key    text;
  v_shared integer;
  v_extras jsonb;
  v_blind  boolean := false;
begin
  v_order := case p_view
    when 'v_metrics_by_month'        then 'month_start'
    when 'v_metrics_by_week'         then 'week_start'
    when 'v_metrics_by_round'        then 'start_date'
    when 'v_metrics_by_round_source' then 'start_date, ord'
    when 'v_metrics_by_offer'        then 'start_date'
    when 'v_metrics_by_source'       then 'ord'
    when 'v_metrics_by_adset'        then 'ord'
    when 'v_metrics_by_ad'           then 'ord'
    when 'v_metrics_by_session'      then 'ord'
    when 'v_metrics_this_round'      then 'ord'
    when 'v_metrics_total'           then 'cut_key'
    when 'v_metrics_baseline'        then 'cut_key'
    when 'v_journey_strip'           then 'stage_order'
    else null
  end;

  if v_order is null then
    raise exception 'fo_cut: % is not a readable cut', p_view;
  end if;

  perform set_config('funnel.product', coalesce(p_product, ''), true);
  perform set_config('funnel.channel', coalesce(p_channel, ''), true);
  perform set_config('funnel.country', coalesce(p_country, ''), true);
  perform set_config('funnel.from',    coalesce(p_from::text, ''), true);
  perform set_config('funnel.to',      coalesce(p_to::text, ''), true);

  -- Both filters can remove spend while retaining the whole denominator. The
  -- established response is to blind derived ratios, never imply a false CPA
  -- or ROAS. Each comparison clears only its own setting, inside this cut.
  if p_channel is not null then
    perform set_config('funnel.channel', '', true);
    select count(distinct coalesce(channel, 'other'))
      into v_shared
      from v_ads
     where client_id = p_client
       and coalesce(spend, 0) <> 0;
    perform set_config('funnel.channel', p_channel, true);
    v_blind := coalesce(v_shared, 0) > 1;
  end if;

  if p_country is not null then
    perform set_config('funnel.country', '', true);
    select count(distinct coalesce(country, 'not stated'))
      into v_shared
      from v_ads
     where client_id = p_client
       and coalesce(spend, 0) <> 0;
    perform set_config('funnel.country', p_country, true);
    v_blind := v_blind or coalesce(v_shared, 0) > 1;
  end if;

  v_row := case when v_blind
    then 'case when to_jsonb(t) ? ''m'' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m'')) else to_jsonb(t) end'
    else 'to_jsonb(t)'
  end;

  v_extras := fo_stage_extras(p_view, p_client);
  if v_extras <> '{}'::jsonb then
    v_key := case when p_view = 'v_journey_strip' then '''TOTAL''' else 't.cut_key' end;
    v_row := 'fo_merge_stage(' || v_row || ', $3, ' || v_key || ')';
  end if;
  v_sel := 'select ' || v_row;

  if p_view = 'v_metrics_by_offer' and p_offer is not null then
    v_where := ' and product = $2';
    return query execute
      format('%s from %I t where client_id = $1%s order by %s', v_sel, p_view, v_where, v_order)
      using p_client, p_offer, v_extras;
  else
    return query execute
      format('%s from %I t where client_id = $1 order by %s', v_sel, p_view, v_order)
      using p_client, p_offer, v_extras;
  end if;
end;
$$;

grant execute on function fo_cut(text, text, text, text, date, date, text, text) to anon, authenticated;

commit;
