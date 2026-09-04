-- ═══════════════════════════════════════════════════════════════════════════
-- 0058 — which landing page a campaign pointed at.
--
-- The client confirms there are two, LP1 and LP2. Both are already in the data
-- — inside the campaign name, written six different ways:
--
--     ..._0826_03_LP1GHL              ..._0726_04_LP1GHL(0826_02)
--     ..._0726_02_LP1                 ..._0726_023_LP1GHLHenry
--     ..._0726_04_LP1GHL_AcqOS        ..._0826_03_LP1GHL_AcqOS
--
-- so the mapping is read from the name rather than stored: a table of campaign
-- to page would need a row adding every time a campaign is created, and the
-- one thing every one of those names does agree on is the LP1 / LP2 token.
--
-- ── WHY THIS IS NOT THE VARIANT COLUMN ────────────────────────────────────
-- 0056's variant is people-side and carries no spend, because a reminder
-- sequence is given to people the ads already bought. A landing page is the
-- opposite: the campaign points at it, so the spend belongs to it and cost per
-- lead by page is the whole question. Same shape as ad set and creative, and
-- it reuses their arithmetic exactly.
--
-- ── WHAT IS DELIBERATELY NOT MAPPED ───────────────────────────────────────
-- Two campaigns say LP with no number — 0626_02_LP and 0726_01_AI_LP, $1,970
-- between them — and they predate the round where LP1 and LP2 first appear
-- together. They could be the original single page or they could be LP1; the
-- two readings give different answers and nothing in the data decides it, so
-- they are left unmapped and appear as "Not stated" rather than being guessed
-- into a column.
--
-- Nine more campaigns carry no LP token at all. Those rounds ran before the
-- test; they are not a third page and not a zero.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function fo_landing_page(p_campaign text)
returns text
language sql
immutable
as $$
  -- LP1GHL, LP1GHLHenry, LP1GHL(0826_02), LP1GHL_AcqOS, LP1 — the token is the
  -- only thing every spelling shares. A bare "LP" is not a page: see the note.
  select case
    when p_campaign is null then null
    when upper(p_campaign) ~ 'LP\s*1' then 'LP1'
    when upper(p_campaign) ~ 'LP\s*2' then 'LP2'
  end;
$$;

grant execute on function fo_landing_page(text) to anon, authenticated;

-- ── BY LANDING PAGE, EVERY ROUND ───────────────────────────────────────────
create or replace view v_metrics_by_lp as
with ads as (
  select client_id, fo_landing_page(campaign) as lp,
         sum(spend) as spend, sum(impressions) as impressions,
         sum(clicks) as clicks, count(*) as ad_rows
  from v_ads where fo_landing_page(campaign) is not null
  group by 1, 2
),
-- the page that acquired each person: their earliest lead carrying one
lead_lp as (
  select distinct on (client_id, contact_id) client_id, contact_id,
         fo_landing_page(utm_campaign) as lp
  from v_events
  where event_type = 'lead' and contact_id is not null
    and fo_landing_page(utm_campaign) is not null
  order by client_id, contact_id, event_date
),
ev_leads as (
  select client_id, fo_landing_page(utm_campaign) as lp, count(*) as leads
  from v_events
  where event_type = 'lead' and fo_landing_page(utm_campaign) is not null
  group by 1, 2
),
ev_after as (
  select l.client_id, l.lp,
    count(*) filter (where e.event_type = 'attendance') as attendance,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buy,
    count(*) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_rev,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'preview' and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'middle'  and e.attribution_bucket in ('Paid Ads','Previous Paid Ads')) as paid_mid_rev
  from v_events e
  join lead_lp l on l.client_id = e.client_id and l.contact_id = e.contact_id
  where e.event_type <> 'lead'
  group by 1, 2
),
cells as (
  select client_id, lp from ads
  union select client_id, lp from ev_leads
)
select
  c.client_id,
  c.lp        as cut_key,
  c.lp        as cut_label,
  null::text  as cut_sub,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend,
      -- 0016: reach is deduplicated people and is only true at the level it was
      -- queried. A page's campaigns cannot be added.
      null::bigint,
      a.impressions, a.clicks,
      coalesce(l.leads, 0), coalesce(v.attendance, 0),
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
  row_number() over (partition by c.client_id order by c.lp)::int as ord
from cells c
left join ads      a on a.client_id = c.client_id and a.lp = c.lp
left join ev_leads l on l.client_id = c.client_id and l.lp = c.lp
left join ev_after v on v.client_id = c.client_id and v.lp = c.lp
left join v_sales_seen   s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, ord;

grant select on v_metrics_by_lp to anon, authenticated;

-- ── ONE LANDING PAGE, ROUND BY ROUND ───────────────────────────────────────
create or replace view v_metrics_by_lp_round as
with ads as (
  select client_id, round_id, fo_landing_page(campaign) as lp,
         sum(spend) as spend, sum(impressions) as impressions,
         sum(clicks) as clicks, count(*) as ad_rows
  from v_ads where fo_landing_page(campaign) is not null
  group by 1, 2, 3
),
lead_lp as (
  select distinct on (client_id, contact_id, round_id)
         client_id, contact_id, round_id, fo_landing_page(utm_campaign) as lp
  from v_events
  where event_type = 'lead' and contact_id is not null
    and fo_landing_page(utm_campaign) is not null
  order by client_id, contact_id, round_id, event_date
),
ev_leads as (
  select client_id, round_id, fo_landing_page(utm_campaign) as lp, count(*) as leads
  from v_events
  where event_type = 'lead' and fo_landing_page(utm_campaign) is not null
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
  c.lp || '·' || c.round_id        as cut_key,
  c.round_id                       as cut_label,
  to_char(r.start_date, 'Mon DD')  as cut_sub,
  c.lp                             as group_key,
  c.lp                             as group_label,
  null::text                       as group_sub,
  r.start_date,
  fo_paid_returns(
    fo_metrics(
      coalesce(a.ad_rows, 0) > 0,
      a.spend, null::bigint, a.impressions, a.clicks,
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
  row_number() over (partition by c.client_id, c.lp order by r.start_date)::int as ord
from cells c
join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join ads      a on a.client_id = c.client_id and a.round_id = c.round_id and a.lp = c.lp
left join ev_leads l on l.client_id = c.client_id and l.round_id = c.round_id and l.lp = c.lp
left join ev_att   t on t.client_id = c.client_id and t.round_id = c.round_id and t.lp = c.lp
left join ev_sale  v on v.client_id = c.client_id and v.round_id = c.round_id and v.lp = c.lp
left join v_sales_seen   s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, group_key, start_date;

grant select on v_metrics_by_lp_round to anon, authenticated;

-- ── fo_cut learns the landing-page cuts ────────────────────────────────────

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
