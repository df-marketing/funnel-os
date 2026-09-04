-- ═══════════════════════════════════════════════════════════════════════════
-- 0052 — a sale with no lead behind it is still a sale.
--
-- WHAT WAS WRONG. pipeline.ts writes a sale whose buyer has no lead event and
-- says, in a warning the importer prints, "counted in revenue, excluded from
-- ROAS". Only the second half was true. Every per-round revenue view gated on
-- `lead_round_id is not null`, so the row was written to `events`, counted by
-- v_metrics_total, and dropped by all six views that cut revenue by a spine.
--
-- That is worse than either choice made cleanly. The Total tab and the By
-- round tab would disagree, and nothing on any screen said why.
--
-- WHAT THIS DOES. Revenue rolls up on coalesce(lead_round_id, round_id): the
-- round that produced the lead where one exists, otherwise the round the money
-- arrived in. A buyer who never opted in is counted where they bought, which
-- is the only round that has any claim on them.
--
-- WHY ROAS DOES NOT MOVE. Every paid figure is gated separately, on
-- attribution_bucket in ('Paid Ads', 'Previous Paid Ads') — see 0020. A sale
-- with no lead has no lead source, so it cannot land in either bucket. It adds
-- to revenue and contributes nothing to ROAS, CPA or any paid ratio. That is
-- the behaviour the importer already claimed.
--
-- SIX VIEWS, ONE RULE. by_round, by_round_source, by_offer, by_session,
-- by_week and by_month. Every one of them, or the tabs stop agreeing — which
-- was the original fault, and would be the fault again if this were partial.
-- v_metrics_total is untouched because it never had the gate.
--
-- The column list of each view is unchanged, so create or replace is legal.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── v_metrics_by_session ──────────────────────────────────────────────────
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
  from v_events e join v_rounds r on r.round_id = coalesce(e.lead_round_id, e.round_id)
       join v_round_labels rl on rl.round_id = r.round_id
  where e.event_type = 'sale'
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

