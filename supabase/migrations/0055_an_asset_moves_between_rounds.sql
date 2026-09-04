-- ═══════════════════════════════════════════════════════════════════════════
-- 0055 — the same creative, round after round.
--
-- v_metrics_by_ad answers "which creative is best" by summing every round it
-- ever ran in. That is the right question for choosing what to run next and the
-- wrong one for noticing that the answer changed: a creative at 2.2 overall can
-- be 7.7 in one round and 0.0 in the next, and the sum shows neither.
--
-- Measured on Shely's own data, inside 0726-02 alone: the audience with the
-- WORST cost per lead returned 7.70 and the one with the second best returned
-- nothing at all. Neither fact survives being averaged with ten other rounds.
--
-- So: the asset is the GROUP and the round is the CUT. One block per creative,
-- its rounds along it, ordered by when they ran. The same shape
-- v_metrics_by_round_source already uses, with the two levels the other way
-- round, because the question here is about the asset over time rather than
-- the round across its sources.
--
-- ── WHAT COUNTS WHERE ─────────────────────────────────────────────────────
-- Exactly the rules the flat views already use, so a row here sums to the row
-- there and the two tabs cannot disagree:
--
--   spend, impressions, clicks   the ad row's own round
--   reach                        NOT summed — 0016. Per-ad reach is
--                                deduplicated people and adding it overstates;
--                                left null here, and the round totals on By
--                                round remain the place to read it.
--   leads                        the creative on the lead, in the lead's round
--   attendance                   the creative that ACQUIRED them, in the round
--                                whose class they attended
--   sales                        the creative that acquired them, in the round
--                                credited with the revenue (0052)
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── BY CREATIVE, ROUND BY ROUND ────────────────────────────────────────────
create or replace view v_metrics_by_ad_round as
with ads as (
  select client_id, round_id, nullif(btrim(ad), '') as asset,
         sum(spend) as spend, sum(impressions) as impressions,
         sum(clicks) as clicks, count(*) as ad_rows
  from v_ads group by 1, 2, 3
),
-- the creative that acquired each person: their earliest lead carrying one
lead_asset as (
  select distinct on (client_id, contact_id)
         client_id, contact_id,
         coalesce(nullif(btrim(ad), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as asset
  from v_events
  where event_type = 'lead' and contact_id is not null
    and (nullif(btrim(ad), '') is not null or source = 'Paid Ads')
  order by client_id, contact_id, event_date
),
ev_leads as (
  select client_id, round_id,
         coalesce(nullif(btrim(ad), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as asset,
         count(*) as leads
  from v_events
  where event_type = 'lead'
    and (nullif(btrim(ad), '') is not null or source = 'Paid Ads')
  group by 1, 2, 3
),
ev_att as (
  select e.client_id, e.round_id, la.asset, count(*) as attendance
  from v_events e
  join lead_asset la on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type = 'attendance'
  group by 1, 2, 3
),
ev_sale as (
  select e.client_id, coalesce(e.lead_round_id, e.round_id) as round_id, la.asset,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
    count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_mid_rev
  from v_events e
  join lead_asset la on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type = 'sale'
  group by 1, 2, 3
),
cells as (
  select client_id, round_id, asset from ads where asset is not null
  union select client_id, round_id, asset from ev_leads
  union select client_id, round_id, asset from ev_att
  union select client_id, round_id, asset from ev_sale
)
select
  c.client_id,
  c.asset || '·' || c.round_id                                     as cut_key,
  c.round_id                                                       as cut_label,
  to_char(r.start_date, 'Mon DD')                                  as cut_sub,
  c.asset                                                          as group_key,
  case when c.asset = '(unsplit)' then 'Unsplit spend' else c.asset end as group_label,
  case when c.asset = '(unsplit)' then 'paid, no ad recorded' end   as group_sub,
  r.start_date,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend,
      -- 0016: per-asset reach is deduplicated people and must not be summed.
      null::bigint,
      case when c.asset <> '(unsplit)' then a.impressions end,
      case when c.asset <> '(unsplit)' then a.clicks      end,
      coalesce(l.leads, 0), coalesce(t.attendance, 0),
      case when s.client_id is not null then coalesce(v.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(v.mid_buy,  0) end,
      case when s.client_id is not null then coalesce(v.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(v.mid_rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(v.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.paid_mid_rev,  0) end
  ) as m,
  row_number() over (
    partition by c.client_id, c.asset order by r.start_date
  )::int as ord
from cells c
join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join ads      a on a.client_id = c.client_id and a.round_id = c.round_id and a.asset = c.asset
left join ev_leads l on l.client_id = c.client_id and l.round_id = c.round_id and l.asset = c.asset
left join ev_att   t on t.client_id = c.client_id and t.round_id = c.round_id and t.asset = c.asset
left join ev_sale  v on v.client_id = c.client_id and v.round_id = c.round_id and v.asset = c.asset
left join v_sales_seen   s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, group_key, start_date;

grant select on v_metrics_by_ad_round to anon, authenticated;

-- ── BY AUDIENCE, ROUND BY ROUND ────────────────────────────────────────────
-- Identical but for the column it groups on. Written out rather than
-- parameterised because a view cannot take an argument, and the alternative is
-- a function returning a set, which every metric view would then have to
-- become.
create or replace view v_metrics_by_adset_round as
with ads as (
  select client_id, round_id, nullif(btrim(ad_set), '') as asset,
         sum(spend) as spend, sum(impressions) as impressions,
         sum(clicks) as clicks, count(*) as ad_rows
  from v_ads group by 1, 2, 3
),
lead_asset as (
  select distinct on (client_id, contact_id)
         client_id, contact_id,
         coalesce(nullif(btrim(ad_set), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as asset
  from v_events
  where event_type = 'lead' and contact_id is not null
    and (nullif(btrim(ad_set), '') is not null or source = 'Paid Ads')
  order by client_id, contact_id, event_date
),
ev_leads as (
  select client_id, round_id,
         coalesce(nullif(btrim(ad_set), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as asset,
         count(*) as leads
  from v_events
  where event_type = 'lead'
    and (nullif(btrim(ad_set), '') is not null or source = 'Paid Ads')
  group by 1, 2, 3
),
ev_att as (
  select e.client_id, e.round_id, la.asset, count(*) as attendance
  from v_events e
  join lead_asset la on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type = 'attendance'
  group by 1, 2, 3
),
ev_sale as (
  select e.client_id, coalesce(e.lead_round_id, e.round_id) as round_id, la.asset,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
    count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_mid_rev
  from v_events e
  join lead_asset la on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type = 'sale'
  group by 1, 2, 3
),
cells as (
  select client_id, round_id, asset from ads where asset is not null
  union select client_id, round_id, asset from ev_leads
  union select client_id, round_id, asset from ev_att
  union select client_id, round_id, asset from ev_sale
)
select
  c.client_id,
  c.asset || '·' || c.round_id                                     as cut_key,
  c.round_id                                                       as cut_label,
  to_char(r.start_date, 'Mon DD')                                  as cut_sub,
  c.asset                                                          as group_key,
  case when c.asset = '(unsplit)' then 'Unsplit spend' else c.asset end as group_label,
  case when c.asset = '(unsplit)' then 'paid, no ad set recorded' end as group_sub,
  r.start_date,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend,
      null::bigint,
      case when c.asset <> '(unsplit)' then a.impressions end,
      case when c.asset <> '(unsplit)' then a.clicks      end,
      coalesce(l.leads, 0), coalesce(t.attendance, 0),
      case when s.client_id is not null then coalesce(v.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(v.mid_buy,  0) end,
      case when s.client_id is not null then coalesce(v.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(v.mid_rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(v.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.paid_mid_rev,  0) end
  ) as m,
  row_number() over (
    partition by c.client_id, c.asset order by r.start_date
  )::int as ord
from cells c
join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join ads      a on a.client_id = c.client_id and a.round_id = c.round_id and a.asset = c.asset
left join ev_leads l on l.client_id = c.client_id and l.round_id = c.round_id and l.asset = c.asset
left join ev_att   t on t.client_id = c.client_id and t.round_id = c.round_id and t.asset = c.asset
left join ev_sale  v on v.client_id = c.client_id and v.round_id = c.round_id and v.asset = c.asset
left join v_sales_seen   s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, group_key, start_date;

grant select on v_metrics_by_adset_round to anon, authenticated;

-- ── fo_cut learns the two new cuts ─────────────────────────────────────────
-- Reproduced whole rather than patched, because a plpgsql body cannot be
-- edited in place. Only the whitelist changed.

create or replace function fo_cut(
  p_view    text,
  p_client  text,
  p_product text default null,
  p_channel text default null,
  p_from    date default null,
  p_to      date default null,
  p_offer   text default null
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
  perform set_config('funnel.from',    coalesce(p_from::text, ''), true);
  perform set_config('funnel.to',      coalesce(p_to::text,   ''), true);

  v_row := 'to_jsonb(t)';

  -- Did selecting this channel actually take spend away? Counted with the
  -- channel setting momentarily cleared, and put straight back.
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

grant execute on function fo_cut(text, text, text, text, date, date, text) to anon, authenticated;

commit;
