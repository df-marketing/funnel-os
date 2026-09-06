-- ═══════════════════════════════════════════════════════════════════════════
-- 0067 — a source is a filter, not only a tab.
--
-- The client wants "paid ads only" on every screen, not a separate tab that
-- puts the six sources side by side. So source joins Product, Channel, Country
-- and Period in the filter bar, and the By source tab leaves the sidebar
-- (Round × source stays; the view itself stays readable by URL).
--
-- ── WHAT A SOURCE FILTER CAN AND CANNOT NARROW ─────────────────────────────
-- A source is a fact about a PERSON. v_events already computes it on every row
-- as attribution_bucket — Paid Ads · Previous Paid Ads · AOAI · AI Community ·
-- Organic · Unattributed — and attendance and sales inherit it from the lead
-- that acquired the person (pipeline.ts, sourceFor). So leads, attendance,
-- purchases and revenue all narrow cleanly.
--
-- Spend has no source. ads_performance carries no such column and never will:
-- every dollar in it is paid advertising. That gives one honest rule, and it is
-- the same rule v_metrics_by_source has used all along:
--
--   Paid Ads selected      spend stays whole — it is exactly the money that
--                          bought these people, so CPL, CPA and ROAS are the
--                          paid-only figures the filter exists to produce.
--
--   anything else selected spend, reach, frequency, impressions, clicks and
--                          every rate built on them go BLANK. Organic leads
--                          divided by paid spend is not a cost per lead, it is
--                          a number. Previous Paid Ads blanks too: those people
--                          were bought by an EARLIER round's spend, so this
--                          round's spend has nothing to do with them.
--
-- Unlike the channel filter (0028), there is no "did it take anything away"
-- probe. Under a channel, spend might all be on one platform and the filter
-- removes nothing. Under a source, spend belongs to Paid Ads and to no one
-- else, always — so the blanking is deterministic and fo_cut does not need to
-- ask the database twice.
--
-- ── WHERE THE PREDICATE LIVES ──────────────────────────────────────────────
-- Its own function, fo_filter_source_ok, called from v_events only. It is NOT
-- added to fo_filter_people_ok, because v_rounds calls that too and a source
-- filter must never remove a round: the period list, the round columns and
-- "which rounds is this data in" all read v_rounds, and a round that had only
-- organic leads is still a round that ran.
--
-- ── THE JOURNEY STRIP ──────────────────────────────────────────────────────
-- The strip computes its `value` inside the view, before fo_cut's blinding
-- runs, so under Organic it would print 434,575 impressions above 247 organic
-- leads and a "lead gen %" that divided one by the other. The blinding is
-- applied inside v_journey_strip's base instead, through fo_source_keeps_spend,
-- so the Impressions and Clicks cards read "—" and the rate that follows them
-- reads nothing rather than nonsense. Output columns unchanged — an internal
-- CASE, not a reorder.
--
-- ── FOUND IN PASSING, LEFT ALONE ───────────────────────────────────────────
-- fo_cut's country block (0061) assigns its blinded row to v_sel, which the
-- line `v_sel := 'select ' || v_row` then overwrites — so country blinding has
-- never fired. It is reproduced verbatim below, unfixed, because activating it
-- would be WRONG: under a country filter both spend (v_ads) and people
-- (v_events) narrow, so the ratios are valid and should not blank. The block
-- and the countryBlanked note in Shell.tsx are dead code, and can be removed
-- in a change of their own. Not this one.
--
-- ── SIGNATURE ──────────────────────────────────────────────────────────────
-- p_source is appended as the ninth argument, defaulted, and the eight-argument
-- overload is dropped so every caller reaches one code path (0062's rule).
--
-- Safe to re-run. Changes nothing while no source is selected: with the setting
-- empty, fo_filter_source_ok is true for every row and fo_source_keeps_spend is
-- true, so every existing figure is what it was.
--
-- ROLLBACK:
--   drop function if exists fo_cut(text, text, text, text, date, date, text, text, text);
--   -- re-run 0062's fo_cut, then:
--   drop view if exists v_client_sources;
--   -- re-run 0062's v_events (without the fo_filter_source_ok clause) and
--   -- 0051's v_journey_strip (without the fo_source_keeps_spend CASE), then:
--   drop function if exists fo_source_blind(jsonb);
--   drop function if exists fo_source_keeps_spend();
--   drop function if exists fo_filter_source_ok(text);
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── THE PREDICATE ──────────────────────────────────────────────────────────
-- True when no source is selected, or when this row's bucket is the one
-- selected. Same shape as the other two predicates: a nullable comparison is
-- never used, because `null = 'Paid Ads'` is NULL and NULL is not true.
create or replace function fo_filter_source_ok(p_bucket text)
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('funnel.source', true), ''), p_bucket, '')
         = coalesce(p_bucket, '');
