-- ═══════════════════════════════════════════════════════════════════════════
-- REACH IS DEDUPLICATED PEOPLE, SO IT IS TAKEN FROM THE COARSEST ROW AVAILABLE
-- RATHER THAN ADDED UP.
--
-- Every other number in ads_performance is additive. Reach is not: it counts
-- distinct people, and the same person is reached by more than one ad set. The
-- May export proves the size of it —
--
--     DF_SG_Preview_Sprint1_0526_02   its six ad sets sum to  20,665
--                                     the campaign's own row   11,380
--
-- — so adding the ad-set rows overstates by 82%, and drags Frequency with it.
--
-- Until now the app avoided this by simply not having per-ad-set reach: the
-- daily export could not give a usable one, so reach entered on two hand-built
-- rows carrying the round totals and every audience showed a dash. The
-- period-level export changes that. Each ad set now has a real, deduplicated
-- reach for its own audience — 4,083 for Cold_Broad in 0526-02 — which is worth
-- having, and which must not be summed.
--
-- The rule, applied wherever rounds are rolled up:
--
--     A row that names no ad set is a COARSER measurement — a campaign or
--     account line. Where such rows exist they are the reach, because they are
--     already deduplicated across everything below them. Only when none exists
--     does the app fall back to adding the ad-set rows, and that sum is an
--     over-count it has no way to avoid.
--
-- Impressions, clicks and spend keep summing, because they are counts of events
-- rather than of people and adding them is correct.
--
-- Note this does NOT make a round's reach right when two campaigns ran in it —
-- 0526-03's two campaigns report 7,902 and 4,863 and the true figure is 10,131,
-- because the same person saw both. No per-campaign export can produce that; it
-- takes a query at the level you want the answer for. That is what the ads
-- file's round-level correction rows are, and why they still exist.
--
-- Requires 0015. Replaces four views; no table is touched.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- BY ROUND
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_round as
with ads as (
  select client_id, round_id,
         sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, round_id
),
ev as (
  select client_id, round_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance
  from v_events group by client_id, round_id
),
sales as (
  select client_id, lead_round_id as round_id,
         count(*) filter (where product = 'preview')                     as prev_buy,
         count(*) filter (where product = 'middle')                      as mid_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview') as prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle')  as mid_rev
  from v_events where event_type = 'sale' and lead_round_id is not null
  group by client_id, lead_round_id
)
select
  r.client_id,
  r.round_id                                  as cut_key,
  r.round_id                                  as cut_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as cut_sub,
  r.start_date,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from rounds r
left join ads   on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev    on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales on sales.client_id = r.client_id and sales.round_id = r.round_id
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, r.start_date;

