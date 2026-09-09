-- ═══════════════════════════════════════════════════════════════════════════
-- 0078 — the journey strip reads Total once.
--
-- After the rules rewire, v_metrics_total is a real calculation rather than a
-- cheap lookup. v_journey_strip joined it directly to every stage. The planner
-- expanded that calculation once per stage, so the homepage hit statement
-- timeout even though asking for Total on its own returned the right number.
--
-- The strip has one Total for its whole filtered window. Materialise that one
-- row at the top, then join each stage to it. This is per-request, not stored:
-- filters and rule edits still apply on the next read.
--
-- No metric or attribution changes. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_journey_strip as
with total as materialized (
  select * from v_metrics_total
), base as (
  select
    j.client_id, j.stage_order, j.stage_name, j.stage_slug, j.stage_rate_label,
    j.stage_metric,
    jm.metric_key,
    fo_add_stage_costs(
      case when fo_source_keeps_spend() then t.m else fo_source_blind(t.m) end,
      fo_stage_extras('v_journey_strip', j.client_id) -> 'TOTAL') as mm
  from v_journey j
  left join total t on t.client_id = j.client_id
  left join journey_metrics jm on jm.metric = j.stage_metric
), valued as (
  select *,
    case when (mm ->> metric_key) ~ '^-?[0-9]+(\.[0-9]+)?$'
         then (mm ->> metric_key)::numeric end as value_num
  from base
)
select
  client_id, stage_order, stage_name, stage_slug, stage_rate_label,
  (mm ->> metric_key) as value,
  (100 * value_num / nullif(lag(value_num) over (
    partition by client_id order by stage_order), 0))::text as rate,
  stage_metric, mm as m
from valued
order by client_id, stage_order;

grant select on v_journey_strip to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING, THROUGH THE ANON KEY ─────────────────────────────
-- GET /rest/v1/v_journey_strip?client_id=eq.shely returns the six stages
-- without a statement timeout. The first row's m still says spend 20474.78,
-- leads 1889, attendance 682 and revenue 83927.00.
