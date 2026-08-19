-- ═══════════════════════════════════════════════════════════════════════════
-- 0024 — a round outside the filter must not leave an empty column behind.
--
-- 0023 filtered the facts and forgot the frame. Six views build their columns
-- by scanning `rounds` and then left-joining the numbers onto them, so
-- filtering to 0526-03 still produced a 0526-02 column — reading leads 0,
-- attendance 0, revenue 0.
--
-- Those zeroes are the exact lie the rest of this app is built to refuse. A
-- measured zero says "we looked and there was nothing". These say "this round
-- is not in the window you asked for", which is a different fact, and the
-- screen had no way to tell them apart.
--
-- v_rounds carries the same filter as v_ads and v_events, and the six views
-- read it instead of the table. A round outside the period now has no column at
-- all, which is the honest answer — and a round INSIDE the period with no data
-- yet still gets its column of dashes, which is the other honest answer, and
-- the two stop being the same picture.
--
-- Deliberately the PEOPLE filter, not the ads one: a round does not belong to a
-- channel. Filtering to Google narrows spend and leaves every round standing,
-- which is what the bar says it does.
--
-- Everything else that reads `rounds` is left alone on purpose — the staleness
-- horizon in v_import_status asks "what is the last round that ended", and that
-- question has nothing to do with what anyone is looking at.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_rounds as
select * from rounds
where fo_filter_people_ok(product_id, start_date, end_date);

grant select on v_rounds to anon, authenticated;

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
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle')  as mid_rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle'  and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events where event_type = 'sale' and lead_round_id is not null
  group by client_id, lead_round_id
)
select
  r.client_id,
  r.round_id                                  as cut_key,
  r.round_id                                  as cut_label,
  to_char(r.start_date, 'Mon DD') || ' – ' || to_char(r.end_date, 'DD') as cut_sub,
  r.start_date,
  fo_paid_returns(
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
    ),
    case when s.client_id is not null then coalesce(sales.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_mid_rev,  0) end
  ) as m
from v_rounds r
left join ads   on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev    on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales on sales.client_id = r.client_id and sales.round_id = r.round_id
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, r.start_date;

grant select on v_metrics_by_round to anon, authenticated;


create or replace view v_metrics_by_month as
with months as (
  select client_id, date_trunc('month', start_date)::date as month_start,
         count(*)::int as round_count
  from v_rounds group by 1, 2
),
ads as (
  select r.client_id, date_trunc('month', r.start_date)::date as month_start,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a join v_rounds r on r.round_id = a.round_id group by 1, 2
),
ev as (
  select r.client_id, date_trunc('month', r.start_date)::date as month_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join v_rounds r on r.round_id = e.round_id group by 1, 2
),
sales as (
  select r.client_id, date_trunc('month', r.start_date)::date as month_start,
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
  to_char(m.month_start, 'YYYY-MM')  as cut_key,
  to_char(m.month_start, 'Mon YYYY') as cut_label,
  m.round_count || ' round' || case when m.round_count = 1 then '' else 's' end as cut_sub,
  m.month_start,
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
  from v_rounds group by 1, 2
),
ads as (
  select r.client_id, coalesce(nullif(btrim(r.session_label), ''), '(unlabelled)') as label,
         sum(a.spend) as spend,
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a join v_rounds r on r.round_id = a.round_id group by 1, 2
),
ev as (
  select r.client_id, coalesce(nullif(btrim(r.session_label), ''), '(unlabelled)') as label,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join v_rounds r on r.round_id = e.round_id group by 1, 2
),
sales as (
  select r.client_id, coalesce(nullif(btrim(r.session_label), ''), '(unlabelled)') as label,
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
         sum(amount - coalesce(refund_amount, 0)) as rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_buys,
         sum(amount - coalesce(refund_amount, 0)) filter (where attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_rev
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
  fo_paid_returns(
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
    ),
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.paid_buys, 0) end,
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.paid_rev,  0) end,
    case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.paid_rev,  0) end
  ) as m
from v_rounds r
cross join offers o
left join ads on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev  on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales sp on sp.client_id = r.client_id and sp.round_id = r.round_id and sp.product = 'preview'
left join sales sm on sm.client_id = r.client_id and sm.round_id = r.round_id and sm.product = 'middle'
left join v_sales_seen s    on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, o.product, r.start_date;

grant select on v_metrics_by_offer to anon, authenticated;


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
    sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle')  as mid_rev,
    -- the ad-produced slice, for ROAS and CPA (0020)
    count(*) filter (where product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
    sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
    sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle'  and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
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
  fo_paid_returns(
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
    ),
    case when s.client_id is not null then coalesce(sales.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(sales.paid_mid_rev,  0) end
  ) as m
from cells c
join v_rounds r
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


create or replace view v_metrics_this_round as
select
  client_id, cut_key, cut_label, cut_sub, start_date, m,
  case when rn = 1 then 'this round' else 'previous' end as period,
  rn::int as ord
from (
  select b.*, row_number() over (partition by b.client_id order by b.start_date desc) as rn
  from v_metrics_by_round b
  join v_rounds r on r.round_id = b.cut_key
  where r.start_date <= current_date
) ranked
where rn <= 2
order by client_id, start_date;

grant select on v_metrics_this_round to anon, authenticated;
