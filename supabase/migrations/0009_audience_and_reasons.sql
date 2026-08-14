-- ═══════════════════════════════════════════════════════════════════════════
-- WHICH AUDIENCE CONVERTS — and saying why a row was parked.
--
-- Three fixes, found by checking the live app after the first real sales import.
--
-- 1. TARGETED VIEWS DIED BELOW THE LEADS ROW.
--
--        lead        306 rows, 292 with utm_campaign
--        attendance   40 rows,   0 with utm_campaign
--        sale          2 rows,   0 with utm_campaign
--
--    The importer writes utm_campaign onto lead events and nowhere else, so
--    joining attendance and sales on the event's own utm found nothing and every
--    audience reported 0 attendees and 0 buyers. Those 44 Cold_Broad leads
--    certainly produced some of the 40 attendees; printing 0 claims otherwise.
--
--    The app already solved this problem once. lead_round_id exists because a
--    sale belongs to the round that ACQUIRED the person, not the round it
--    happened in. Audiences get the same treatment here: a person's attendance
--    and purchases are attributed to the audience their lead came from. Without
--    it the tab can only ever report cost per lead, when the question it is
--    named for is which audience converts.
--
-- 2. THE COLUMNS SHUFFLED BETWEEN PAGE LOADS. With no per-audience spend,
--    sort_spend was 0 for all eight audiences and Postgres returned them in
--    whatever order it liked. v_metrics_by_source fixes its column order on
--    purpose so a column doesn't slide sideways; this view now does too, via an
--    explicit `ord` the app reads instead of a spend that is often a tie.
--
-- 3. "NAME ONLY, NO CONTACT DETAIL" WAS GROUPING ROWS THAT HAD CONTACT DETAIL.
--    The importer reused reason = 'name_only' for rows it couldn't use for
--    completely different causes — no opt-in date, no round, an unrecognised
--    product. limpljanet@gmail.com sat under "no contact detail" with its email
--    right there in the row. Two new reasons split that apart, and they map to
--    two different actions: fix the file, or create the round.
--
-- Requires 0008. Adds a check constraint value and re-labels 9 existing rows;
-- creates no tables.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 3. Reasons ─────────────────────────────────────────────────────────────
alter table unmatched_rows drop constraint if exists unmatched_rows_reason_check;
alter table unmatched_rows add constraint unmatched_rows_reason_check
  check (reason in (
    'same_person_two_addresses',
    'phone_format',
    'name_only',          -- we know the row, we don't know the person
    'bought_without_lead',
    'incomplete_row',     -- the row is missing something the app needs
    'no_matching_round',  -- the row is fine; there is no round to attach it to
    'unknown_person'      -- contact detail we have, a person we don't
  ));

-- Re-label only rows whose guess_method already names the real cause. Rows
-- parked by the identity matcher have a null guess_method and really are
-- name_only — the 121 Zoom attendees with no email, and the 7 sales rows with
-- no email, are correctly filed and are left alone.
update unmatched_rows
   set reason = 'incomplete_row'
 where reason = 'name_only'
   and guess_method in ('no usable opt-in date', 'missing date or amount');

update unmatched_rows
   set reason = 'no_matching_round'
 where reason = 'name_only'
   and (guess_method like 'no round covers%' or guess_method like 'no round matches%');

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 + 2. TARGETED VIEWS
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view v_metrics_by_adset as
with ads as (
  select client_id, nullif(btrim(ad_set), '') as ad_set,
         sum(spend) as spend, sum(reach) as reach,
         sum(impressions) as impressions, sum(clicks) as clicks,
         count(*) as ad_rows
  from v_ads group by client_id, nullif(btrim(ad_set), '')
),
-- The audience that ACQUIRED each person: the earliest lead of theirs that
-- carries a utm. A contact with no tagged lead has no audience and stays out of
-- every audience column, which is the existing rule and still correct — an
-- organic lead cost nothing, so it belongs to no ad set.
lead_audience as (
  select distinct on (client_id, contact_id)
         client_id, contact_id, nullif(btrim(utm_campaign), '') as ad_set
  from v_events
  where event_type = 'lead'
    and contact_id is not null
    and nullif(btrim(utm_campaign), '') is not null
  order by client_id, contact_id, event_date
),
-- A LEAD is counted on its OWN tag, not on the acquiring lead's. The two differ
-- for anyone who opted in twice: 40 contacts here have a second lead, and
-- routing those through the first audience inflated the lead total from 828 to
-- 868. That second opt-in genuinely came from the second ad set — it is the
-- events with no tag of their own that need the detour.
ev_leads as (
  select client_id, nullif(btrim(utm_campaign), '') as ad_set, count(*) as leads
  from v_events
  where event_type = 'lead' and nullif(btrim(utm_campaign), '') is not null
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
)
select
  coalesce(ads.client_id, ev.client_id)                     as client_id,
  coalesce(ads.ad_set, ev.ad_set, '(unsplit)')              as cut_key,
  coalesce(ads.ad_set, ev.ad_set, 'Unsplit spend')          as cut_label,
  case when coalesce(ads.ad_set, ev.ad_set) is null
       then 'ads that name no ad set' end                   as cut_sub,
  fo_metrics(
    coalesce(ads.ad_rows, 0) > 0,
    ads.spend, ads.reach, ads.impressions, ads.clicks,
    case when coalesce(ads.ad_set, ev.ad_set) is not null then coalesce(ev.leads, 0)      end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null then coalesce(ev.attendance, 0) end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.prev_buy, 0) end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.mid_buy, 0)  end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.prev_rev, 0) end,
    case when coalesce(ads.ad_set, ev.ad_set) is not null and s.client_id is not null
         then coalesce(ev.mid_rev, 0)  end,
    p.preview_price, p.middle_price
  ) as m,
  case when coalesce(ads.ad_set, ev.ad_set) is null then -1
       else coalesce(ads.spend, 0) end                      as sort_spend,
  -- Fixed column order. Spend first because that's the size of the bet, leads
  -- as the tiebreaker when no spend is attributable, then the name so the order
  -- is total rather than merely mostly-decided. Unsplit spend always last: it is
  -- real money but it isn't an audience.
  row_number() over (
    partition by coalesce(ads.client_id, ev.client_id)
    order by
      case when coalesce(ads.ad_set, ev.ad_set) is null then 1 else 0 end,
      coalesce(ads.spend, 0) desc,
      coalesce(ev.leads, 0) desc,
      coalesce(ads.ad_set, ev.ad_set)
  )::int                                                    as ord
from ads
full join ev on ev.client_id = ads.client_id and ev.ad_set = ads.ad_set
left join v_sales_seen s on s.client_id = coalesce(ads.client_id, ev.client_id)
left join v_client_prices p on p.client_id = coalesce(ads.client_id, ev.client_id)
order by 1, ord;

grant select on v_metrics_by_adset to anon, authenticated;
