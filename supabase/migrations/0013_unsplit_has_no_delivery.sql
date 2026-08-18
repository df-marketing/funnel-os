-- ═══════════════════════════════════════════════════════════════════════════
-- "UNSPLIT SPEND" HAS NO CTR, BECAUSE IT IS NOT AN AUDIENCE.
--
-- Targeted views ends in a column called Unsplit spend. It holds the money that
-- moved without naming an ad set — a campaign exported without an ad-set
-- breakdown, or a round-level correction row. The column exists so that spend
-- lands SOMEWHERE rather than vanishing, and its label says exactly that.
--
-- It was also printing delivery metrics, and they were nonsense:
--
--     Unsplit spend    reach 22,803   impressions 1,566   clicks 856
--                      Outbound CTR 54.66%   Lead Gen % 1.05%   Frequency 0.07
--
-- 54.66% is not a click-through rate anyone has ever seen. It is 856 clicks —
-- the whole account's outbound clicks for two rounds — divided by 1,566
-- impressions, which belong only to the one campaign that had no ad-set
-- breakdown. Two different populations, one fraction. Frequency 0.07 says every
-- person saw the ad a fourteenth of a time.
--
-- The cause is not arithmetic. Meta's ad-set-level export gives spend and
-- impressions per ad set and does NOT give reach (deduplicated people cannot be
-- summed) or outbound clicks (the Outbound CTR column comes back empty on every
-- row). So those two figures are only available for the account as a whole and
-- have to enter as rows that name no ad set — landing, correctly, in the only
-- bucket for rows that name no ad set.
--
-- Every other view is unaffected and already right: By round, By source and the
-- Total column group by round, so they read reach 12,672 and clicks 479 for
-- 0526-02, matching the master sheet to the unit.
--
-- The rule this applies:
--
--   Reach, impressions and clicks describe how an AUDIENCE was delivered to.
--   Spend describes a payment. In the bucket whose entire meaning is "we cannot
--   say which audience", the delivery metrics have no subject, so they are
--   absent rather than zero and rather than wrong. Spend, leads, attendance and
--   revenue stay — those are real facts about the bucket.
--
-- After this the column reads: spend 84.20 · leads 9 · CPL 9.36 · attendance 2
-- · CP Attendance 42.10 · revenue 594.00 · ROAS 7.1, and a dash everywhere the
-- number would have been a fabrication.
--
-- THE REAL FIX IS UPSTREAM. Re-export the ad-set report from Meta with Reach
-- and Outbound clicks included as columns. Then every audience carries its own
-- CTR and CPC, the correction rows stop being necessary, and this bucket goes
-- back to holding nothing but genuinely unattributable spend.
--
-- Requires 0011. Replaces one view; no table is touched.
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
    r.spend,
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