grant select on v_metrics_by_round to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- CLIENT TOTAL
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_total as
with ads as (
  select client_id, sum(spend) as spend,
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads group by client_id
),
ev as (
  select client_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance,
         count(*) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
         count(*) filter (where event_type = 'sale' and product = 'middle')  as mid_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'preview') as prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle')  as mid_rev
  from v_events group by client_id
)
select
  c.client_id,
  'TOTAL'::text as cut_key,
  'Total'::text as cut_label,
  'all rounds'::text as cut_sub,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    case when s.client_id is not null then coalesce(ev.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(ev.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from v_clients c
left join ads on ads.client_id = c.client_id
left join ev  on ev.client_id  = c.client_id
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

grant select on v_metrics_total to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- BY MONTH
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_month as
with months as (
  select client_id, date_trunc('month', start_date)::date as month_start,
         count(*)::int as round_count
  from rounds group by 1, 2
),
ads as (
  select r.client_id, date_trunc('month', r.start_date)::date as month_start,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a join rounds r on r.round_id = a.round_id group by 1, 2
),
ev as (
  select r.client_id, date_trunc('month', r.start_date)::date as month_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join rounds r on r.round_id = e.round_id group by 1, 2
),
sales as (
  select r.client_id, date_trunc('month', r.start_date)::date as month_start,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev
  from v_events e join rounds r on r.round_id = e.lead_round_id
  where e.event_type = 'sale' and e.lead_round_id is not null
  group by 1, 2
)
select
  m.client_id,
  to_char(m.month_start, 'YYYY-MM')  as cut_key,
  to_char(m.month_start, 'Mon YYYY') as cut_label,
  m.round_count || ' round' || case when m.round_count = 1 then '' else 's' end as cut_sub,
  m.month_start,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from months m
left join ads   on ads.client_id   = m.client_id and ads.month_start   = m.month_start
left join ev    on ev.client_id    = m.client_id and ev.month_start    = m.month_start
left join sales on sales.client_id = m.client_id and sales.month_start = m.month_start
left join v_sales_seen s    on s.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id
order by m.client_id, m.month_start;

grant select on v_metrics_by_month to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- ATTEND CLASS
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_session as
with labels as (
  select client_id, coalesce(nullif(btrim(session_label), ''), '(unlabelled)') as label,
         count(*)::int as round_count, min(start_date) as first_start
  from rounds group by 1, 2
),
ads as (
  select r.client_id, coalesce(nullif(btrim(r.session_label), ''), '(unlabelled)') as label,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a join rounds r on r.round_id = a.round_id group by 1, 2
),
ev as (
  select r.client_id, coalesce(nullif(btrim(r.session_label), ''), '(unlabelled)') as label,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join rounds r on r.round_id = e.round_id group by 1, 2
),
sales as (
  select r.client_id, coalesce(nullif(btrim(r.session_label), ''), '(unlabelled)') as label,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev
  from v_events e join rounds r on r.round_id = e.lead_round_id
  where e.event_type = 'sale' and e.lead_round_id is not null
  group by 1, 2
)
select
  l.client_id,
  l.label as cut_key,
  l.label as cut_label,
  l.round_count || ' round' || case when l.round_count = 1 then '' else 's' end as cut_sub,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
    p.preview_price, p.middle_price
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

-- ═══════════════════════════════════════════════════════════════════════════
-- AND ZERO SPEND IN THE UNSPLIT BUCKET IS NOT FREE LEADS.
--
-- The bucket that means "we cannot say which audience" now collects the
-- round-level reach rows, which carry no spend of their own. sum() of nothing
-- but zeroes is 0, so the column read
--
--     Unsplit spend    spend 0.00    leads 9    CPL 0.00
--
-- and CPL 0.00 says those nine leads were free. They were not; nobody knows
-- what they cost, which is the entire reason they are in this bucket.
--
-- Exactly-zero spend here becomes NULL, and CPL, CPA and ROAS blank themselves
-- with it. Real unsplit spend — a campaign exported without an ad-set
-- breakdown — is a positive number and still shows, which is the case this
-- column was built for. Same rule as 0013, applied to the one metric it left.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_metrics_by_adset as
with ads as (
  select client_id, nullif(btrim(ad_set), '') as ad_set,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, nullif(btrim(ad_set), '')
),
-- The audience that ACQUIRED each person: the earliest lead of theirs carrying
-- one. Paid leads with no audience resolve to the unsplit bucket rather than to
-- nothing, so their attendance and purchases stay attached to paid money.
lead_audience as (
  select distinct on (client_id, contact_id)
         client_id, contact_id,
         coalesce(nullif(btrim(ad_set), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad_set
  from v_events
  where event_type = 'lead'
    and contact_id is not null
    and (nullif(btrim(ad_set), '') is not null or source = 'Paid Ads')
  order by client_id, contact_id, event_date
),
-- A LEAD counts on its OWN audience, not on the acquiring lead's. The two
-- differ for anyone who opted in twice, and routing those through the first
-- audience inflates the lead total — that second opt-in really did come from
-- the second ad set. It is the events with no tag of their own that need the
-- detour.
ev_leads as (
  select client_id,
         coalesce(nullif(btrim(ad_set), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad_set,
         count(*) as leads
  from v_events
  where event_type = 'lead'
    and (nullif(btrim(ad_set), '') is not null or source = 'Paid Ads')
  group by 1, 2
),
ev_after as (
  select
    la.client_id, la.ad_set,
    count(*) filter (where e.event_type = 'attendance') as attendance,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buy,
    count(*) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_rev
  from v_events e
  join lead_audience la
    on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type <> 'lead'
  group by la.client_id, la.ad_set
),
ev as (
  select
    coalesce(l.client_id, a.client_id) as client_id,
    coalesce(l.ad_set, a.ad_set)       as ad_set,
    l.leads, a.attendance, a.prev_buy, a.mid_buy, a.prev_rev, a.mid_rev
  from ev_leads l
  full join ev_after a on a.client_id = l.client_id and a.ad_set = l.ad_set
),
cut as (
  select
    coalesce(ads.client_id, ev.client_id) as client_id,
    case when ads.ad_set is null and ev.ad_set is null then '(unsplit)'
         else coalesce(ads.ad_set, ev.ad_set) end as ad_set,
    ads.spend, ads.reach, ads.impressions, ads.clicks, ads.ad_rows,
    ev.leads, ev.attendance, ev.prev_buy, ev.mid_buy, ev.prev_rev, ev.mid_rev
  from ads
  full join ev on ev.client_id = ads.client_id and ev.ad_set = ads.ad_set
),
rolled as (
  select client_id, ad_set,
         sum(spend)::numeric      as spend,
         sum(reach)::bigint       as reach,
         sum(impressions)::bigint as impressions,
         sum(clicks)::bigint      as clicks,
         sum(ad_rows)::bigint     as ad_rows,
         sum(leads)::bigint       as leads,
         sum(attendance)::bigint  as attendance,
         sum(prev_buy)::bigint    as prev_buy,
         sum(mid_buy)::bigint     as mid_buy,
         sum(prev_rev)::numeric   as prev_rev,
         sum(mid_rev)::numeric    as mid_rev
  from cut group by client_id, ad_set
)
select
  r.client_id,
  r.ad_set                                                  as cut_key,
  case when r.ad_set = '(unsplit)' then 'Unsplit spend' else r.ad_set end as cut_label,
  case when r.ad_set = '(unsplit)'
       then 'paid, no ad set recorded' end                  as cut_sub,
  fo_metrics(
    coalesce(r.ad_rows, 0) > 0,
    -- 0 here means "no spend was recorded against unknown audiences", not
    -- "those leads cost nothing" — see the note above.
    case when r.ad_set = '(unsplit)' then nullif(r.spend, 0) else r.spend end,
    -- Delivery has no subject in the bucket that means "audience unknown".
    -- Passing NULL blanks reach, impressions, clicks and — because SQL
    -- arithmetic propagates NULL — Frequency, CTR, Lead Gen %, CPM and CPC
    -- along with them, without any of those needing to be special-cased.
    case when r.ad_set <> '(unsplit)' then r.reach       end,
    case when r.ad_set <> '(unsplit)' then r.impressions end,
    case when r.ad_set <> '(unsplit)' then r.clicks      end,
    coalesce(r.leads, 0), coalesce(r.attendance, 0),
    case when s.client_id is not null then coalesce(r.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(r.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(r.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(r.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m,
  case when r.ad_set = '(unsplit)' then -1 else coalesce(r.spend, 0) end as sort_spend,
  row_number() over (
    partition by r.client_id
    order by
      case when r.ad_set = '(unsplit)' then 1 else 0 end,
      coalesce(r.spend, 0) desc,
      coalesce(r.leads, 0) desc,
      r.ad_set
  )::int                                                    as ord
from rolled r
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by 1, ord;

grant select on v_metrics_by_adset to anon, authenticated;
