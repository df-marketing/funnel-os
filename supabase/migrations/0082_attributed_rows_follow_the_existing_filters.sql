-- ═══════════════════════════════════════════════════════════════════════════
-- 0082 — credit follows the same filters as every other fact.
--
-- A product, country, period or source filter must cut attributed sales by the
-- round and source receiving the credit. A lead or attendee already receives
-- credit in its own round, so this is unchanged for them. Keeping this wrapper
-- separate lets the metric-view migration use one filtered input instead of
-- each tab inventing a slightly different definition of "selected".
--
-- No existing view reads v_attributed_events yet. This remains inert until the
-- metric rewiring migration immediately after it.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_attributed_events as
with campaign_dimensions as materialized (
  select * from v_campaign_dimensions
)
select
  a.*,
  coalesce(d.market, r.country) as attr_country
from v_event_attribution a
join rounds r
  on r.client_id = a.client_id
 and r.round_id = a.attr_round_id
left join campaign_dimensions d
  on d.client_id = a.client_id
 and d.campaign is not distinct from a.attr_utm_campaign
where fo_filter_people_ok(
        r.product_id,
        coalesce(d.market, r.country),
        r.start_date,
        r.end_date
      )
  and fo_filter_source_ok(coalesce(a.attr_source, 'Unattributed'));

comment on view v_attributed_events is
  'The attribution rows that survive the current product, channel, country, '
  'period and source filters. Sales follow the credited round; leads and '
  'attendance follow their own round because those are the same row.';

grant select on v_attributed_events to anon, authenticated;

commit;
