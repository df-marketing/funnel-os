-- ═══════════════════════════════════════════════════════════════════════════
-- 0076 — the campaign lookup is built once per read.
--
-- 0075 moved market and page correctly onto fo_resolve, but a normal Postgres
-- view is expanded wherever it is mentioned. The planner therefore expanded
-- v_campaign_dimensions repeatedly inside v_events and the landing-page / MY
-- country reads. The result was correct when it returned, but the app's query
-- hit its statement timeout first. Correct but unreadable is not correct.
--
-- The lookup has about 25 client/campaign rows. Materialising it as a CTE
-- inside each base reader makes that lookup once for that reader invocation,
-- before joining 1,832 ad rows or the event rows. This is NOT a materialized
-- view: it is rebuilt on every read, so editing a rule immediately restates
-- every historical round as 0073 promised.
--
-- No meaning changes. The baseline must remain:
--   spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--   ROAS 1.80 · CPA 365.62.
--
-- Safe to re-run.
-- ROLLBACK: re-run 0075's v_ads and v_events definitions. Do not remove the
-- rules table, resolver, or v_campaign_dimensions.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_ads as
with campaign_dimensions as materialized (
  select * from v_campaign_dimensions
)
select r.client_id, a.*, r.product_id,
       coalesce(d.market, r.country) as country
from ads_performance a
join rounds r on r.round_id = a.round_id
left join campaign_dimensions d
  on d.client_id = r.client_id
 and d.campaign is not distinct from a.campaign
where fo_filter_ok(r.product_id, a.channel,
                   coalesce(d.market, r.country),
                   r.start_date, r.end_date);

create or replace view v_events as
with campaign_dimensions as materialized (
  select * from v_campaign_dimensions
)
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
  e.ad,
  r.product_id,
  e.variant,
  coalesce(e.country, d.market, r.country) as country
from events e
join rounds r on r.round_id = e.round_id
left join campaign_dimensions d
  on d.client_id = r.client_id
 and d.campaign is not distinct from e.utm_campaign
where fo_filter_people_ok(r.product_id,
                          coalesce(e.country, d.market, r.country),
                          r.start_date, r.end_date)
  and fo_filter_source_ok(
        coalesce(
          case
            when e.source = 'Paid Ads'
             and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
              then 'Previous Paid Ads'
            else e.source
          end,
          'Unattributed'));

grant select on v_ads, v_events to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING — through the app's anon key, never only the editor
-- 1. Total: spend 20474.78 · leads 1889 · attendance 682 · revenue 83927.00
--           · ROAS 1.80 · CPA 365.62.
-- 2. Country=MY: fo_cut('v_metrics_by_round','shely', p_country => 'MY')
--    returns one round, spend 989.53 — and returns rather than timing out.
-- 3. Landing-page cut returns LP1 (11853.47 spend, 738 leads, 26.8% show,
--    1.88 ROAS), LP2 (3056.16, 216, 20.4%, 0.66) and Lead Form (5565.15,
--    595 leads), without a statement timeout.
