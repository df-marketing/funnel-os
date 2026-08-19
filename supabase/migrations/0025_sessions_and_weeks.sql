-- ═══════════════════════════════════════════════════════════════════════════
-- 0025 — a round holds however many classes it holds, and weeks always exist.
--
-- Two changes that belong together, because they answer the same problem: the
-- class schedule is not predictable. Some months run four rounds, some run
-- none, and a round can run one class or several.
--
-- ── SESSIONS ──────────────────────────────────────────────────────────────
-- rounds.session_date has been a single date since 0001, where the comment
-- said: "1:1 with round today. If a client needs 1:many later, split into a
-- sessions table." A round that runs classes on the 5th and the 7th has nowhere
-- to put the second one, so it is invented here rather than assumed away.
--
-- The old columns are NOT dropped. Every existing row is copied into the new
-- table and the columns stay as they were, so nothing that still reads them
-- breaks mid-migration. They stop being the source of truth, not the truth.
--
-- ── ONE LABEL PER ROUND, OR AN HONEST ADMISSION ───────────────────────────
-- Attend class compares class FORMATS, so the label belongs to the session, not
-- the round. That creates a case that didn't exist before: a round whose
-- sessions carry two different labels. Its attendance is recorded against the
-- round, not the session, so it cannot be split between them.
--
-- Rather than pick one or count it twice, such a round reports '(mixed)'. The
-- number stays right and the screen says why it can't be broken down — the
-- alternative is a Class A column quietly containing Class B's attendees.
--
-- ── WEEKS ─────────────────────────────────────────────────────────────────
-- Rounds only exist when someone runs one; weeks are always there. A week view
-- gives every chart and comparison a spine that doesn't disappear in a quiet
-- month, and it is By month with one word changed — a round belongs to the week
-- it STARTED in, for the same reason it belongs to the month it started in:
-- splitting it would put the spend in one column and the class that spend paid
-- for in the next.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists round_sessions (
  session_id    text primary key,
  round_id      text not null references rounds(round_id) on delete cascade,
  session_date  date not null,
  session_label text,
  ord           int  not null default 1
);

create index if not exists idx_round_sessions_round on round_sessions (round_id);
create index if not exists idx_round_sessions_date  on round_sessions (session_date);

alter table round_sessions enable row level security;
drop policy if exists "demo read" on round_sessions;
create policy "demo read" on round_sessions for select using (true);
grant select on round_sessions to anon, authenticated;

-- Carry every existing class across. A round with no session_date has no class
-- recorded, which is a fact about the data and not a reason to invent one.
insert into round_sessions (session_id, round_id, session_date, session_label, ord)
select r.round_id || '·1', r.round_id, r.session_date, r.session_label, 1
from rounds r
where r.session_date is not null
on conflict (session_id) do nothing;

-- ── WHAT THE APP READS ─────────────────────────────────────────────────────
-- Sessions of rounds that survive the current filter, so a class outside the
-- period disappears with its round.
create or replace view v_round_sessions as
select s.session_id, s.round_id, r.client_id, r.product_id,
       s.session_date, s.session_label, s.ord
from round_sessions s
join v_rounds r on r.round_id = s.round_id;

grant select on v_round_sessions to anon, authenticated;

-- One row per round: its class label, or '(mixed)' when it ran more than one
-- and its attendance cannot be attributed between them.
create or replace view v_round_labels as
select
  s.round_id,
  s.client_id,
  case
    when count(distinct coalesce(nullif(btrim(s.session_label), ''), '(unlabelled)')) = 1
      then max(coalesce(nullif(btrim(s.session_label), ''), '(unlabelled)'))
    else '(mixed)'
  end                                as label,
  count(*)::int                      as session_count,
  min(s.session_date)                as first_session,
  max(s.session_date)                as last_session
from v_round_sessions s
group by s.round_id, s.client_id;

grant select on v_round_labels to anon, authenticated;

