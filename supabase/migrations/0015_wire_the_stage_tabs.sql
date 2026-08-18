-- ═══════════════════════════════════════════════════════════════════════════
-- THE JOURNEY-STAGE TABS, WIRED TO THE CUTS THE JOURNEY CONFIG ALREADY NAMES.
--
-- client_journey_config has carried a compare_dimension for every stage since
-- Sprint 2. Five of them had no view behind them, so the tabs said "not wired
-- yet" while the database already knew what they were supposed to cut by:
--
--     ads       ads_performance.ad        the creative
--     lp        (none)                    <- still nothing to cut by
--     class     rounds.session_label      Class A vs Class B
--     preview   events.round_id           rounds, preview offer only
--     middle    events.round_id           rounds, middle offer only
--
-- Landing page stays unwired, and deliberately. Its compare_dimension is null —
-- no dimension has been decided and no column exists to hold one. Guessing it
-- would put a number on screen that nobody chose.
--
-- Plus "This round", which is not a journey stage: the newest round that has
-- started, next to the one before it.
--
-- Every view here builds its columns with the same fo_metrics call as By round,
-- so a metric cannot mean one thing on one tab and something else on another,
-- and none of them touch a table. Requires 0013.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- ADS — the creative, not the audience.
--
-- Same bridge as Targeted views, one level down: events.ad against
-- ads_performance.ad. The people half is real — 18 creatives arrive on leads
-- from GoHighLevel's utm_content. The money half is empty, because the Meta
-- export we have is at ad-set level and its ad column is null on all 62 rows,
-- so every dollar lands in Unsplit spend until an ad-level export exists.
--
-- That is worth showing rather than hiding. "Which creative produced the most
-- leads" is answerable today; "what did it cost" is not, and a dash says so.
--
-- 17 leads carry a numeric Ad ID instead of a name, because a second tracking
-- template passes utm_content={{ad.id}}. They get their own columns rather than
-- being merged or dropped — an ID is a better join key than a name, and this is
-- where they resolve when ad-level spend arrives.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_ad as
with ads as (
  select client_id, nullif(btrim(ad), '') as ad,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, nullif(btrim(ad), '')
),
-- the creative that ACQUIRED each person: their earliest lead carrying one
lead_ad as (
  select distinct on (client_id, contact_id)
         client_id, contact_id,
         coalesce(nullif(btrim(ad), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad
  from v_events
  where event_type = 'lead' and contact_id is not null
    and (nullif(btrim(ad), '') is not null or source = 'Paid Ads')
  order by client_id, contact_id, event_date
),
-- a lead counts on its OWN creative; only later events need the detour
ev_leads as (
  select client_id,
         coalesce(nullif(btrim(ad), ''),
                  case when source = 'Paid Ads' then '(unsplit)' end) as ad,
         count(*) as leads
  from v_events
  where event_type = 'lead'
    and (nullif(btrim(ad), '') is not null or source = 'Paid Ads')
  group by 1, 2
),
ev_after as (
  select la.client_id, la.ad,
    count(*) filter (where e.event_type = 'attendance') as attendance,
    count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buy,
    count(*) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_buy,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_rev,
    sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.event_type = 'sale' and e.product = 'middle')  as mid_rev
  from v_events e
  join lead_ad la on la.client_id = e.client_id and la.contact_id = e.contact_id
  where e.event_type <> 'lead'
  group by la.client_id, la.ad
),
ev as (
  select coalesce(l.client_id, a.client_id) as client_id,
         coalesce(l.ad, a.ad)               as ad,
         l.leads, a.attendance, a.prev_buy, a.mid_buy, a.prev_rev, a.mid_rev
  from ev_leads l
  full join ev_after a on a.client_id = l.client_id and a.ad = l.ad
),
cut as (
  select coalesce(ads.client_id, ev.client_id) as client_id,
         case when ads.ad is null and ev.ad is null then '(unsplit)'
              else coalesce(ads.ad, ev.ad) end as ad,
         ads.spend, ads.reach, ads.impressions, ads.clicks, ads.ad_rows,
         ev.leads, ev.attendance, ev.prev_buy, ev.mid_buy, ev.prev_rev, ev.mid_rev
  from ads full join ev on ev.client_id = ads.client_id and ev.ad = ads.ad
),
rolled as (
  select client_id, ad,
         sum(spend)::numeric as spend, sum(reach)::bigint as reach,
         sum(impressions)::bigint as impressions, sum(clicks)::bigint as clicks,
         sum(ad_rows)::bigint as ad_rows, sum(leads)::bigint as leads,
         sum(attendance)::bigint as attendance, sum(prev_buy)::bigint as prev_buy,
         sum(mid_buy)::bigint as mid_buy, sum(prev_rev)::numeric as prev_rev,
         sum(mid_rev)::numeric as mid_rev
  from cut group by client_id, ad
)
select
  r.client_id,
  r.ad                                                        as cut_key,
  case when r.ad = '(unsplit)' then 'Unsplit spend' else r.ad end as cut_label,
  case when r.ad = '(unsplit)' then 'paid, no ad recorded'
       when r.ad ~ '^[0-9]+$' then 'Ad ID, no name in the export' end as cut_sub,
  fo_metrics(
    coalesce(r.ad_rows, 0) > 0,
    r.spend,
    -- same rule as 0013: delivery has no subject in the unattributable bucket
    case when r.ad <> '(unsplit)' then r.reach       end,
    case when r.ad <> '(unsplit)' then r.impressions end,
    case when r.ad <> '(unsplit)' then r.clicks      end,
    coalesce(r.leads, 0), coalesce(r.attendance, 0),
    case when s.client_id is not null then coalesce(r.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(r.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(r.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(r.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m,
  row_number() over (
    partition by r.client_id
    order by case when r.ad = '(unsplit)' then 1 else 0 end,
             coalesce(r.leads, 0) desc, coalesce(r.spend, 0) desc, r.ad
  )::int as ord
from rolled r
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by 1, ord;

grant select on v_metrics_by_ad to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- ATTEND CLASS — rounds grouped by session_label, Class A against Class B.
--
-- Spend is kept, not blanked. A class variant does not buy traffic itself, but
-- the rounds that ran it did, and cost per attendee by class is the entire
-- reason this comparison is worth having: the old sheet protected the class
-- format and could not see what it cost. Reach is summed across the label's
-- rounds and double-counts anyone in both, exactly as it does on By month and
-- in every Total column — Meta only reports reach per query.
--
-- Both of Shely's May rounds are Class A, so this renders one column today and
-- splits the moment a Class B round is imported. One column is the true answer,
-- not a broken one.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_session as
with labels as (
  select client_id, coalesce(nullif(btrim(session_label), ''), '(unlabelled)') as label,
         count(*)::int as round_count, min(start_date) as first_start
  from rounds group by 1, 2
),
ads as (
  select r.client_id, coalesce(nullif(btrim(r.session_label), ''), '(unlabelled)') as label,
         sum(a.spend) as spend, sum(a.reach) as reach,
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
  l.label                                                     as cut_key,
  l.label                                                     as cut_label,
  l.round_count || ' round' || case when l.round_count = 1 then '' else 's' end as cut_sub,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
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
-- PREVIEW OFFER and MIDDLE OFFER — rounds across, one offer at a time.
--
-- Same columns as By round. The difference is which offer's rows are filled:
-- on Preview the middle rows are NULL and on Middle the preview rows are, so
-- the take-up and ROAS lines read for the offer the tab is named after and
-- nothing else competes for attention.
--
-- NULL and not zero, deliberately. A round with no middle purchases and a round
-- whose middle numbers are simply not this tab's subject are different things,
-- and only one of them is a measurement. Both tabs' totals still agree with By
-- round because they are the same rows, filtered rather than recomputed.
--
-- Built as one view with a `product` column so the two tabs cannot drift apart.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_offer as
with offers as (select unnest(array['preview', 'middle']) as product),
ads as (
  select client_id, round_id, sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks, count(*) as ad_rows
  from v_ads group by 1, 2
),
ev as (
  select client_id, round_id,
         count(*) filter (where event_type = 'lead')       as leads,
         count(*) filter (where event_type = 'attendance') as attendance
  from v_events group by 1, 2
),
sales as (
  select client_id, lead_round_id as round_id, product,
         count(*) as buys,
         sum(amount - coalesce(refund_amount, 0)) as rev
  from v_events
  where event_type = 'sale' and lead_round_id is not null and product is not null
  group by 1, 2, 3
)
select
  r.client_id,
  o.product,
  r.round_id                                  as cut_key,
  r.round_id                                  as cut_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as cut_sub,
  r.start_date,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
    coalesce(ev.leads, 0), coalesce(ev.attendance, 0),
    -- only this tab's offer carries numbers; the other is absent, not zero
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.buys, 0) end,
    case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.buys, 0) end,
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.rev,  0) end,
    case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from rounds r
cross join offers o
left join ads on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev  on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales sp on sp.client_id = r.client_id and sp.round_id = r.round_id and sp.product = 'preview'
left join sales sm on sm.client_id = r.client_id and sm.round_id = r.round_id and sm.product = 'middle'
left join v_sales_seen s    on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, o.product, r.start_date;

grant select on v_metrics_by_offer to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- THIS ROUND — the newest round that has started, beside the one before it.
--
-- "While it runs" is the intent, but a tab that empties itself the day a round
-- ends is a tab nobody trusts. The rule is the newest round whose start_date
-- has passed, which IS the live one while a round is running and is the one
-- just finished otherwise — and the previous round alongside it, because a
-- single number with nothing to compare it to is not analysis.
--
-- Rounds that have not started yet are excluded: a scheduled round has no
-- figures, and putting it here would answer "how is it going" with a blank.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_this_round as
select
  client_id, cut_key, cut_label, cut_sub, start_date, m,
  case when rn = 1 then 'this round' else 'previous' end as period,
  rn::int as ord
from (
  select b.*, row_number() over (partition by b.client_id order by b.start_date desc) as rn
  from v_metrics_by_round b
  join rounds r on r.round_id = b.cut_key
  where r.start_date <= current_date
) ranked
where rn <= 2
order by client_id, start_date;

grant select on v_metrics_this_round to anon, authenticated;
