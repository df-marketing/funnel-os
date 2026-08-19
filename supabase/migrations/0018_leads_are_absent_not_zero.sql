-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 — two things the screen was stating that nobody had measured.
--
-- ONE. Reach was still being added up in three views.
--
-- 0016 established that reach cannot be summed — it counts deduplicated people,
-- so adding two rows counts anyone in both twice — and taught By round, Total,
-- By month and Attend class to read it off the coarsest row instead. Three
-- views never got the rule: Preview offer, Middle offer (one view), By source
-- and Round × source. They were reading 33,337 for a round whose real reach is
-- 12,672, and 62,279 for a client whose real reach is 22,803.
--
-- The tell was Frequency, which is impressions ÷ reach and therefore cannot be
-- below 1: nobody sees an ad less than once. Those tabs were printing 0.86 and
-- 0.78. An impossible number is the cheapest kind of bug to believe, because it
-- looks like a small one.
--
-- TWO. Leads and attendance read 0 before their file had ever been imported.
--
-- The app already knows the difference between a measurement and an absence,
-- and already applies it to money: revenue reads "—" rather than 0.00 until
-- some sale exists, because "this round earned nothing" is a claim nobody has
-- evidence for. Leads and attendance were exempt from their own rule. With only
-- the ads file imported, every tab showed "Leads 0" and "Lead Gen % 0.00%" —
-- which does not say "no leads file yet", it says the advertising produced
-- nobody. That is the strongest claim on the screen and it was made up.
--
-- v_leads_seen and v_attendance_seen mirror v_sales_seen exactly, keyed on
-- events rather than on import_batches for the same reason given there: a file
-- whose every row parked in Unmatched has been imported and has told us
-- nothing. Once one lead lands, a cut with no leads correctly reads 0 again.
--
-- The journey strip needs no change: it reads v_metrics_total, so its cards go
-- blank and its rates disappear along with the tab they summarise.
-- ═══════════════════════════════════════════════════════════════════════════

-- Has a lead ever landed for this client? Same shape and same reasoning as
-- v_sales_seen in 0008 — see the note there.
create or replace view v_leads_seen as
select distinct client_id from v_events where event_type = 'lead';

grant select on v_leads_seen to anon, authenticated;

-- Has an attendance row ever landed? Gated separately from leads, because the
-- Zoom export can be missing while the CRM export is not.
create or replace view v_attendance_seen as
select distinct client_id from v_events where event_type = 'attendance';

