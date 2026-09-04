-- ═══════════════════════════════════════════════════════════════════════════
-- 0057 — an arm belongs to the round its test was run in.
--
-- 0056 read each person's variant once — their earliest lead carrying one — and
-- then attached everything they ever did to it. So somebody put into WA
-- Sequence A for 0726-02 had their attendance at May's class counted as a
-- result of a test that had not been written yet:
--
--     WA Sequence A · 0526-02    0 leads    1 attendance    0.0% show
--
-- Eight rows like that, and they moved the headline: A read 31.8% against a
-- true 27.4%, B 33.7% against 27.0%. Both arms flattered, the gap distorted,
-- and the giveaway was a show rate computed over no leads at all.
--
-- The variant is now keyed on (person, ROUND). Somebody who registers for three
-- rounds and is only in an arm for one is in that arm for that round and in
-- nothing for the other two. Which is what the test actually did.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_metrics_by_variant as
with lead_variant as (
  -- the arm they were put in FOR THAT ROUND, not for all time
  select distinct on (client_id, contact_id, round_id)
         client_id, contact_id, round_id, nullif(btrim(variant), '') as variant
  from v_events
  where event_type = 'lead' and contact_id is not null
    and nullif(btrim(variant), '') is not null
  order by client_id, contact_id, round_id, event_date
),
ev_leads as (
  select client_id, nullif(btrim(variant), '') as variant, count(*) as leads
  from v_events
  where event_type = 'lead' and nullif(btrim(variant), '') is not null
  group by 1, 2
),
ev_att as (
  select lv.client_id, lv.variant, count(*) as attendance
  from v_events e
  join lead_variant lv
    on lv.client_id = e.client_id and lv.contact_id = e.contact_id
   and lv.round_id  = e.round_id
  where e.event_type = 'attendance'
  group by 1, 2
),
ev_sale as (
  select lv.client_id, lv.variant,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev
  from v_events e
  join lead_variant lv
    on lv.client_id = e.client_id and lv.contact_id = e.contact_id
   and lv.round_id  = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2
)
select
  l.client_id,
  l.variant   as cut_key,
  l.variant   as cut_label,
  null::text  as cut_sub,
  fo_metrics(
    false, null::numeric, null::bigint, null::bigint, null::bigint,
    coalesce(l.leads, 0), coalesce(a.attendance, 0),
    case when s.client_id is not null then coalesce(v.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(v.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(v.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(v.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m,
  row_number() over (partition by l.client_id order by l.variant)::int as ord
from ev_leads l
left join ev_att  a on a.client_id = l.client_id and a.variant = l.variant
left join ev_sale v on v.client_id = l.client_id and v.variant = l.variant
left join v_sales_seen   s on s.client_id = l.client_id
left join v_client_prices p on p.client_id = l.client_id
order by 1, ord;

grant select on v_metrics_by_variant to anon, authenticated;

create or replace view v_metrics_by_variant_round as
with lead_variant as (
  select distinct on (client_id, contact_id, round_id)
         client_id, contact_id, round_id, nullif(btrim(variant), '') as variant
  from v_events
  where event_type = 'lead' and contact_id is not null
    and nullif(btrim(variant), '') is not null
  order by client_id, contact_id, round_id, event_date
),
ev_leads as (
  select client_id, round_id, nullif(btrim(variant), '') as variant, count(*) as leads
  from v_events
  where event_type = 'lead' and nullif(btrim(variant), '') is not null
  group by 1, 2, 3
),
ev_att as (
  select lv.client_id, lv.round_id, lv.variant, count(*) as attendance
  from v_events e
  join lead_variant lv
    on lv.client_id = e.client_id and lv.contact_id = e.contact_id
   and lv.round_id  = e.round_id
  where e.event_type = 'attendance'
  group by 1, 2, 3
),
ev_sale as (
  select lv.client_id, lv.round_id, lv.variant,
    count(*) filter (where e.product = 'preview') as prev_buy,
    count(*) filter (where e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev
  from v_events e
  join lead_variant lv
    on lv.client_id = e.client_id and lv.contact_id = e.contact_id
   and lv.round_id  = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2, 3
),
-- Only rounds the test was actually run in. A round with no leads in an arm is
-- not a zero for that arm, it is a round the arm did not exist in — and a show
-- rate over no leads is what gave the first version away.
cells as (
  select client_id, round_id, variant from ev_leads
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

commit;
