-- ═══════════════════════════════════════════════════════════════════════════
-- 0056 — the arm of a test somebody actually ran.
--
-- Shely's Registration Lists have carried a "WA Sequence" column since 0726-02:
-- every registrant tagged "WA Sequence A" or "WA Sequence B", four rounds, 357
-- people. The app never read it, so the answer to "which reminder sequence gets
-- people to show up" sat in a spreadsheet column nobody could plot.
--
-- (It is 27.4% against 27.0%, and the winner flips between rounds. Knowing that
-- is worth more than the test was — and it took reading the column to find out.)
--
-- ── WHY IT IS ITS OWN DIMENSION AND NOT A SOURCE ──────────────────────────
-- source answers "where did this person come from". A variant answers "which
-- version were they given once they were here". A person has both at once, and
-- collapsing them would make every organic lead in sequence A indistinguishable
-- from a paid lead in sequence B.
--
-- Deliberately generic. Today it holds a WhatsApp reminder sequence; the same
-- column holds an email sequence, a landing page, a subject line, a price test.
-- Whatever the export names, the app compares — no migration per experiment.
--
-- ── SPEND IS BLANK HERE, ON PURPOSE ───────────────────────────────────────
-- A reminder sequence does not buy traffic. The ads were bought before anyone
-- was sorted into an arm, and apportioning spend across arms would invent a
-- cost per lead that nobody paid. So the money columns are null and the screen
-- says why: this dimension is about what happened to people already here.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table events add column if not exists variant text;

comment on column events.variant is
  'The arm of a test this person was in — "WA Sequence A", "LP2", whatever the '
  'export names. Read from leads and attendance; never inferred. Null means the '
  'export did not say, which is not the same as a control group.';

create index if not exists idx_events_variant
  on events (round_id, variant)
  where variant is not null;

-- v_events has to carry it, because every metric view reads facts through that
-- view and not through the table. Appended LAST — create or replace may add a
-- column but never insert or reorder one, and doing so silently shifts every
-- column in whatever reads it.
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
  e.variant
from events e
join rounds r on r.round_id = e.round_id
where fo_filter_people_ok(r.product_id, r.start_date, r.end_date);

grant select on v_events to anon, authenticated;

-- ── THE VARIANT, ACROSS EVERY ROUND ────────────────────────────────────────
create or replace view v_metrics_by_variant as
with lead_variant as (
  -- the arm they were put in when they arrived; their earliest lead carrying one
  select distinct on (client_id, contact_id) client_id, contact_id, variant
  from v_events
  where event_type = 'lead' and contact_id is not null
    and nullif(btrim(variant), '') is not null
  order by client_id, contact_id, event_date
),
ev_leads as (
  select client_id, nullif(btrim(variant), '') as variant, count(*) as leads
  from v_events
  where event_type = 'lead' and nullif(btrim(variant), '') is not null
  group by 1, 2
),
ev_after as (
  select lv.client_id, lv.variant,
    count(*) filter (where e.event_type = 'attendance') as attendance,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buy,
    count(*) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_rev
  from v_events e
  join lead_variant lv on lv.client_id = e.client_id and lv.contact_id = e.contact_id
  where e.event_type <> 'lead'
  group by 1, 2
)
select
  l.client_id,
  l.variant                                   as cut_key,
  l.variant                                   as cut_label,
  null::text                                  as cut_sub,
  fo_metrics(
    false,                       -- no ads row belongs to an arm
    null::numeric,               -- and so no spend, reach, delivery or clicks
    null::bigint, null::bigint, null::bigint,
    coalesce(l.leads, 0), coalesce(a.attendance, 0),
    case when s.client_id is not null then coalesce(a.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(a.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(a.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(a.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m,
  row_number() over (partition by l.client_id order by l.variant)::int as ord
from ev_leads l
left join ev_after a on a.client_id = l.client_id and a.variant = l.variant
left join v_sales_seen   s on s.client_id = l.client_id
left join v_client_prices p on p.client_id = l.client_id
order by 1, ord;

grant select on v_metrics_by_variant to anon, authenticated;

-- ── ONE VARIANT, ROUND BY ROUND ────────────────────────────────────────────
-- The same drill-down the asset tabs have: the arm is the group, the round is
-- the cut. It is where the interesting part of Shely's test lives — A wins
-- three rounds and B wins the fourth by the largest margin of the four, which
-- is what a test measuring nothing looks like, and no combined figure shows it.
create or replace view v_metrics_by_variant_round as
with lead_variant as (
  select distinct on (client_id, contact_id) client_id, contact_id, variant
  from v_events
  where event_type = 'lead' and contact_id is not null
    and nullif(btrim(variant), '') is not null
  order by client_id, contact_id, event_date
),
ev_leads as (
  select client_id, round_id, nullif(btrim(variant), '') as variant, count(*) as leads
  from v_events
  where event_type = 'lead' and nullif(btrim(variant), '') is not null
  group by 1, 2, 3
),
ev_att as (
  select e.client_id, e.round_id, lv.variant, count(*) as attendance
  from v_events e
  join lead_variant lv on lv.client_id = e.client_id and lv.contact_id = e.contact_id
  where e.event_type = 'attendance'
  group by 1, 2, 3
),
ev_sale as (
  select e.client_id, coalesce(e.lead_round_id, e.round_id) as round_id, lv.variant,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev
  from v_events e
  join lead_variant lv on lv.client_id = e.client_id and lv.contact_id = e.contact_id
  where e.event_type = 'sale'
  group by 1, 2, 3
),
cells as (
  select client_id, round_id, variant from ev_leads
  union select client_id, round_id, variant from ev_att
  union select client_id, round_id, variant from ev_sale
)
select
  c.client_id,
  c.variant || '·' || c.round_id      as cut_key,
  c.round_id                          as cut_label,
  to_char(r.start_date, 'Mon DD')     as cut_sub,
  c.variant                           as group_key,
  c.variant                           as group_label,
  null::text                          as group_sub,
  r.start_date,
  fo_metrics(
    false, null::numeric, null::bigint, null::bigint, null::bigint,
    coalesce(l.leads, 0), coalesce(t.attendance, 0),
    case when s.client_id is not null then coalesce(v.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(v.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m,
  row_number() over (partition by c.client_id, c.variant order by r.start_date)::int as ord
from cells c
join v_rounds r on r.client_id = c.client_id and r.round_id = c.round_id
left join ev_leads l on l.client_id = c.client_id and l.round_id = c.round_id and l.variant = c.variant
left join ev_att   t on t.client_id = c.client_id and t.round_id = c.round_id and t.variant = c.variant
left join ev_sale  v on v.client_id = c.client_id and v.round_id = c.round_id and v.variant = c.variant
left join v_sales_seen   s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id
order by 1, group_key, start_date;

grant select on v_metrics_by_variant_round to anon, authenticated;

-- ── fo_cut learns the variant cuts ─────────────────────────────────────────
-- Reproduced whole; a plpgsql body cannot be edited in place. Only the
-- whitelist changed.

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
