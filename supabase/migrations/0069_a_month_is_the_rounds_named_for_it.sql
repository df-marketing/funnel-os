-- ═══════════════════════════════════════════════════════════════════════════
-- 0069 — a month is the rounds named for it, whole.
--
-- WHAT WAS WRONG. By month read August as SGD 6,712.82. August had three
-- classes — 0826-01, 0826-02, 0826-03 — and their spend is 4,997.27. The
-- other 1,715.55 is 0926-01's spend dated 28–31 August: a September round
-- whose ads started four days early, filed by 0045 into the calendar month the
-- money went out in. September then read 2,221.13 for a round that spent
-- 3,936.68. The client caught it against his own sheet on 2026-09-07:
--
--     "Aug only had 3 classes ... 28th August onwards' ads were attributed
--      to 27 aug class too for some reason, leading to a SGD 6k ad spent
--      appearance"
--
-- Two definitions of "month" had been living in the app:
--
--   the period filter, By round, This round   the month the round is NAMED for
--                                             (cuts.ts monthOf — 0826-01 is
--                                             August though it opened 31 Jul)
--   By month (0045)                           the calendar month of each ad
--                                             row's date and each event's date
--
-- 0045's reasoning was sound in the abstract — a round running 28 April to
-- 4 May should not put May's spend under April. It is wrong for this
-- business: a round is the unit a class is sold in, the client reads a month
-- as the set of rounds named for it, and a 6.7k August corresponds to no set
-- of classes anyone ran. It also made two other things quietly false: the By
-- month footer's promise that rolling the round columns up gives the month
-- ("from the same rows"), and This round's "this round is inside these
-- figures" — Sep 2,221.13 sat next to 0926-01 3,936.68 on the same screen.
-- And it filed late-May registrants for June rounds into May: 471 leads
-- against the sheet's 415, which are the two May rounds' 412.
--
-- THE RULING. A month is its rounds, whole. Ads, leads, attendance, sales and
-- sessions all take the named month of the round they belong to — the one
-- rule cuts.ts already applies — so By month IS By round rolled up by name.
-- Expected after this: Aug 4,997.27 · Sep 3,936.68 · May leads 412.
--
-- fo_round_month is the SQL port of monthOf: MMYY from the round id, trusted
-- only when it overlaps the round's own dates, else the start month; an id
-- in no known shape (Northsea's NS-W1) falls back to the start month. The
-- four cases the test suite pins for monthOf hold here by construction.
--
-- Sales keep By round's axis — the round whose spend acquired the buyer
-- (coalesce(lead_round_id, round_id)) — so the month total is the sum of the
-- round columns exactly, not a third attribution.
--
-- `tainted` is gone: with every row placed through its round there is no
-- straddling ambiguity left to withhold. Output columns are identical in name,
-- order and type (client_id, cut_key, cut_label, cut_sub, month_start, m), so
-- every caller reads what it read.
--
-- WHO ELSE READS THIS. This round (step 1) and the By month tab, through
-- fo_cut. The integration's month-insight endpoint reads this view for the
-- month's own figures — which is precisely the row that should change — and
-- separately lists the rounds beside it through a calendar window
-- (monthWindow + By round with p_from/p_to); that listing is unchanged, and a
-- round that opens late in the prior month still appears in both lists there,
-- as it did before. Frozen month insights (0041) keep the reading they had —
-- fixing a view does not fix a report, and that is what freezing is for.
--
-- Safe to re-run.
--
-- ROLLBACK: re-run 0045's v_metrics_by_month (ALL.sql, the definition that
-- begins "with -- Which month each ad row belongs to"), then
--   drop function if exists fo_round_month(text, date, date);
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── THE MONTH A ROUND IS NAMED FOR ─────────────────────────────────────────
-- cuts.ts monthOf, in SQL. First day of the month, for grouping.
create or replace function fo_round_month(p_round_id text, p_start date, p_end date)
returns date
language sql
immutable
as $$
  select case
    when y.named is not null
     and y.named between date_trunc('month', p_start)::date
                     and date_trunc('month', p_end)::date
      then y.named
    else date_trunc('month', p_start)::date
  end
  from (
    select case when x.mm between 1 and 12 then make_date(2000 + x.yy, x.mm, 1) end as named
    from (
      select nullif(substring(p_round_id from '^(\d{2})\d{2}-'), '')::int as mm,
             nullif(substring(p_round_id from '^\d{2}(\d{2})-'), '')::int as yy
    ) x
  ) y;
$$;
grant execute on function fo_round_month(text, date, date) to anon, authenticated;

-- ── BY MONTH = BY ROUND, ROLLED UP BY NAME ─────────────────────────────────
create or replace view v_metrics_by_month as
with
-- Every round, and the month it is named for. Everything below hangs off this.
rm as (
  select r.client_id, r.round_id,
         fo_round_month(r.round_id, r.start_date, r.end_date) as month_start
  from v_rounds r
),
ads as (
  select rm.client_id, rm.month_start,
         sum(a.spend) as spend,
         -- 0016: reach is distinct people and cannot be added; read off the
         -- coarsest row. A month spanning several rounds still over-counts
         -- anyone reached in two of them — REACH_NOTE says so on every response.
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join rm on rm.round_id = a.round_id
  group by 1, 2
),
ev as (
  select rm.client_id, rm.month_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e
  join rm on rm.round_id = e.round_id
  group by 1, 2
),
-- By round's axis: the round whose spend acquired the buyer.
sales as (
  select rm.client_id, rm.month_start,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events e
  join rm on rm.round_id = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2
),
-- A month whose rounds held no class has no attendance to report, as distinct
-- from having had nobody turn up. A session belongs to its round's month.
cls as (
  select rm.client_id, rm.month_start, count(*) as sessions
  from v_round_sessions s
  join rm on rm.round_id = s.round_id
  where s.session_date is not null
  group by 1, 2
),
months as (
  select distinct client_id, month_start from rm
),
spans as (
  select client_id, month_start, count(distinct round_id)::int as round_count
  from rm group by 1, 2
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
left join ads   on ads.client_id   = m.client_id and ads.month_start   = m.month_start
left join ev    on ev.client_id    = m.client_id and ev.month_start    = m.month_start
left join sales on sales.client_id = m.client_id and sales.month_start = m.month_start
left join cls   on cls.client_id   = m.client_id and cls.month_start   = m.month_start
left join v_sales_seen s    on s.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id
order by m.client_id, m.month_start;

grant select on v_metrics_by_month to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. The rule, on the two rounds that open early and one that does not:
--      select round_id, start_date, end_date,
--             fo_round_month(round_id, start_date, end_date) as month
--        from rounds where client_id = 'shely' order by start_date;
--    Expect 0826-01 → 2026-08-01, 0926-01 → 2026-09-01, 0526-02 → 2026-05-01.
--
-- 2. By month now equals By round rolled up — the three figures the client
--    checked, plus the sum, which must be the same 20474.78 as before:
--      select r->>'cut_label' as month, (r->'m'->>'spend')::numeric as spend,
--             (r->'m'->>'leads')::int as leads
--        from fo_cut('v_metrics_by_month','shely') as r;
--    Expect  Aug 2026 4997.27 · Sep 2026 3936.68 · May 2026 leads 412
--    and     select sum((r->'m'->>'spend')::numeric) from fo_cut('v_metrics_by_month','shely') as r;  → 20474.78