-- ── v_metrics_by_round ────────────────────────────────────────────────────
create or replace view v_metrics_by_round as
with cls as (
  -- classes actually recorded against each round. A round with none had no
  -- class, so its attendance was never measured and must not read 0.
  select client_id, round_id, count(*) as sessions
  from v_round_sessions group by client_id, round_id
),
ads as (
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
  select client_id, coalesce(lead_round_id, round_id) as round_id,
         count(*) filter (where product = 'preview')                     as prev_buy,
         count(*) filter (where product = 'middle')                      as mid_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview') as prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle')  as mid_rev,
         -- the ad-produced slice, for ROAS and CPA (0020)
         count(*) filter (where product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'preview' and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(amount - coalesce(refund_amount, 0)) filter (where product = 'middle'  and attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events where event_type = 'sale'
  group by client_id, coalesce(lead_round_id, round_id)
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
from v_rounds r
left join cls   on cls.client_id = r.client_id and cls.round_id = r.round_id
left join ads   on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev    on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales on sales.client_id = r.client_id and sales.round_id = r.round_id
left join v_sales_seen s on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
order by r.client_id, r.start_date;
grant select on v_metrics_by_round to anon, authenticated;

-- ── v_metrics_by_round_source ─────────────────────────────────────────────
create or replace view v_metrics_by_round_source as
with cls as (
  -- see v_metrics_by_round. The round decides this, not the source: a source
  -- cannot have brought people to a class that never happened.
  select client_id, round_id, count(*) as sessions
  from v_round_sessions group by client_id, round_id
),
ev as (
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
    client_id, coalesce(lead_round_id, round_id) as round_id,
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
  where event_type = 'sale'
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
from cells c
join v_rounds r
  on r.round_id = c.round_id and r.client_id = c.client_id
left join cls
  on cls.client_id = c.client_id and cls.round_id = c.round_id
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

-- ── v_metrics_by_week ─────────────────────────────────────────────────────
create or replace view v_metrics_by_week as
with
-- Can this client's ad rows be placed on a day at all? A row dated outside the
-- round it belongs to is a reporting-window marker, not the day money moved.
ads_placeable as (
  select client_id, bool_and(dated) as day_level
  from (
    select r.client_id, (a.date between r.start_date and r.end_date) as dated
    from v_ads a join v_rounds r on r.round_id = a.round_id
  ) t
  group by client_id
),
ads as (
  select r.client_id,
         date_trunc('week', a.date)::date as week_start,
         sum(a.spend) as spend,
         -- 0016: reach is distinct people and cannot be added. Taken off the
         -- coarsest row available. A week holding several days of campaign rows
         -- still over-counts anyone reached on two of them — REACH_NOTE says so
         -- on every response, and that caveat is now more load-bearing here.
         coalesce(sum(a.reach) filter (where nullif(btrim(a.ad_set), '') is null),
                  sum(a.reach)) as reach,
         sum(a.impressions) as impressions, sum(a.clicks) as clicks, count(*) as ad_rows
  from v_ads a
  join v_rounds r on r.round_id = a.round_id
  join ads_placeable d on d.client_id = r.client_id and d.day_level
  group by 1, 2
),
-- The join to v_rounds is what applies the product and period filter — v_events
-- carries none of its own — while the bucket comes from the event's own instant.
ev as (
  select r.client_id,
         date_trunc('week', (e.event_date at time zone 'Asia/Singapore')::date)::date as week_start,
         count(*) filter (where e.event_type = 'lead')       as leads,
         count(*) filter (where e.event_type = 'attendance') as attendance
  from v_events e join v_rounds r on r.round_id = e.round_id
  group by 1, 2
),
-- A sale lands in the week the money arrived. On a calendar cut that is what a
-- week's revenue means; the round it is credited to is By round's question.
sales as (
  select r.client_id,
         date_trunc('week', (e.event_date at time zone 'Asia/Singapore')::date)::date as week_start,
         count(*) filter (where e.product = 'preview') as prev_buy,
         count(*) filter (where e.product = 'middle')  as mid_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview') as prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle')  as mid_rev,
         count(*) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_buy,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'preview' and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_prev_rev,
         sum(e.amount - coalesce(e.refund_amount, 0)) filter (where e.product = 'middle'  and e.attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_mid_rev
  from v_events e join v_rounds r on r.round_id = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
  group by 1, 2
),
-- A week with no class has no attendance to report, as distinct from a week
-- where nobody turned up. Bucketed by the session's own date, like everything
-- else here.
cls as (
  select client_id, date_trunc('week', session_date)::date as week_start, count(*) as sessions
  from v_round_sessions
  where session_date is not null
  group by 1, 2
),
-- The spine is the weeks that HAVE something, not the weeks rounds start in.
weeks as (
  select client_id, week_start from ads
  union
  select client_id, week_start from ev
  union
  select client_id, week_start from sales
),
-- Which rounds this week overlaps — a week may touch two, and a round may touch
-- two weeks. That is the fact the old cut_sub, always "1 round", could not say.
spans as (
  select w.client_id, w.week_start,
         string_agg(distinct r.round_id, ', ' order by r.round_id) as rounds
  from weeks w
  join v_rounds r
    on r.client_id = w.client_id
   and r.start_date <= w.week_start + 6
   and r.end_date   >= w.week_start
  group by 1, 2
)
select
  w.client_id,
  to_char(w.week_start, 'IYYY-"W"IW')       as cut_key,
  to_char(w.week_start, 'DD Mon') || ' – ' || to_char(w.week_start + 6, 'DD Mon') as cut_label,
  sp.rounds                                 as cut_sub,
  w.week_start,
  fo_paid_returns(
    fo_metrics(
      coalesce(ads.ad_rows, 0) > 0,
      ads.spend, ads.reach::bigint, ads.impressions, ads.clicks,
      case when exists (select 1 from v_leads_seen z where z.client_id = w.client_id)
           then coalesce(ev.leads, 0) end,
      case when exists (select 1 from v_attendance_seen z where z.client_id = w.client_id)
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
from weeks w
left join spans sp  on sp.client_id    = w.client_id and sp.week_start    = w.week_start
left join ads       on ads.client_id   = w.client_id and ads.week_start   = w.week_start
left join ev        on ev.client_id    = w.client_id and ev.week_start    = w.week_start
left join sales     on sales.client_id = w.client_id and sales.week_start = w.week_start
left join cls       on cls.client_id   = w.client_id and cls.week_start   = w.week_start
left join v_sales_seen s    on s.client_id = w.client_id
left join v_client_prices p on p.client_id = w.client_id
order by w.client_id, w.week_start;
grant select on v_metrics_by_week to anon, authenticated;

-- ── v_metrics_by_offer ────────────────────────────────────────────────────
create or replace view v_metrics_by_offer as
with offers as (select unnest(array['preview', 'middle']) as product),
ads as (
  select client_id, round_id, sum(spend) as spend,
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
  select client_id, coalesce(lead_round_id, round_id) as round_id, product,
         count(*) as buys,
         sum(amount - coalesce(refund_amount, 0)) as rev,
         count(*) filter (where attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_buys,
         sum(amount - coalesce(refund_amount, 0)) filter (where attribution_bucket in ('Paid Ads', 'Previous Paid Ads')) as paid_rev
  from v_events
  where event_type = 'sale' and product is not null
  group by 1, 2, 3
)
select
  r.client_id,
  o.product,
  r.round_id || '·' || o.product              as cut_key,
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
      case when o.product = 'preview' and s.client_id is not null then coalesce(sp.buys, 0) end,
      case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.buys, 0) end,
      case when o.product = 'preview' and s.client_id is not null then coalesce(sp.rev,  0) end,
      case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.rev,  0) end,
      p.preview_price, p.middle_price
    ),
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.paid_buys, 0) end,
    case when o.product = 'preview' and s.client_id is not null then coalesce(sp.paid_rev,  0) end,
    case when o.product = 'middle'  and s.client_id is not null then coalesce(sm.paid_rev,  0) end
  ) as m,
  o.product                                   as group_key,
  coalesce(j.stage_name,
           case o.product when 'preview' then 'Preview offer' else 'Middle offer' end) as group_label,
  null::text                                  as group_sub
from v_rounds r
cross join offers o
left join ads on ads.client_id = r.client_id and ads.round_id = r.round_id
left join ev  on ev.client_id  = r.client_id and ev.round_id  = r.round_id
left join sales sp on sp.client_id = r.client_id and sp.round_id = r.round_id and sp.product = 'preview'
left join sales sm on sm.client_id = r.client_id and sm.round_id = r.round_id and sm.product = 'middle'
left join v_sales_seen s    on s.client_id = r.client_id
left join v_client_prices p on p.client_id = r.client_id
left join client_journey_config j
       on j.client_id = r.client_id and j.stage_slug = o.product
order by r.client_id, o.product, r.start_date;
grant select on v_metrics_by_offer to anon, authenticated;

-- ── v_metrics_by_month ────────────────────────────────────────────────────
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
  from v_events e join v_rounds r on r.round_id = coalesce(e.lead_round_id, e.round_id)
  where e.event_type = 'sale'
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
commit;
