-- ═══════════════════════════════════════════════════════════════════════════
-- 0068 — a filter is a set, not a value.
--
-- Every selector in the filter bar becomes multi-select: click buttons to add
-- members, click again to remove them, and nothing pressed means everything.
-- The client asked for it on source first — Paid Ads AND Previous Paid Ads
-- together — and then for every other selector, which is the right shape:
-- May and July without June, SG and MY, two products.
--
-- ── ONE REPRESENTATION END TO END ──────────────────────────────────────────
-- A selection is a comma-separated string. It arrives in the URL that way, is
-- passed to fo_cut that way, is stored in the transaction-local setting that
-- way, and is read by the predicates with string_to_array(..., ','). Nothing
-- is parsed twice. No product id, channel, country or bucket contains a comma.
--
-- A single value is a one-element set, so every existing caller — the UI, the
-- integration routes passing one product and one channel — keeps working with
-- no change. With no selection the settings are empty, the arrays are NULL,
-- and every predicate is true: nothing moves until somebody presses a button.
--
-- ── THE THREE PREDICATES KEEP THEIR SIGNATURES ─────────────────────────────
-- fo_filter_ok, fo_filter_people_ok and fo_filter_source_ok change body only.
-- `create or replace` with the same signature swaps them in place, so v_ads,
-- v_events, v_rounds and everything above them are untouched. No view is
-- redefined here.
--
-- ── PERIODS ────────────────────────────────────────────────────────────────
-- A period selection is a set of windows, `from..to,from..to`, carried in a
-- new setting funnel.periods and a new fo_cut argument p_periods. A round
-- passes when it overlaps ANY chosen window — same overlap test the single
-- window has always used, applied per member. funnel.from / funnel.to and
-- p_from / p_to stay exactly as they were, honoured alongside, because the
-- integration routes read by month window through them.
--
-- ── WHEN A SELECTION BLANKS THE SPEND FIGURES ──────────────────────────────
-- Channel: 0028's rule generalised. It used to blank when more than one
-- channel had spend; it now blanks when a channel with spend is NOT in the
-- selection — which is the same thing for one member and the right thing for
-- several. Select every channel that spent and nothing blanks, as it should.
--
-- Source: fo_source_keeps_spend() decides, and now reads the set. Spend stays
-- when Paid Ads is selected and every member is one of Paid Ads / Previous
-- Paid Ads — together they are exactly what 0020's ROAS counts. Previous Paid
-- Ads alone blanks (this round's spend did not buy those people); anything
-- else in the set blanks. lib/funnel/filters.ts mirrors this rule for the
-- note under the bar, and the two must never disagree.
--
-- Country: 0061's block in fo_cut is reproduced verbatim and is still dead
-- (assigns to v_sel, overwritten below). See 0067's header. Not this change.
--
-- ── SIGNATURE ──────────────────────────────────────────────────────────────
-- p_periods is appended as the tenth argument, defaulted; the nine-argument
-- overload is dropped (0062's rule: one code path).
--
-- Safe to re-run.
--
-- ROLLBACK:
--   drop function if exists fo_cut(text, text, text, text, date, date, text, text, text, text);
--   -- re-run 0067's fo_cut, fo_filter_source_ok and fo_source_keeps_spend;
--   -- re-run 0062's fo_filter_ok and fo_filter_people_ok.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── ADS ────────────────────────────────────────────────────────────────────
create or replace function fo_filter_ok(
  p_product text, p_channel text, p_country text, p_round_start date, p_round_end date
) returns boolean language sql stable as $$
  with f as (
    select
      string_to_array(nullif(current_setting('funnel.product', true), ''), ',') as product,
      string_to_array(nullif(current_setting('funnel.channel', true), ''), ',') as channel,
      string_to_array(nullif(current_setting('funnel.country', true), ''), ',') as country,
      nullif(current_setting('funnel.from', true), '')::date                     as from_date,
      nullif(current_setting('funnel.to',   true), '')::date                     as to_date,
      string_to_array(nullif(current_setting('funnel.periods', true), ''), ',') as periods
  )
  select
      (f.product is null or p_product = any(f.product))
  and (f.channel is null or p_channel = any(f.channel))
  and (f.country is null or p_country = any(f.country))
  and (f.from_date is null or p_round_end   >= f.from_date)
  and (f.to_date   is null or p_round_start <= f.to_date)
  and (f.periods is null or exists (
        select 1 from unnest(f.periods) w
         where p_round_end   >= split_part(w, '..', 1)::date
           and p_round_start <= split_part(w, '..', 2)::date))
  from f;
$$;

-- ── PEOPLE ─────────────────────────────────────────────────────────────────
create or replace function fo_filter_people_ok(
  p_product text, p_country text, p_round_start date, p_round_end date
) returns boolean language sql stable as $$
  with f as (
    select
      string_to_array(nullif(current_setting('funnel.product', true), ''), ',') as product,
      string_to_array(nullif(current_setting('funnel.country', true), ''), ',') as country,
      nullif(current_setting('funnel.from', true), '')::date                     as from_date,
      nullif(current_setting('funnel.to',   true), '')::date                     as to_date,
      string_to_array(nullif(current_setting('funnel.periods', true), ''), ',') as periods
  )
  select
      (f.product is null or p_product = any(f.product))
  and (f.country is null or p_country = any(f.country))
  and (f.from_date is null or p_round_end   >= f.from_date)
  and (f.to_date   is null or p_round_start <= f.to_date)
  and (f.periods is null or exists (
        select 1 from unnest(f.periods) w
         where p_round_end   >= split_part(w, '..', 1)::date
           and p_round_start <= split_part(w, '..', 2)::date))
  from f;
$$;

-- ── SOURCE ─────────────────────────────────────────────────────────────────
create or replace function fo_filter_source_ok(p_bucket text)
returns boolean language sql stable as $$
  with f as (
    select string_to_array(nullif(current_setting('funnel.source', true), ''), ',') as source
  )
  select f.source is null or coalesce(p_bucket, '') = any(f.source)
  from f;
$$;

-- ── DOES THE SELECTED SET OWN THE SPEND? ───────────────────────────────────
create or replace function fo_source_keeps_spend()
returns boolean language sql stable as $$
  with f as (
    select string_to_array(nullif(current_setting('funnel.source', true), ''), ',') as source
  )
  select f.source is null
      or ('Paid Ads' = any(f.source)
          and f.source <@ array['Paid Ads', 'Previous Paid Ads']::text[])
  from f;
$$;

-- ── fo_cut — sets the sets, blanks by set ──────────────────────────────────
drop function if exists fo_cut(text, text, text, text, date, date, text, text, text);

create or replace function fo_cut(
  p_view    text,
  p_client  text,
  p_product text default null,
  p_channel text default null,
  p_from    date default null,
  p_to      date default null,
  p_offer   text default null,
  p_country text default null,
  p_source  text default null,
  p_periods text default null
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

  -- Each setting holds a comma-separated SET; the predicates split it.
  perform set_config('funnel.product', coalesce(p_product, ''), true);
  perform set_config('funnel.channel', coalesce(p_channel, ''), true);
  perform set_config('funnel.country', coalesce(p_country, ''), true);
  perform set_config('funnel.source',  coalesce(p_source,  ''), true);
  perform set_config('funnel.periods', coalesce(p_periods, ''), true);
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

  /*
   * Did the channel selection leave a channel with spend OUT? Counted with the
   * channel setting momentarily cleared so the scope is the rest of the filter
   * only, and put straight back. One member, several members, same test.
   */
  if p_channel is not null then
    perform set_config('funnel.channel', '', true);
    select count(distinct coalesce(channel, 'other'))
      into v_shared
      from v_ads
     where client_id = p_client
       and coalesce(spend, 0) <> 0
       and coalesce(channel, 'other') <> all(string_to_array(p_channel, ','));
    perform set_config('funnel.channel', p_channel, true);

    if coalesce(v_shared, 0) > 0 then
      -- `? 'm'` guards a view that has no metric object: jsonb_set returns NULL
      -- when handed one, which would drop every row without raising anything.
      v_row := 'case when to_jsonb(t) ? ''m'''
            || ' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m''))'
            || ' else to_jsonb(t) end';
    end if;
  end if;

  /*
   * The source set either owns the spend or it does not — one rule, in
   * fo_source_keeps_spend, which reads the setting just set above. Blanks a
   * superset of what the channel blinder removes, so replacing v_row loses
   * nothing a channel selection had already taken.
   */
  if not fo_source_keeps_spend() then
    v_row := 'case when to_jsonb(t) ? ''m'''
          || ' then jsonb_set(to_jsonb(t), ''{m}'', fo_source_blind(to_jsonb(t)->''m''))'
          || ' else to_jsonb(t) end';
  end if;

  /*
   * Declared metrics, folded in after the blinding rather than before.
   *
   * Order matters and this is the safe way round: the blinders null the ratios
   * a filter cannot answer, and they know the core keys. Merging first would
   * hand them an object holding keys they have never seen.
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
grant execute on function fo_cut(text, text, text, text, date, date, text, text, text, text) to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- fo_cut returns setof jsonb; metrics sit under 'm'. Alias the row.
--
-- One grid, five rows. Expect:
--   all          20474.78 · 1889 · roas 1.80 · rev 83927     (nothing moved)
--   paid         20474.78 · 1520 · roas 1.05                  (same-round paid)
--   paid+prev    20474.78 · 1520 · roas 1.80                  (everything the ads produced — the client's #3)
--   prev only    NULL spend · 0 leads · NULL roas · rev > 0   (earlier round's money)
--   may+july     spend/leads well below all; June's rounds absent
--
--   select 'all' as scope, (r->'m'->>'spend')::numeric as spend, (r->'m'->>'leads')::int as leads,
--          (r->'m'->>'roas')::numeric as roas, (r->'m'->>'rev')::numeric as rev
--     from fo_cut('v_metrics_total','shely') as r
--   union all select 'paid', (r->'m'->>'spend')::numeric, (r->'m'->>'leads')::int, (r->'m'->>'roas')::numeric, (r->'m'->>'rev')::numeric
--     from fo_cut('v_metrics_total','shely', p_source => 'Paid Ads') as r
--   union all select 'paid+prev', (r->'m'->>'spend')::numeric, (r->'m'->>'leads')::int, (r->'m'->>'roas')::numeric, (r->'m'->>'rev')::numeric
--     from fo_cut('v_metrics_total','shely', p_source => 'Paid Ads,Previous Paid Ads') as r
--   union all select 'prev only', (r->'m'->>'spend')::numeric, (r->'m'->>'leads')::int, (r->'m'->>'roas')::numeric, (r->'m'->>'rev')::numeric
--     from fo_cut('v_metrics_total','shely', p_source => 'Previous Paid Ads') as r
--   union all select 'may+july', (r->'m'->>'spend')::numeric, (r->'m'->>'leads')::int, (r->'m'->>'roas')::numeric, (r->'m'->>'rev')::numeric
--     from fo_cut('v_metrics_total','shely', p_periods => '2026-05-13..2026-05-28,2026-07-01..2026-07-30') as r;
