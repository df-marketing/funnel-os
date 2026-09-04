-- ═══════════════════════════════════════════════════════════════════════════
-- 0061 — country is a property of a round.
--
-- Rewritten from the branch that first built this. Two things had moved since:
-- v_events gained a `variant` column (0056) and fo_cut learned five new cuts,
-- so the original recreated both from a shape that no longer existed. Applying
-- it as written would have put `country` where `variant` now sits and silently
-- shifted every column in whatever reads that view — and it would have deleted
-- the landing-page, variant and asset-by-round cuts from fo_cut's whitelist.
--
-- ── WHAT THIS CANNOT DO, SAID PLAINLY ─────────────────────────────────────
-- The client's own 0926-01 runs BOTH countries: SG $2,946.46 and MY $989.34,
-- 102 leads against 242, sub-columns of one round in their sheet. A country on
-- the ROUND cannot split that, and this migration does not pretend to — the
-- back-fill finds two prefixes for that round and leaves it null, so it shows
-- under All and in neither country.
--
-- That is the honest behaviour and it is also the limitation: splitting a mixed
-- round needs country on the lead and on the ad row, which is a bigger change.
-- Until then this answers "which countries did we run in" and not "how did MY
-- do inside a round that also ran SG".
--
-- Absence is never a default: a round whose country cannot be determined stays
-- NULL, is excluded by a country filter, and appears under All.
--
-- Safe to re-run.
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

-- A single legible prefix is evidence. More than one is a mixed round and none
-- is not evidence, so both deliberately stay NULL.
with candidates as (
  select a.round_id,
         min(substring(a.campaign from '^DF_([A-Z]{2})_')) as country
  from ads_performance a
  where a.campaign ~ '^DF_[A-Z]{2}_'
  group by a.round_id
  having count(distinct substring(a.campaign from '^DF_([A-Z]{2})_')) = 1
)
update rounds r
   set country = c.country
  from candidates c
 where r.round_id = c.round_id and r.country is null;

do $$
declare v_unknown integer;
begin
  select count(*) into v_unknown from rounds where country is null;
  raise notice 'Country could not be determined for % round(s); they remain unstated.', v_unknown;
end $$;

-- New signatures first, then the views switch to them, then the old ones go.
create or replace function fo_filter_ok(
  p_product text, p_channel text, p_country text, p_round_start date, p_round_end date
) returns boolean language sql stable as $$
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
  p_product text, p_country text, p_round_start date, p_round_end date
) returns boolean language sql stable as $$
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

-- EVERY view that calls a filter function must move to the new signature before
-- the old one can be dropped. There are three, and the first attempt missed one:
--
--     2BP01: cannot drop function fo_filter_people_ok(text,date,date)
--            because other objects depend on it
--     DETAIL: view v_rounds depends on it
--
-- with fourteen views depending on v_rounds in turn. Caught by the transaction,
-- so nothing was half-applied.
--
-- `select *` re-expands, and rounds gained `country` above, so v_rounds picks it
-- up as its last column — an append, which is legal.
create or replace view v_rounds as
select * from rounds
where fo_filter_people_ok(product_id, country, start_date, end_date);

grant select on v_rounds to anon, authenticated;

-- country is APPENDED. create or replace may add a column, never insert or
-- reorder one — and `variant` (0056) already holds the last slot on v_events,
-- so country goes after it, not where the original branch put it.
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
  e.variant,
  r.country
from events e
join rounds r on r.round_id = e.round_id
where fo_filter_people_ok(r.product_id, r.country, r.start_date, r.end_date);

grant select on v_ads, v_events to anon, authenticated;
grant execute on function fo_filter_ok(text, text, text, date, date) to anon, authenticated;
grant execute on function fo_filter_people_ok(text, text, date, date) to anon, authenticated;

drop function if exists fo_filter_ok(text, text, date, date);
drop function if exists fo_filter_people_ok(text, date, date);

-- Adding a defaulted parameter creates an OVERLOAD in Postgres. Drop the old
-- seven-argument form so every caller reaches one code path.
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
begin
  v_order := case p_view
    when 'v_metrics_by_month'        then 'month_start'
    when 'v_metrics_by_week'         then 'week_start'
    when 'v_metrics_by_round'        then 'start_date'
    when 'v_metrics_by_round_source' then 'start_date, ord'
    -- the asset is the group and the round is the cut, so it orders by the
    -- asset first and then by when each round ran
    when 'v_metrics_by_ad_round'     then 'group_key, start_date'
    -- people-side A/B: the arm, and the arm across its rounds
    when 'v_metrics_by_variant'       then 'ord'
    when 'v_metrics_by_lp'            then 'ord'
    when 'v_metrics_by_lp_round'      then 'group_key, start_date'
    when 'v_metrics_by_variant_round' then 'group_key, start_date'
    when 'v_metrics_by_adset_round'  then 'group_key, start_date'
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
  perform set_config('funnel.to',      coalesce(p_to::text,   ''), true);

  v_row := 'to_jsonb(t)';

  -- Did selecting this channel actually take spend away? Counted with the
  -- channel setting momentarily cleared, and put straight back.
  if p_country is not null then
    perform set_config('funnel.country', '', true);
    select count(distinct coalesce(country, 'not stated'))
      into v_shared
      from v_ads
     where client_id = p_client
       and coalesce(spend, 0) <> 0;
    perform set_config('funnel.country', p_country, true);
    if coalesce(v_shared, 0) > 1 then
      v_sel := 'select case when to_jsonb(t) ? ''m'''
            || ' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m''))'
            || ' else to_jsonb(t) end';
    end if;
  end if;

  if p_channel is not null then
    perform set_config('funnel.channel', '', true);
    select count(distinct coalesce(channel, 'other'))
      into v_shared
      from v_ads
     where client_id = p_client
       and coalesce(spend, 0) <> 0;
    perform set_config('funnel.channel', p_channel, true);

    if coalesce(v_shared, 0) > 1 then
      -- `? 'm'` guards a view that has no metric object: jsonb_set returns NULL
      -- when handed one, which would drop every row without raising anything.
      v_row := 'case when to_jsonb(t) ? ''m'''
            || ' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m''))'
            || ' else to_jsonb(t) end';
    end if;
  end if;

  /*
   * Declared metrics, folded in after the blinding rather than before.
   *
   * Order matters and this is the safe way round: fo_channel_blind nulls the
   * ratios a channel filter cannot answer, and it knows the core keys. Merging
   * first would hand it an object holding keys it has never seen.
   *
   * The strip is keyed on TOTAL because it is always the whole filtered window
   * — it has no cut_key column to read, and asking for one would fail.
   */
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