grant select on v_attendance_seen to anon, authenticated;

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
    case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
         then coalesce(ev.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
         then coalesce(ev.attendance, 0) end,
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
    case when exists (select 1 from v_leads_seen z where z.client_id = c.client_id)
         then coalesce(ev.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = c.client_id)
         then coalesce(ev.attendance, 0) end,
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
    case when exists (select 1 from v_leads_seen z where z.client_id = m.client_id)
         then coalesce(ev.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = m.client_id)
         then coalesce(ev.attendance, 0) end,
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
    case when exists (select 1 from v_leads_seen z where z.client_id = l.client_id)
         then coalesce(ev.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = l.client_id)
         then coalesce(ev.attendance, 0) end,
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
    case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
         then coalesce(r.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
         then coalesce(r.attendance, 0) end,
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
    -- the one change: 0.00 in this bucket means "not recorded", not "free"
    case when r.ad = '(unsplit)' then nullif(r.spend, 0) else r.spend end,
    -- same rule as 0013: delivery has no subject in the unattributable bucket
    case when r.ad <> '(unsplit)' then r.reach       end,
    case when r.ad <> '(unsplit)' then r.impressions end,
    case when r.ad <> '(unsplit)' then r.clicks      end,
    case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
         then coalesce(r.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
         then coalesce(r.attendance, 0) end,
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

create or replace view v_metrics_by_offer as
with offers as (select unnest(array['preview', 'middle']) as product),
ads as (
  select client_id, round_id, sum(spend) as spend,
         -- 0016's rule, which this view never got: read reach off the coarsest
         -- row rather than adding the tiers, or a round claims 33,337 people
         -- when 12,672 saw it and Frequency drops below 1.
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
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
    case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
         then coalesce(ev.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
         then coalesce(ev.attendance, 0) end,
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

create or replace view v_metrics_by_source as
with ev as (
  select
    client_id,
    coalesce(attribution_bucket, 'Unattributed') as bucket,
    count(*) filter (where event_type = 'lead')       as leads,
    count(*) filter (where event_type = 'attendance') as attendance,
    count(*) filter (where event_type = 'sale' and product = 'preview') as prev_buy,
    count(*) filter (where event_type = 'sale' and product = 'middle')  as mid_buy,
    sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'preview') as prev_rev,
    sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle')  as mid_rev
  from v_events
  group by client_id, coalesce(attribution_bucket, 'Unattributed')
),
ads as (
  select client_id, sum(spend) as spend,
         -- 0016's rule, which this view never got — see the note in By round.
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id
),
share as (
  select client_id, sum(leads) as all_leads from ev group by client_id
)
select
  ev.client_id,
  ev.bucket                                   as cut_key,
  ev.bucket                                   as cut_label,
  case
    when share.all_leads > 0
      then to_char(round(100.0 * ev.leads / share.all_leads), 'FM999') || '% of leads'
    else coalesce(b.note, 'no leads')
  end                                         as cut_sub,
  coalesce(b.ord, 99)                         as ord,
  fo_metrics(
    -- only the paid column has spend behind it
    ev.bucket = 'Paid Ads' and coalesce(ads.ad_rows, 0) > 0,
    case when ev.bucket = 'Paid Ads' then ads.spend       end,
    case when ev.bucket = 'Paid Ads' then ads.reach       end,
    case when ev.bucket = 'Paid Ads' then ads.impressions end,
    case when ev.bucket = 'Paid Ads' then ads.clicks      end,
    case when exists (select 1 from v_leads_seen z where z.client_id = ev.client_id)
         then coalesce(ev.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = ev.client_id)
         then coalesce(ev.attendance, 0) end,
    case when s.client_id is not null then coalesce(ev.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(ev.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(ev.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from ev
left join v_source_buckets b on b.bucket = ev.bucket
left join ads   on ads.client_id   = ev.client_id
left join share on share.client_id = ev.client_id
left join v_sales_seen s on s.client_id = ev.client_id
left join v_client_prices p on p.client_id = ev.client_id
order by ev.client_id, coalesce(b.ord, 99);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROUND × SOURCE — per-round Total still lifted whole out of By round, so the
-- two tabs cannot drift.
-- ═══════════════════════════════════════════════════════════════════════════

grant select on v_metrics_by_source to anon, authenticated;

create or replace view v_metrics_by_round_source as
with ev as (
  select
    client_id, round_id,
    coalesce(attribution_bucket, 'Unattributed') as bucket,
    count(*) filter (where event_type = 'lead')       as leads,
    count(*) filter (where event_type = 'attendance') as attendance
  from v_events
  group by 1, 2, 3
),
sales as (
  select
    client_id, lead_round_id as round_id,
    coalesce(attribution_bucket, 'Unattributed') as bucket,
    count(*) filter (where product = 'preview') as prev_buy,
    count(*) filter (where product = 'middle')  as mid_buy,
    sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview') as prev_rev,
    sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle')  as mid_rev
  from v_events
  where event_type = 'sale' and lead_round_id is not null
  group by 1, 2, 3
),
ads as (
  select client_id, round_id, sum(spend) as spend,
         -- 0016's rule, which this view never got: read reach off the coarsest
         -- row rather than adding the tiers, or a round claims 33,337 people
         -- when 12,672 saw it and Frequency drops below 1.
         coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null),
                  sum(reach)) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by 1, 2
),
-- a cell exists if either side has rows for it; a source with nothing in a
-- round gets no column in that round rather than a column of zeroes
cells as (
  select client_id, round_id, bucket from ev
  union
  select client_id, round_id, bucket from sales
)
select
  r.client_id,
  r.round_id || '·' || c.bucket                as cut_key,
  c.bucket                                     as cut_label,
  null::text                                   as cut_sub,
  r.round_id                                   as group_key,
  r.round_id                                   as group_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as group_sub,
  r.start_date,
  coalesce(b.ord, 99)                          as ord,
  fo_metrics(
    c.bucket = 'Paid Ads' and coalesce(ads.ad_rows, 0) > 0,
    case when c.bucket = 'Paid Ads' then ads.spend       end,
    case when c.bucket = 'Paid Ads' then ads.reach       end,
    case when c.bucket = 'Paid Ads' then ads.impressions end,
    case when c.bucket = 'Paid Ads' then ads.clicks      end,
    case when exists (select 1 from v_leads_seen z where z.client_id = r.client_id)
         then coalesce(ev.leads, 0) end,
    case when exists (select 1 from v_attendance_seen z where z.client_id = r.client_id)
         then coalesce(ev.attendance, 0) end,
    case when s.client_id is not null then coalesce(sales.prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_buy,  0) end,
    case when s.client_id is not null then coalesce(sales.prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.mid_rev,  0) end,
    p.preview_price, p.middle_price
  ) as m
from cells c
join rounds r
  on r.round_id = c.round_id and r.client_id = c.client_id
left join ev
  on ev.client_id = c.client_id and ev.round_id = c.round_id and ev.bucket = c.bucket
left join sales
  on sales.client_id = c.client_id and sales.round_id = c.round_id and sales.bucket = c.bucket
left join ads
  on ads.client_id = c.client_id and ads.round_id = c.round_id
left join v_source_buckets b on b.bucket = c.bucket
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id

union all

-- the per-round Total column, taken whole from By round so the two tabs agree.
-- rev is NULL until a sale exists, so it is coalesced here rather than compared
-- directly — a NULL comparison would make the whole OR-chain NULL and drop the
-- round out of the tab.
select
  client_id,
  cut_key || '·Total',
  'Total',
  null::text,
  cut_key,
  cut_key,
  cut_sub,
  start_date,
  0,
  m
from v_metrics_by_round
where (m->>'leads')::bigint > 0
   or coalesce((m->>'rev')::numeric, 0) > 0
   or (m->>'spend') is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- BASELINE — the pinned reference column. Same rule, NULL-safe: a client with
-- no sales yet simply has no baseline, rather than the comparison silently
-- vanishing on a NULL.
-- ═══════════════════════════════════════════════════════════════════════════

grant select on v_metrics_by_round_source to anon, authenticated;
