-- ═══════════════════════════════════════════════════════════════════════════
-- A month is a calendar month, not the month a round happened to start in.
--
-- The same fault 0044 fixed in weeks, still sitting in months. Every figure was
-- bucketed by date_trunc('month', ROUND START), so a round running 28 April to
-- 4 May reported all of its May spend, leads, attendance and sales under April.
--
-- It is invisible in today's data — both of Shely's rounds start and end inside
-- May, and Northsea's four weekly rounds sit inside June — which is exactly why
-- it is worth fixing now. It costs nothing today and silently misfiles a whole
-- month the first time a round crosses a month boundary, which is an ordinary
-- thing for a round to do.
--
-- WHY THE ADS RULE IS NOT THE WEEK RULE. 0044 refuses to place an ad row on a
-- week unless its date falls inside its own round, because a period-level Meta
-- export dates the whole window to its first day and that day says nothing
-- about which week the money went out in. A month is a coarser question and the
-- same row often answers it with certainty: Shely's rows are dated 2026-05-01
-- and belong to rounds running 13–19 and 23–27 May. The day is useless; the
-- MONTH is not in doubt. Applying the week rule here would blank May's spend
-- on data that is perfectly capable of answering the question asked.
--
-- So an ad row is placed on a month when either
--   (a) its own date falls inside its round — real day-level data, believe it; or
--   (b) its round begins and ends in the same calendar month — the day cannot
--       matter, because every day of that round is in that month.
--
-- What is left is the genuinely ambiguous case: a round crossing a month
-- boundary whose ads carry no usable day. Nothing can say how that spend split,
-- and both halves of a guess would be wrong. Those months — and only those —
-- report ads as absent. Withheld per month rather than per client, unlike 0044:
-- a month is a reporting unit a client reads on its own, and blanking a year of
-- them because one round in March straddled would be a worse answer than the
-- question deserves.
--
-- People are simpler. Leads, attendance and sales all carry their own instant,
-- so they are bucketed by their own local day — the +8 the importer uses — and
-- need no rule at all.
--
-- VERIFIED NOT TO MOVE ANY EXISTING FIGURE. Every round in this database begins
-- and ends inside one month, so rule (b) reproduces the old bucketing exactly
-- and no frozen period's live counterpart changes.
--
-- ROLLBACK: re-run 0027's v_metrics_by_month. No data is touched.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_metrics_by_month as
with
-- Which month each ad row belongs to, or NULL when nothing can say.
ads_placed as (
  select
    r.client_id,
    case
      when a.date between r.start_date and r.end_date
        then date_trunc('month', a.date)::date
      when date_trunc('month', r.start_date) = date_trunc('month', r.end_date)
        then date_trunc('month', r.start_date)::date
    end as month_start,
    a.spend, a.reach, a.impressions, a.clicks, a.ad_set
  from v_ads a join v_rounds r on r.round_id = a.round_id
),
-- The months a straddling round with undated ads touches. Ads are withheld from
-- these, because the split between them is unknowable and a guess would put real
-- money in a month it was not spent in.
tainted as (
  select distinct r.client_id, gs::date as month_start
  from v_ads a
  join v_rounds r on r.round_id = a.round_id
  cross join lateral generate_series(
    date_trunc('month', r.start_date), date_trunc('month', r.end_date), interval '1 month'
  ) gs
  where not (a.date between r.start_date and r.end_date)
    and date_trunc('month', r.start_date) <> date_trunc('month', r.end_date)
),
ads as (
  select client_id, month_start,
         sum(spend) as spend,
         -- 0016: reach is distinct people and cannot be added; read off the
         -- coarsest row. A month spanning several rounds still over-counts
         -- anyone reached in two of them — REACH_NOTE says so on every response.
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from ads_placed
  where month_start is not null
  group by 1, 2
),
-- The join to v_rounds applies the product and period filter — v_events carries
-- none of its own — while the bucket comes from the event's own instant.
ev as (
  select r.client_id,
         date_trunc('month', (e.event_date at time zone 'Asia/Singapore')::date)::date as month_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join v_rounds r on r.round_id = e.round_id
  group by 1, 2
),
sales as (
  select r.client_id,
         date_trunc('month', (e.event_date at time zone 'Asia/Singapore')::date)::date as month_start,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events e join v_rounds r on r.round_id = e.lead_round_id
  where e.event_type = 'sale' and e.lead_round_id is not null
  group by 1, 2
),
-- A month whose rounds held no class has no attendance to report, as distinct
-- from having had nobody turn up. Bucketed by the session's own date.
cls as (
  select client_id, date_trunc('month', session_date)::date as month_start, count(*) as sessions
  from v_round_sessions
  where session_date is not null
  group by 1, 2
),
-- Every month a round TOUCHES, not the one it starts in — that is the whole
-- point — plus any month carrying data of its own.
round_months as (
  select r.client_id, gs::date as month_start, r.round_id
  from v_rounds r
  cross join lateral generate_series(
    date_trunc('month', r.start_date), date_trunc('month', r.end_date), interval '1 month'
  ) gs
),
months as (
  select client_id, month_start from round_months
  union
  select client_id, month_start from ads
  union
  select client_id, month_start from ev
  union
  select client_id, month_start from sales
),
spans as (
  select client_id, month_start, count(distinct round_id)::int as round_count
  from round_months group by 1, 2
)
select
  m.client_id,
  to_char(m.month_start, 'YYYY-MM')  as cut_key,
  to_char(m.month_start, 'Mon YYYY') as cut_label,
  coalesce(sp.round_count, 0) || ' round'
    || case when coalesce(sp.round_count, 0) = 1 then '' else 's' end as cut_sub,
  m.month_start,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = m.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = m.client_id)
            and coalesce(cls.sessions, 0) > 0
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
from months m
left join spans sp on sp.client_id = m.client_id and sp.month_start = m.month_start
-- Ads join is suppressed for a tainted month, which is what makes the ads
-- figures absent there rather than half-counted.
left join ads
       on ads.client_id = m.client_id and ads.month_start = m.month_start
      and not exists (
        select 1 from tainted t
         where t.client_id = m.client_id and t.month_start = m.month_start
      )
left join ev    on ev.client_id    = m.client_id and ev.month_start    = m.month_start
left join sales on sales.client_id = m.client_id and sales.month_start = m.month_start
left join cls   on cls.client_id   = m.client_id and cls.month_start   = m.month_start
left join v_sales_seen s    on s.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id
order by m.client_id, m.month_start;

grant select on v_metrics_by_month to anon, authenticated;
