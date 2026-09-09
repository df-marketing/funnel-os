-- 0095 — the four core delivery facts remain columns; client-declared extra
-- ad measurements live in JSON so an export can add video_views without a
-- schema migration.  An absent key remains absent, never zero.
begin;

alter table ads_performance
  add column if not exists measures jsonb not null default '{}'::jsonb;

alter table journey_metrics
  add column if not exists aliases text[] not null default '{}',
  add column if not exists client_id text;

-- `metric` used to be globally unique. A measure can now be global or scoped
-- to one client, so retain the global row and permit one scoped declaration of
-- the same name. PostgreSQL unique constraints treat NULL as distinct; the
-- expression makes the global namespace a real, unique member too.
alter table journey_metrics drop constraint if exists journey_metrics_pkey;
create unique index if not exists journey_metrics_client_metric_unique
  on journey_metrics (metric, coalesce(client_id, ''));

create index if not exists idx_journey_metrics_ads_client
  on journey_metrics (client_id, metric)
  where source = 'ads';

-- A new read surface avoids changing the ordinal contract of v_ads (Postgres
-- rejects a replace that shifts existing view columns). It exposes every
-- existing v_ads field plus the dynamic object; an absent metric is no key.
create or replace view v_ads_measures as
select v.*, a.measures
from v_ads v
join ads_performance a on a.id = v.id;
grant select on v_ads_measures to anon, authenticated;

commit;

-- CHECK AFTER RUNNING (through the app's anon key):
-- select measures from v_ads_measures where client_id = 'shely' limit 1;
-- Existing rows return {}, not a fabricated measurement.
