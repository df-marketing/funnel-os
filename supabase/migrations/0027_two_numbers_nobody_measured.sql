-- ═══════════════════════════════════════════════════════════════════════════
-- 0027 — two numbers nobody measured, both found by the imaginary product.
--
-- A second product was loaded to prove the Product and Channel filters narrow
-- anything, which one option can never prove. It did that, and it also exposed
-- two figures the app was printing as if they had been observed. Neither was
-- reachable with a single product on a single platform, which is exactly why
-- they survived this long.
--
-- ── 1. ATTENDANCE READ 0 FOR A CLASS THAT NEVER HAPPENED ──────────────────
-- The same round reported two different things depending on the filter:
--
--     DEMO-W1, no product filter   ->  attendance 0
--     DEMO-W1, filtered to it      ->  attendance —
--
-- The gate asks "does this CLIENT report attendance at all?". With the filter
-- off, Shely does — the workshop's 40 — so the gate opens and an evergreen
-- round with no class reports a measured zero. Nobody measured it. There was
-- no class to attend.
--
-- Fixed by requiring both: the client reports attendance AND the rounds in this
-- bucket actually held a class. round_sessions has said which since 0025, so
-- the question is now answerable where before it was not. Strictly more blanks
-- and never fewer — a round that held a class and drew nobody still reads 0,
-- because that zero was observed.
--
-- v_metrics_this_round needs no change: it reads v_metrics_by_round.
--
-- ── 2. FILTERING BY CHANNEL INVENTED ROAS ─────────────────────────────────
-- Revenue carries no platform. Sales and leads arrive from GoHighLevel and
-- Zoom, which do not know whether the ad was on Meta or Google, so a channel
-- filter narrows spend and leaves revenue whole — deliberately, and the filter
-- bar says so. What it did not say is what happens to everything DERIVED from
-- the two together. On the demo product:
--
--     meta      spend 1,200   rev 2,376   ROAS 1.98
--     google    spend   800   rev 2,376   ROAS 2.97
--     truth     spend 2,000   rev 2,376   ROAS 1.19
--
-- Each channel is credited with all of the revenue, so both beat the blended
-- figure and neither is real. Someone reads 2.97 and moves budget to Google.
--
-- Every ratio that divides an unattributed numerator by channel-scoped spend
-- now goes blank while a channel filter is on: roas, prevRoas, midRoas, cpa,
-- cpl, cpAtt, and leadgen (leads per click — clicks are per-channel, leads are
-- not). Nothing else changes. spend, impressions, reach, clicks, ctr, cpm, cpc
-- and frequency are all ads-side and all correctly narrowed. Revenue, leads,
-- attendance and the rates BETWEEN them are unattributed on both sides of the
-- division, so a channel filter leaves them alone.
--
-- Done in fo_cut rather than in twelve views: it is the one door every read
-- goes through, and it already knows what the filter is set to.
--
-- Changes nothing with no channel filter set. Shely's unfiltered numbers stay
-- spend 2,447.26, leads 313, attendance 40, revenue 5,067.00.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ATTENDANCE ──────────────────────────────────────────────────────────

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

create or replace view v_metrics_by_month as
with months as (
  select client_id, date_trunc('month', start_date)::date as month_start,
         count(*)::int as round_count
  from v_rounds group by 1, 2
),
cls as (
  -- see v_metrics_by_round: a month whose rounds held no class has no
  -- attendance to report, as distinct from having had nobody turn up.
  select r.client_id, date_trunc('month', r.start_date)::date as month_start,
         count(*) as sessions
  from v_round_sessions s join v_rounds r on r.round_id = s.round_id
  group by 1, 2
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
left join cls   on cls.client_id   = m.client_id and cls.month_start   = m.month_start
left join ads   on ads.client_id   = m.client_id and ads.month_start   = m.month_start
left join ev    on ev.client_id    = m.client_id and ev.month_start    = m.month_start
left join sales on sales.client_id = m.client_id and sales.month_start = m.month_start
left join v_sales_seen s    on s.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id
order by m.client_id, m.month_start;

grant select on v_metrics_by_month to anon, authenticated;

create or replace view v_metrics_by_week as
with weeks as (
  select client_id, date_trunc('week', start_date)::date as week_start,
         count(*)::int as round_count
  from v_rounds group by 1, 2
),
cls as (
  -- see v_metrics_by_round: a week whose rounds held no class has no
  -- attendance to report, as distinct from having had nobody turn up.
  select r.client_id, date_trunc('week', r.start_date)::date as week_start,
         count(*) as sessions
  from v_round_sessions s join v_rounds r on r.round_id = s.round_id
  group by 1, 2
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
from weeks m
left join cls   on cls.client_id   = m.client_id and cls.week_start   = m.week_start
left join ads   on ads.client_id   = m.client_id and ads.week_start   = m.week_start
left join ev    on ev.client_id    = m.client_id and ev.week_start    = m.week_start
left join sales on sales.client_id = m.client_id and sales.week_start = m.week_start
left join v_sales_seen s    on s.client_id = m.client_id
left join v_client_prices p on p.client_id = m.client_id
order by m.client_id, m.week_start;

grant select on v_metrics_by_week to anon, authenticated;

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

-- ── 2. CHANNEL-BLIND RATIOS ────────────────────────────────────────────────
-- Returns the metric object with every channel-incoherent ratio removed, or
-- unchanged when no channel filter is set.
--
-- Setting a key to null rather than dropping it is deliberate: the spine renders
-- a null as a dash and a missing key as nothing at all, and a row that silently
-- loses its label reads as a rendering bug rather than as an honest blank.
create or replace function fo_channel_blind(m jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when nullif(current_setting('funnel.channel', true), '') is null then m
    else m
      || jsonb_build_object(
           'roas',     null,   -- revenue ÷ this channel's spend
           'prevRoas', null,
           'midRoas',  null,
           'cpa',      null,   -- this channel's spend ÷ all buyers
           'cpl',      null,   -- this channel's spend ÷ all leads
           'cpAtt',    null,   -- this channel's spend ÷ all attendees
           'leadgen',  null    -- all leads ÷ this channel's clicks
         )
  end;
$$;

grant execute on function fo_channel_blind(jsonb) to anon, authenticated;

-- ── ONE WAY IN, NOW ALSO THE ONE PLACE THAT BLANKS ─────────────────────────
-- Unchanged from 0025 except for the jsonb_set on the way out.
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
  v_sel   text := 'select jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m''))';
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
      format('%s from %I t where client_id = $1%s order by %s', v_sel, p_view, v_where, v_order)
      using p_client, p_offer;
  else
    return query execute
      format('%s from %I t where client_id = $1 order by %s', v_sel, p_view, v_order)
      using p_client;
  end if;
end;
$$;

grant execute on function fo_cut(text, text, text, text, date, date, text) to anon, authenticated;