create or replace view v_metrics_by_week as
with weeks as (
  select client_id, date_trunc('week', start_date)::date as week_start,
         count(*)::int as round_count
  from v_rounds group by 1, 2
),
ads as (
  select r.client_id, date_trunc('week', r.start_date)::date as week_start,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a join v_rounds r on r.round_id = a.round_id group by 1, 2
),
ev as (
  select r.client_id, date_trunc('week', r.start_date)::date as week_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join v_rounds r on r.round_id = e.round_id group by 1, 2
),
sales as (
  select r.client_id, date_trunc('week', r.start_date)::date as week_start,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events e join v_rounds r on r.round_id = e.lead_round_id
  where e.event_type = 'sale' and e.lead_round_id is not null
  group by 1, 2
)
select
  m.client_id,
  to_char(m.week_start, 'IYYY-"W"IW')       as cut_key,
  to_char(m.week_start, 'DD Mon') || ' – ' || to_char(m.week_start + 6, 'DD Mon') as cut_label,
  m.round_count || ' round' || case when m.round_count = 1 then '' else 's' end as cut_sub,
  m.week_start,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = m.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = m.client_id)
           then coalesce(ev.attendance, 0) end,
      case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
      case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(sales.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_mid_rev,  0) end
  ) as m
from weeks m
left join ads   on ads.client_id   = m.client_id and ads.week_start   = m.week_start
left join ev    on ev.client_id    = m.client_id and ev.week_start    = m.week_start
left join sales on sales.client_id = m.client_id and sales.week_start = m.week_start
left join v_sales_seen s    on s.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id
order by m.client_id, m.week_start;

grant select on v_metrics_by_week to anon, authenticated;
create or replace view v_metrics_by_session as
with labels as (
  -- the label is the SESSION's now, and a round that ran two different formats
  -- reports '(mixed)' rather than being counted under either — see 0025
  select r.client_id, rl.label,
         count(*)::int as round_count, min(r.start_date) as first_start
  from v_rounds r join v_round_labels rl on rl.round_id = r.round_id
  group by 1, 2
),
ads as (
  select r.client_id, rl.label,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a join v_rounds r on r.round_id = a.round_id
       join v_round_labels rl on rl.round_id = r.round_id group by 1, 2
),
ev as (
  select r.client_id, rl.label,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join v_rounds r on r.round_id = e.round_id
       join v_round_labels rl on rl.round_id = r.round_id group by 1, 2
),
sales as (
  select r.client_id, rl.label,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events e join v_rounds r on r.round_id = e.lead_round_id
       join v_round_labels rl on rl.round_id = r.round_id
  where e.event_type = 'sale' and e.lead_round_id is not null
  group by 1, 2
)
select
  l.client_id,
  l.label as cut_key,
  l.label as cut_label,
  l.round_count || ' round' || case when l.round_count = 1 then '' else 's' end as cut_sub,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = l.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = l.client_id)
           then coalesce(ev.attendance, 0) end,
      case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
      case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
      case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
      case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when s.client_id is not null then coalesce(sales.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_mid_rev,  0) end
  ) as m,
  row_number() over (partition by l.client_id order by l.first_start, l.label)::int as ord
from labels l
left join ads   on ads.client_id   = l.client_id and ads.label   = l.label
left join ev    on ev.client_id    = l.client_id and ev.label    = l.label
left join sales on sales.client_id = l.client_id and sales.label = l.label
left join v_sales_seen s    on s.client_id = l.client_id
left join v_client_prices p on p.client_id = l.client_id
order by 1, ord;

grant select on v_metrics_by_session to anon, authenticated;
-- ── fo_cut learns the week ────────────────────────────────────────────────
-- The whitelist is the only thing standing between p_view and dynamic SQL, so
-- a new cut is a new line here rather than a looser check.
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
    when 'v_metrics_by_week'        then 'week_start'
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
