-- ═══════════════════════════════════════════════════════════════════════════
-- 0079 — the journey strip counts extras once.
--
-- 0078 cached v_metrics_total, but the strip has a second expensive input:
-- fo_stage_extras scans v_events for declared stages. It was called from the
-- stage row, therefore once for every card in the strip. The homepage still
-- timed out because that scan remained multiplied by the journey length.
--
-- A journey has one extras object per client and filtered window. Build it once
-- beside Total, then join it to every stage. Both CTEs are per request, so no
-- data is stored and rule/filter changes remain live.
--
-- No metric, label, or attribution changes. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_journey_strip as
with journey_clients as materialized (
  select distinct client_id from v_journey
), total as materialized (
  select t.* from v_metrics_total t join journey_clients c using (client_id)
), extras as materialized (
  select c.client_id, fo_stage_extras('v_journey_strip', c.client_id) as x
  from journey_clients c
), base as (
  select
    j.client_id, j.stage_order, j.stage_name, j.stage_slug, j.stage_rate_label,
    j.stage_metric, jm.metric_key,
    fo_add_stage_costs(
      case when fo_source_keeps_spend() then t.m else fo_source_blind(t.m) end,
      e.x -> 'TOTAL') as mm
  from v_journey j
  left join total t on t.client_id = j.client_id
  left join extras e on e.client_id = j.client_id
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
-- GET /rest/v1/v_journey_strip?client_id=eq.shely returns six rows, without
-- timeout. Its metric object remains spend 20474.78 · leads 1889 · attendance
-- 682 · revenue 83927.00.
