-- Draft only. Apply in an approved isolated environment before any rollout.
-- Clients are registered by client_journey_config, which can replace its rows
-- during a GU sync. Scope checks use the current journey, not an FK to a
-- transient row. A material configuration change invalidates the binding; an identical sync does not.
begin;
create table public.import_mapping_profiles (
  id uuid primary key default gen_random_uuid(),
  client_id text not null check (client_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'),
  source text not null check (
    source in ('ads', 'leads', 'attendance', 'sales') or
    source ~ '^stage:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'
  ),
  stage_key text not null check (stage_key ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'),
  stage_binding text not null check (stage_binding ~ '^[0-9a-f]{64}$'),
  name text not null check (length(name) between 1 and 80),
  name_key text not null check (length(name_key) between 1 and 240),
  config jsonb not null check (
    jsonb_typeof(config) = 'object' and
    config ?& array['headers', 'mapping', 'rules'] and
    jsonb_typeof(config->'headers') = 'array' and
    jsonb_typeof(config->'mapping') = 'object' and
    jsonb_typeof(config->'rules') = 'object' and
    octet_length(config::text) <= 65536
  ),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, source, stage_key, stage_binding, name_key)
);
alter table public.import_mapping_profiles enable row level security;
revoke all on table public.import_mapping_profiles from public, anon, authenticated, service_role;
grant select, insert, update on table public.import_mapping_profiles to service_role;
comment on table public.import_mapping_profiles is
  'Server-validated import mapping metadata only; no uploaded rows. No browser role has direct access.';
commit;