$$;
grant execute on function fo_filter_source_ok(text) to anon, authenticated;

-- ── DOES THE SELECTED SOURCE OWN THE SPEND? ────────────────────────────────
-- Paid Ads does. Nothing else does. No selection means everything, which does.
create or replace function fo_source_keeps_spend()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('funnel.source', true), ''), 'Paid Ads') = 'Paid Ads';
$$;
grant execute on function fo_source_keeps_spend() to anon, authenticated;

-- ── WHAT A NON-PAID SOURCE CANNOT ANSWER ───────────────────────────────────
-- Everything that is spend, delivery, or a ratio with either underneath it.
-- The people-side counts and rates survive: leads, attendance, purchases,
-- revenue, attendance %, purchase %, AOV, and the two prices.
create or replace function fo_source_blind(m jsonb)
returns jsonb language sql immutable as $$
  select m || jsonb_build_object(
    'spend',    null,   -- paid money, not this source's
    'reach',    null,
    'freq',     null,
    'impr',     null,
    'clicks',   null,
    'ctr',      null,   -- clicks ÷ impressions
    'cpm',      null,
    'cpc',      null,
    'cpl',      null,   -- paid spend ÷ this source's leads
    'cpAtt',    null,
    'cpa',      null,
    'leadgen',  null,   -- this source's leads ÷ paid clicks
    'prevRoas', null,
    'midRoas',  null,
    'roas',     null
  );
$$;
grant execute on function fo_source_blind(jsonb) to anon, authenticated;

-- ── v_events — the one place the filter bites ──────────────────────────────
-- 0062's definition with one clause added. Column list identical.
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
  -- the row's own country first: the lead's campaign said it, or the import
  -- inherited it from the lead that acquired this person
  coalesce(e.country, fo_country(e.utm_campaign), r.country) as country
from events e
join rounds r on r.round_id = e.round_id
where fo_filter_people_ok(r.product_id,
                          coalesce(e.country, fo_country(e.utm_campaign), r.country),
                          r.start_date, r.end_date)
  -- the same expression as attribution_bucket above, with the same
  -- 'Unattributed' fallback the source views use, so the filter and the tab
  -- cannot disagree about which bucket a row is in
  and fo_filter_source_ok(
        coalesce(
          case
            when e.source = 'Paid Ads'
             and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
              then 'Previous Paid Ads'
            else e.source
          end,
          'Unattributed'));

grant select on v_events to anon, authenticated;

-- ── WHAT THE FILTER BAR CAN OFFER ──────────────────────────────────────────
-- The buckets this client actually has people in, in the source view's order,
-- with a lead count so the option can say how big it is. Deliberately NOT
-- filtered itself — the list has to stay whole while you are standing on one
-- of its members, or you could never choose back (same rule as products).
create or replace view v_client_sources as
select
  r.client_id,
  coalesce(
    case
      when e.source = 'Paid Ads'
       and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
        then 'Previous Paid Ads'
      else e.source
    end,
    'Unattributed')                                        as bucket,
  coalesce(b.ord, 99)                                      as ord,
  b.note,
  count(*) filter (where e.event_type = 'lead')::int       as leads,
  count(*)::int                                            as event_rows
