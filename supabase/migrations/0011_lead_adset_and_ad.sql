-- ═══════════════════════════════════════════════════════════════════════════
-- A LEAD CARRIES AN AUDIENCE AND AN AD, NOT ONE FIELD DOING BOTH JOBS.
--
-- GoHighLevel writes three tracking tags at opt-in and they mean three
-- different things:
--
--   utm_term     the AUDIENCE   Cold_BusinessOwners
--   utm_content  the AD         Static_LetAISellYourProducts
--   utm_campaign the ROUND      DF_SG_Preview_Sprint1_0526_02
--
-- The app only ever read one column, called it utm_campaign, and expected the
-- AUDIENCE in it. So the raw GHL export imported perfectly and attributed
-- nothing: every lead arrived carrying a round name where an ad set was
-- expected, matched no audience, and silently fell back to date-window
-- attribution. The only reason the numbers are right today is that leads.csv
-- was hand-edited to move utm_term into the utm_campaign column — a manual step
-- that would eventually be forgotten with nothing to warn anyone.
--
-- events now stores what it actually has: ad_set and ad, named after the same
-- things ads_performance names them, so both sides of the bridge match.
--
-- The 17 leads whose utm_content is a raw numeric Ad ID rather than a name are
-- stored as-is. An id is a better key than a name — names get edited in Ads
-- Manager and silently break the join — and this is where that will be resolved
-- when ad-level Meta data arrives.
--
-- Requires 0010. Adds two columns, backfills them, replaces one view.
-- ═══════════════════════════════════════════════════════════════════════════

alter table events add column if not exists ad_set text;
alter table events add column if not exists ad     text;

create index if not exists idx_events_adset on events (ad_set);

-- Everything already imported put the audience in utm_campaign, because that is
-- the only column the importer read. Move it, don't reinterpret it: whatever is
-- in there today IS what the audience bridge has been matching on, so copying it
-- across preserves every number on screen exactly.
update events
   set ad_set = nullif(btrim(utm_campaign), '')
 where event_type = 'lead'
   and ad_set is null
   and nullif(btrim(utm_campaign), '') is not null;

-- v_events was written as `select r.client_id, e.*, … as attribution_bucket`,
-- and `e.*` is expanded ONCE, when the view is created. Adding a column to
-- events therefore does not reach the view — every downstream query would fail
-- with "column ad_set does not exist" while the column plainly exists.
--
-- The columns are listed out here rather than starred, in their table order,
-- with the two new ones appended AFTER attribution_bucket. Appending is the only
-- edit CREATE OR REPLACE VIEW accepts; had they landed mid-list (where `*` would
-- have put them) this would need a drop-cascade and a rebuild of all seven
-- dependent views.
create or replace view v_events as
select
  r.client_id,
  e.event_id, e.contact_id, e.round_id, e.event_type, e.event_date,
  e.lead_round_id, e.close_round_id, e.attribution_method, e.utm_campaign,
  e.source, e.match_status, e.product, e.minutes_watched,
  e.amount, e.refund_amount, e.refund_date, e.is_lead, e.import_batch_id,
  case
    when e.source = 'Paid Ads'
     and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
      then 'Previous Paid Ads'
    else e.source
  end as attribution_bucket,
  e.ad_set,
  e.ad
from events e
join rounds r on r.round_id = e.round_id;

grant select on v_events to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED VIEWS — same view as 0010, bridging on ad_set instead of on a
-- column named after a different tag.
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
    r.spend, r.reach, r.impressions, r.clicks,
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
