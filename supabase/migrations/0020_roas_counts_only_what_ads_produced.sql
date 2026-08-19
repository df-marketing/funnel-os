-- ═══════════════════════════════════════════════════════════════════════════
-- 0020 — ROAS and CPA must divide ad spend into what advertising produced.
--
-- 0526-03 spent 1,153.22 and reported ROAS 3.62, highlighted green as a win.
-- Every cent of that round's 4,176.00 came from two AOAI members and four AI
-- Community members — people already in the room, who cost nothing to acquire.
-- Not one ad-sourced person bought in that round. The true answer is 0.00, and
-- the screen was saying the opposite as loudly as it could.
--
-- The rule already exists everywhere else. 0006 established that spend belongs
-- to Paid Ads and only to Paid Ads, which is why the AOAI column carries no
-- CPM, no CPL and no ROAS. The round tabs were the one place it was never
-- applied, so one app printed 2.07 and 0.36 for the same period on two tabs.
--
-- WHAT COUNTS AS AD-PRODUCED. Paid Ads and Previous Paid Ads — both are paid
-- leads, and on By round a Previous Paid Ads sale already lands on the round
-- whose spend produced the lead. Unattributed does NOT count: nothing evidences
-- it was paid, and this app understates rather than overstates.
--
-- CPA GOES WITH IT, by the same argument. It is ad spend divided by acquired
-- customers, and counting customers the ads did not acquire makes acquisition
-- look cheaper than it was. 0526-03 read CPA 192.20 as though advertising had
-- bought six customers. It bought none, so that cell now reads '—'.
--
-- WHAT DOES NOT CHANGE. Total Revenue, Preview/Middle Offer Revenue, the
-- purchase counts and both AOV rows still count every sale — they are facts
-- about the round, not about advertising. So ROAS can no longer be derived from
-- the revenue row above it. That is a real cost of this change, and the reason
-- the round tabs now say in words which revenue ROAS is counting.
--
-- HOW. fo_metrics is left alone — eleven views depend on it, so its signature
-- cannot change without dropping every one of them. Instead the four affected
-- keys are recomputed by one helper, in one place, and only the six views that
-- can tell paid revenue from community revenue call it. By audience and By
-- creative need no change: a person with no ad set and no creative has no
-- column there, so their revenue is already ad-only.
-- ═══════════════════════════════════════════════════════════════════════════

-- The four figures whose denominator is ad spend, recomputed against the slice
-- of revenue advertising actually produced.
--
-- Reads spend back out of the metrics object rather than taking it as its own
-- argument, so it cannot disagree with the Ads Spent row on the same screen.
-- When a cut has no ads at all, spend is NULL there and all four of these blank
-- themselves — the same behaviour as before, arrived at the same way.
create or replace function fo_paid_returns(
  m               jsonb,
  p_paid_prev_buy bigint,     -- customers advertising acquired
  p_paid_prev_rev numeric,    -- preview revenue advertising produced
  p_paid_mid_rev  numeric     -- middle revenue advertising produced
) returns jsonb
language sql
immutable
as $$
  select m || jsonb_build_object(
    'cpa',      (m->>'spend')::numeric / nullif(p_paid_prev_buy, 0),
    'prevRoas', p_paid_prev_rev / nullif((m->>'spend')::numeric, 0),
    'midRoas',  p_paid_mid_rev  / nullif((m->>'spend')::numeric, 0),
    'roas',     (p_paid_prev_rev + p_paid_mid_rev) / nullif((m->>'spend')::numeric, 0)
  );
$$;

grant execute on function fo_paid_returns(jsonb, bigint, numeric, numeric) to anon, authenticated;

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
from rounds r
left join ads   on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev    on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales on sales.client_id = r.client_id and sales.round_id = r.round_id
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, r.start_date;

grant select on v_metrics_by_round to anon, authenticated;


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
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
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
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events e join rounds r on r.round_id = e.lead_round_id
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
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle')  as mid_rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where event_type = 'sale' and product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where event_type = 'sale' and product = 'middle'  and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events group by client_id
)
select
  c.client_id,
  'TOTAL'::text as cut_key,
  'Total'::text as cut_label,
  'all rounds'::text as cut_sub,
  fo_paid_returns(
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
    ),
    case when s.client_id is not null then coalesce(ev.paid_prev_buy, 0) end,
    case when s.client_id is not null then coalesce(ev.paid_prev_rev, 0) end,
    case when s.client_id is not null then coalesce(ev.paid_mid_rev,  0) end
  ) as m
from v_clients c
left join ads on ads.client_id = c.client_id
left join ev  on ev.client_id  = c.client_id
left join v_sales_seen s on s.client_id = c.client_id
left join v_client_prices p on p.client_id = c.client_id;

grant select on v_metrics_total to anon, authenticated;


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
