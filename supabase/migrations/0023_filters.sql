-- ═══════════════════════════════════════════════════════════════════════════
-- 0023 — product, channel and period, applied before anything is added up.
--
-- A filter that arrives after aggregation is no filter at all: you cannot
-- average a ROAS or re-derive a cost per lead from six rounds that have already
-- been summed. So it has to bite at the bottom, on the rows.
--
-- Every metric view reads its facts through exactly two views — v_ads and
-- v_events — and the three that don't read them directly derive from ones that
-- do. Filtering there means all eleven inherit it and NOT ONE of them changes.
--
-- ── HOW THE FILTER GETS IN ────────────────────────────────────────────────
-- A view takes no arguments, so the choice travels as three transaction-local
-- settings. fo_cut() sets them and reads the view in the same transaction; the
-- `true` on set_config makes them die with that transaction, so one request can
-- never leak its filter into another.
--
-- Unset means unfiltered. Reading any of these views directly — psql, the
-- Supabase table editor, a future dashboard — behaves exactly as it did before
-- this migration, because current_setting(..., true) returns NULL when nobody
-- has set it.
--
-- ── PERIOD FILTERS ROUNDS, NOT ROWS ───────────────────────────────────────
-- The tempting version filters each row on its own date. It quietly breaks the
-- funnel: a sale on 20 May whose lead came in on 14 May would keep its revenue
-- and lose the lead that produced it, and every rate built on that pair would
-- be wrong in a way nobody could see.
--
-- So a period selects ROUNDS that overlap it, and a round brings all of its
-- rows with it. Leads, attendance and sales always travel together, which is
-- the only way the funnel stays internally consistent. Slightly generous at the
-- edges — asking for 1–15 May includes a round that ran 13–19 — and that is the
-- right trade against a funnel that silently doesn't add up.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── THE FILTER, IN ONE PLACE ───────────────────────────────────────────────
-- Two functions rather than one with a nullable channel, because NULL is not
-- "doesn't apply" in SQL — it is unknown, and `null = 'meta'` is NULL, which
-- fails the AND and silently deletes every row. That mistake removed all 313
-- leads the first time this ran. Named functions make the difference unmissable.

-- Rows that belong to a platform: ads.
create or replace function fo_filter_ok(
  p_product      text,
  p_channel      text,
  p_round_start  date,
  p_round_end    date
) returns boolean
language sql
stable
as $$
  -- Settings are read into a row first. Inline, the empty string reaches ::date
  -- before the `is null` guard can stop it — SQL does not promise to
  -- short-circuit an OR — and every read fails with "invalid input syntax for
  -- type date". nullif() has to happen before the cast.
  with f as (
    select
      nullif(current_setting('funnel.product', true), '')        as product,
      nullif(current_setting('funnel.channel', true), '')        as channel,
      nullif(current_setting('funnel.from',    true), '')::date  as from_date,
      nullif(current_setting('funnel.to',      true), '')::date  as to_date
  )
  select
      (f.product is null or p_product = f.product)
  and (f.channel is null or p_channel = f.channel)
  -- overlap, not containment: a round that started before the window and ran
  -- into it is part of that window's story
  and (f.from_date is null or p_round_end   >= f.from_date)
  and (f.to_date   is null or p_round_start <= f.to_date)
  from f;
$$;

-- Rows that belong to a person: leads, attendance, sales.
--
-- A person is not bought on a platform — their click is. Nothing in the leads
-- export says whether someone came from Meta or Google, so a channel filter
-- CANNOT narrow people, and pretending otherwise would either delete leads that
-- exist or credit them to a platform that didn't produce them. It narrows spend
-- and delivery; the screen says so.
create or replace function fo_filter_people_ok(
  p_product      text,
  p_round_start  date,
  p_round_end    date
) returns boolean
language sql
stable
as $$
  with f as (
    select
      nullif(current_setting('funnel.product', true), '')        as product,
      nullif(current_setting('funnel.from',    true), '')::date  as from_date,
      nullif(current_setting('funnel.to',      true), '')::date  as to_date
  )
  select
      (f.product is null or p_product = f.product)
  and (f.from_date is null or p_round_end   >= f.from_date)
  and (f.to_date   is null or p_round_start <= f.to_date)
  from f;