from events e
join rounds r on r.round_id = e.round_id
left join v_source_buckets b on b.bucket = coalesce(
    case
      when e.source = 'Paid Ads'
       and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
        then 'Previous Paid Ads'
      else e.source
    end,
    'Unattributed')
group by 1, 2, 3, 4
order by r.client_id, coalesce(b.ord, 99);

grant select on v_client_sources to anon, authenticated;

-- ── THE JOURNEY STRIP — blind at the base, not after the fact ──────────────
-- 0051's definition; the only change is the CASE around t.m.
create or replace view v_journey_strip as
with base as (
  select
    j.client_id, j.stage_order, j.stage_name, j.stage_slug, j.stage_rate_label,
    j.stage_metric,
    jm.metric_key,
    fo_add_stage_costs(
      case when fo_source_keeps_spend() then t.m else fo_source_blind(t.m) end,
      fo_stage_extras('v_journey_strip', j.client_id) -> 'TOTAL') as mm
  from v_journey j
  left join v_metrics_total t on t.client_id = j.client_id
  left join journey_metrics jm on jm.metric = j.stage_metric
),
valued as (
  select *,
    case when (mm ->> metric_key) ~ '^-?[0-9]+(\.[0-9]+)?$'
         then (mm ->> metric_key)::numeric end as value_num
  from base
)
select
  client_id, stage_order, stage_name, stage_slug, stage_rate_label,
  (mm ->> metric_key) as value,
  (
    100 * value_num
    / nullif(lag(value_num) over (partition by client_id order by stage_order), 0)
  )::text as rate,
  stage_metric,
  mm as m
from valued
order by client_id, stage_order;

grant select on v_journey_strip to anon, authenticated;

-- ── fo_cut — gains p_source, sets the GUC, blinds when the source is not paid
drop function if exists fo_cut(text, text, text, text, date, date, text, text);

create or replace function fo_cut(
  p_view    text,
  p_client  text,
  p_product text default null,
  p_channel text default null,
  p_from    date default null,
  p_to      date default null,
  p_offer   text default null,
  p_country text default null,
  p_source  text default null
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
  perform set_config('funnel.source',  coalesce(p_source,  ''), true);
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
   * A source other than Paid Ads owns no spend, so every spend-derived figure
   * blanks. Deterministic — no probe, see the header. fo_source_blind nulls a
   * superset of fo_channel_blind's keys, so replacing v_row here loses nothing
   * a channel filter had already removed.
   */
  if p_source is not null and p_source <> 'Paid Ads' then
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
grant execute on function fo_cut(text, text, text, text, date, date, text, text, text) to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- fo_cut returns setof jsonb — one JSON value per row, metrics nested under
-- 'm'. Alias the row and reach into it; there is no column called m.
--
-- 1. Nothing moved with no source selected — the By round total is unchanged:
--      select (r->'m'->>'spend')::numeric, (r->'m'->>'leads')::int, (r->'m'->>'rev')::numeric
--        from fo_cut('v_metrics_total', 'shely') as r;
--    Expect 20474.78 · 1889 · 83927 (as of 4 Sep 2026).
--
-- 2. Paid only keeps spend, narrows people:
--      select (r->'m'->>'spend')::numeric, (r->'m'->>'leads')::int, (r->'m'->>'cpl')::numeric
--        from fo_cut('v_metrics_total', 'shely', p_source => 'Paid Ads') as r;
--    Spend still 20474.78; leads lower; CPL higher than 10.84.
--
-- 3. Organic blanks spend and every rate on it:
--      select r->'m'->>'spend', r->'m'->>'cpl', r->'m'->>'roas', (r->'m'->>'leads')::int
--        from fo_cut('v_metrics_total', 'shely', p_source => 'Organic') as r;
--    First three NULL; leads > 0.
--
-- 4. The filter bar's options:
--      select bucket, leads from v_client_sources where client_id = 'shely';
