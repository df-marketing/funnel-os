-- ═══════════════════════════════════════════════════════════════════════════
-- The wire is visible from both ends.
--
-- AcqOS shows a "Send this funnel to Funnel OS" panel, so the push is visible
-- from the sending side. Nothing on this side said the wire existed at all: a
-- funnel arrives, the stages change, and the only evidence is that the sidebar
-- reads differently than it did yesterday.
--
-- The inbound half is already recorded — 0034 and 0038 put schema_source,
-- schema_version, generated_at and synced_at on client_journey_config, and the
-- anon read policy from 0001 covers that table. This adds the outbound half:
-- which periods AcqOS has taken a reading of and kept.
--
-- A view rather than a read policy on period_insights, for two reasons. The
-- table holds whole API responses and the panel wants four scalars, so pulling
-- the payload across to count it would be wasteful. And RLS on the base table
-- stays exactly as closed as 0041 left it — a view owned by the database owner
-- answers on its own privileges, which is the same route v_clients already
-- takes over the RLS'd tables underneath it.
--
-- ROLLBACK: drop view v_frozen_insights;
--   Nothing else reads it and no data lives in it.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_frozen_insights as
select
  client_id,
  period_kind,
  period_key,
  count(*)::int  as versions,
  max(version)   as current_version,
  max(frozen_at) as frozen_at,
  min(frozen_at) as first_frozen_at
from period_insights
group by client_id, period_kind, period_key;

comment on view v_frozen_insights is
  'One row per period that has ever been frozen, without the payloads. '
  'versions counts every reading kept for that period; current_version is the one '
  'a caller gets by default and frozen_at is when it was taken.';

grant select on v_frozen_insights to anon, authenticated, service_role;