$$;

grant execute on function fo_filter_ok(text, text, date, date) to anon, authenticated;
grant execute on function fo_filter_people_ok(text, date, date) to anon, authenticated;

-- ── THE TWO VIEWS EVERYTHING READS ─────────────────────────────────────────
-- product_id and channel are exposed as columns as well as filtered on, so the
-- filter bar can show what actually exists rather than a fixed list.
-- product_id goes LAST, and channel arrives inside a.*: create or replace view
-- may only append columns, never insert one. Same reason product_id trails the
-- event columns below.
create or replace view v_ads as
select r.client_id, a.*, r.product_id
from ads_performance a
join rounds r on r.round_id = a.round_id
where fo_filter_ok(r.product_id, a.channel, r.start_date, r.end_date);

grant select on v_ads to anon, authenticated;

-- Events carry no channel of their own — a person is not bought on a platform,
-- their click is. Passing NULL means a channel filter never removes people,
-- only spend. That is deliberate: filtering to Google should not delete the
-- leads Meta produced, it should show Google's spend against no leads until
-- Google leads carry a platform of their own.
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
  r.product_id
from events e
join rounds r on r.round_id = e.round_id
where fo_filter_people_ok(r.product_id, r.start_date, r.end_date);

grant select on v_events to anon, authenticated;

-- ── ONE WAY IN ─────────────────────────────────────────────────────────────
-- Sets the filter and reads the cut in the same transaction, returning each row
-- as jsonb so a single function serves eleven views of different shapes.
--
-- p_view is whitelisted rather than escaped. A whitelist can only ever return
-- one of eleven known views; escaping is a promise that the next person to edit
-- this has to keep.
--
-- Ordering lives here too. PostgREST does not promise a view's own ORDER BY
-- survives, and these rows arrive as opaque jsonb with nothing left to sort on,
-- so the order is applied inside and is part of the contract.
create or replace function fo_cut(
  p_view    text,
  p_client  text,
  p_product text default null,
  p_channel text default null,
  p_from    date default null,
  p_to      date default null,
  p_offer   text default null      -- v_metrics_by_offer only: 'preview' | 'middle'
) returns setof jsonb
language plpgsql
stable
as $$
declare
  v_order text;
  v_where text := '';
begin
  v_order := case p_view
    when 'v_metrics_by_month'       then 'month_start'
    when 'v_metrics_by_round'       then 'start_date'
    when 'v_metrics_by_round_source' then 'start_date, ord'
    when 'v_metrics_by_offer'       then 'start_date'
    when 'v_metrics_by_source'      then 'ord'
    when 'v_metrics_by_adset'       then 'ord'
    when 'v_metrics_by_ad'          then 'ord'
    when 'v_metrics_by_session'     then 'ord'
    when 'v_metrics_this_round'     then 'ord'
    when 'v_metrics_total'          then 'cut_key'
    when 'v_metrics_baseline'       then 'cut_key'
    else null
  end;

  if v_order is null then
    raise exception 'fo_cut: % is not a readable cut', p_view;
  end if;

  perform set_config('funnel.product', coalesce(p_product, ''), true);
  perform set_config('funnel.channel', coalesce(p_channel, ''), true);
  perform set_config('funnel.from',    coalesce(p_from::text, ''), true);
  perform set_config('funnel.to',      coalesce(p_to::text,   ''), true);

  if p_view = 'v_metrics_by_offer' and p_offer is not null then
    v_where := ' and product = $2';
    return query execute
      format('select to_jsonb(t) from %I t where client_id = $1%s order by %s', p_view, v_where, v_order)
      using p_client, p_offer;
  else
    return query execute
      format('select to_jsonb(t) from %I t where client_id = $1 order by %s', p_view, v_order)
      using p_client;
  end if;
end;
$$;

grant execute on function fo_cut(text, text, text, text, date, date, text) to anon, authenticated;
